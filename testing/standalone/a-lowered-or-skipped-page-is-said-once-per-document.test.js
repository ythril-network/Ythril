/**
 * What a render sidecar did to a page instead of reading it as asked is said ONCE per document, and a skipped page is
 * walked past, never re-asked (Q-611).
 *
 * ## The rule
 *
 * A sidecar that clamps a page's dpi to `RENDER_MAX_PIXELS` answers `dpiUsed` per page; one that will not render a page at
 * all answers it in `skipped` with its reason. The extraction the operator sees afterwards has a page read at 96 dpi instead
 * of 150, or a page that is not in it, and nothing in the result says so. So:
 *
 *  - one WARN per document (not per window) names the file and every page read below `documentProcessing.renderDpi`;
 *  - one WARN per document names the file and every skipped page with its reason, and says it is NOT in the extraction;
 *  - a skipped page counts as part of its window: the next window starts after it (the sidecar did not return it, and
 *    asking for it again would be asked for it forever), and the VLM is never shown it;
 *  - a document whose every page was skipped is not "no pages came back": it fails saying every page was skipped, so the
 *    caller's fall back to OCR has the reason.
 *
 * ## How it is driven
 *
 * The built `vlmExtractDocument` against a mock render sidecar and a mock Ollama-wire VLM, as
 * `a-short-render-window-does-not-skip-pages.test.js` does. The log lines are read from the logger's own subscription.
 *
 * Run: node --test testing/standalone/a-lowered-or-skipped-page-is-said-once-per-document.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { listenOnLoopback } from '../_shared/local-server.mjs';

const TOTAL = 8;
const WINDOW = 5;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-skipped-page-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');

/** The scenario the pretend sidecar plays: window start -> what it answers. */
let scenario = {};
const asked = [];
const transcribed = [];

const png = (i) => Buffer.from(`PAGE-${i}`).toString('base64');

const renderSrv = await listenOnLoopback(http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"status":"ok"}'); return; }
  req.on('data', () => {});
  req.on('end', () => {
    const startPage = Number(url.searchParams.get('startPage') ?? 0);
    asked.push(startPage);
    const answer = scenario[startPage];
    if (!answer) { res.writeHead(500); res.end('unplanned window'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ count: answer.pages.length, total: TOTAL, dpi: 150, startPage, ...answer, pages: answer.pages.map(png) }));
  });
}));

const vlmSrv = await listenOnLoopback(http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const tag = Buffer.from(JSON.parse(body).messages?.[0]?.images?.[0] ?? '', 'base64').toString();
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
delete process.env['CONVERSION_SIDECAR_URL'];

let extract; let subscribeLogLines;
const lines = [];

describe('a page the render sidecar lowered or skipped', () => {
  before(async () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'skipped-page-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: 'general', label: 'General', builtIn: true, folders: [], meta: {} }],
      mediaEmbedding: { documentProcessing: { mode: 'vlm', maxPages: WINDOW, maxTotalPages: 200, concurrency: 1, renderDpi: 150 } },
    }, null, 2), { mode: 0o600 });
    const loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    ({ vlmExtractDocument: extract } = await import('../../server/dist/files/converters/vlm-extract.js'));
    ({ subscribeLogLines } = await import('../../server/dist/util/log.js'));
    subscribeLogLines((l) => lines.push(l));
  });

  after(async () => {
    await renderSrv.close();
    await vlmSrv.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('is walked past, never shown to the VLM, and said once for the whole document', async () => {
    // Window 0 holds pages 0-4: 0 and 1 rendered (1 at 96 dpi), 2 skipped, and the byte cap ended the window after the skip.
    // Window 3 holds pages 3-7: all rendered, one of them lowered.
    scenario = {
      0: { pages: [0, 1], dpiUsed: [150, 96], skipped: [{ page: 2, reason: 'a 14400 x 14400 pt page needs 31.6 dpi to fit' }], truncated: true },
      3: { pages: [3, 4, 5, 6, 7], dpiUsed: [150, 150, 120, 150, 150], skipped: [], truncated: false },
    };
    asked.length = 0; transcribed.length = 0; lines.length = 0;
    const out = await extract(Buffer.from('%PDF-fake'), 'poster.pdf', 'vlm');

    assert.deepEqual(asked, [0, 3], 'the second window starts after the skipped page, not at the page it asked for');
    assert.deepEqual(transcribed, [0, 1, 3, 4, 5, 6, 7].map(i => `PAGE-${i}`), 'every returned page once, and the skipped one never');
    assert.equal(out.extractionPath, 'vlm');

    const lowered = lines.filter(l => /below documentProcessing\.renderDpi/.test(l));
    assert.equal(lowered.length, 1, `one line for the whole document, got ${lowered.length}:\n${lowered.join('\n')}`);
    assert.match(lowered[0], /poster\.pdf/);
    assert.match(lowered[0], /page 1: 96 dpi/);
    assert.match(lowered[0], /page 5: 120 dpi/, 'a page of a LATER window is numbered in the document, not in its window');

    const skipped = lines.filter(l => /would not render/.test(l));
    assert.equal(skipped.length, 1, `one line for the whole document, got ${skipped.length}:\n${skipped.join('\n')}`);
    assert.match(skipped[0], /poster\.pdf/);
    assert.match(skipped[0], /page 2: a 14400 x 14400 pt page needs 31\.6 dpi/);
    assert.match(skipped[0], /NOT in the extraction/);
  });

  it('a clean document says nothing of the kind', async () => {
    scenario = { 0: { pages: [0, 1, 2], dpiUsed: [150, 150, 150], skipped: [], truncated: false } };
    asked.length = 0; transcribed.length = 0; lines.length = 0;
    await extract(Buffer.from('%PDF-fake'), 'plain.pdf', 'vlm');
    assert.deepEqual(lines.filter(l => /below documentProcessing\.renderDpi|would not render/.test(l)), []);
  });

  it('an older sidecar that answers neither field is read as before', async () => {
    scenario = { 0: { pages: [0, 1], truncated: false } };
    transcribed.length = 0; lines.length = 0;
    await extract(Buffer.from('%PDF-fake'), 'old.pdf', 'vlm');
    assert.deepEqual(transcribed, ['PAGE-0', 'PAGE-1']);
    assert.deepEqual(lines.filter(l => /below documentProcessing\.renderDpi|would not render/.test(l)), []);
  });

  it('a document whose every page was skipped fails saying so, rather than "no pages"', async () => {
    scenario = { 0: { pages: [], dpiUsed: [], skipped: [{ page: 0, reason: 'too big' }, { page: 1, reason: 'too big' }], truncated: false } };
    transcribed.length = 0;
    await assert.rejects(() => extract(Buffer.from('%PDF-fake'), 'huge.pdf', 'vlm'), /every page was skipped/);
    assert.deepEqual(transcribed, []);
  });
});
