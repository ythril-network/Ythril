/**
 * The unresolved versions of a space are counted, and the count is said where an operator looks (Q-624 design §13, S8).
 *
 * ## What it holds
 *
 *  1. `forkCountsOf(space)` answers, per forking kind, how many fork rows the space holds and how many of them carry a `_resolvedElsewhere` mark (a
 *     decision another instance already made, still owed here). The kinds are read from the planner, floored; a fork row of every kind is seeded;
 *  2. the gauge `ythril_unresolved_forks{kind,resolvedElsewhere}` is that count summed over the spaces, at scrape time, and it is a budgeted
 *     collector (`TIMED_COLLECTORS`), so a slow store cannot stretch a scrape;
 *  3. the `MERKLE_DIVERGENCE` line of a space holding marked forks says how many versions await a decision in Review, and the line of a space holding
 *     none is unchanged. The count is read in the mismatch branch alone: a match asks nothing of the store.
 *
 * Run: node --test testing/standalone/the-unresolved-forks-are-counted-db.test.js  (requires a prior server build and the test MongoDB)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';
import { FORK_KINDS, initForkFixtures, seedFork } from './_fork-kinds.mjs';
import { stripComments } from './_strip-comments.mjs';

const skip = await mongoSkipReason();
const A = 'q624countsa';
const B = 'q624countsb';
const MARK = [{ by: 'other-instance', at: '2026-10-01T00:00:00.000Z', seq: 9, proven: true }];

describe('the unresolved versions are counted', { skip }, () => {
  let door; let counts; let registry; let report; let say;
  before(async () => {
    door = await openPushDoor({ suite: 'q624_forkcounts', spaces: [{ id: A, label: 'A', folders: [], meta: {} }, { id: B, label: 'B', folders: [], meta: {} }] });
    await initForkFixtures();
    counts = await import('../../server/dist/brain/fork-counts.js').catch(() => ({}));
    registry = await import('../../server/dist/metrics/registry.js');
    ({ reportDivergence: report } = await import('../../server/dist/sync/merkle-check.js').catch(() => ({})));
    const { subscribeLogLines } = await import('../../server/dist/util/log.js');
    /** The MERKLE_DIVERGENCE line `reportDivergence` says for `facts`, captured from the log. */
    say = async (facts) => { const out = []; const off = subscribeLogLines(l => out.push(String(l))); try { await report(facts); } finally { off(); } return out.find(l => l.includes('MERKLE_DIVERGENCE')) ?? ''; };
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.wipe(A); await door.wipe(B); });

  /** In space `S`, per kind: a parent, one fork, and (when `marked`) a second fork carrying the mark. */
  async function seedKinds(S, { marked }) {
    for (const [kind, k] of Object.entries(FORK_KINDS)) {
      const parent = k.row(S, `p-${kind}`, 5, {});
      await door.coll(S, k.family).insertOne(parent);
      const identity = parent.from === undefined ? {} : { from: parent.from, to: parent.to, label: parent.label, fromKind: parent.fromKind, toKind: parent.toKind };
      await seedFork(door, S, kind, parent._id, 5, { ...identity, ...k.alt });
      if (marked) await seedFork(door, S, kind, parent._id, 5, { ...identity, [k.main]: 'a third version', _resolvedElsewhere: MARK });
    }
  }

  const scrape = async () => { registry.beginScrape(); try { return await registry.register.metrics(); } finally { registry.endScrape(); } };
  const sample = (text, kind, marked) => {
    const m = new RegExp(`^ythril_unresolved_forks\\{[^}]*\\}\\s+(\\S+)$`, 'm');
    const hit = text.split('\n').find(l => l.startsWith('ythril_unresolved_forks{') && l.includes(`kind="${kind}"`) && l.includes(`resolvedElsewhere="${marked}"`));
    return hit === undefined ? undefined : Number(m.exec(hit)?.[1]);
  };

  it('forkCountsOf answers every forking kind: the fork rows, and how many carry the mark', async () => {
    assert.equal(typeof counts.forkCountsOf, 'function', 'brain/fork-counts.js exports no forkCountsOf: nothing counts the unresolved versions of a space');
    await seedKinds(A, { marked: true });
    const got = await counts.forkCountsOf(A);
    const kinds = Object.keys(FORK_KINDS);
    assert.ok(kinds.length >= 4, `only ${kinds.length} forking kinds derived`);
    assert.deepEqual(Object.keys(got).sort(), kinds.sort(), 'the answer does not name every forking kind');
    for (const kind of kinds) assert.deepEqual(got[kind], { unresolved: 2, resolvedElsewhere: 1 }, `${kind}: wrong counts`);
  });

  it('a space with no fork answers zero for every kind', async () => {
    const got = await counts.forkCountsOf(B);
    for (const [kind, c] of Object.entries(got)) assert.deepEqual(c, { unresolved: 0, resolvedElsewhere: 0 }, kind);
  });

  it('the gauge is the count summed over the spaces, split by the mark, and its collector is budgeted', async () => {
    assert.ok(registry.TIMED_COLLECTORS.includes('unresolved_forks'), 'the collector is not in TIMED_COLLECTORS: a slow store would stretch the scrape');
    await seedKinds(A, { marked: true });
    await seedKinds(B, { marked: false });
    const text = await scrape();
    for (const kind of Object.keys(FORK_KINDS)) {
      assert.equal(sample(text, kind, 'true'), 1, `${kind}: the marked forks of A are not counted`);
      assert.equal(sample(text, kind, 'false'), 2, `${kind}: the other forks (one in A, one in B) are not counted`);
    }
  });

  it('the divergence line says how many versions await a decision, and is the old line when none does', async () => {
    assert.equal(typeof report, 'function', 'sync/merkle-check.js exports no reportDivergence: the line is not said by one function');
    const facts = { spaceId: A, peerLabel: 'P', peerInstanceId: 'p1', networkLabel: 'N', localRoot: 'aaa', localLeaves: 3, peerRoot: 'bbb', peerLeaves: 4 };
    const none = await say(facts);
    assert.match(none, /MERKLE_DIVERGENCE: space 'q624countsa'/);
    assert.doesNotMatch(none, /await a decision/, 'a space with no marked fork says forks await a decision');
    await seedKinds(A, { marked: true });
    const some = await say(facts);
    const n = Object.keys(FORK_KINDS).length;
    assert.match(some, new RegExp(`${n} unresolved versions here were resolved on another instance and await a decision in Review`), some);
  });

  it('a store that cannot answer the count does not change the verdict: the line is the old one', async () => {
    const facts = { spaceId: 'no-such-space-for-the-count', peerLabel: 'P', peerInstanceId: 'p1', networkLabel: 'N', localRoot: 'aaa', localLeaves: 3, peerRoot: 'bbb', peerLeaves: 4 };
    assert.doesNotMatch(await say(facts), /await a decision/);
  });

  it('the count is read in the mismatch branch alone', () => {
    const src = stripComments(fs.readFileSync('server/src/sync/merkle-check.ts', 'utf8'));
    const matchBranch = src.slice(src.indexOf("log.info(`Merkle OK"));
    assert.doesNotMatch(matchBranch, /forkCountsOf|reportDivergence/, 'the match branch reads the forks');
    assert.match(src, /await reportDivergence\(/, 'the mismatch branch does not build its line through reportDivergence');
  });
});
