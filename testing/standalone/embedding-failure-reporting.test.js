/**
 * B3: embedding failures must not be reported as success.
 *
 * A text/document upload is chunked and each chunk embedded by the media worker.
 * Previously an embed failure was swallowed by an empty catch and the job still
 * reported embeddingStatus='complete' — so a file whose chunks never embedded was
 * silently invisible to $vectorSearch, with no failure signal and no retry.
 *
 * This drives the real path: break the embedding provider (point it at a dead
 * endpoint via config + reload), upload a document, and assert the file is NEVER
 * marked 'complete'. Then restore the provider, hit the existing retry endpoint,
 * and assert it embeds to 'complete' — proving failures are visible and recoverable.
 *
 * NOTE: patches config.json (embedding.baseUrl) on instance A — do not run in
 * parallel with reload-config.test.js / quota.test.js. The `after` hook restores
 * the original embedding config no matter what.
 *
 * Run: node --test testing/standalone/embedding-failure-reporting.test.js
 *
 * @needs-instance — drives a live server on :3200; runs in CI, skipped by preflight.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, delWithBody, readCollection, waitFor } from '../sync/helpers.js';
import { holdsWithin, waitForReading } from '../_shared/wait-for.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CANDIDATE_CONFIGS = [
  path.join(__dirname, '..', 'sync', 'configs', 'a', 'config.json'),
  path.join(__dirname, '..', '..', 'config', 'config.json'),
];
const CONFIG_FILE = CANDIDATE_CONFIGS.find(p => fs.existsSync(p)) ?? null;
const TOKEN_FILE = path.join(__dirname, '..', 'sync', 'configs', 'a', 'token.txt');
// Through the container on EVERY platform when the config is the test stack's. Written from the Windows side of a
// Docker Desktop bind mount, the container's view lagged by seconds or did not change at all within 15 s (measured
// 2026-10-01), so the reload read the old embedder and the test failed for its harness, not for the product.
const USE_DOCKER_EXEC = CONFIG_FILE?.includes(path.join('sync', 'configs')) ?? false;
const CONTAINER_A = 'ythril-a';
const RUN_ID = Date.now();
const SPACE_ID = `b3-embed-fail-${RUN_ID}`;
const DOC_PATH = `b3-doc-${RUN_ID}.md`;

// A document with two sections long enough to produce chunk records.
const DOC = '# B3 Document\n\nIntroduction paragraph with enough words to matter.\n\n' +
  '## Section One\n\nThis first section has enough content to exceed the minimum chunk ' +
  'body length so that a chunk record is created and an embedding is attempted.\n\n' +
  '## Section Two\n\nThe second section likewise carries enough text to pass the minimum ' +
  'body length threshold and produce a second embeddable chunk record.';

let token;
let originalEmbedding;

function readConfig() {
  if (USE_DOCKER_EXEC) {
    return JSON.parse(execSync(`docker exec ${CONTAINER_A} cat /config/config.json`).toString('utf8'));
  }
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

function writeConfig(cfg) {
  if (USE_DOCKER_EXEC) {
    execSync(
      // Double quotes: execSync runs cmd.exe on Windows, which does not treat single quotes as quoting.
      `docker exec -i ${CONTAINER_A} sh -c "cat > /config/config.json && chmod 600 /config/config.json"`,
      { input: JSON.stringify(cfg, null, 2) },
    );
    return;
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

async function setEmbeddingAndReload(embedding) {
  const cfg = readConfig();
  if (embedding === undefined) delete cfg.embedding;
  else cfg.embedding = embedding;
  writeConfig(cfg);
  // Wait until the CONTAINER sees the file we wrote, then reload. A fixed pause was not enough on Docker Desktop:
  // measured 2026-10-01, the bind mount showed the new config about three seconds later, so the reload read the old
  // one, the upload embedded against a working model, and the file was reported `complete` — this test failing for
  // its harness rather than for the product. Reading it back through the container is the propagation, not a guess.
  const want = JSON.stringify(cfg.embedding ?? null);
  let seen;
  await waitFor(() => {
    try {
      seen = JSON.stringify(JSON.parse(execSync(`docker exec ${CONTAINER_A} cat /config/config.json`).toString('utf8')).embedding ?? null);
    } catch { seen = undefined; }
    return seen === want;
  }, 15_000, 250, () => `the container saw ${seen} where ${want} was written`,
  { what: 'the container to see the written embedding config' });
  const reload = await post(INSTANCES.a, token, '/api/admin/reload-config', {});
  assert.equal(reload.status, 200, `reload-config failed: ${JSON.stringify(reload.body)}`);
}

/** Read the ORIGINAL document's embeddingStatus (chunk records carry `#chunk` ids). */
async function docStatus() {
  const r = await readCollection(INSTANCES.a, token, SPACE_ID, 'files', { limit: 200 });
  if (r.status !== 200) return undefined;
  const meta = r.results?.find(f => f._id === DOC_PATH || f.path === DOC_PATH);
  return meta?.embeddingStatus;
}

