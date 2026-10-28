#!/usr/bin/env node
/**
 * Pull one documented example from the visual enhancer and leave behind a pair you can inspect:
 * input, output, their SHA-256 hashes, and a local compare page.
 *
 * This talks to the public catalog endpoint, which serves a cached run to guests. It spends no
 * credits, needs no account, and sends no image of yours anywhere. Uploading your own picture is a
 * different, signed-in flow on the site, not something this script does.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const BASE = 'https://www.dlss5nvidia.com';
const SAMPLES = ['sample1', 'sample2', 'characterStyle'];

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`usage: node bin/enhance-example.mjs [--sample ${SAMPLES.join('|')}] [--out ./out] [--base ${BASE}]`);
  process.exit(0);
}
const sample = arg('sample', 'sample1');
const out = resolve(arg('out', './out'));
const base = arg('base', BASE).replace(/\/$/, '');

if (!SAMPLES.includes(sample)) {
  console.error(`unknown sample "${sample}". Known: ${SAMPLES.join(', ')}`);
  process.exit(2);
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MiB`;
const ms = (t) => `${t} ms`;

async function get(path, init) {
  const started = Date.now();
  const res = await fetch(base + path, init);
  const body = Buffer.from(await res.arrayBuffer());
  if (!res.ok) throw new Error(`${init?.method || 'GET'} ${path} → HTTP ${res.status}: ${body.subarray(0, 200).toString()}`);
  return { res, body, elapsed: Date.now() - started };
}

async function main() {
  await mkdir(out, { recursive: true });
  console.log(`sample: ${sample}\nhost:   ${base}\n`);

  const run = await get('/api/image-edit/samples', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sample }),
  });
  const record = JSON.parse(run.body.toString());
  if (record.status !== 'SUCCEEDED') throw new Error(`example status is ${record.status}, not SUCCEEDED`);
  console.log(`catalog: ${ms(run.elapsed)} · cached=${record.cached}`);

  const input = await get(record.input);
  const output = await get(record.result);
  for (const [label, part] of [['input', input], ['output', output]]) {
    const type = part.res.headers.get('content-type') || '';
    if (!type.startsWith('image/')) throw new Error(`${label} came back as ${type || 'no content-type'}, not an image`);
  }

  const ext = record.extension || 'webp';
  const files = [
    { name: `input.${(record.input.split('.').pop() || 'jpg').toLowerCase()}`, part: input },
    { name: `output.${ext}`, part: output },
  ];
  for (const file of files) {
    const path = join(out, file.name);
    await writeFile(path, file.part.body);
    const hash = sha256(file.part.body);
    file.hash = hash;
    file.bytes = file.part.body.length;
    console.log(`${file.name.padEnd(12)} ${mb(file.bytes).padStart(9)}  ${ms(file.part.elapsed).padStart(7)}  sha256:${hash.slice(0, 16)}…`);
  }

  const [inputFile, outputFile] = files;
  const html = `<!doctype html><meta charset="utf-8"><title>${sample} — input / output</title>
<style>
 :root{color-scheme:dark}
 body{margin:0;background:#0b0b0b;color:#e5e5e5;font:14px/1.5 ui-sans-serif,system-ui,sans-serif}
 main{max-width:1100px;margin:0 auto;padding:32px 20px 64px}
 h1{font-size:18px;margin:0 0 4px}
 p.note{color:#a3a3a3;margin:0 0 24px}
 .frame{position:relative;border-radius:12px;overflow:hidden;border:1px solid #262626}
 .frame img{display:block;width:100%}
 .clip{position:absolute;inset:0} /* both images sit on the same box; the slider only clips this one */
 input[type=range]{width:100%;margin:16px 0 8px}
 .legend{display:flex;justify-content:space-between;color:#a3a3a3;font-size:12px}
 dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;margin:24px 0 0;font-size:12px}
 dt{color:#a3a3a3}dd{margin:0;font-family:ui-monospace,monospace;word-break:break-all}
</style>
<main>
 <h1>${sample}</h1>
 <p class="note">Same cached example the site serves to guests. Left is the input, right is the model output — not a benchmark, not NVIDIA.</p>
 <div class="frame">
   <img src="${outputFile.name}" alt="model output">
   <div class="clip" id="clip"><img src="${inputFile.name}" alt="input"></div>
 </div>
 <input id="slider" type="range" min="0" max="100" value="50" aria-label="reveal input or output">
 <div class="legend"><span>input</span><span>output</span></div>
 <dl>
  <dt>prompt</dt><dd>${record.prompt.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</dd>
  <dt>input sha256</dt><dd>${inputFile.hash}</dd>
  <dt>output sha256</dt><dd>${outputFile.hash}</dd>
  <dt>input bytes</dt><dd>${inputFile.bytes}</dd>
  <dt>output bytes</dt><dd>${outputFile.bytes}</dd>
  <dt>cached</dt><dd>${record.cached}</dd>
 </dl>
</main>
<script>
 const clip = document.getElementById('clip');
 const slider = document.getElementById('slider');
 const apply = () => { clip.style.clipPath = 'inset(0 ' + (100 - slider.value) + '% 0 0)'; };
 slider.addEventListener('input', apply); apply();
</script>`;
  await writeFile(join(out, 'compare.html'), html);

  console.log(`\nwrote ${out}`);
  console.log(`open  ${join(out, 'compare.html')}`);
}

main().catch((error) => {
  console.error(`failed: ${error.message}`);
  process.exit(1);
});
