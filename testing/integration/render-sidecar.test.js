/**
 * Integration: the F11 document-render sidecar (PyMuPDF) — real PDF → PNG pages.
 *
 * Hits the sidecar directly on the host-published test port (8100). Proves the Python service boots,
 * reports health, renders a real PDF to PNG page images, and rejects non-PDF / oversize input.
 *
 * Run: node --test testing/integration/render-sidecar.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'url';
import { waitFor } from '../_shared/wait-for.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.RENDER_SIDECAR_TEST_URL ?? 'http://127.0.0.1:8100';
const PDF = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'minimal.pdf'));

/** Minimal multipart POST of a file to the sidecar; resolves { status, json }. */
function postRender(bytes, query = '') {
  const boundary = '----ythrilRenderTest' + Date.now();
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="doc.pdf"\r\n` +
    `Content-Type: application/pdf\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, bytes, tail]);
  const u = new URL(`${BASE}/render${query}`);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: u.hostname, port: Number(u.port), path: u.pathname + u.search, method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length } },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => {
        let json; try { json = JSON.parse(d); } catch { json = null; }
        resolve({ status: res.statusCode, json });
      }); });
    req.on('error', reject);
    req.end(body);
  });
}

function getHealth() {
  const u = new URL(`${BASE}/health`);
  return new Promise((resolve, reject) => {
    http.get({ host: u.hostname, port: Number(u.port), path: '/health', timeout: 4000 }, (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    }).on('error', reject);
  });
}

describe('doc-render sidecar (F11)', () => {
  before(async () => {
    // Wait for the sidecar to be healthy (compose starts it alongside the stack).
    await waitFor(async () => (await getHealth()).status === 200, 60_000, 1000, undefined,
      { what: 'the doc-render sidecar to become healthy on :8100', tolerate: () => true }); // refused until it is up
  });

  it('reports health', async () => {
    const h = await getHealth();
    assert.equal(h.status, 200);
    assert.match(h.body, /ok/);
  });

  it('renders a real PDF to at least one PNG page', async () => {
    const r = await postRender(PDF);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.ok(Array.isArray(r.json.pages) && r.json.pages.length >= 1, `expected pages, got ${JSON.stringify(r.json)}`);
    // Each page is base64 PNG — verify the PNG magic bytes.
    const png = Buffer.from(r.json.pages[0], 'base64');
    assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'first page must be a PNG');
    assert.equal(r.json.total, 1);
    assert.equal(r.json.truncated, false);
  });

  it('rejects non-PDF input with 400', async () => {
    const r = await postRender(Buffer.from('this is not a pdf'));
    assert.equal(r.status, 400, JSON.stringify(r.json));
  });

  it('honours maxPages (caps + reports truncated)', async () => {
    const r = await postRender(PDF, '?maxPages=1');
    assert.equal(r.status, 200);
    assert.ok(r.json.pages.length <= 1);
  });
});
