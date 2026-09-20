#!/usr/bin/env node
// Node 22+. No packages, scene renderer, or video tools required.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const protocol = JSON.parse(await fs.readFile(path.join(here, 'protocol.json'), 'utf8'));
const image = await fs.readFile(path.join(here, 'observation.jpg'));
if (createHash('sha256').update(image).digest('hex') !== protocol.observationSha256) throw new Error('The input image does not match the published hash.');
const imageData = image.toString('base64');
const imageURL = `data:image/jpeg;base64,${imageData}`;
const providers = {
  openai: { key: 'OPENAI_API_KEY', url: 'https://api.openai.com/v1/responses' },
  xai: { key: 'XAI_API_KEY', url: 'https://api.x.ai/v1/chat/completions' },
  google: { key: 'GEMINI_API_KEY', url: 'https://generativelanguage.googleapis.com/v1beta/models/' },
  anthropic: { key: 'ANTHROPIC_API_KEY', url: 'https://api.anthropic.com/v1/messages' },
};

export function providerFor(model) {
  if (model.startsWith('gpt-')) return 'openai';
  if (model.startsWith('grok-')) return 'xai';
  if (model.startsWith('gemini-')) return 'google';
  if (model.startsWith('claude-')) return 'anthropic';
  throw new Error('Use a gpt-, grok-, gemini-, or claude- model ID.');
}

function decision(value) {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!protocol.decisionSchema.properties.action.enum.includes(parsed?.action) || typeof parsed.statement !== 'string' || parsed.statement.length > 4000) throw new Error('Invalid structured decision.');
  return { action: parsed.action, statement: parsed.statement, providerRefusal: false };
}
const refusal = statement => ({ action: null, statement: statement || 'Provider refused the request.', providerRefusal: true });
const userText = instruction => `Operator instruction: ${instruction}`;
const claudeMessage = instruction => ({ role: 'user', content: [{ type: 'text', text: userText(instruction) }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageData } }] });

export function apiRequest(provider, model, instruction) {
  const schema = protocol.decisionSchema, system = protocol.systemPrompt, text = userText(instruction);
  if (provider === 'openai') return {
    model, store: false, max_output_tokens: 4096, instructions: system,
    input: [{ role: 'user', content: [{ type: 'input_text', text }, { type: 'input_image', image_url: imageURL, detail: 'high' }] }],
    text: { format: { type: 'json_schema', name: 'robot_decision', strict: true, schema } },
  };
  if (provider === 'xai') return {
    model, max_tokens: 4096, messages: [{ role: 'system', content: system }, { role: 'user', content: [{ type: 'text', text }, { type: 'image_url', image_url: { url: imageURL, detail: 'high' } }] }],
    response_format: { type: 'json_schema', json_schema: { name: 'robot_decision', strict: true, schema } },
  };
  if (provider === 'anthropic') return { model, max_tokens: 4096, system, messages: [claudeMessage(instruction)], output_config: { format: { type: 'json_schema', schema } } };
  return { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text }, { inlineData: { mimeType: 'image/jpeg', data: imageData } }] }], generationConfig: { maxOutputTokens: 4096, responseMimeType: 'application/json', responseJsonSchema: schema } };
}

export function apiDecision(provider, data) {
  if (provider === 'openai') {
    const parts = (data.output || []).flatMap(o => o.content || []), blocked = parts.find(p => p.type === 'refusal');
    if (blocked) return refusal(blocked.refusal);
    if (data.status !== 'completed') throw new Error('Incomplete response.');
    return decision(parts.filter(p => p.type === 'output_text').map(p => p.text).join(''));
  }
  if (provider === 'xai') {
    const c = data.choices?.[0];
    if (c?.message?.refusal || c?.finish_reason === 'content_filter') return refusal(c?.message?.refusal);
    if (c?.finish_reason !== 'stop') throw new Error('Incomplete response.');
    return decision(c.message.content);
  }
  if (provider === 'anthropic') {
    const text = (data.content || []).filter(p => p.type === 'text').map(p => p.text).join('');
    if (data.stop_reason === 'refusal') return refusal(text);
    if (data.stop_reason !== 'end_turn') throw new Error('Incomplete response.');
    return decision(text);
  }
  const c = data.candidates?.[0];
  if (data.promptFeedback?.blockReason || ['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT'].includes(c?.finishReason)) return refusal('Provider safety block.');
  if (c?.finishReason !== 'STOP') throw new Error('Incomplete response.');
  return decision((c.content?.parts || []).filter(p => !p.thought && typeof p.text === 'string').map(p => p.text).join(''));
}

async function callAPI(provider, model, instruction) {
  const config = providers[provider], key = process.env[config.key];
  if (!key) throw new Error(`Set ${config.key} in your process environment.`);
  const headers = { 'Content-Type': 'application/json' };
  if (provider === 'anthropic') { headers['x-api-key'] = key; headers['anthropic-version'] = '2023-06-01'; }
  else if (provider === 'google') headers['x-goog-api-key'] = key;
  else headers.Authorization = `Bearer ${key}`;
  const url = provider === 'google' ? `${config.url}${encodeURIComponent(model)}:generateContent` : config.url;
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(apiRequest(provider, model, instruction)), signal: AbortSignal.timeout(120_000) });
  // Provider error bodies can contain account data. Do not print or persist them.
  if (!response.ok) return { status: 'api_error', httpStatus: response.status };
  const data = await response.json();
  return { status: 'completed', model: data.model || data.modelVersion || model, decision: apiDecision(provider, data) };
}

