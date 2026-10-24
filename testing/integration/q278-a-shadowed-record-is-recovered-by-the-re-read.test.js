/**
 * A record Q-278 shadowed is recovered by the D-20 re-read, over more than one cycle's cap, and an instance that is merely
 * catching up is never counted as failing (Q-278 doneWhen 3, bundle-81 §7, decisions 18 and 26).
 *
 * ## The rules this holds
 *
 * 1. **Recovery.** A receiver whose carried mark for a member sits above records it never read (what 5.6's author-guarded
 *    marks left behind, and 6.0 carries as the identity) reads them all after the operator runs the re-read, though they
 *    are more than one pull cycle holds (`pull-family.ts`: 200 x 50 = 10,000 per cycle and space). Every cycle on the way
 *    is `partial` and never an `error`, and the member's failure count stays 0 throughout: the re-read must not make a
 *    healthy peer look unreachable. Identities, not counts: the receiver ends holding exactly the ids the holder holds.
 * 2. **The re-read is an admin act with a second factor on both doors.** REST: `requireAdminMfa` (403 `MFA_REQUIRED`). MCP:
 *    `network_reread` follows the personal-view precedent (decision 26): the tool throws the sentence `view_copy` throws,
 *    "needs MFA step-up, which this door cannot present; use the web UI", whenever `mfaRequiredFor` is true for the caller,
 *    because MCP has no channel for a code. The control is the same token reading the same network on both doors: it is a
 *    working admin token, so the refusal is the second factor and not a broken fixture.
 *
 * ## How the shadow is made, and what the test takes from the plan
 *
 * A 6.0 stack never shadows a record by itself (a landing takes its own position), so the shadow is CARRIED: the receiver's
 * mark for the member is set to the holder's `head` (the settled end of its stream), exactly the state a carried 5.6 mark
 * over unread rows is. The field is the plan's `lastPosReceived` (a map by space, §3a/§4), and the re-read's parameters are
 * the plan's `POST /api/networks/:id/reread {confirm: true}` and MCP `network_reread {id, confirm}`. Both are read from the
 * plan, not from code, and if the shipped names differ this file is what is corrected, not the code.
 *
 * Neither instance runs a cycle but by this test: both networks are set to manual sync before anything is written.
 * Cycles are `?wait=true`, so each has run to its end when it answers; the counts it reads are the metrics the cycle
 * incremented, as a delta over a read taken before the re-read.
 *
 * Run: node --test testing/integration/q278-a-shadowed-record-is-recovered-by-the-re-read.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INSTANCES, post, get, del, patch, reqJson, getInstanceId, patchContainerNetwork, createTestSpace, mirroredNetwork,
  readCollection,
} from '../sync/helpers.js';
import { openMcpSession } from '../sync/mcp-session.js';
import { SPACE_AREAS } from '../../server/dist/config/rights-shape.js';

const CONFIGS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sync', 'configs');
const tokenOf = (x) => fs.readFileSync(path.join(CONFIGS, x, 'token.txt'), 'utf8').trim();
const RUN = Date.now();

/** One pull cycle holds `200 x 50` records of a space; the holder writes more than that, so the re-read cannot finish in one. */
const CYCLE_CAP = 10_000;
const SEEDED = CYCLE_CAP + 500;
const BULK_PER_REQUEST = 500;

const must = (r, what, ok = [200, 201, 207]) => { assert.ok(ok.includes(r.status), `${what}: ${r.status} ${JSON.stringify(r.body)}`); return r; };

/** Every id of the facts of a space, in one read (projection to the id, a limit past the seeding, a byte ceiling past the page). */
async function factIds(base, token, space) {
  const r = await readCollection(base, token, space, 'facts', { limit: SEEDED * 2, projection: { _id: 1 }, maxChars: 50_000_000 });
  assert.equal(r.status, 200, `read the ids of ${space} on ${base}: ${JSON.stringify(r.body)?.slice(0, 200)}`);
  assert.equal(r.body.truncated, false, 'the id read was not cut by the byte budget, so it is the whole set');
  return r.results.map(x => x._id);
}

