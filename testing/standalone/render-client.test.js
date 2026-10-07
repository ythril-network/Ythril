/**
 * F11 — render sidecar client (`files/converters/renderer.ts`), tested against mock HTTP sidecars so no
 * Docker/PDF/LibreOffice is needed. Covers the availability probes (+ caching), page decode, error paths,
 * and — F11-a — format routing: PDFs go to `doc-render`, office docs go to `doc-office`.
 *
 * Run: node --test testing/standalone/render-client.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { listenOnLoopback } from '../_shared/local-server.mjs';

// ── Two mock sidecars (PDF render + office render) ───────────────────────────
function mockSidecar(state) {
  return http.createServer((req, res) => {
    const url = req.url ?? '';
    if (url.startsWith('/health')) {
      res.writeHead(state.health, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: state.health === 200 ? 'ok' : 'bad' }));
      return;
    }
    if (url.startsWith('/render') && req.method === 'POST') {
      state.lastUrl = url;   // so a test can assert the window that was actually requested
      req.on('data', () => {}); // drain the multipart body
      req.on('end', () => {
        res.writeHead(state.status, { 'content-type': 'application/json' });
        res.end(state.body ?? JSON.stringify({
          // Tag the page content so the test can assert WHICH sidecar answered.
          pages: [Buffer.from(`PNG-${state.tag}-A`).toString('base64'), Buffer.from(`PNG-${state.tag}-B`).toString('base64')],
          count: 2, total: 3, truncated: true, dpi: 150,
        }));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
}
const renderState = { health: 200, status: 200, body: null, tag: 'RENDER' };
const officeState = { health: 200, status: 200, body: null, tag: 'OFFICE' };
const renderSrv = await listenOnLoopback(mockSidecar(renderState));
const officeSrv = await listenOnLoopback(mockSidecar(officeState));
process.env.RENDER_SIDECAR_URL = renderSrv.url;
process.env.RENDER_OFFICE_SIDECAR_URL = officeSrv.url;

const R = await import('../../server/dist/files/converters/renderer.js');

describe('render client — format detection', () => {
  it('classifies office documents vs PDFs by extension', () => {
    for (const f of ['a.docx', 'b.DOCX', 'c.epub', 'd.pptx', 'e.odt', 'f.rtf', 'g.xlsx']) {
      assert.equal(R.isOfficeDocument(f), true, f);
    }
    for (const f of ['a.pdf', 'b.PDF', 'c.png', 'noext']) {
      assert.equal(R.isOfficeDocument(f), false, f);
    }
  });
});

describe('render client — availability probes', () => {
  it('isRenderAvailable() reflects the PDF sidecar /health (and caches)', async () => {
    R._resetRenderHealthCache(); renderState.health = 200;
    assert.equal(await R.isRenderAvailable(), true);
    renderState.health = 500; // cache holds within TTL
    assert.equal(await R.isRenderAvailable(), true);
    R._resetRenderHealthCache();
    assert.equal(await R.isRenderAvailable(), false);
    renderState.health = 200;
  });

  it('isOfficeRenderAvailable() reflects the office sidecar /health', async () => {
    R._resetRenderHealthCache(); officeState.health = 200;
    assert.equal(await R.isOfficeRenderAvailable(), true);
    R._resetRenderHealthCache(); officeState.health = 503;
    assert.equal(await R.isOfficeRenderAvailable(), false);
    officeState.health = 200;
  });

  it('isRenderAvailableFor() picks the office probe for office docs, the PDF probe otherwise', async () => {
    R._resetRenderHealthCache(); renderState.health = 200; officeState.health = 500;
    assert.equal(await R.isRenderAvailableFor('report.pdf'), true);   // PDF sidecar up
    R._resetRenderHealthCache();
    assert.equal(await R.isRenderAvailableFor('report.docx'), false); // office sidecar down
    officeState.health = 200;
  });
});

describe('render client — page windows', () => {
  // A long document used to become its first `maxPages` pages, permanently. The sidecars now take a
  // `startPage` so the caller can walk the document in windows; these pin the request the client builds,
  // because a dropped or mis-typed parameter degrades silently back to "always page 0" — the exact bug
  // being fixed, and one where every page still renders and nothing errors.
  it('asks for page 0 by default, so an un-windowed call is unchanged', async () => {
    renderState.lastUrl = '';
    await R.renderDocumentPages(Buffer.from('%PDF'), { fileName: 'x.pdf', maxPages: 2 });
    assert.match(renderState.lastUrl, /startPage=0/);
  });

  it('passes the requested window through to the sidecar', async () => {
    renderState.lastUrl = '';
    await R.renderDocumentPages(Buffer.from('%PDF'), { fileName: 'x.pdf', maxPages: 50, startPage: 150 });
    assert.match(renderState.lastUrl, /maxPages=50/);
    assert.match(renderState.lastUrl, /startPage=150/);
  });

  it('never sends a negative or fractional startPage', async () => {
    // These would be a 422 from the sidecar's `ge=0` int query, turning a caller bug into a failed
    // extraction rather than a clamped one.
    renderState.lastUrl = '';
    await R.renderDocumentPages(Buffer.from('%PDF'), { fileName: 'x.pdf', startPage: -5 });
    assert.match(renderState.lastUrl, /startPage=0/);
    renderState.lastUrl = '';
    await R.renderDocumentPages(Buffer.from('%PDF'), { fileName: 'x.pdf', startPage: 12.7 });
    assert.match(renderState.lastUrl, /startPage=12(&|$)/);
  });

  it('reports the window offset back, falling back to what was asked', async () => {
    // An older sidecar that does not echo `startPage` still windows correctly; the client must not then
    // report 0 and make a caller think it was handed the start of the document.
    renderState.body = JSON.stringify({ pages: [], count: 0, total: 300, truncated: true, dpi: 150 });
    const r = await R.renderDocumentPages(Buffer.from('%PDF'), { fileName: 'x.pdf', startPage: 100 });
    assert.equal(r.startPage, 100);
    renderState.body = null;
  });

  it('windows office documents too, not just PDFs', async () => {
    // Segmenting only PDFs would leave long .docx/.odt silently truncated — the same bug, half-fixed.
    officeState.lastUrl = '';
    await R.renderDocumentPages(Buffer.from('PK'), { fileName: 'report.docx', maxPages: 25, startPage: 25 });
    assert.match(officeState.lastUrl, /startPage=25/);
    assert.match(officeState.lastUrl, /maxPages=25/);
  });
});

describe('render client — renderDocumentPages routing + decode', () => {
  it('routes a PDF to the doc-render sidecar and decodes pages/total/truncated', async () => {
    const r = await R.renderDocumentPages(Buffer.from('%PDF-fake'), { fileName: 'x.pdf', maxPages: 2 });
    assert.equal(r.pages.length, 2);
    assert.equal(r.pages[0].toString(), 'PNG-RENDER-A'); // answered by the PDF sidecar
    assert.equal(r.total, 3);
    assert.equal(r.truncated, true);
  });

  it('routes an office doc to the doc-office sidecar', async () => {
    const r = await R.renderDocumentPages(Buffer.from('PK-docx'), { fileName: 'report.docx' });
    assert.equal(r.pages[0].toString(), 'PNG-OFFICE-A'); // answered by the office sidecar
  });

  it('throws on a sidecar error status (→ caller falls back to OCR)', async () => {
    officeState.status = 422; officeState.body = JSON.stringify({ detail: 'office->pdf conversion failed' });
    await assert.rejects(() => R.renderDocumentPages(Buffer.from('x'), { fileName: 'x.docx' }), /doc-office sidecar error 422/);
    officeState.status = 200; officeState.body = null;
  });

  it('throws when the target sidecar is unreachable', async () => {
    await officeSrv.close();
    await assert.rejects(() => R.renderDocumentPages(Buffer.from('x'), { fileName: 'x.docx' }), /doc-office sidecar unreachable/);
    await renderSrv.close();
  });
});
