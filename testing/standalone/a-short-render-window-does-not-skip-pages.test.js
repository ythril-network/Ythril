/**
 * The VLM extraction walks a document by the pages a window RETURNED, not by the pages it asked for (Q-611).
 *
 * ## The defect this pins
 *
 * `files/converters/vlm-extract.ts` walks a long document in windows: `for (startPage = 0; ...; startPage += windowSize)`.
 * That step is the number of pages it ASKED for. Q-611 lets a render sidecar end a window early — a response whose
 * encoded pages would pass `RENDER_MAX_RESPONSE_BYTES` stops, answers the pages it holds, and says `truncated: true`.
 * A caller that still steps by `windowSize` then asks for page 5 when the sidecar stopped after page 2, and pages 2-4
 * are never read: no error, `truncated` was honest, the extraction is accepted and recall answers from a document with
 * holes in it. The same stepping also makes the "an empty LATER window just means the end" branch read a hole as the
 * end.
 *
 * ## The rule
 *
 * Whatever the window size, the next window starts where the last one ended: `startPage` of window n+1 is `startPage`
 * of window n plus the number of pages window n returned. Every page of the document is transcribed exactly once, in
 * order, however the sidecar chops the windows.
 *
 * ## How it is driven
 *
 * The built `vlmExtractDocument` itself, against a mock render sidecar (the module's own HTTP client talks to it, so
 * `renderDocumentPages` is exactly the client the product ships) and a mock Ollama-wire VLM that echoes the page it
 * was shown. The mock sidecar plays a short sidecar: it never returns more than `PER_WINDOW` pages, whatever
 * `maxPages` asked for, and says `truncated` while pages remain. No Docker, no PDF, no model.
 *
 * Run: node --test testing/standalone/a-short-render-window-does-not-skip-pages.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { listenOnLoopback } from '../_shared/local-server.mjs';

const TOTAL = 12;        // pages in the pretend document
const WINDOW = 5;        // documentProcessing.maxPages: what the caller asks for each time
const PER_WINDOW = 2;    // what the pretend sidecar actually answers (a byte bound ended each window early)

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-short-window-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');

/** Every render request the client made, in order: the window it asked for. */
const asked = [];
/** The page tags the pretend VLM was shown, in the order it was shown them. */
const transcribed = [];

const renderSrv = await listenOnLoopback(http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"status":"ok"}'); return;
  }
  req.on('data', () => {});
  req.on('end', () => {
    const startPage = Number(url.searchParams.get('startPage') ?? 0);
    const maxPages = Number(url.searchParams.get('maxPages') ?? 1);
    asked.push({ startPage, maxPages });
    const start = Math.min(startPage, TOTAL);
    const end = Math.min(TOTAL, start + Math.min(maxPages, PER_WINDOW));
    const pages = [];
    for (let i = start; i < end; i++) pages.push(Buffer.from(`PAGE-${i}`).toString('base64'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ pages, count: pages.length, total: TOTAL, truncated: end < TOTAL, startPage: start, dpi: 150 }));
  });
}));

const vlmSrv = await listenOnLoopback(http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const j = JSON.parse(body);
    const img = j.messages?.[0]?.images?.[0] ?? '';
    const tag = Buffer.from(img, 'base64').toString();
    transcribed.push(tag);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: 'mock-vlm', done_reason: 'stop', message: { role: 'assistant', content: `Transcription of ${tag}` } }));
  });
}));

process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['RENDER_SIDECAR_URL'] = renderSrv.url;
process.env['VISION_BASE_URL'] = vlmSrv.url;
process.env['DOC_VLM_MODEL'] = 'mock-vlm';
delete process.env['DOC_VLM_URL'];
delete process.env['CONVERSION_SIDECAR_URL'];   // no OCR: the extraction runs ungrounded, which is the path under test

let extract;

describe('a render window that comes back short', () => {
  before(async () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'short-window-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: 'general', label: 'General', builtIn: true, folders: [], meta: {} }],
      mediaEmbedding: { documentProcessing: { mode: 'vlm', maxPages: WINDOW, maxTotalPages: 200, concurrency: 1 } },
    }, null, 2), { mode: 0o600 });
    const loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    ({ vlmExtractDocument: extract } = await import('../../server/dist/files/converters/vlm-extract.js'));
  });

  after(async () => {
    await renderSrv.close();
    await vlmSrv.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('is walked by the pages it returned: each window starts where the previous one ended', async () => {
    const out = await extract(Buffer.from('%PDF-fake'), 'long.pdf', 'vlm');

    // The sidecar answered PER_WINDOW pages of every WINDOW asked for, so the walk must be 0, 2, 4, ... 10.
    assert.deepEqual(asked.map(a => a.startPage), [0, 2, 4, 6, 8, 10],
      `the windows asked for were ${JSON.stringify(asked)}; a caller that steps by the window it ASKED for (${WINDOW}) `
      + 'jumps over the pages a short window did not return');

    // And the consequence the walk exists for: every page read once, in order, none lost.
    assert.deepEqual(transcribed, Array.from({ length: TOTAL }, (_, i) => `PAGE-${i}`),
      'every page of the document is shown to the VLM exactly once, in order');
    assert.equal(out.extractionPath, 'vlm');
    for (let i = 0; i < TOTAL; i++) assert.match(out.markdown, new RegExp(`Transcription of PAGE-${i}(?!\\d)`));
  });
});
