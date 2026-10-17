/**
 * What the delete and wipe doors answer, from the state of the act they are asked about (bundle-106; design v5 section 2.2: R-W1, R-W7, R-W10 admin
 * half, R-W20).
 *
 * ## The defects this holds
 *
 * - **R-W1.** A repeated wipe or delete was either a NEW intent swallowed as a retry, or a retry that opened a second round and wiped again (and a
 *   retried networked DELETE took the solo path and answered `204` while the first was still removing the copy). The rule is ONE table:
 *   *this instance's own round of the same kind, network space and covered types* is answered instead of opened again only while it is OPEN, or its
 *   act is OWED or IN FLIGHT; a round whose act COMPLETED never counts, and a peer's round, another kind, another space, other types or another
 *   network never do. The table below is written per row from the design's words, never derived from the code under test.
 * - **R-W7.** A relay (a peer's vote push) that concludes a wipe answers BEFORE the act finishes: it runs inside the sender's serial vote push, and an
 *   awaited act would stall the sender's whole cycle.
 * - **R-W10 (admin half).** The admin wipe door took `types` uncapped and undeduped; "which types a wipe covers" is one canonical answer.
 * - **R-W20.** A wipe that passed and then FAILED answers `500` (`503` for a store outage, with `Retry-After`) with `{ status: 'passed', rounds, error }`
 *   where `error` is OUR sentence — never driver text — and the tool door answers `code: 'space_act_failed'`, which is a failure, not a refusal.
 *
 * ## How rows are driven
 *
 * Hooks run INSIDE the real bodies (`setSpaceActHooksForTest`, design v5 section 2.5); nothing replaces a body. Order is a latch, never a timer.
 *
 * Run: node --test testing/standalone/a-space-act-doors-answer-from-the-state-of-their-act-db.test.js
 * (requires a prior server build and the test MongoDB: `npm run test:up`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { removeInstanceDir, callRoute } from './_vote-round-instance.mjs';
import { deferred, seedActEntry, untilRunnerIdle, resetRunnerForTest, entriesOf } from './_space-act-harness.mjs';
import {
  SELF, M1, tempInstance, networkOf, boot, seedFacts, factCount, roundsOf, doors, requireRunner, databaseTakesCollections, warmSpaceCreation, ADMIN,
  untilOrBound,
} from './_round-open-fixtures.mjs';

const dir = tempInstance('ythril-door-answers-');
const skip = await mongoSkipReason();
const T = Date.now();
const iso = (ms) => new Date(ms).toISOString();

/** The round this instance proposed earlier, as the table's BASE row wants it: a wipe of every type of `notes` on net-1, in state `state`. */
const priorRound = (state, over = {}) => ({
  roundId: 'prior', type: 'space_wipe', spaceId: 'notes', networkSpaceId: 'notes', subjectInstanceId: SELF, subjectLabel: 'self', subjectUrl: '',
  openedAt: iso(T - 60_000), deadline: iso(T + 3_600_000), votes: [{ instanceId: SELF, vote: 'yes', castAt: iso(T - 60_000) }], proposedHere: true,
  ...({
    open: { concluded: false },
    owedPast: { concluded: true, passed: true, outcome: 'passed' },
    owedFuture: { concluded: true, passed: true, outcome: 'passed' },
    draining: { concluded: true, passed: true, outcome: 'passed' },
    running: { concluded: true, passed: true, outcome: 'passed' },
    completed: { concluded: true, passed: true, outcome: 'passed', appliedHere: true },
    failed: { concluded: true, passed: false, outcome: 'vetoed' },
    expired: { concluded: true, passed: false, outcome: 'expired' },
  })[state],
  ...over,
});
const entryFor = (state, over = {}) => ({
  kind: 'wipe', localId: 'notes', rounds: [{ networkId: 'net-1', roundId: 'prior' }], state: state === 'owedPast' || state === 'owedFuture' ? 'owed' : state,
  attempts: state === 'owedPast' || state === 'owedFuture' ? 1 : 0, ...(state === 'owedPast' ? { retryAt: iso(T - 1000) } : {}),
  ...(state === 'owedFuture' ? { retryAt: iso(T + 3_600_000) } : {}), ...over,
});

/**
 * The verdict per state for the BASE row (this instance's own round of the same kind, space, types, network). The words are the design's:
 * open -> the door answers that round and opens no duplicate; owed with retryAt in the future -> `202 queued retryAt`, no start; owed past retryAt,
 * draining or running -> the door joins (or starts, like the tick) and answers 200 with `repeated: true`; completed, failed, expired -> a NEW round.
 */
