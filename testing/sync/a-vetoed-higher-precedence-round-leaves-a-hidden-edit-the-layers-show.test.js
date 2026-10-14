/**
 * A schema edit that one network took and a higher-precedence network vetoed is a HIDDEN EDIT, and `space_schema_layers`
 * shows it — on REST and on MCP, derived on read (`R6-8`, Q-67; the owner's rule that a layer outranks the own definitions).
 *
 * ## The scenario Q-67 is about
 *
 * A space sits in two networks. The first one (joined first, so highest precedence) is a democratic network with B, and B
 * published a purpose for the space as that network's layer. The second is a club A organises. A edits the purpose: a round
 * opens on each network. The club's passes at once on A's own yes, and writes the edit into A's own definitions; the democratic
 * network's needs B, and B vetoes it. The space now holds an own value that nothing it runs on reflects: the first network's
 * layer outranks it. Every door said the edit was saved; the space went on running on B's purpose. Not an error, so nobody was
 * ever told — which is why the answer to "why is my purpose not what I set" was nowhere.
 *
 * ## What is pinned
 *
 *  - the write answers 202 and, per network, `layers` = [first network `vote_pending`, club `applied`];
 *  - `space_schema_layers` (REST) lists `purpose` with own = what A set, effective = what B published, winner = the first
 *    network, hidden = true — and so does MCP, with the same row;
 *  - it says so while the vote is STILL OPEN (the view is derived from the own definitions and the layers, not recorded at a
 *    conclusion), and still after B's veto has concluded the round as vetoed on A;
 *  - the control: a space in the first network only, edited the same way and vetoed, has no hidden field — its own definitions
 *    never took the edit, so nothing outranks anything.
 *
 * ## Stack-run
 *
 * Written, NOT run here: it needs the stack (instances A and B). Every wait is a `waitFor` on a stated condition (a round
 * reaching the other member, a layer arriving, a veto landing), never a fixed sleep.
 *
 * Run: node --test testing/sync/a-vetoed-higher-precedence-round-leaves-a-hidden-edit-the-layers-show.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, patch, get, del, delWithBody, triggerSync, waitFor, mirroredNetwork } from './helpers.js';
import { openMcpSession } from './mcp-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');
const RUN = Date.now();
const SPACE = `q67-two-${RUN}`;
const ONLY = `q67-one-${RUN}`;
const FROM_B = `published by B ${RUN}`;
const FROM_A = `edited by A ${RUN}`;
const token = (x) => fs.readFileSync(path.join(CONFIGS, x, 'token.txt'), 'utf8').trim();

let tA, tB, mcp, first, club;

const syncBoth = async (...ids) => {
  for (const id of ids) {
    await triggerSync(INSTANCES.b, tB, id).catch(() => {});
    await triggerSync(INSTANCES.a, tA, id).catch(() => {});
  }
};
const layersOnA = async (space) => (await get(INSTANCES.a, tA, `/api/spaces/${space}/schema-layers`)).body;
const tool = async (name, args) => {
  const r = await mcp.callTool(name, args);
  return { isError: !!r?.isError, body: r?.structuredContent ?? {}, text: r?.content?.[0]?.text ?? '' };
};
const openRound = async (base, tok, networkId, spaceMatch) => ((await get(base, tok, `/api/networks/${networkId}/votes`)).body?.rounds ?? [])
  .find(r => r.type === 'meta_change' && r.concluded !== true && (spaceMatch ? r.spaceId === spaceMatch : true));

/** B publishes `purpose` as the first network's layer for `space`: B proposes, A votes yes, and the layer lands on A. */
async function publishFromB(space, purpose) {
  const r = await patch(INSTANCES.b, tB, `/api/spaces/${space}`, { meta: { purpose } });
  assert.equal(r.status, 202, `B's proposal needs A's vote on a democratic network of two: ${r.status} ${JSON.stringify(r.body)}`);
  let roundId;
  await waitFor(async () => {
    await syncBoth(first.networkId);
    roundId = (await openRound(INSTANCES.a, tA, first.networkId, space))?.roundId;
    return !!roundId;
  }, 60_000, 2_000, () => `B's round for ${space} never reached A`, { what: `B's meta_change round for ${space} reaching A` });
  const v = await post(INSTANCES.a, tA, `/api/networks/${first.networkId}/votes/${roundId}`, { vote: 'yes' });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  await waitFor(async () => {
    await syncBoth(first.networkId);
    return (await layersOnA(space)).layers?.find(l => l.networkId === first.networkId)?.meta?.purpose === purpose;
  }, 60_000, 2_000, async () => `the layer on A: ${JSON.stringify((await layersOnA(space)).layers)}`, { what: `B's purpose arriving on A as the first network's layer for ${space}` });
}

