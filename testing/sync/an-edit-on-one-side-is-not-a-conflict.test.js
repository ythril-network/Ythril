/**
 * An edit on ONE side of a two-way network replaces the other side's copy; only edits on BOTH sides are a conflict
 * (`Q-66`).
 *
 * A pulled file whose hash differed from ours was always a conflict, because nothing remembered which version the two
 * ends last agreed on — so "only the peer changed it" looked exactly like "both changed it", and every upstream edit
 * to the onboarding guide landed on each member as a conflict copy. Owner, 2026-09-27: auto-accept the incoming copy
 * when the local one was not touched since. Each end now keeps, per file and peer, the hash both last held.
 *
 * A and B on a CLOSED network (both push and pull), so the pull side decides — the side that raised the conflicts.
 *
 * Run: node --test testing/sync/an-edit-on-one-side-is-not-a-conflict.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, del, delWithBody, waitFor, getInstanceId } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');
const RUN = Date.now();
const SPACE = `q66-${RUN}`;
let tokenA, tokenB, networkId;

const auth = t => ({ Authorization: `Bearer ${t}` });
async function write(base, token, p, content) {
  const r = await fetch(`${base}/api/files/${SPACE}?path=${encodeURIComponent(p)}`, {
    method: 'POST', headers: { ...auth(token), 'Content-Type': 'application/json' }, body: JSON.stringify({ content, encoding: 'utf8' }),
  });
  assert.ok(r.status < 300, `write ${p} on ${base}: ${r.status}`);
}
async function read(base, token, p) {
  const r = await fetch(`${base}/api/files/${SPACE}?path=${encodeURIComponent(p)}`, { headers: auth(token) });
  return r.ok ? r.text() : null;
}
async function conflicts(base, token, p) {
  const r = await get(base, token, `/api/conflicts?spaceId=${SPACE}`);
  return (r.body?.conflicts ?? []).filter(c => c.originalPath === p);
}
/** A holds the network with B as a both-ways member, so A's cycle pulls from B (and decides) and pushes to it. */
async function syncBoth() {
  await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/sync?wait=true`, {});
}

before(async () => {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  tokenB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();
  for (const [base, t] of [[INSTANCES.a, tokenA], [INSTANCES.b, tokenB]]) {
    assert.equal((await post(base, t, '/api/spaces', { id: SPACE, label: SPACE })).status, 201);
  }
  const net = await post(INSTANCES.a, tokenA, '/api/networks', { label: `q66-${RUN}`, type: 'closed', spaces: [SPACE], votingDeadlineHours: 1 });
  assert.equal(net.status, 201, JSON.stringify(net.body));
  networkId = net.body.id;
  const ptB = await post(INSTANCES.b, tokenB, '/api/tokens', { name: `q66-peer-${RUN}`, peerInstanceId: getInstanceId('ythril-a') });
  assert.equal(ptB.status, 201);
  const addB = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/members`, {
    instanceId: getInstanceId('ythril-b'), label: 'Q66B', url: 'http://ythril-b:3200', token: ptB.body.plaintext, direction: 'both',
  });
  if (addB.status === 202) await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/votes/${addB.body.roundId}`, { vote: 'yes' });
  else assert.equal(addB.status, 201, JSON.stringify(addB.body));
});

after(async () => {
  if (networkId) {
    await del(INSTANCES.a, tokenA, `/api/networks/${networkId}`).catch(() => {});
  }
  await delWithBody(INSTANCES.a, tokenA, `/api/spaces/${SPACE}`, { confirm: true }).catch(() => {});
  await delWithBody(INSTANCES.b, tokenB, `/api/spaces/${SPACE}`, { confirm: true }).catch(() => {});
});

describe('who changed the file decides', () => {
  it('an edit on B alone replaces A\'s untouched copy, with no conflict', async () => {
    const p = 'guide.md';
    await write(INSTANCES.b, tokenB, p, `first ${RUN}\n`);
    await waitFor(async () => { await syncBoth(); return (await read(INSTANCES.a, tokenA, p))?.includes(`first ${RUN}`); },
      60_000, 2_000, () => 'the first version never reached A');
    await write(INSTANCES.b, tokenB, p, `second ${RUN}\n`);
    await waitFor(async () => { await syncBoth(); return (await read(INSTANCES.a, tokenA, p))?.includes(`second ${RUN}`); },
      60_000, 2_000, () => 'B\'s edit never replaced A\'s untouched copy');
    assert.deepEqual(await conflicts(INSTANCES.a, tokenA, p), [], 'an edit on one side only is not a conflict');
  });

  it('edits on both sides are still a conflict, and nothing is overwritten', async () => {
    const p = 'both.md';
    await write(INSTANCES.b, tokenB, p, `base ${RUN}\n`);
    await waitFor(async () => { await syncBoth(); return (await read(INSTANCES.a, tokenA, p))?.includes(`base ${RUN}`); },
      60_000, 2_000, () => 'the base version never reached A');
    await write(INSTANCES.a, tokenA, p, `a-edit ${RUN}\n`);
    await write(INSTANCES.b, tokenB, p, `b-edit ${RUN}\n`);
    await waitFor(async () => { await syncBoth(); return (await conflicts(INSTANCES.a, tokenA, p)).length > 0 || (await conflicts(INSTANCES.b, tokenB, p)).length > 0; },
      60_000, 2_000, () => 'two edits never raised a conflict on either side');
  });
});

describe('what an instance derives for itself never travels', () => {
  const manifestPaths = async (base, token) =>
    ((await get(base, token, `/api/sync/manifest?spaceId=${SPACE}&networkId=${networkId}`)).body?.manifest ?? []).map(e => e.path);

  it('a conflict copy stays on the instance that raised it', async () => {
    const open = (await conflicts(INSTANCES.a, tokenA, 'both.md'))[0];
    assert.ok(open, 'the previous case left a conflict on A');
    await syncBoth(); await syncBoth();
    assert.ok(!(await manifestPaths(INSTANCES.a, tokenA)).includes(open.conflictPath), 'A offers its conflict copy to peers');
    assert.equal(await read(INSTANCES.b, tokenB, open.conflictPath), null, 'the conflict copy reached B');
  });

  it('a schema snapshot (schemas/*.json) stays on the instance that wrote it', async () => {
    // A schema change on a closed network opens a vote rather than writing, so the snapshot is written the way
    // `syncSchemaFiles` names it; the rule is about that name (`schemas/<space>_<kind>_<type>.json`), not its author.
    const snap = `schemas/${SPACE}_entity_Note.json`;
    await write(INSTANCES.a, tokenA, snap, '{ "propertySchemas": {} }\n');
    await syncBoth(); await syncBoth();
    assert.ok(!(await manifestPaths(INSTANCES.a, tokenA)).includes(snap), 'A offers its schema snapshot to peers');
    assert.equal(await read(INSTANCES.b, tokenB, snap), null, 'A\'s schema snapshot reached B as a file');
  });
});
