/**
 * A read spill never reaches a peer, and a legacy `_tmp/` spill a peer sends is dropped (`Q-92`).
 *
 * ## Why this is a sync test as well as a red-team one
 *
 * The red-team suite proves a search leaves the space's own stores untouched. That is not the same claim as
 * "a spill stays on this instance", because the harm of the old spill was that it SYNCED: a `<space>_files`
 * record with a seq, so every peer of the space received a copy of another instance's search results —
 * readable there by any files:read token, under nobody's issuing-token check. And the peers that have not
 * upgraded keep holding and sending the ones they already wrote.
 *
 * So both directions are asserted, against the receiver's own Mongo rather than its listing (the listing
 * hides `_tmp/`, so it would report clean over the very file this looks for):
 *
 * - **Outbound.** A recall spill on A, and a legacy-shaped `_tmp/graph-<uuid>.json` on A, never arrive on
 *   B — while a sentinel file written AFTER both (so with a higher seq) does. The sentinel is what makes
 *   "absent" mean absent rather than "not looked for yet".
 * - **Inbound.** A legacy spill FileMeta pushed straight at B's ingest is dropped, while an ordinary FileMeta
 *   in the same batch is kept.
 *
 * Run: node --test --test-concurrency=1 testing/sync/a-read-spill-never-reaches-a-peer.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { INSTANCES, post, createTestSpace, mirroredNetwork, waitFor, waitForEmbedQueueEmpty } from './helpers.js';
import { spaceFootprint, spillRows } from '../_shared/space-footprint.mjs';
import { requireEmbedding } from '../_shared/embedding-required.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');
const RUN = Date.now();
const VAULT_QUERY = 'vault credential rotation service';
const LEGACY = `_tmp/graph-${randomUUID()}.json`;     // the shape every version before this one wrote
const SENTINEL = `notes/sentinel-${RUN}.md`;

let tokenA, tokenB, space, network;
let embeddingAvailable = false;

const isSpillPath = (p) => /^_tmp\/(graph|results)-[0-9a-f-]+\.json$/.test(p);

async function writeFile(base, token, spaceId, filePath, content) {
  const r = await fetch(`${base}/api/files/${spaceId}?path=${encodeURIComponent(filePath)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ content, encoding: 'utf8' }),
  });
  assert.ok(r.status < 300, `write ${filePath}: ${r.status}`);
}

/** Sync from both ends each poll: whichever end moves files, a passing test must not depend on guessing it. */
async function syncUntil(condition, what) {
  await waitFor(async () => {
    await post(INSTANCES.a, tokenA, `/api/networks/${network.networkId}/sync?wait=true`, {});
    await post(INSTANCES.b, tokenB, `/api/networks/${network.networkId}/sync?wait=true`, {});
    return condition();
  }, 90_000, 2_000, () => what);
}

before(async () => {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  tokenB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();
  space = await createTestSpace('spill-peer', [[INSTANCES.a, tokenA], [INSTANCES.b, tokenB]]);
  network = await mirroredNetwork({
    label: `spill-peer-${RUN}`, spaces: [space.id], a: [INSTANCES.a, tokenA], b: [INSTANCES.b, tokenB],
  });
  let written = 0;
  for (let i = 0; i < 6; i++) {
    const r = await post(INSTANCES.a, tokenA, `/api/brain/spaces/${space.id}/entities`, {
      name: `vault-credential-peer-${i}-${RUN}`, type: 'service', tags: [], properties: {},
      description: `Vault credential rotation service peer ${i}, scoping authentication tokens`,
    });
    if (r.status === 201) written++;
  }
  embeddingAvailable = written === 6;
  // The recall below has to find enough of the seed to overflow 1000 bytes and spill; a REST write does not embed
  // inline, so wait for the queue that does (Q-99: it no longer keeps pace by blocking the server).
  if (embeddingAvailable) await waitForEmbedQueueEmpty(INSTANCES.a, tokenA, space.id);
});

after(async () => {
  await network?.remove();
  await space?.remove();
});

describe('a read spill stays on the instance that made it', () => {
  it('neither a recall spill nor a legacy _tmp spill on A reaches B; a later ordinary file does', async (t) => {
    if (!requireEmbedding(t, embeddingAvailable, `the seed entities could not be written on A (${space.id})`)) return;

    // The shape an older version left behind, present in the space before this version runs.
    await writeFile(INSTANCES.a, tokenA, space.id, LEGACY, JSON.stringify({ kind: 'graph-traversal', nodes: 0, graph: [] }));

    const r = await post(INSTANCES.a, tokenA, '/api/brain/recall', {
      space: space.id, query: VAULT_QUERY, types: ['entity'], topK: 10, maxBytes: 1000, remainderDump: true,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
    assert.ok(r.body.remainder, `the fixture must spill: ${JSON.stringify({ ...r.body, results: undefined })}`);

    // Written LAST, so its seq is above both spills: once it has arrived, anything that was going to has.
    await writeFile(INSTANCES.a, tokenA, space.id, SENTINEL, `# sentinel ${RUN}\n`);
    await syncUntil(() => spaceFootprint('b', space.id).fileIds.includes(SENTINEL),
      `the sentinel ${SENTINEL} reaching B — without it, "no spill on B" cannot be told from "nothing synced yet"`);

    const onB = spaceFootprint('b', space.id).fileIds;
    assert.deepEqual(onB.filter(isSpillPath), [],
      'a spill reached the peer: another instance\'s search results, readable there by any files:read token');

    assert.match(String(r.body.remainder.spillId), /^[0-9a-f-]{36}$/, 'the spill is delivered by id');
    assert.deepEqual(spillRows('b', r.body.remainder.spillId), { headers: 0, pages: 0 },
      'and the spill store is not replicated either');
  });

  it('a legacy spill pushed at the receiver is dropped; an ordinary file in the same batch is kept', async () => {
    const now = new Date().toISOString();
    const meta = (p, tags) => ({
      _id: p, spaceId: space.id, path: p, tags, description: 'pushed by a peer',
      author: { instanceId: 'older-peer', instanceLabel: 'Older peer' }, createdAt: now, updatedAt: now, seq: Date.now(),
    });
    const legacy = `_tmp/results-${randomUUID()}.json`;
    const kept = `notes/pushed-${RUN}.md`;
    const r = await post(INSTANCES.b, tokenB, `/api/sync/batch-upsert?spaceId=${space.id}`, {
      filemeta: [meta(legacy, ['result-spill']), meta(kept, [])],
    });
    assert.ok(r.status < 400, `push: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);

    const onB = spaceFootprint('b', space.id).fileIds;
    assert.ok(onB.includes(kept), `the ordinary FileMeta must land, or the drop below is unobserved: ${JSON.stringify(onB)}`);
    assert.ok(!onB.includes(legacy), `a legacy spill pushed by an older peer must be dropped by the receiver: ${legacy}`);
  });
});