before(async () => {
  [tA, tB] = ['a', 'b'].map(token);
  for (const base of [[INSTANCES.a, tA], [INSTANCES.b, tB]]) {
    for (const id of [SPACE, ONLY]) assert.equal((await post(base[0], base[1], '/api/spaces', { id, label: id })).status, 201);
  }
  // The first network: joined first, so it wins a clash. Democratic with two members, so neither yes alone passes a round.
  first = await mirroredNetwork({ label: `q67-first-${RUN}`, type: 'democratic', spaces: [SPACE, ONLY], a: [INSTANCES.a, tA], b: [INSTANCES.b, tB] });
  await publishFromB(SPACE, FROM_B);
  await publishFromB(ONLY, FROM_B);
  // The second: a club A organises, carrying the space the first also carries.
  const n = await post(INSTANCES.a, tA, '/api/networks', { label: `q67-club-${RUN}`, type: 'club', spaces: [SPACE] });
  assert.equal(n.status, 201, JSON.stringify(n.body));
  club = n.body.id;
  mcp = await openMcpSession(tA);
});

after(async () => {
  await mcp?.close?.();
  if (club) await del(INSTANCES.a, tA, `/api/networks/${club}`).catch(() => {});
  await first?.remove();
  for (const [base, tok] of [[INSTANCES.a, tA], [INSTANCES.b, tB]]) {
    for (const id of [SPACE, ONLY]) await delWithBody(base, tok, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
  }
});

/** The row both doors must give for `purpose`: A's edit is hidden by the first network's layer. */
const HIDDEN = () => ({ field: 'purpose', own: FROM_A, effective: FROM_B, winner: first.networkId, hidden: true });
function assertRow(row, expected, where) {
  assert.ok(row, `${where}: purpose has no row in fields`);
  for (const [k, v] of Object.entries(expected)) assert.deepEqual(row[k], v, `${where}: ${k} (${JSON.stringify(row)})`);
}

describe('an edit the club took and the first network vetoed', () => {
  let proposal;

  it('A edits the purpose: 202, with the first network pending and the club applied, per network', async () => {
    const r = await patch(INSTANCES.a, tA, `/api/spaces/${SPACE}`, { meta: { purpose: FROM_A } });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const by = (id) => r.body.layers?.find(l => l.networkId === id);
    assert.equal(by(first.networkId)?.outcome, 'vote_pending', `layers: ${JSON.stringify(r.body.layers)}`);
    assert.equal(by(club)?.outcome, 'applied', `layers: ${JSON.stringify(r.body.layers)}`);
    proposal = r.body.rounds.find(x => x.networkId === first.networkId);
    assert.ok(proposal?.roundId, 'no round was opened on the first network');
  });

  it('while the first network\'s vote is still open the view already shows the edit hidden, on REST and on MCP', async () => {
    const rest = await layersOnA(SPACE);
    assertRow(rest.fields?.find(f => f.field === 'purpose'), HIDDEN(), 'REST');
    const viaMcp = await tool('space_schema_layers', { space: SPACE });
    assert.equal(viaMcp.isError, false, viaMcp.text);
    assertRow(viaMcp.body.fields?.find(f => f.field === 'purpose'), HIDDEN(), 'MCP');
    assert.deepEqual(viaMcp.body, rest, 'the MCP tool answers something other than the route');
  });

  it('B vetoes the first network\'s round, and A records it vetoed', async () => {
    await waitFor(async () => {
      await syncBoth(first.networkId);
      return !!(await openRound(INSTANCES.b, tB, first.networkId, SPACE));
    }, 60_000, 2_000, () => 'A\'s round never reached B', { what: 'A\'s meta_change round reaching B' });
    const open = await openRound(INSTANCES.b, tB, first.networkId, SPACE);
    const v = await post(INSTANCES.b, tB, `/api/networks/${first.networkId}/votes/${open.roundId}`, { vote: 'veto' });
    assert.equal(v.status, 200, JSON.stringify(v.body));
    await waitFor(async () => {
      await syncBoth(first.networkId);
      const outcomes = (await get(INSTANCES.a, tA, `/api/networks/${first.networkId}/vote-outcomes`)).body?.outcomes ?? [];
      return outcomes.some(o => o.roundId === proposal.roundId && o.outcome === 'vetoed');
    }, 60_000, 2_000, async () => `A's outcomes: ${JSON.stringify((await get(INSTANCES.a, tA, `/api/networks/${first.networkId}/vote-outcomes`)).body)}`,
    { what: 'the veto concluding the round as vetoed on A' });
  });

  it('after the veto the edit is still hidden: own is what A set, the space runs on what B published', async () => {
    assert.equal((await get(INSTANCES.a, tA, `/api/spaces/${SPACE}/meta`)).body.purpose, FROM_B, 'the space must run on the first network\'s layer');
    const rest = await layersOnA(SPACE);
    assertRow(rest.fields?.find(f => f.field === 'purpose'), HIDDEN(), 'REST after the veto');
    assert.equal(rest.own?.purpose, FROM_A, 'the own definitions lost the edit: it was never applied there');
    const viaMcp = await tool('space_schema_layers', { space: SPACE });
    assertRow(viaMcp.body.fields?.find(f => f.field === 'purpose'), HIDDEN(), 'MCP after the veto');
  });
});

describe('the control: a space in the first network only', () => {
  it('an edit vetoed there leaves nothing hidden, on REST and on MCP', async () => {
    const r = await patch(INSTANCES.a, tA, `/api/spaces/${ONLY}`, { meta: { purpose: FROM_A } });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal('layers' in r.body, false, 'a single-network write answer grew a layers array');
    const round = r.body.rounds[0];
    await waitFor(async () => {
      await syncBoth(first.networkId);
      return !!(await openRound(INSTANCES.b, tB, first.networkId, ONLY));
    }, 60_000, 2_000, () => 'A\'s round never reached B', { what: `A's round for ${ONLY} reaching B` });
    const open = await openRound(INSTANCES.b, tB, first.networkId, ONLY);
    assert.equal((await post(INSTANCES.b, tB, `/api/networks/${first.networkId}/votes/${open.roundId}`, { vote: 'veto' })).status, 200);
    await waitFor(async () => {
      await syncBoth(first.networkId);
      const outcomes = (await get(INSTANCES.a, tA, `/api/networks/${first.networkId}/vote-outcomes`)).body?.outcomes ?? [];
      return outcomes.some(o => o.roundId === round.roundId && o.outcome === 'vetoed');
    }, 60_000, 2_000, () => 'the veto never concluded the round on A', { what: `the veto of ${ONLY}'s round landing on A` });
    for (const answer of [await layersOnA(ONLY), (await tool('space_schema_layers', { space: ONLY })).body]) {
      assert.ok(Array.isArray(answer.fields), `no per-field view: ${Object.keys(answer).join(', ')}`);
      assert.deepEqual(answer.fields.filter(f => f.hidden === true), [], 'a single-network space reports a hidden edit that was never stored');
      assert.equal(answer.fields.find(f => f.field === 'purpose')?.effective, FROM_B);
    }
  });
});
