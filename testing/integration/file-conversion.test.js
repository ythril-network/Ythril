/**
 * Integration tests: File conversion pipeline
 *
 * Tests the inputFormat parameter and chunk record creation.
 * The unstructured sidecar is not expected to be running in CI,
 * so PDF/DOCX/EPUB tests verify the graceful failure path.
 * HTML, .md, and .txt paths are tested end-to-end (in-process, no sidecar).
 *
 * Run: node --test testing/integration/file-conversion.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, delWithBody, readCollection } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE_A = path.join(__dirname, '..', 'sync', 'configs', 'a', 'token.txt');

let tokenA;
const RUN = Date.now();
// Dedicated space so the file listing is small and chunk counts are unambiguous.
const CONV_SPACE = `conv-${RUN}`;

async function uploadJson(token, spaceId, filePath, body) {
  const url = `${INSTANCES.a}/api/files/${spaceId}?path=${encodeURIComponent(filePath)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

/** All file+chunk records in a space (chunks carry parentFileId). */
async function listAllFiles(token, spaceId) {
  const r = await readCollection(INSTANCES.a, token, spaceId, 'files', { limit: 200 });
  assert.equal(r.status, 200, `files listing failed: ${JSON.stringify(r.body)}`);
  return r.results ?? [];
}

/** Count chunk records whose parent is the file at `parentPath`. */
async function countChunks(token, spaceId, parentPath) {
  const all = await listAllFiles(token, spaceId);
  const parent = all.find(f => f.path === parentPath && !f.parentFileId);
  if (!parent) return { parentFound: false, chunks: 0 };
  const chunks = all.filter(f => f.parentFileId === parent._id);
  return { parentFound: true, chunks: chunks.length };
}

