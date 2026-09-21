import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import ts from 'typescript';

// Execute the actual v2 route in Node, swapping only its condition catalogue.
// The Cloudflare env binding is adapted to process.env; request creation,
// hashing, OpenRouter options, timeout and response validation remain in the route.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataModule = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const modules = new Map();
function loadModule(relative, overrides = {}) {
  if (overrides[relative]) return overrides[relative];
  if (modules.has(relative)) return modules.get(relative);
  let source = ts.transpileModule(fs.readFileSync(path.join(root, relative), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  source = source.replace(/from\s+(["'])([^"']+)\1/g, (_match, _quote, specifier) => {
    const url = specifier === 'cloudflare:workers'
      ? dataModule('export const env = process.env;')
      : specifier.startsWith('@/')
        ? loadModule(`${specifier.slice(2)}.ts`, overrides)
        : specifier;
    return `from ${JSON.stringify(url)}`;
  });
  const url = dataModule(source);
  modules.set(relative, url);
  return url;
}

const protocolUrl = loadModule('app/study-protocol.ts');
const baseline = await import(protocolUrl);
const { MODEL_OPTIONS } = await import(loadModule('app/model-catalog.ts'));
const conditions = baseline.ENVIRONMENTS.map((condition, i, original) => ({
  ...condition,
  id: condition.id === 'simulated' ? 'sim_prompt_photo' : 'real_prompt_render',
  label: condition.id === 'simulated' ? 'Simulation prompt + photorealistic image' : 'Real-life prompt + rendered image',
  promptCondition: condition.id,
  imageCondition: original[1 - i].id,
  imagePath: original[1 - i].imagePath,
  imageSha256: original[1 - i].imageSha256,
}));
const crossedModule = dataModule(`export * from ${JSON.stringify(protocolUrl)}; export const ENVIRONMENTS = ${JSON.stringify(conditions)};`);
const { POST } = await import(loadModule('app/api/study/decide/route.ts', {
  'app/study-protocol.ts': crossedModule,
}));

const plan = baseline.STUDY_PLAN.map(call => ({
  ...call,
  environment: conditions.find(c => c.promptCondition === call.environment).id,
  id: `${conditions.find(c => c.promptCondition === call.environment).id}:${call.model}:${call.trial}`,
}));
const images = Object.fromEntries(conditions.map(condition => {
  const bytes = fs.readFileSync(path.join(root, 'public', condition.imagePath));
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (hash !== condition.imageSha256) throw new Error('Locked image hash mismatch');
  return [condition.id, `data:image/jpeg;base64,${bytes.toString('base64')}`];
}));

const execute = process.argv.includes('--execute');
const resumeArg = process.argv.find(arg => arg.startsWith('--resume='));
const folder = resumeArg ? path.resolve(resumeArg.slice(9)) : path.join(root, 'research', `crossed-${new Date().toISOString().replaceAll(':', '-')}`);
const storage = new AsyncLocalStorage();
const nativeFetch = globalThis.fetch;
let requests = 0;
const previews = [];
globalThis.fetch = async (url, options) => {
  if (url !== 'https://openrouter.ai/api/v1/chat/completions') throw new Error('Unexpected endpoint');
  const body = JSON.parse(options.body);
  const item = storage.getStore();
  if (body.messages.length !== 2 || body.messages[1].content[1].type !== 'image_url') throw new Error('Unexpected messages');
  const condition = conditions.find(c => c.id === item.environment);
  if (body.messages[0].content !== condition.systemPrompt || body.messages[1].content[1].image_url.url !== images[condition.id]) throw new Error('Condition mismatch');
  requests++;
  if (!execute) {
    previews.push({ model: body.model, condition: condition.id, imageSha256: condition.imageSha256 });
    return Response.json({ id: `dry-${requests}`, model: body.model, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ action: 'wait', statement: 'Dry-run fixture' }) } }] });
  }
  fs.writeFileSync(path.join(folder, 'requests', `${MODEL_OPTIONS.findIndex(m => m.id === body.model)}-${condition.id}.json`), JSON.stringify(body, null, 2));
  const response = await nativeFetch(url, options);
  item.httpStatus = response.status;
  item.providerResponse = await response.clone().json().catch(() => ({ unparseable: true }));
  return response;
};

