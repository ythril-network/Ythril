/**
 * F11-a — the OPTIONAL `doc-office` sidecar (LibreOffice → PDF → PNG for office docs).
 *
 * It is heavy (LibreOffice) and opt-in (compose `office` profile), so this suite **skips** unless the
 * sidecar is reachable — it does not force LibreOffice into every CI run. To exercise it locally:
 *
 *   docker build -t ythril-doc-office:0.2.0 ./sidecars/doc-office
 *   docker run -d --read-only --tmpfs /tmp:size=512m -p 8101:8100 ythril-doc-office:0.2.0
 *   node --test testing/integration/doc-office-sidecar.test.js
 *
 * Run: node --test testing/integration/doc-office-sidecar.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.RENDER_OFFICE_SIDECAR_TEST_URL ?? 'http://127.0.0.1:8101';
const DOCX = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'minimal.docx'));

function postRender(bytes, filename = 'doc.docx', query = '') {
  const boundary = '----ythrilOfficeTest' + Date.now();
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n`);
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

let available = false;
before(async () => {
  available = await new Promise((resolve) => {
    const u = new URL(`${BASE}/health`);
    const req = http.get({ host: u.hostname, port: Number(u.port), path: '/health', timeout: 3000 },
      (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
  if (!available) console.log('doc-office sidecar not reachable at', BASE, '— skipping (opt-in / heavy).');
});

describe('doc-office sidecar (F11-a)', () => {
  it('renders a DOCX to at least one PNG page', async (t) => {
    if (!available) return t.skip('sidecar unavailable');
    const { status, json } = await postRender(DOCX, 'minimal.docx', '?dpi=100&maxPages=5');
    assert.equal(status, 200);
    assert.ok(Array.isArray(json.pages) && json.pages.length >= 1, 'expected >=1 page');
    const png = Buffer.from(json.pages[0], 'base64');
    assert.deepEqual(png.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'PNG magic');
    assert.equal(json.total, json.count); // small doc, not truncated
  });

  it('rejects an empty upload with 400', async (t) => {
    if (!available) return t.skip('sidecar unavailable');
    const { status } = await postRender(Buffer.alloc(0), 'empty.docx');
    assert.equal(status, 400);
  });
});