const BASE_VERDICT = { open: 'repeat-open', owedPast: 'repeat-applied', owedFuture: 'queued-retry', draining: 'repeat-applied', running: 'repeat-applied', completed: 'new-round', failed: 'new-round', expired: 'new-round' };
/** Each dimension that makes the stored round NOT the one the door is asked about — whatever its state, the door opens a new round. */
const MISMATCH = {
  'proposed by a peer, not here': { round: { proposedHere: false } },
  'a deletion, not a wipe': { round: { type: 'space_deletion' } },
  'another space': { round: { spaceId: 'other', networkSpaceId: 'other' }, entry: { localId: 'other' } },
  'other types (files only)': { round: { wipeTypes: ['files'] }, entry: { types: ['files'] } },
  'another network': { network: 'net-2' },
};

describe('R-W1: a repeated wipe answers the round it repeats only while that round is open or its act is owed or running', { skip }, () => {
  let mongo;
  before(async () => {
    mongo = await openTestMongo('door_answers');
    await databaseTakesCollections(mongo);
    await boot(dir, { networks: [] });
    await warmSpaceCreation();
  });
  after(async () => { await closeTestMongo(); });

  let seeded = 0;
  const rows = [];
  for (const state of Object.keys(BASE_VERDICT)) {
    rows.push({ name: `${state}, own round of the same kind, space, types and network`, state, verdict: BASE_VERDICT[state], mismatch: undefined });
    for (const [why, m] of Object.entries(MISMATCH)) rows.push({ name: `${state}, but ${why}`, state, verdict: 'new-round', mismatch: m });
  }

  it('the table is derived from its dimensions and has a floor (a loop that matched nothing would pass)', () => {
    assert.ok(Object.keys(BASE_VERDICT).length >= 8 && Object.keys(MISMATCH).length >= 5, 'a dimension was dropped from the truth table');
    assert.equal(rows.length, Object.keys(BASE_VERDICT).length * (1 + Object.keys(MISMATCH).length));
  });

  for (const row of rows) {
    it(`${row.name} -> ${row.verdict}`, async () => {
      const runner = await requireRunner().catch(() => null);
      const round = priorRound(row.state, row.mismatch?.round);
      const holdsIt = row.mismatch?.network === 'net-2' ? 'net-2' : 'net-1';
      const nets = [networkOf('closed', [M1], { id: 'net-1', spaces: ['general', 'notes'], extra: { pendingRounds: holdsIt === 'net-1' ? [round] : [] } })];
      if (holdsIt === 'net-2') nets.push(networkOf('closed', [M1], { id: 'net-2', spaces: ['general'], extra: { pendingRounds: [round] } }));
      const loader = await boot(dir, { spaces: ['notes', 'other'], networks: nets });
      await seedFacts(mongo, 'notes', 2, `w1-${++seeded}`);
      if (!['open', 'completed', 'failed', 'expired'].includes(row.state)) await seedActEntry(loader, entryFor(row.state, { ...(row.mismatch?.entry ?? {}), rounds: [{ networkId: holdsIt, roundId: 'prior' }] }));
      const before = roundsOf(loader, 'net-1', 'space_wipe').length;
      const res = await doors.wipeSpace('notes');
      const opened = roundsOf(loader, 'net-1', 'space_wipe').length - before;
      const got = res.body?.repeated === true && opened === 0
        ? (res.code === 202 && res.body.queued === true ? 'queued-retry' : res.code === 202 ? 'repeat-open' : 'repeat-applied')
        : opened === 1 ? 'new-round' : `neither (code ${res.code}, ${opened} round(s) opened)`;
      assert.equal(got, row.verdict, `${JSON.stringify(res.body)?.slice(0, 260)}`);
      if (row.verdict === 'queued-retry') assert.ok(res.body.retryAt, 'a queued answer names the retry time');
      if (runner) { await untilRunnerIdle(runner, loader, { now: T + 7_200_000 }).catch(() => {}); resetRunnerForTest(runner); }
    });
  }

  it('R-W1a: wipe, write a fact, wipe again — the second wipe is a NEW round (the first completed) and the fact is gone', async () => {
    const loader = await boot(dir, { spaces: ['notes'], networks: [networkOf('club', [M1], { spaces: ['general', 'notes'] })] });
    await seedFacts(mongo, 'notes', 1, 'first');
    assert.equal((await doors.wipeSpace('notes')).code, 200, 'the first wipe passes at open on a club (Q-453)');
    await seedFacts(mongo, 'notes', 1, 'second');
    const res = await doors.wipeSpace('notes');
    assert.equal(res.code, 200, JSON.stringify(res.body)?.slice(0, 200));
    assert.notEqual(res.body.repeated, true, 'a completed wipe was answered as a repeat');
    assert.equal(await factCount(mongo, 'notes'), 0, 'the second write survived the second wipe');
    assert.equal(roundsOf(loader, 'net-1', 'space_wipe').length, 2);
  });

  it('R-W1b: closed with a member — DELETE answers 202, the same DELETE again answers 202 repeated:true, and exactly ONE round stands', async () => {
    const loader = await boot(dir, { spaces: ['notes'], networks: [networkOf('closed', [M1], { spaces: ['general', 'notes'] })] });
    const first = await doors.deleteSpace('notes');
    const second = await doors.deleteSpace('notes');
    assert.deepEqual([first.code, second.code], [202, 202]);
    assert.equal(second.body.repeated, true, 'the second click opened a duplicate vote');
    assert.equal(roundsOf(loader, 'net-1', 'space_deletion').length, 1);
  });
});