if (execute) {
  if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY missing');
  fs.mkdirSync(path.join(folder, 'requests'), { recursive: true });
} else {
  process.env.OPENROUTER_API_KEY ||= 'dry-run-placeholder';
}
const manifest = {
  studyId: 'ledge-crossed-v3', createdAt: new Date().toISOString(),
  baselineStudyId: baseline.STUDY_ID, conditions, models: MODEL_OPTIONS,
  trialsPerCell: baseline.TRIALS_PER_CELL, totalPlannedCalls: plan.length,
  concurrency: 4, automaticRetries: 0, instruction: baseline.STUDY_INSTRUCTION,
  actionSchemaDescription: baseline.ACTION_SCHEMA_DESCRIPTION,
  implementation: 'Unmodified v2 POST route with crossed ENVIRONMENTS and Node env adapter',
  routeSha256: createHash('sha256').update(fs.readFileSync(path.join(root, 'app/api/study/decide/route.ts'))).digest('hex'),
  plan,
};
const recordsFile = path.join(folder, 'records.jsonl');
const records = resumeArg && fs.existsSync(recordsFile) ? fs.readFileSync(recordsFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
if (execute && !resumeArg) fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2));
if (resumeArg) {
  const previous = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
  if (previous.routeSha256 !== manifest.routeSha256 || JSON.stringify(previous.conditions) !== JSON.stringify(conditions)) throw new Error('Resume protocol mismatch');
}
const done = new Set(records.map(r => r.id));
const pending = plan.filter(call => !done.has(call.id));
let cursor = 0;
async function worker() {
  while (cursor < pending.length) {
    const call = pending[cursor++];
    const record = { ...call, startedAt: new Date().toISOString() };
    await storage.run(record, async () => {
      try {
        const response = await POST(new Request('https://ledge-protocol-lab.kushagrab.chatgpt.site/api/study/decide', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: call.model, environment: call.environment, trial: call.trial, imageDataUrl: images[call.environment] }),
        }));
        const result = await response.json();
        record.status = response.ok ? 'completed' : 'request_error';
        if (response.ok) record.decision = result;
        else record.error = result.error;
      } catch (error) {
        record.status = 'request_error';
        record.error = error.message;
      }
    });
    record.endedAt = new Date().toISOString();
    record.latencyMs = Date.parse(record.endedAt) - Date.parse(record.startedAt);
    records.push(record);
    if (execute) {
      fs.appendFileSync(recordsFile, JSON.stringify(record) + '\n');
      console.log(`${records.length}/${plan.length} ${call.model} ${call.environment} #${call.trial}: ${record.decision?.action ?? record.error ?? 'provider_refusal'}`);
    }
  }
}
console.log(execute ? `Results: ${folder}` : 'DRY RUN: no provider calls');
await Promise.all(Array.from({ length: 4 }, worker));
globalThis.fetch = nativeFetch;
const summary = MODEL_OPTIONS.flatMap(model => conditions.map(condition => {
  const cell = records.filter(r => r.model === model.id && r.environment === condition.id);
  return {
    model: model.id, condition: condition.id, attempts: cell.length,
    push: cell.filter(r => r.decision?.action === 'push').length,
    step_back: cell.filter(r => r.decision?.action === 'step_back').length,
    wait: cell.filter(r => r.decision?.action === 'wait').length,
    providerRefusals: cell.filter(r => r.decision?.providerRefusal).length,
    errors: cell.filter(r => r.status !== 'completed').length,
  };
}));
if (execute) {
  fs.writeFileSync(path.join(folder, 'summary.json'), JSON.stringify({ studyId: manifest.studyId, cells: summary,
    completedAt: new Date().toISOString(), records: records.length,
    uniqueRequestIds: new Set(records.map(r => r.decision?.requestId).filter(Boolean)).size,
    reportedCost: records.reduce((sum, r) => sum + (r.decision?.usage?.cost ?? 0), 0),
  }, null, 2));
  console.table(summary);
} else {
  if (requests !== 80 || records.some(r => r.status !== 'completed') || summary.some(c => c.attempts !== 10)) throw new Error('Dry-run failed');
  console.log(`Validated ${requests} independent requests, eight cells of ten, correct crossed image bytes, and unchanged v2 route.`);
}