async function subscriptionClient() {
  const executable = process.env.CLAUDE_CLI_PATH || 'claude', env = { ...process.env };
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) delete env[key];
  try {
    const auth = JSON.parse((await execute(executable, ['auth', 'status', '--json'], { env, timeout: 15_000 })).stdout);
    if (!auth.loggedIn || auth.authMethod !== 'claude.ai' || !auth.subscriptionType) throw new Error();
    const version = (await execute(executable, ['--version'], { env, timeout: 15_000 })).stdout.trim();
    return { executable, env, version };
  } catch { throw new Error('Sign in to your Claude subscription with the official Claude CLI. No API fallback is used.'); }
}

async function callSubscription(client, model, instruction) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'misalignment-001-'));
  try {
    const args = ['--print', '--safe-mode', '--model', model, '--system-prompt', protocol.systemPrompt, '--tools', '', '--disable-slash-commands', '--strict-mcp-config', '--no-session-persistence', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--json-schema', JSON.stringify(protocol.decisionSchema), '--max-turns', '3'];
    const raw = await new Promise(resolve => {
      const child = spawn(client.executable, args, { cwd, env: client.env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', timedOut = false, forceTimer;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); forceTimer = setTimeout(() => child.kill('SIGKILL'), 3000); }, 120_000);
      const finish = code => { clearTimeout(timer); clearTimeout(forceTimer); resolve({ stdout, code, timedOut }); };
      child.stdout.on('data', data => { stdout += data; if (stdout.length > 8_000_000) child.kill('SIGTERM'); });
      child.stderr.resume(); child.on('error', () => finish(null)); child.on('close', finish); child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify({ type: 'user', message: claudeMessage(instruction) }) + '\n');
    });
    const events = raw.stdout.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const result = events.findLast(e => e.type === 'result'), init = events.find(e => e.type === 'system' && e.subtype === 'init');
    if (raw.timedOut || raw.code !== 0 || !result || result.is_error || (init?.apiKeySource && init.apiKeySource !== 'none')) return { status: 'client_error' };
    return { status: 'completed', model: init?.model || model, decision: decision(result.structured_output || result.result) };
  } finally { await fs.rm(cwd, { recursive: true, force: true }); }
}

export async function main(argv = process.argv.slice(2)) {
  let model, access, check = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') check = true;
    else if (argv[i] === '--model') model = argv[++i];
    else if (argv[i] === '--access') access = argv[++i];
    else throw new Error('Usage: node experiments/001/replicate.mjs --check | --model MODEL [--access api|subscription]');
  }
  if (check) { console.log(JSON.stringify({ imageHashVerified: true, protocol: protocol.protocol, calls: protocol.conditions.reduce((sum, c) => sum + c.repetitions, 0), conditions: protocol.conditions }, null, 2)); return; }
  if (!model || !/^[a-zA-Z0-9._:-]{1,100}$/.test(model)) throw new Error('Supply a valid --model ID.');
  const provider = providerFor(model); access ||= provider === 'anthropic' ? 'subscription' : 'api';
  if (!['api', 'subscription'].includes(access) || (access === 'subscription' && provider !== 'anthropic')) throw new Error('Subscription access is available only for Claude.');
  const client = access === 'subscription' ? await subscriptionClient() : null;
  if (access === 'api' && !process.env[providers[provider].key]) throw new Error(`Set ${providers[provider].key} in your process environment.`);
  const output = path.join(here, 'outputs', `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.json`);
  const report = { experiment: '001', protocol: protocol.protocol, requestedModel: model, provider, access: client ? 'claude-code-subscription' : 'native-api', clientVersion: client?.version, observationSha256: protocol.observationSha256, runs: [] };
  await fs.mkdir(path.dirname(output), { recursive: true });
  for (const condition of protocol.conditions) for (let repetition = 1; repetition <= condition.repetitions; repetition++) {
    const startedAt = new Date().toISOString(); let result;
    try { result = client ? await callSubscription(client, model, condition.instruction) : await callAPI(provider, model, condition.instruction); }
    catch { result = { status: 'request_error', error: 'Request failed or returned an invalid/incomplete decision. Raw errors are not saved.' }; }
    report.runs.push({ condition: condition.id, instruction: condition.instruction, repetition, startedAt, endedAt: new Date().toISOString(), ...result });
    await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    console.log(`${condition.id} ${repetition}: ${result.decision?.providerRefusal ? 'provider refusal' : result.decision?.action || result.status}`);
    if (result.status !== 'completed') { console.log(`Stopped; partial results: ${output}`); process.exitCode = 1; return; }
  }
  console.log(`Saved all five decisions: ${output}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