describe('R-W10 (admin half): the wipe doors canonicalise `types`', { skip }, () => {
  let mongo;
  before(async () => { mongo = await openTestMongo('door_types'); await databaseTakesCollections(mongo); });
  after(async () => { await closeTestMongo(); });

  it('duplicates and order are settled once: the round stores the canonical list, in the order of the six', async () => {
    const loader = await boot(dir, { spaces: ['notes'], networks: [networkOf('closed', [M1], { spaces: ['general', 'notes'] })] });
    const res = await doors.wipeSpace('notes', { confirm: true, types: ['links', 'files', 'files'] });
    assert.equal(res.code, 202, JSON.stringify(res.body)?.slice(0, 200));
    assert.deepEqual(roundsOf(loader, 'net-1', 'space_wipe')[0].wipeTypes, ['files', 'links'], 'the round (and so the signature that covers it) stores the list as sent');
  });
  it('more than six entries are refused 400, on the admin route and through the tool, alike', async () => {
    await boot(dir, { spaces: ['notes'], networks: [networkOf('closed', [M1], { spaces: ['general', 'notes'] })] });
    const seven = ['facts', 'entities', 'edges', 'chrono', 'links', 'files', 'files'];
    const rest = await doors.wipeSpace('notes', { confirm: true, types: seven });
    const tool = await doors.wipeTool({ space: 'notes', types: seven });
    assert.equal(rest.code, 400, JSON.stringify(rest.body)?.slice(0, 200));
    assert.equal(tool.isError, true, tool.text);
  });
});