/** The status the file was in when `accept` took it; THROWS at the deadline, naming the last status read. */
const waitForStatus = (accept, timeoutMs, what) => waitForReading(docStatus, accept, timeoutMs, 1000, { what });

describe('B3: embedding failure is reported, not silently completed', () => {
  before(async () => {
    if (!CONFIG_FILE) throw new Error('No config.json found for test or dev stack');
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    originalEmbedding = readConfig().embedding; // may be undefined (local pipeline)
    const created = await post(INSTANCES.a, token, '/api/spaces', { id: SPACE_ID, label: 'B3 Embed Fail' });
    assert.ok([201, 409].includes(created.status), `create space: ${JSON.stringify(created.body)}`);
  });

  after(async () => {
    // ALWAYS restore embeddings so a failure here doesn't break the rest of the suite.
    await setEmbeddingAndReload(originalEmbedding).catch(() => {});
    await delWithBody(INSTANCES.a, token, `/api/spaces/${SPACE_ID}`, { confirm: true }).catch(() => {});
  });

  it('a document whose chunks all fail to embed is never marked complete', async () => {
    // Break the embedding provider: point it at a closed port → embed() throws fast.
    await setEmbeddingAndReload({ ...(originalEmbedding ?? {}), baseUrl: 'http://127.0.0.1:1' });

    const up = await post(INSTANCES.a, token, `/api/files/${SPACE_ID}?path=${encodeURIComponent(DOC_PATH)}`,
      { content: DOC, encoding: 'utf8' });
    assert.equal(up.status, 202, `upload should be async (202): ${JSON.stringify(up.body)}`);
    assert.equal(up.body.embeddingStatus, 'pending');

    // The worker will claim it ('processing'), fail every chunk embed, and route into
    // the retry path — so it must reach 'processing' and NEVER flip to 'complete'.
    // Allow > the idle-backoff poll cap (default 30s) for the worker to pick the job up.
    await waitForStatus(s => s === 'processing' || s === 'failed', 45_000, 'the worker to engage the failing job');
    // Give it more room and assert it still never claims success: the wait is expected to run out its window.
    const completed = await holdsWithin(async () => (await docStatus()) === 'complete', 8_000, 1000,
      { what: 'a file whose every chunk failed to embed to be reported complete' });
    assert.equal(completed, false,
      'a file whose every chunk failed to embed must NOT be reported complete (B3 regression)');
  });

  it('the retry endpoint re-embeds once the provider is healthy', async () => {
    // Restore the working provider and re-trigger the existing retry endpoint.
    await setEmbeddingAndReload(originalEmbedding);
    const retry = await post(INSTANCES.a, token,
      `/api/files/${SPACE_ID}/retry_embedding?path=${encodeURIComponent(DOC_PATH)}`, {});
    assert.equal(retry.status, 202, `retry should queue (202): ${JSON.stringify(retry.body)}`);

    // Allow > the idle-backoff poll cap for the worker to re-claim the reset job.
    const status = await waitForStatus(s => s === 'complete', 50_000, 'the retried file to embed to complete');
    assert.equal(status, 'complete', `file should embed to complete after retry, got: ${status}`);
  });
});
