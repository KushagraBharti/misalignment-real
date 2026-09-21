import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const folder = path.resolve(process.argv[2]);
const summary = JSON.parse(fs.readFileSync(path.join(folder, 'summary.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
const baseline = JSON.parse(fs.readFileSync(path.join(root, 'social/results-v2-summary.json'), 'utf8'));
const records = fs.readFileSync(path.join(folder, 'records.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const label = model => model.label.split(' · ')[1];
const denominator = cell => cell.attempts - cell.errors;
const cellFor = (model, condition) => summary.cells.find(c => c.model === model.id && c.condition === condition);
let markdown = '# Crossed framing study — v3\n\n';
markdown += `Completed ${summary.completedAt}. ${summary.records} attempts; ${summary.uniqueRequestIds} unique successful request IDs. OpenRouter reported cost: $${summary.reportedCost.toFixed(6)}.\n\n`;
markdown += 'Each request reused the v2 route, changing only the association between system prompt and locked image. Ten fresh calls per model/condition; concurrency four; no automatic retries. Photorealistic imagery was generated. No physical robot was involved.\n\n';
markdown += '| Model | Prompt | Image | Push | Step back | Wait | Provider refusal | Errors |\n|---|---|---|---:|---:|---:|---:|---:|\n';
for (const model of manifest.models) for (const condition of manifest.conditions) {
  const c = cellFor(model, condition.id);
  markdown += `| ${label(model)} | ${condition.promptCondition} | ${condition.imageCondition === 'real' ? 'Photorealistic' : 'Rendered'} | ${c.push} | ${c.step_back} | ${c.wait} | ${c.providerRefusals} | ${c.errors} |\n`;
}
markdown += '\n## All four combinations: observed push counts\n\nThe matched conditions below are the previous v2 run, collected September 20; the crossed conditions are this new run. This combines runs from different days, rather than a contemporaneous randomized factorial experiment.\n\n';
markdown += '| Model | Sim prompt + render (v2) | Sim prompt + photo (v3) | Real prompt + render (v3) | Real prompt + photo (v2) |\n|---|---:|---:|---:|---:|\n';
const headers = ['SIM + RENDER', 'SIM + PHOTO', 'REAL + RENDER', 'REAL + PHOTO'];
const notes = ['prior v2', 'new v3', 'new v3', 'prior v2'];
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900"><rect width="1600" height="900" fill="#0a1013"/><g font-family="Arial, Helvetica, sans-serif" fill="#f4f7fa">`;
const text = (x,y,t,size=22,color='#f4f7fa') => `<text x="${x}" y="${y}" font-size="${size}" fill="${color}">${esc(t)}</text>`;
svg += text(60,70,'WHEN THE PROMPT AND IMAGE DISAGREE',40);
svg += text(60,112,'Selected push / valid responses · 10 independent calls per cell',24,'#a9b7c4');
headers.forEach((h,i) => {svg += text(510+i*260,180,h,21);svg += text(510+i*260,210,notes[i],18,'#a9b7c4');});
manifest.models.forEach((model,i) => {
  const prior = baseline.results[i];
  const simPhoto = cellFor(model, 'sim_prompt_photo');
  const realRender = cellFor(model, 'real_prompt_render');
  const counts = [[prior.simulated.push,10],[simPhoto.push,denominator(simPhoto)],[realRender.push,denominator(realRender)],[prior.real.push,10]];
  markdown += `| ${label(model)} | ${counts.map(([n,d]) => `${n}/${d}`).join(' | ')} |\n`;
  const y = 255+i*123;
  svg += text(60,y+53,label(model),28);
  counts.forEach(([n,d],j) => {
    const x=500+j*260;
    svg += `<rect x="${x}" y="${y}" width="230" height="96" rx="12" fill="${n ? '#284633' : '#17212a'}"/>`;
    svg += text(x+68,y+60,`${n}/${d}`,40,n ? '#d7ff3f' : '#f4f7fa');
  });
});
svg += text(60,800,'SIM / REAL = system wording. PHOTO = generated photorealistic image.',22,'#a9b7c4');
svg += text(60,837,'v2: September 20 · v3: September 21 · Different-day runs; provider defaults retained.',22,'#a9b7c4');
svg += '</g></svg>';
fs.writeFileSync(path.join(folder,'push-matrix.svg'),svg);
markdown += '\n## Exact inputs and evidence\n\n- `manifest.json`: fixed plan, complete prompts, model IDs, image hashes and route-source hash.\n- `requests/`: eight actual request bodies, including JPEG bytes (one per model/condition; repeated ten times). No credentials.\n- `records.jsonl`: every attempt with provider response, public statement, usage, timestamps, errors and request ID.\n- `summary.json`: aggregate counts and reported cost.\n- `push-matrix.svg`: comparison with the previous run.\n\nVerbal refusal can accompany a valid `wait` or `step_back` action. The provider-refusal column counts only the API refusal field. Errors are excluded from push-rate denominators. Ten observations per cell describe this run; they do not establish a universal response rate.\n';
fs.writeFileSync(path.join(folder,'REPORT.md'),markdown);
const header=['model','condition','trial','status','action','provider_refusal','statement','request_id','latency_ms'];
const csvValue=value=>'"'+String(value??'').replaceAll('"','""')+'"';
const csv=[header,...records.map(r=>[r.model,r.environment,r.trial,r.status,r.decision?.action,r.decision?.providerRefusal,r.decision?.statement,r.decision?.requestId,r.latencyMs])].map(row=>row.map(csvValue).join(',')).join('\n');
fs.writeFileSync(path.join(folder,'trials.csv'),csv+'\n');
console.log(markdown);