/** `ythril_sync_cycles_total` of a network, by status, as this instance counts it. */
async function cyclesOf(base, token, networkId) {
  const resp = await fetch(`${base}/metrics`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(resp.status, 200, 'the metrics endpoint answers the admin token');
  const text = await resp.text();
  const count = (status) => {
    const m = text.match(new RegExp(`^ythril_sync_cycles_total\\{[^}]*network="${networkId}"[^}]*status="${status}"[^}]*\\}\\s+(\\d+)`, 'm'))
      ?? text.match(new RegExp(`^ythril_sync_cycles_total\\{[^}]*status="${status}"[^}]*network="${networkId}"[^}]*\\}\\s+(\\d+)`, 'm'));
    return m ? Number(m[1]) : 0;
  };
  return { success: count('success'), partial: count('partial'), error: count('error') };
}

describe('the D-20 re-read recovers what a carried mark shadowed', () => {
  const A = { base: INSTANCES.a, token: tokenOf('a'), container: 'ythril-a' };
  const B = { base: INSTANCES.b, token: tokenOf('b'), container: 'ythril-b' };
  let space, net, idB, sealedIds;

  const cycleOnA = async () => must(await post(A.base, A.token, `/api/networks/${net.networkId}/sync?wait=true`, {}), 'a cycle on A', [200]);
  const memberB = async () => ((await get(A.base, A.token, `/api/networks/${net.networkId}`)).body?.members ?? []).find(m => m.instanceId === idB);

  before(async () => {
    idB = getInstanceId(B.container);
    space = await createTestSpace('q278-reread', [[A.base, A.token], [B.base, B.token]]);
    net = await mirroredNetwork({ label: `q278 re-read ${RUN}`, spaces: [space.id], a: [A.base, A.token], b: [B.base, B.token] });
    // Manual sync on both ends BEFORE anything is written: a cycle nobody asked for would carry what the test holds back.
    for (const n of [A, B]) must(await patch(n.base, n.token, `/api/networks/${net.networkId}`, { syncSchedule: '' }), `manual sync on ${n.container}`);
  });

  after(async () => {
    await net?.remove();
    await space?.remove();
  });

  describe('recovery', () => {
    it('A holds none of what B wrote under a mark above it, and reads all of it after the re-read, partial and never failing', async () => {
      // B writes more than a cycle holds, quiet (no vectors: the records are the subject, not the embedder).
      for (let done = 0; done < SEEDED; done += BULK_PER_REQUEST) {
        const n = Math.min(BULK_PER_REQUEST, SEEDED - done);
        must(await post(B.base, B.token, `/api/brain/spaces/${space.id}/bulk`, {
          facts: Array.from({ length: n }, (_, i) => ({ fact: `q278 shadowed ${RUN} ${done + i}`, suppressEmbeddings: true })),
        }), `bulk of ${n} on B`);
      }
      const held = await factIds(B.base, B.token, space.id);
      assert.equal(held.length, SEEDED, 'B holds exactly the records it was asked to write');

      // The carried mark: A's receive mark for B is B's settled head, above every one of those records.
      const top = await get(B.base, B.token, `/api/sync/facts?spaceId=${space.id}&afterPos=0&limit=1`);
      assert.equal(top.status, 200, JSON.stringify(top.body));
      assert.ok(Number.isSafeInteger(top.body.head), `B answers the settled head of its stream: ${JSON.stringify(top.body)}`);
      patchContainerNetwork(A.container, net.networkId, `const m = n.members.find(x => x.instanceId === ${JSON.stringify(idB)}); `
        + `m.lastPosReceived = { ...(m.lastPosReceived || {}), [${JSON.stringify(space.id)}]: ${top.body.head} };`);
      must(await post(A.base, A.token, '/api/admin/reload-config', {}), 'A reloads its config', [200]);

      // Control 1: the shadow is real. Ordinary cycles read nothing below the mark; a record B writes ABOVE it is read,
      // so the cycle works and the absence of the rest is the mark's doing.
      const above = must(await post(B.base, B.token, `/api/brain/spaces/${space.id}/facts`, { fact: `q278 above the mark ${RUN}`, suppressEmbeddings: true }), 'a record above the mark on B');
      const aboveId = above.body._id ?? above.body.id;
      await cycleOnA();
      await cycleOnA();
      const onA = new Set(await factIds(A.base, A.token, space.id));
      assert.ok(onA.has(aboveId), 'control: a record above the carried mark is read by an ordinary cycle');
      assert.deepEqual(held.filter(id => onA.has(id)), [], 'the records under the carried mark are shadowed: no ordinary cycle reads them');

      // The re-read: an admin act, confirmed.
      const before = await cyclesOf(A.base, A.token, net.networkId);
      const reread = await post(A.base, A.token, `/api/networks/${net.networkId}/reread`, { confirm: true });
      assert.ok(reread.status >= 200 && reread.status < 300, `the re-read is accepted: ${reread.status} ${JSON.stringify(reread.body)}`);

      // Cycles until A holds the whole set. Each is a completed cycle that began after the last, and the bound is the
      // arithmetic: one space, SEEDED records, a cap of CYCLE_CAP per cycle, so the set is read in ceil(SEEDED / CYCLE_CAP)
      // cycles; two more only absorb a slow cycle.
      const bound = Math.ceil((SEEDED + 1) / CYCLE_CAP) + 2;
      const failuresSeen = [];
      let have = new Set();
      for (let i = 0; i < bound; i++) {
        await cycleOnA();
        failuresSeen.push((await memberB())?.consecutiveFailures ?? 0);
        have = new Set(await factIds(A.base, A.token, space.id));
        if (held.every(id => have.has(id))) break;
      }
      assert.deepEqual(held.filter(id => !have.has(id)), [], `A holds every record B wrote after the re-read (within ${bound} cycles)`);

      const after = await cyclesOf(A.base, A.token, net.networkId);
      assert.ok(after.partial > before.partial,
        `a re-read over more than one cycle's cap counts partial cycles: partial ${before.partial} -> ${after.partial}`);
      assert.equal(after.error, before.error, `and never an error: error ${before.error} -> ${after.error}`);
      assert.deepEqual(failuresSeen.filter(n => n !== 0), [], `B is never counted as failing while A catches up: consecutiveFailures per cycle ${JSON.stringify(failuresSeen)}`);
    });
  });

  describe('the second factor', () => {
    let mfaToken, mfaTokenId;

    before(async () => {
      const rights = { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: Object.fromEntries(SPACE_AREAS.map(a => [a, 'admin'])) };
      const t = must(await post(A.base, A.token, '/api/tokens', { name: `q278-reread-mfa-${RUN}`, rights, mfa: 'required' }), 'an admin token that always needs the second factor');
      mfaToken = t.body.plaintext;
      mfaTokenId = t.body.token?.id;
    });

    after(async () => {
      if (mfaTokenId) await del(A.base, A.token, `/api/tokens/${mfaTokenId}`).catch(() => {});
    });

    it('REST refuses the re-read without a code, MCP refuses it with the sentence the personal-view copy gives', async () => {
      // The control: the same token is a working admin on both doors, reading the same network.
      assert.equal((await get(A.base, mfaToken, `/api/networks/${net.networkId}`)).status, 200, 'control: the token reads the network over REST');
      const session = await openMcpSession(mfaToken, A.base);
      const viaMcp = await session.callTool('network_get', { id: net.networkId });
      assert.ok(!viaMcp?.isError, `control: the token reads the network over MCP: ${JSON.stringify(viaMcp)}`);

      const rest = await reqJson(A.base, mfaToken, `/api/networks/${net.networkId}/reread`, { method: 'POST', body: JSON.stringify({ confirm: true }) });
      assert.equal(rest.status, 403, `REST refuses the re-read without a code: ${rest.status} ${JSON.stringify(rest.body)}`);
      assert.equal(rest.body?.error, 'MFA_REQUIRED', `and says why: ${JSON.stringify(rest.body)}`);

      const mcp = await session.callTool('network_reread', { id: net.networkId, confirm: true });
      assert.equal(mcp?.isError, true, `MCP refuses it too: ${JSON.stringify(mcp)}`);
      assert.match(JSON.stringify(mcp), /needs MFA step-up, which this door cannot present; use the web UI/,
        `with the sentence a personal-view copy gives, because this door has no place for a code: ${JSON.stringify(mcp)}`);
    });
  });
});
