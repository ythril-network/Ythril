/**
 * A delete or wipe no vote decided is never answered as a vote that passed (bundle-106 PR A, lens finding F4; design v5 section 2.2 (3), W20).
 *
 * ## The rule, and where it was broken
 *
 * `spaceActFailureAnswer` and the two "queued" answers spoke for an act a VOTE had decided: `status: 'passed'`, the rounds, and the sentence
 * "The vote passed ...". An unnetworked space has no round, so a local delete or wipe whose act failed, or outlasted the door's budget, told its
 * operator that a vote had passed, in a body whose `rounds` was an empty list. The owner's ruling: an unnetworked delete or wipe is not a vote;
 * its ANSWERS are unchanged when it works (`204`, `200 { deleted }`), and when it does not, the failure goes through the ordinary senders in our own
 * words (the change did not complete, it is retried automatically, see the space's `actPending`), and a queued answer is `202 { queued: true,
 * retryAt? }` with no vote word. A networked act keeps every word it had.
 *
 * ## Rows
 *
 * - **R-F4a (failed):** a local wipe whose body throws is `500` with `code: 'space_act_failed'`, our sentence, no `status`, no `rounds`, no driver text and no
 *   vote word — on the admin route, on `delete_space_data` over MCP, and through the dispatcher (`500`, never the `422` of a refusal); a local delete likewise;
 *   a store outage keeps its `503` and `Retry-After` and gains no `status`.
 * - **R-F4b (queued):** a local wipe or delete that outlasts `SPACE_ACT_ANSWER_MS` is `202 { queued: true }` with no `status` and no vote word, and so is a repeat
 *   that finds the act owed with its retry ahead (`retryAt` named).
 * - **R-F4c (controls, passing on the base on purpose):** a NETWORKED wipe that fails is still `500` with `status: 'passed'`, the rounds and "vote passed"; a networked
 *   wipe past the budget is still `202 { status: 'passed', queued: true }`. They say the rows above are about the local case and not about every answer.
 *
 * Hooks run INSIDE the real bodies (`setSpaceActHooksForTest`); nothing replaces a body, and ordering is a latch, never a timer.
 *
 * Run: `node --test testing/standalone/an-unnetworked-act-is-not-a-vote-db.test.js` (a Mongo the harness accepts; a prior `npm run build:server`).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { removeInstanceDir } from './_vote-round-instance.mjs';
import { deferred, seedActEntry, untilRunnerIdle, resetRunnerForTest, entriesOf } from './_space-act-harness.mjs';
import {
  M1, tempInstance, networkOf, boot, seedFacts, doors, requireRunner, databaseTakesCollections, warmSpaceCreation,
} from './_round-open-fixtures.mjs';

const dir = tempInstance('ythril-not-a-vote-');
const skip = await mongoSkipReason();

/** Any word of a vote: a local act has none to say. */
const VOTE = /\bvot(?:e|es|ed|ing)\b/i;
const DRIVER_TEXT = /MONGO_SECRET_HOST|E11000/;

/** What a local act's failure or queued answer must not carry, said once for every row. */
function assertNoVote(body, what) {
  assert.ok(body && typeof body === 'object', `${what}: no body`);
  assert.equal('status' in body, false, `${what} answered status ${JSON.stringify(body.status)}: an unnetworked act is not a vote that passed (${JSON.stringify(body).slice(0, 240)})`);
  assert.equal('rounds' in body, false, `${what} carries a rounds list for an act no round decided`);
  assert.doesNotMatch(JSON.stringify(body), VOTE, `${what} speaks of a vote`);
  assert.doesNotMatch(JSON.stringify(body), DRIVER_TEXT, `${what} carries the driver's text`);
}