describe('File conversion pipeline — inputFormat bypass', () => {
  before(async () => {
    tokenA = fs.readFileSync(TOKEN_FILE_A, 'utf8').trim();
    const c = await post(INSTANCES.a, tokenA, '/api/spaces', { id: CONV_SPACE, label: 'File Conversion Test' });
    assert.ok(c.status === 201 || c.status === 409, `create conv space: ${JSON.stringify(c.body)}`);
  });

  after(async () => {
    await delWithBody(INSTANCES.a, tokenA, `/api/spaces/${CONV_SPACE}`, { confirm: true }).catch(() => {});
  });

  it('inputFormat "text" bypasses conversion — produces ZERO chunk records', async () => {
    const filePath = `conv-text-bypass-${RUN}.md`;
    const content = '# Section One\n\nSome content here.\n\n## Section Two\n\nMore content.';
    const r = await uploadJson(tokenA, CONV_SPACE, filePath, { content, encoding: 'utf8', inputFormat: 'text' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(r.body?.sha256);

    // The bypass is synchronous (no async job); with conversion skipped the file
    // must have NO chunk records. Previously the test never observed inputFormat
    // at all — a bypass that silently chunked anyway would have passed (S8.11).
    const { parentFound, chunks } = await countChunks(tokenA, CONV_SPACE, filePath);
    assert.ok(parentFound, 'the uploaded file record must exist');
    assert.equal(chunks, 0, `inputFormat:text must not produce chunk records, found ${chunks}`);
  });

  it('Markdown file (.md) converts to chunk records (unlike the text bypass)', async () => {
    const filePath = `conv-md-test-${RUN}.md`;
    const content = '# Document Title\n\nIntroduction paragraph.\n\n## Section One\n\n' +
      'This is the first section with enough content to exceed the minimum chunk body length ' +
      'threshold so that a chunk record is created for this section.\n\n' +
      '## Section Two\n\nThis is the second section with enough content to pass the minimum ' +
      'body length threshold and produce a second chunk record.';
    const r = await uploadJson(tokenA, CONV_SPACE, filePath, { content, encoding: 'utf8' });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.ok(r.body?.sha256);
    assert.equal(r.body?.embeddingStatus, 'pending');

    // Conversion runs in-process (no sidecar for md); poll until the worker has
    // produced chunk records. The exact count is chunker-dependent (short
    // sections may merge), so the observable that matters for inputFormat is the
    // CONTRAST with the bypass case above: converted → ≥1 chunk, bypass → 0.
    // (The HTML case below asserts the stronger ≥2.)
    let chunkCount = 0;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const { chunks } = await countChunks(tokenA, CONV_SPACE, filePath);
      chunkCount = chunks;
      if (chunkCount >= 1) break;
      await new Promise(res => setTimeout(res, 1000));
    }
    assert.ok(chunkCount >= 1, `markdown conversion must produce chunk records (bypass produces 0), found ${chunkCount}`);
  });

  it('Plain text file (.txt extension) is processed asynchronously, returns 202', async () => {
    const filePath = `conv-txt-test-${Date.now()}.txt`;
    const content = 'First paragraph of plain text content that goes on for a while.\n\n' +
      'Second paragraph with different information.\n\n' +
      'Third paragraph completing the document.';
    const r = await uploadJson(tokenA, 'general', filePath, { content, encoding: 'utf8' });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.ok(r.body?.sha256);
    assert.equal(r.body?.embeddingStatus, 'pending');
  });

  it('HTML with inputFormat "html" converts to chunks — at least 2 chunk records appear', async () => {
    const filePath = `conv-html-test-${RUN}.html`;
    const html = `<!DOCTYPE html><html><head><title>Test Article</title></head><body>
      <article>
        <h1>Article Title</h1>
        <p>This is a test article paragraph with enough text to be meaningful content for embedding.</p>
        <h2>Second Section</h2>
        <p>This section has additional content that will appear as a second chunk in the pipeline.</p>
      </article>
    </body></html>`;
    const r = await uploadJson(tokenA, CONV_SPACE, filePath, {
      content: Buffer.from(html).toString('base64'),
      encoding: 'base64',
      inputFormat: 'html',
    });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.ok(r.body?.sha256);
    assert.equal(r.body?.embeddingStatus, 'pending');

    let chunkCount = 0;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const { chunks } = await countChunks(tokenA, CONV_SPACE, filePath);
      chunkCount = chunks;
      if (chunkCount >= 2) break;
      await new Promise(res => setTimeout(res, 1000));
    }
    assert.ok(chunkCount >= 2, `html conversion must produce ≥2 chunk records, found ${chunkCount}`);
  });

  it('PDF uploaded with inputFormat "text" (explicit bypass) does not call sidecar, returns 201', async () => {
    const filePath = `conv-pdf-bypass-${Date.now()}.pdf`;
    const r = await uploadJson(tokenA, 'general', filePath, {
      content: Buffer.from('%PDF-1.4 minimal').toString('base64'),
      encoding: 'base64',
      inputFormat: 'text',
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(r.body?.sha256);
  });

  it('PDF with auto format and unavailable sidecar: write succeeds with async embedding queued', async () => {
    const filePath = `conv-pdf-no-sidecar-${Date.now()}.pdf`;
    const r = await uploadJson(tokenA, 'general', filePath, {
      content: Buffer.from('%PDF-1.4 test').toString('base64'),
      encoding: 'base64',
    });
    // PDF auto-format is now enqueued for async embedding, so returns 202 Accepted immediately.
    // The sidecar being unavailable is handled by the background worker, not the upload handler.
    assert.equal(r.status, 202, `Expected 202 for async PDF embedding, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body?.sha256);
    assert.equal(r.body?.embeddingStatus, 'pending');
  });
});

describe('Media/text job queue — the worker actually claims work (P12)', () => {
  // The claim walk probes each space with its own findOneAndUpdate, so an idle queue paid a
  // full N-space walk per claim, (workerConcurrency + 1) times per tick. It now probes only
  // spaces a hint says MIGHT have work.
  //
  // The hazard that introduces is STRANDING: if anything creates claimable work without
  // announcing it, the walk never visits that space and the job sits pending forever. Nothing
  // covered this — the existing conversion tests assert `embeddingStatus === 'pending'` and
  // never wait for the worker at all, so a queue that claimed NOTHING would have passed.
  //
  // These tests wait for the job to actually leave `pending`.
  const spaceId = `jobclaim-${Date.now()}`;

  before(async () => {
    tokenA = fs.readFileSync(TOKEN_FILE_A, 'utf8').trim();
    const r = await fetch(`${INSTANCES.a}/api/spaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ id: spaceId, label: 'Job Claim Test' }),
    });
    assert.ok([201, 409].includes(r.status), `create space: ${r.status}`);
  });

  /** Poll until embeddingStatus leaves `pending`. Returns { status, elapsedMs }. */
  async function waitUntilClaimed(filePath, timeoutMs = 90_000) {
    const start = Date.now();
    let last = 'pending';
    while (Date.now() - start < timeoutMs) {
      const r = await readCollection(INSTANCES.a, tokenA, spaceId, 'files', { path: filePath, limit: 1 });
      const meta = (r.results ?? []).find(f => f.path === filePath);
      last = meta?.embeddingStatus ?? last;
      // Any terminal-ish state proves the worker picked the job up.
      if (last && last !== 'pending') return { status: last, elapsedMs: Date.now() - start };
      await new Promise(res => setTimeout(res, 2_000));
    }
    throw new Error(
      `job for ${filePath} was never claimed — it sat in '${last}' for ${timeoutMs}ms. ` +
      'The claim walk only probes spaces its pending-work hint knows about, so something that ' +
      'creates claimable work is not announcing it (see markSpaceMayHaveWork).',
    );
  }

  it('a newly uploaded file in a previously-idle space IS claimed by the worker', async () => {
    // The space starts with no work at all, so the hint is empty for it — precisely the case
    // where a missing announcement would strand the job forever.
    const filePath = `claim-first-${Date.now()}.md`;
    const content = '# Claim Test\n\n' + 'Body text long enough to produce a chunk record. '.repeat(8);
    const up = await uploadJson(tokenA, spaceId, filePath, { content, encoding: 'utf8' });
    assert.equal(up.status, 202, JSON.stringify(up.body));
    assert.equal(up.body?.embeddingStatus, 'pending');

    const { status } = await waitUntilClaimed(filePath);
    assert.notEqual(status, 'pending', `worker must claim the job; ended in '${status}'`);

    // NOTE — deliberately no latency assertion here, and it is worth saying why. First-claim
    // latency is dominated by the WORKER'S IDLE BACKOFF (it stretches its poll interval up to
    // workerMaxPollIntervalMs, 30s by default, when there is nothing to do), not by the
    // pending-work hint. An earlier version of this test asserted a latency bound and failed at
    // 32s on a cold worker while the hint was working perfectly — it was measuring the backoff.
    // What this test pins is the invariant that actually matters: the job is CLAIMED, never
    // stranded. The 30s full scan is the deliberate safety net behind the hint.
  });

  it('after the queue drains, a SECOND upload re-arms the hint and is also claimed', async () => {
    // Draining clears the hint for the space. A second upload must put it back — if only the
    // first enqueue announced work, this one would hang.
    const filePath = `claim-second-${Date.now()}.md`;
    const content = '# Second Claim\n\n' + 'More body text to force a chunk to be produced. '.repeat(8);
    const up = await uploadJson(tokenA, spaceId, filePath, { content, encoding: 'utf8' });
    assert.equal(up.status, 202, JSON.stringify(up.body));

    const { status } = await waitUntilClaimed(filePath);
    assert.notEqual(status, 'pending', `second job must also be claimed; ended in '${status}'`);
  });
});
