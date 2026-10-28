import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'enhance-example.mjs');
const IN_BYTES = Buffer.from('fake-jpeg-input');
const OUT_BYTES = Buffer.from('fake-webp-output');

/** A stand-in for the site's catalog endpoint: it answers like the real one and nothing more. */
async function serve({ resultType = 'image/webp' } = {}) {
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/image-edit/samples') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'SUCCEEDED', sample: 'sample1', prompt: 'keep the layout', input: '/img/in.jpg', result: '/api/res', extension: 'webp', cached: true }));
      });
      return;
    }
    if (req.url === '/img/in.jpg') { res.writeHead(200, { 'content-type': 'image/jpeg' }); res.end(IN_BYTES); return; }
    if (req.url === '/api/res') { res.writeHead(200, { 'content-type': resultType }); res.end(OUT_BYTES); return; }
    res.writeHead(404); res.end('nope');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

const run = (args) => new Promise((resolve) => {
  execFile(process.execPath, [BIN, ...args], (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
});

test('writes the pair, the hashes and a compare page from the catalog', async () => {
  const { base, close } = await serve();
  const out = await mkdtemp(join(tmpdir(), 'd5ve-'));
  try {
    const res = await run(['--sample', 'sample1', '--out', out, '--base', base]);
    assert.equal(res.code, 0, res.stderr);
    const files = await readdir(out);
    assert.deepEqual(files.sort(), ['compare.html', 'input.jpg', 'output.webp']);
    const input = await readFile(join(out, 'input.jpg'));
    const output = await readFile(join(out, 'output.webp'));
    assert.deepEqual(input, IN_BYTES);
    assert.deepEqual(output, OUT_BYTES);
    const page = await readFile(join(out, 'compare.html'), 'utf8');
    assert.match(page, /input\.jpg/);
    assert.match(page, /output\.webp/);
    assert.ok(page.includes(createHash('sha256').update(input).digest('hex')), 'input hash is on the page');
    assert.ok(page.includes(createHash('sha256').update(output).digest('hex')), 'output hash is on the page');
    assert.match(res.stdout, /cached=true/);
  } finally { await close(); }
});

test('refuses a result that is not an image', async () => {
  const { base, close } = await serve({ resultType: 'text/html; charset=utf-8' });
  const out = await mkdtemp(join(tmpdir(), 'd5ve-'));
  try {
    const res = await run(['--sample', 'sample1', '--out', out, '--base', base]);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /not an image/);
  } finally { await close(); }
});

test('rejects an unknown sample before calling anything', async () => {
  const res = await run(['--sample', 'nonexistent', '--out', join(tmpdir(), 'd5ve-x')]);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /unknown sample/);
});
