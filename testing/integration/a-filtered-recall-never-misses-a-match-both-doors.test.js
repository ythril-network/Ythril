/**
 * A filtered recall returns its one matching record even when it ranks below many that do not — on both doors
 * (Q-102).
 *
 * ## What this adds to the database-level test
 *
 * `testing/standalone/a-filtered-recall-never-misses-a-match-db.test.js` pins the truth table against a real
 * index with ten thousand records and stub vectors. It cannot see the doors: the REST route handing its body to
 * the MCP tool, the filter resolution each door applies, `filterPath` on each response, and a real embedding
 * model ranking real text. This is that, small.
 *
 * ## How it keeps the target out of every channel but the one under test
 *
 * - The target is written FIRST and more than `FRESH_SCAN_CAP` decoys after it, so the fresh-write scan — which
 *   reads only the newest `FRESH_SCAN_CAP` records by `seq` — cannot supply it. Only the index path can.
 * - Its text is unlike the query and the decoys' text is like it, so it ranks below every decoy; the positive
 *   control asserts exactly that, so a red is about rank and not about reachability.
 * - It is polled INDEXED through a filter the index applies natively (`name`), before the case asks with one it
 *   cannot (an undeclared `properties.*` key).
 *
 * It IS seeded past the vector window (just over a thousand records through the real embedder), so it is red on
 * the base commit at the doors, as the ticket's doneWhen asks; the database test pins the rest of the truth table.
 * Both the target and the last decoy are polled indexed first, so a half-ingested window cannot pass it.
 *
 * FAILS rather than skips on CI when the embedder is unavailable — `requireEmbedding`.
 *
 * Run: node --test testing/integration/a-filtered-recall-never-misses-a-match-both-doors.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post } from '../sync/helpers.js';
import { openMcpSession } from '../sync/mcp-session.js';
import { requireEmbedding } from '../_shared/embedding-required.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const SPACE = `q102-${RUN}`;
const QUERY = 'orbital telescope mirror calibration';
const MARKER = `needle-${RUN}`;
const TARGET_NAME = `ledger-${RUN}`;
/** Today's vector window at small topK (recall.ts ennLimit floor); the fix must make the answer independent of it. */
const WINDOW_FLOOR = 1000;

let tokenA, targetId = null, seeded = false, indexed = false, session;
const token = () => tokenA;
const idOf = (r) => r.record?._id ?? r._id;

before(async () => {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  const created = await post(INSTANCES.a, token(), '/api/spaces', { id: SPACE, label: `Q-102 ${RUN}` });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  // The server's own cap, from the same module and the same (unset) environment the stack runs with.
  const { FRESH_SCAN_CAP } = await import('../../server/dist/brain/fresh-writes.js');

  const target = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/entities`, {
    name: TARGET_NAME, type: 'ledger', description: 'quarterly tax receipts for the bakery, filed by hand',
    tags: [], properties: { marker: MARKER },
  });
  if (target.status !== 201) return;
  targetId = target.body._id ?? target.body.id;

  // Past the vector window as well as the fresh cap, so the base commit is RED here too: at topK 5 with no
  // reranker (the test stack configures none) the window is its 1000-record floor. The doneWhen asks for exactly
  // this — a seed larger than the candidate window, on the doors.
  const decoys = Array.from({ length: Math.max(FRESH_SCAN_CAP, WINDOW_FLOOR) + 40 }, (_, i) => ({
    name: `telescope-${i}-${RUN}`, type: 'instrument',
    description: `orbital telescope mirror calibration run ${i}`, tags: [], properties: {},
  }));
  const BATCH = 100;
  for (let b = 0; b * BATCH < decoys.length; b++) {
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/bulk`, { entities: decoys.slice(b * BATCH, (b + 1) * BATCH) });
    if (r.status >= 300 && r.status !== 207) return;
  }
  seeded = true;

  // Indexed, by a filter the index CAN apply: the target AND the last decoy written. A target inside a
  // half-ingested window would pass against the defect, so the decoys ranking above it must be served too.
  const lastDecoy = decoys[decoys.length - 1].name;
  const served = async (name) => {
    const r = await post(INSTANCES.a, token(), '/api/brain/recall',
      { space: SPACE, query: QUERY, types: ['entity'], topK: 5, filter: { name } });
    return r.status === 200 && (r.body.results ?? []).some(x => (x.record?.name ?? x.name) === name);
  };
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    if (await served(TARGET_NAME) && await served(lastDecoy)) { indexed = true; break; }
    await new Promise(res => setTimeout(res, 2000));
  }
  session = await openMcpSession(token());
});

after(async () => {
  await session?.close?.();
  await fetch(`${INSTANCES.a}/api/spaces/${SPACE}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: true }),
  }).catch(() => {});
});

const ready = (t) => {
  if (!requireEmbedding(t, seeded && targetId != null, `seeded=${seeded} target=${targetId} — writes unavailable`)) return false;
  assert.ok(indexed, `${TARGET_NAME} and the last decoy were not both served by the index within the poll deadline — this is index lag, not the defect`);
  return true;
};

const ARGS = { space: SPACE, query: QUERY, types: ['entity'], topK: 5, filter: { 'properties.marker': MARKER } };

describe('a filtered recall returns a match that ranks below many non-matching records', () => {
  it('positive control: unfiltered, the target is not among the nearest', async (t) => {
    if (!ready(t)) return;
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', { space: SPACE, query: QUERY, types: ['entity'], topK: 10 });
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
    const ids = (r.body.results ?? []).map(idOf);
    assert.ok(ids.length >= 5, `expected the decoys to fill the ranking, got ${ids.length}`);
    assert.ok(!ids.includes(targetId), 'the target ranks among the nearest, so this file would prove nothing about rank');
  });

  it('REST: the target comes back, with filterPath exhaustive', async (t) => {
    if (!ready(t)) return;
    const r = await post(INSTANCES.a, token(), '/api/brain/recall', ARGS);
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
    assert.deepEqual((r.body.results ?? []).map(idOf), [targetId],
      `the one record satisfying the filter must be returned: ${JSON.stringify(r.body).slice(0, 400)}`);
    assert.equal(r.body.filterPath, 'exhaustive', 'an undeclared property is a filter the index cannot apply — say so');
    assert.ok(!(r.body.degraded ?? []).includes('filter_window'), 'a completed answer must not claim it may be missing records');
  });

  it('MCP: the same record, the same filterPath', async (t) => {
    if (!ready(t)) return;
    const res = await session.callTool('recall', ARGS);
    assert.ok(!res?.isError, JSON.stringify(res).slice(0, 400));
    const body = JSON.parse(res?.content?.[0]?.text ?? '{}');
    assert.deepEqual((body.results ?? []).map(idOf), [targetId],
      `the MCP door must return what REST returns: ${JSON.stringify(body).slice(0, 400)}`);
    assert.equal(body.filterPath, 'exhaustive');
    assert.ok(!(body.degraded ?? []).includes('filter_window'));
  });
});