describe('R-F4: an unnetworked delete or wipe is not a vote, in its failure and in its queued answer', { skip }, () => {
  let mongo; let runner; let loader;
  before(async () => {
    mongo = await openTestMongo('not_a_vote');
    await databaseTakesCollections(mongo);
    await boot(dir, { networks: [] });
    await warmSpaceCreation();
    runner = await requireRunner();
  });
  after(async () => { try { resetRunnerForTest(runner); } catch { /* never loaded */ } await closeTestMongo(); removeInstanceDir(dir); });

  /** A fresh instance holding `notes` with data in it, unnetworked unless `networks` says so; the runner starts from none of a prior row's state. */
  async function fresh(networks = []) {
    resetRunnerForTest(runner);
    loader = await boot(dir, { spaces: ['notes'], networks });
    await seedFacts(mongo, 'notes', 2, `f4-${Math.random().toString(36).slice(2, 8)}`);
  }
  const failWipe = () => runner.setSpaceActHooksForTest({ beforeBatch: async () => { throw new Error('E11000 driver detail MONGO_SECRET_HOST'); } });
  const failDelete = () => runner.setSpaceActHooksForTest({ atFileTree: () => { throw new Error('EACCES MONGO_SECRET_HOST under the tree'); } });
  /** Park the body of `family` ('batch' for a wipe, 'tree' for a deletion) on a latch and shorten the door's budget so the door answers queued. */
  function outlastBudget(kind) {
    const hold = deferred();
    const park = async () => { hold.arrive(); await hold.promise; };
    runner.setSpaceActHooksForTest(kind === 'wipe' ? { beforeBatch: park } : { atFileTree: park });
    runner.setSpaceActKnobsForTest({ SPACE_ACT_ANSWER_MS: 25 });
    return hold;
  }
  const settle = async (hold) => { hold?.release(); await untilRunnerIdle(runner, loader); };

  it('R-F4a: a local wipe whose act fails is answered 500 in our words, with no status, no rounds and no vote word, on the admin route', async () => {
    await fresh();
    failWipe();
    const rest = await doors.wipeSpace('notes');
    assert.equal(rest.code, 500, JSON.stringify(rest.body)?.slice(0, 300));
    assert.equal(rest.body.code, 'space_act_failed');
    assertNoVote(rest.body, 'the admin wipe route');
    assert.match(rest.body.error, /did not complete/i, 'the failure is not said in the change\'s own words');
    assert.match(rest.body.error, /retried automatically/i);
    assert.match(rest.body.error, /actPending/, 'the sentence does not point at the field that shows what is owed');
    assert.ok(entriesOf(loader).length > 0, 'the failed act is owed, not dropped');
    resetRunnerForTest(runner);
  });

  it('R-F4a: a local wipe whose act fails is the same failure over MCP and through the dispatcher: space_act_failed, no status, no vote word, and 500 never 422', async () => {
    await fresh();
    failWipe();
    const tool = await doors.wipeTool({ space: 'notes' });
    assert.equal(tool.isError, true, tool.text);
    assert.equal(tool.structured?.code, 'space_act_failed');
    assertNoVote(tool.structured, 'delete_space_data (MCP)');
    assert.doesNotMatch(tool.text, VOTE, 'the tool text speaks of a vote');
    assert.doesNotMatch(tool.text, DRIVER_TEXT);
    assert.match(tool.text, /did not complete/i);
    await fresh();
    failWipe();
    const { callTool: dispatch } = await import('../../server/dist/mcp/call-tool.js');
    const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
    const adminMatrix = { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: Object.fromEntries(SPACE_AREAS.map(a => [a, 'admin'])) };
    const viaDoor = await dispatch({ name: 'delete_space_data', args: { space: 'notes', confirm: true },
      caller: { rights: adminMatrix, ip: '127.0.0.1', authMethod: 'pat', oidcSubject: null, transport: 'rest', tokenId: 't', tokenLabel: 't' } });
    assert.equal(viaDoor.result.structuredContent?.code, 'space_act_failed', JSON.stringify(viaDoor.result).slice(0, 300));
    assertNoVote(viaDoor.result.structuredContent, 'POST /api/delete_space_data');
    assert.equal(viaDoor.status, 500, 'a failed local act was answered with a refusal\'s status: the failure is the server\'s, 500 on every door');
    resetRunnerForTest(runner);
  });

  it('R-F4a: a local delete whose act fails is answered 500 in our words, with no status, no rounds and no vote word', async () => {
    await fresh();
    failDelete();
    const rest = await doors.deleteSpace('notes');
    assert.equal(rest.code, 500, JSON.stringify(rest.body)?.slice(0, 300));
    assert.equal(rest.body.code, 'space_act_failed');
    assertNoVote(rest.body, 'DELETE /api/spaces/:id');
    assert.match(rest.body.error, /did not complete/i);
    assert.match(rest.body.error, /actPending/);
    resetRunnerForTest(runner);
  });

  it('R-F4a: a store outage under a local wipe keeps its 503 and Retry-After and gains no status', async () => {
    await fresh();
    const { MongoNetworkError } = await import('mongodb');
    runner.setSpaceActHooksForTest({ beforeBatch: async () => { throw new MongoNetworkError('connection closed'); } });
    const rest = await doors.wipeSpace('notes');
    assert.equal(rest.code, 503, JSON.stringify(rest.body)?.slice(0, 300));
    assertNoVote(rest.body, 'the 503 of a local wipe');
    resetRunnerForTest(runner);
  });

  it('R-F4b: a local wipe that outlasts the door\'s budget is 202 { queued: true } with no status, no rounds and no vote word, on the admin route and over MCP', async () => {
    await fresh();
    let hold = outlastBudget('wipe');
    const rest = await doors.wipeSpace('notes');
    await settle(hold);   // before any assertion: a failed one must not leave the act parked in the one slot for the rows after it
    assert.equal(rest.code, 202, JSON.stringify(rest.body)?.slice(0, 300));
    assert.equal(rest.body.queued, true);
    assertNoVote(rest.body, 'the queued wipe answer');
    await fresh();
    hold = outlastBudget('wipe');
    const tool = await doors.wipeTool({ space: 'notes' });
    await settle(hold);
    assert.equal(tool.isError, false, tool.text);
    assert.equal(tool.structured?.queued, true);
    assertNoVote(Object.fromEntries(Object.entries(tool.structured ?? {}).filter(([k]) => k !== 'types')), 'delete_space_data queued (MCP)');
    assert.doesNotMatch(tool.text, VOTE, 'the queued tool text speaks of a vote');
    resetRunnerForTest(runner);
  });

  it('R-F4b: a local delete that outlasts the door\'s budget is 202 { queued: true } with no status, no rounds and no vote word', async () => {
    await fresh();
    const hold = outlastBudget('delete');
    const rest = await doors.deleteSpace('notes');
    await settle(hold);
    assert.equal(rest.code, 202, JSON.stringify(rest.body)?.slice(0, 300));
    assert.equal(rest.body.queued, true);
    assertNoVote(rest.body, 'the queued delete answer');
    resetRunnerForTest(runner);
  });

  it('R-F4b: a repeat that finds the local act owed with its retry ahead is 202 { queued: true, retryAt, repeated } with no status and no vote word', async () => {
    await fresh();
    const retryAt = new Date(Date.now() + 3_600_000).toISOString();
    await seedActEntry(loader, { kind: 'wipe', localId: 'notes', state: 'owed', attempts: 1, retryAt });
    const rest = await doors.wipeSpace('notes');
    assert.equal(rest.code, 202, JSON.stringify(rest.body)?.slice(0, 300));
    assert.equal(rest.body.queued, true);
    assert.equal(rest.body.retryAt, retryAt, 'the answer does not say when the act is retried');
    assert.equal(rest.body.repeated, true);
    assertNoVote(rest.body, 'the repeated local wipe answer');
    resetRunnerForTest(runner);
  });

  it('R-F4c (control): a NETWORKED wipe that fails is still 500 with status passed, the rounds and "vote passed"', async () => {
    await fresh([networkOf('club', [M1], { spaces: ['general', 'notes'] })]);
    failWipe();
    const rest = await doors.wipeSpace('notes');
    assert.equal(rest.code, 500, JSON.stringify(rest.body)?.slice(0, 300));
    assert.equal(rest.body.status, 'passed');
    assert.ok(Array.isArray(rest.body.rounds) && rest.body.rounds.length === 1, 'the networked failure lost its rounds');
    assert.match(rest.body.error, /vote passed/i);
    assert.doesNotMatch(JSON.stringify(rest.body), DRIVER_TEXT);
    resetRunnerForTest(runner);
    await fresh([networkOf('club', [M1], { spaces: ['general', 'notes'] })]);
    failWipe();
    const tool = await doors.wipeTool({ space: 'notes' });
    assert.equal(tool.structured?.status, 'passed');
    assert.match(tool.text, /vote passed/i);
    resetRunnerForTest(runner);
  });

  it('R-F4c (control): a NETWORKED wipe past the budget is still 202 { status: passed, queued: true } and its tool text still says the vote passed', async () => {
    await fresh([networkOf('club', [M1], { spaces: ['general', 'notes'] })]);
    let hold = outlastBudget('wipe');
    const rest = await doors.wipeSpace('notes');
    await settle(hold);
    assert.equal(rest.code, 202, JSON.stringify(rest.body)?.slice(0, 300));
    assert.equal(rest.body.status, 'passed');
    assert.equal(rest.body.queued, true);
    assert.ok(Array.isArray(rest.body.rounds) && rest.body.rounds.length === 1);
    await fresh([networkOf('club', [M1], { spaces: ['general', 'notes'] })]);
    hold = outlastBudget('wipe');
    const tool = await doors.wipeTool({ space: 'notes' });
    await settle(hold);
    assert.equal(tool.structured?.status, 'passed');
    assert.match(tool.text, /vote passed/i);
    resetRunnerForTest(runner);
  });
});
