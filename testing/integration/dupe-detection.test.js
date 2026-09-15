/**
 * Integration tests: Insert-time semantic duplicate detection
 *
 * Covers the F4 feature — the `remember` and `save_entity` MCP tools run an
 * opt-in (default-on) near-duplicate check using the freshly computed embedding
 * and flag highly similar existing records in the response:
 *  - remember a near-identical memory → response flags the existing one
 *  - remember a clearly distinct memory → no duplicate flag
 *  - remember with checkDuplicates:false → no flag even for a duplicate
 *  - upsert_entity a semantically duplicate entity → response flags the existing one
 *  - the write always succeeds regardless (the check is advisory)
 *
 * Duplicates are only visible once the original is $vectorSearch-indexed, so the
 * original is written and waited-for before the duplicate is inserted.
 *
 * Run: node --test testing/integration/dupe-detection.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, waitForIndexed as waitForIndexedShared } from '../sync/helpers.js';
import { openMcpSession } from '../sync/mcp-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const SPACE = `dupe-test-${RUN}`;

let tokenA;
let embeddingAvailable = false;

function token() { return tokenA; }
function idFrom(text) { const m = /ID ([0-9a-f-]{36})/.exec(text ?? ''); return m ? m[1] : null; }

async function ensureReindexed(baseUrl, tok) {
  const { body } = await get(baseUrl, tok, '/api/spaces');
  for (const space of body?.spaces ?? []) {
    const { body: st } = await get(baseUrl, tok, `/api/brain/spaces/${space.id}/reindex-status`);
    if (st?.needsReindex) await post(baseUrl, tok, `/api/brain/spaces/${space.id}/reindex`, {});
  }
}

// The MCP client harness lives in ../sync/mcp-session.js. It was copy-pasted into ten files while the
// transport was SSE; 4.0 removed SSE and one shared `POST /mcp` caller replaced every copy.

/**
 * Poll $vectorSearch until every id appears in unfiltered recall for `types`.
 *
 * The poll and its deadline are shared — this file used to carry its own copy with a 30 s timeout, under the
 * 150 s index lag seen on CI.
 */
const waitForIndexed = (ids, types, timeoutMs) =>
  waitForIndexedShared(INSTANCES.a, token(), SPACE, ids, types, timeoutMs);

let session;

before(async () => {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  const r = await post(INSTANCES.a, token(), '/api/spaces', { id: SPACE, label: `Dupe Test ${RUN}` });
  assert.equal(r.status, 201, `Failed to create space: ${JSON.stringify(r.body)}`);
  await ensureReindexed(INSTANCES.a, token());
  // Probe embedding availability
  const probe = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/entities`, { name: `__dupe-probe-${RUN}__`, type: 'probe', description: 'probe', tags: [] });
  embeddingAvailable = probe.status === 201;
  session = await openMcpSession(token());
});

after(async () => {
  try { session?.close(); } catch { /* ignore */ }
  await fetch(`${INSTANCES.a}/api/spaces/${SPACE}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }) }).catch(() => {});
});

describe('Duplicate detection — remember', () => {
  it('flags a near-identical memory as a possible duplicate', async (t) => {
    if (!embeddingAvailable) return t.skip('embedding unavailable');
    const first = 'The Vault service stores secrets and rotates authentication tokens on a schedule.';
    const dup = 'The Vault service stores secrets and rotates authentication tokens on a fixed schedule.';

    const r1 = await session.callTool('save_fact', { space: SPACE, fact: first });
    const id1 = idFrom(r1?.content?.[0]?.text);
    assert.ok(id1, `first remember returned an id: ${r1?.content?.[0]?.text}`);
    await waitForIndexed([id1], ['memory']);

    const r2 = await session.callTool('save_fact', { space: SPACE, fact: dup });
    const text2 = r2?.content?.[0]?.text ?? '';
    assert.match(text2, /Possible duplicate/, `expected a duplicate flag, got: ${text2}`);
    assert.ok(text2.includes(id1), `duplicate flag should name the existing memory ${id1}: ${text2}`);
    // The write still succeeds.
    assert.ok(idFrom(text2) && idFrom(text2) !== id1, 'the near-duplicate is still stored as a new memory');
  });

  it('does not flag a clearly distinct memory', async (t) => {
    if (!embeddingAvailable) return t.skip('embedding unavailable');
    const r = await session.callTool('save_fact', { space: SPACE, fact: 'Ripe bananas are a yellow tropical fruit rich in potassium.' });
    const text = r?.content?.[0]?.text ?? '';
    assert.ok(idFrom(text), 'distinct memory stored');
    assert.doesNotMatch(text, /Possible duplicate/, `distinct memory should not be flagged: ${text}`);
  });

  it('skips the check when checkDuplicates:false', async (t) => {
    if (!embeddingAvailable) return t.skip('embedding unavailable');
    const dup = 'The Vault service stores secrets and rotates authentication tokens on a schedule.';
    const r = await session.callTool('save_fact', { space: SPACE, fact: dup, checkDuplicates: false });
    const text = r?.content?.[0]?.text ?? '';
    assert.ok(idFrom(text), 'memory stored');
    assert.doesNotMatch(text, /Possible duplicate/, `checkDuplicates:false must skip the flag: ${text}`);
  });
});

describe('Duplicate detection — upsert_entity', () => {
  it('flags a semantically duplicate entity insert', async (t) => {
    if (!embeddingAvailable) return t.skip('embedding unavailable');
    const desc = 'Central telemetry aggregation pipeline collecting metrics from downstream collectors.';
    const r1 = await session.callTool('save_entity', { space: SPACE, name: `Telemetry Aggregator ${RUN}`, type: 'service', description: desc });
    const id1 = idFrom(r1?.content?.[0]?.text);
    assert.ok(id1, `first upsert returned an id: ${r1?.content?.[0]?.text}`);
    await waitForIndexed([id1], ['entity']);

    // Different name (avoids the exact-name warning), same semantics → semantic dup.
    const r2 = await session.callTool('save_entity', { space: SPACE, name: `Telemetry Collector Aggregation ${RUN}`, type: 'service', description: desc });
    const text2 = r2?.content?.[0]?.text ?? '';
    assert.match(text2, /Possible duplicate/, `expected a duplicate flag, got: ${text2}`);
    assert.ok(text2.includes(id1), `duplicate flag should name the existing entity ${id1}: ${text2}`);
  });

  it('skips the check when checkDuplicates:false', async (t) => {
    if (!embeddingAvailable) return t.skip('embedding unavailable');
    const desc = 'Central telemetry aggregation pipeline collecting metrics from downstream collectors.';
    const r = await session.callTool('save_entity', { space: SPACE, name: `Telemetry Something Else ${RUN}`, type: 'service', description: desc, checkDuplicates: false });
    const text = r?.content?.[0]?.text ?? '';
    assert.doesNotMatch(text, /Possible duplicate/, `checkDuplicates:false must skip the flag: ${text}`);
  });
});
