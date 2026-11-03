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

/**
 * A tiny PDF whose single page is `w` x `h` points. The file is a few hundred bytes whatever the page size, so a
 * request costs nothing to send and a great deal to render: pdfium allocates `w * h * scale^2` pixels for it, which
 * is what `RENDER_MAX_PIXELS` bounds (Q-611). pdfium rebuilds the cross-reference table itself, as for `minimal.pdf`.
 */
function pdfOfPageSize(w, h) {
  return Buffer.from(
    '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << >> /Contents 4 0 R >>\nendobj\n` +
    '4 0 obj\n<< /Length 40 >>\nstream\n1 0 0 RG 10 10 180 180 re S\nendstream\nendobj\n' +
    'trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n0\n%%EOF\n');
}

/** Width and height of a PNG, from its IHDR. */
function pngSize(b64) {
  const png = Buffer.from(b64, 'base64');
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'a PNG');
  return { w: png.readUInt32BE(16), h: png.readUInt32BE(20) };
}

describe('doc-render sidecar: a page cannot ask for more pixels than RENDER_MAX_PIXELS (Q-611)', () => {
  // The default cap is 40 MP: A4 at 600 dpi (34.8 MP) fits, a 3000 pt poster at 600 dpi (625 MP) does not.
  const DEFAULT_MAX_PIXELS = 40_000_000;
  let capPixels = DEFAULT_MAX_PIXELS;

  before(async () => {
    await waitFor(async () => (await getHealth()).status === 200, 60_000, 1000, undefined,
      { what: 'the doc-render sidecar to become healthy on :8100', tolerate: () => true });
    // The health answer reports the caps the running sidecar enforces (an operator reads them there); a stack
    // started with another RENDER_MAX_PIXELS is measured against its own.
    const h = JSON.parse((await getHealth()).body);
    const key = Object.keys(h).find(k => /pixel/i.test(k));
    assert.ok(key && Number(h[key]) > 0, `the health answer names its pixel cap, got ${JSON.stringify(h)}`);
    capPixels = Number(h[key]);
    const bytesKey = Object.keys(h).find(k => /response/i.test(k) && /byte/i.test(k));
    assert.ok(bytesKey && Number(h[bytesKey]) > 0, `the health answer names its response-bytes cap, got ${JSON.stringify(h)}`);
  });

  it('a page that fits at the requested dpi is rendered at exactly that dpi', async () => {
    const r = await postRender(pdfOfPageSize(595, 842), '?dpi=150');   // A4
    assert.equal(r.status, 200, JSON.stringify(r.json)?.slice(0, 300));
    assert.deepEqual(r.json.dpiUsed, [150], 'an unclamped page reports the dpi it was asked for');
    const { w, h } = pngSize(r.json.pages[0]);
    assert.ok(Math.abs(w - 595 * 150 / 72) <= 2 && Math.abs(h - 842 * 150 / 72) <= 2, `A4 at 150 dpi is about 1240x1754 px, got ${w}x${h}`);
  });

  it('a huge page is clamped to a lower dpi, reported per page, and rendered within the cap', async () => {
    // 3000 x 3000 pt at 600 dpi would be 25000 x 25000 px. Clamped it is 3000 x 3000 pt at about 151 dpi.
    const r = await postRender(pdfOfPageSize(3000, 3000), '?dpi=600');
    assert.equal(r.status, 200, `a big page is clamped, not refused: ${JSON.stringify(r.json)?.slice(0, 300)}`);
    assert.equal(r.json.pages.length, 1);
    assert.ok(Array.isArray(r.json.dpiUsed) && r.json.dpiUsed.length === 1, `dpiUsed per page, got ${JSON.stringify(r.json.dpiUsed)}`);
    assert.ok(r.json.dpiUsed[0] < 600 && r.json.dpiUsed[0] >= 72, `dpiUsed ${r.json.dpiUsed[0]} must be lowered, and not below the 72 dpi floor`);
    const { w, h } = pngSize(r.json.pages[0]);
    assert.ok(w * h <= capPixels, `${w}x${h} = ${w * h} px passes the cap of ${capPixels}`);
  });

  it('a page that would need less than the 72 dpi floor is skipped with a reason, and the sidecar stays up', async () => {
    // 14400 x 14400 pt is 207 MP at 72 dpi: no dpi at or above the floor fits it under 40 MP.
    const r = await postRender(pdfOfPageSize(14400, 14400), '?dpi=72');
    assert.equal(r.status, 200, `a skipped page is an entry, not a failed request: ${JSON.stringify(r.json)?.slice(0, 300)}`);
    assert.equal(r.json.pages.length, 0);
    assert.ok(Array.isArray(r.json.skipped) && r.json.skipped.length === 1, `skipped, got ${JSON.stringify(r.json.skipped)}`);
    assert.equal(r.json.skipped[0].page, 0);
    assert.ok(typeof r.json.skipped[0].reason === 'string' && r.json.skipped[0].reason.length > 0, 'the skip says why');
    const h = await getHealth();
    assert.equal(h.status, 200, 'the sidecar is still answering after being shown the page');
  });
});