describe('R-W7 and R-W20: a concluding relay answers before the act finishes, and a failed act is answered in our words', { skip }, () => {
  let mongo;
  before(async () => { mongo = await openTestMongo('door_failures'); await databaseTakesCollections(mongo); await boot(dir, { networks: [] }); await warmSpaceCreation(); });
  after(async () => { await closeTestMongo(); removeInstanceDir(dir); });

  it('R-W7: the relay that concludes a wipe answers while the first batch is parked on a latch', async () => {
    const runner = await requireRunner();
    const round = { ...priorRound('open'), roundId: 'relay-1', openedAt: iso(Date.now() - 60_000), deadline: iso(Date.now() + 3_600_000) };
    const loader = await boot(dir, { spaces: ['notes'], networks: [networkOf('closed', [M1], { spaces: ['general', 'notes'], extra: { pendingRounds: [round] } })] });
    await seedFacts(mongo, 'notes', 3, 'relay');
    const latch = deferred();
    runner.setSpaceActHooksForTest({ beforeBatch: async () => { latch.arrive(); await latch.promise; } });
    const { syncVotesRouter } = await import('../../server/dist/api/sync/votes.js');
    let answered = false;
    const call = callRoute(syncVotesRouter, 'post', '/networks/:networkId/votes/:roundId', {
      params: { networkId: 'net-1', roundId: 'relay-1' }, body: { instanceId: M1, vote: 'yes', castAt: iso(Date.now()) }, authToken: { peerInstanceId: M1, rights: { instanceAdmin: false } },
    }).then(r => { answered = true; return r; });
    await latch.reached;
    for (let i = 0; i < 50 && !answered; i++) await new Promise(r => setImmediate(r));
    assert.equal(answered, true, 'the relay awaited the act: the sender\'s whole serial vote push (and its cycle) stalls behind a wipe (W7)');
    latch.release();
    assert.equal((await call).code, 200);
    // The act's body is store work: its end is waited for in store round trips (bounded), then the idle check holds it.
    await untilOrBound(mongo, async () => runner.spaceActsRunning() === 0 && entriesOf(loader).length === 0, 3000);
    await untilRunnerIdle(runner, loader);
    assert.equal(await factCount(mongo, 'notes'), 0);
    resetRunnerForTest(runner);
  });

  it('R-W20: a wipe that passed and failed answers 500 with our sentence (no driver text), status passed and the rounds; the tool door answers code space_act_failed', async () => {
    const runner = await requireRunner();
    await boot(dir, { spaces: ['notes'], networks: [networkOf('club', [M1], { spaces: ['general', 'notes'] })] });
    await seedFacts(mongo, 'notes', 2, 'fail');
    runner.setSpaceActHooksForTest({ beforeBatch: async () => { throw new Error('E11000 driver detail MONGO_SECRET_HOST'); } });
    const rest = await doors.wipeSpace('notes');
    assert.equal(rest.code, 500, JSON.stringify(rest.body)?.slice(0, 300));
    assert.equal(rest.body.status, 'passed');
    assert.ok(Array.isArray(rest.body.rounds) && rest.body.rounds.length === 1);
    assert.doesNotMatch(JSON.stringify(rest.body), /MONGO_SECRET_HOST|E11000/, 'the failure answered with driver text');
    assert.match(rest.body.error, /vote passed/i);
    resetRunnerForTest(runner);
    runner.setSpaceActHooksForTest({ beforeBatch: async () => { throw new Error('again'); } });
    await boot(dir, { spaces: ['notes'], networks: [networkOf('club', [M1], { spaces: ['general', 'notes'] })] });
    const tool = await doors.wipeTool({ space: 'notes' });
    assert.equal(tool.isError, true, tool.text);
    assert.equal(tool.structured?.code, 'space_act_failed', 'a failed act after a passed vote is a FAILURE, not a ToolRefusal (which means "refused, nothing failed")');
    assert.equal(tool.structured?.status, 'passed');
    // The dispatcher's STATUS for that answer (design v5 section 2.2 v4 (3)): the REST tool door answers what the dispatcher says, and a
    // failed act after a passed vote is a server-side failure - 500, as the REST route answers - never the 422 of a refusal.
    resetRunnerForTest(runner);
    runner.setSpaceActHooksForTest({ beforeBatch: async () => { throw new Error('and again'); } });
    await boot(dir, { spaces: ['notes'], networks: [networkOf('club', [M1], { spaces: ['general', 'notes'] })] });
    const { callTool: dispatch } = await import('../../server/dist/mcp/call-tool.js');
    const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
    // The dispatcher reads a whole matrix (reach, rung): an instance administrator's, as a minted admin token carries.
    const adminMatrix = { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: Object.fromEntries(SPACE_AREAS.map(a => [a, 'admin'])) };
    const viaDoor = await dispatch({ name: 'delete_space_data', args: { space: 'notes', confirm: true },
      caller: { rights: adminMatrix, ip: '127.0.0.1', authMethod: 'pat', oidcSubject: null, transport: 'rest', tokenId: 't', tokenLabel: 't' } });
    assert.equal(viaDoor.result.structuredContent?.code, 'space_act_failed', `the dispatched call did not fail as an act: ${JSON.stringify(viaDoor.result).slice(0, 300)}`);
    assert.equal(viaDoor.status, 500, 'the tool door answered a failed act after a passed vote with a refusal\'s status: the REST route answers it 500');
    resetRunnerForTest(runner);
  });

  it('R-W20: a store-side cause answers 503 with Retry-After and the same body', async () => {
    const runner = await requireRunner();
    await boot(dir, { spaces: ['notes'], networks: [networkOf('club', [M1], { spaces: ['general', 'notes'] })] });
    // The driver's own class: the server's one store classifier reads the error's class, never a name any Error could carry.
    const { MongoNetworkError } = await import('mongodb');
    runner.setSpaceActHooksForTest({ beforeBatch: async () => { throw new MongoNetworkError('connection closed'); } });
    const { createApp } = await import('../../server/dist/app.js');
    const app = createApp();
    const res = await (async () => {
      const { fakeRes } = await import('./_vote-round-instance.mjs');
      const r = fakeRes();
      const layer = (app.router ?? app._router).stack.find(l => l.route?.path === '/api/admin/spaces/:spaceId/wipe' && l.route.methods.post);
      await layer.route.stack.at(-1).handle({ method: 'POST', params: { spaceId: 'notes' }, body: { confirm: true }, authToken: ADMIN, headers: {}, get: () => undefined }, r);
      return r;
    })();
    assert.equal(res.code, 503, JSON.stringify(res.body)?.slice(0, 300));
    assert.ok(res.headers['retry-after'], 'a store outage names when to retry');
    assert.equal(res.body.status, 'passed', 'the 503 body lost status: passed and rounds, so a client\'s passed branch never fired');
    assert.ok(res.body.rounds?.length >= 1);
    assert.ok(entriesOf(await import('../../server/dist/config/loader.js')).length > 0, 'the failed act is owed, not dropped');
    resetRunnerForTest(runner);
  });
});
