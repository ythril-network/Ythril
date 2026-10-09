/**
 * How the rounds of a network ended are read through ONE act, `voteOutcomesAct(id, limit)`, which REST
 * (`GET /api/networks/:id/vote-outcomes`) and MCP (`network_vote_outcomes`) both call.
 *
 * ## What it holds
 *
 * - the answer is `{ outcomes, total }`, newest first: `total` is the whole log, so a short page is distinguishable from a short
 *   log;
 * - `limit` is an integer from 1 to 50, default 20, and every other value is refused with ONE sentence naming the bounds —
 *   the same refusal whatever the wrong value is, because the bound is what the caller needs to read. The empty string is the
 *   default (REST reaches the act with a query string's text). The parse is the one `syncHistoryAct` uses, parameterised by
 *   its bounds: the sentence is written once in `server/src`, not once per act;
 * - a network that does not exist is the same 404 `Network not found` every network act gives;
 * - the log carries no credential and no proposal body, only what the operator reads.
 *
 * The routes' and the tool's registration (rights, capability map, schema) are held by the registry gates; this holds what the
 * act answers, which is what both doors say.
 *
 * Run: node --test testing/standalone/a-vote-outcomes-are-read-by-one-act.test.js  (requires a prior server build)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { trackedSources } from './_sources.mjs';
import { tempInstanceDir, removeInstanceDir, bootInstance } from './_vote-round-instance.mjs';

const SELF = 'aaaaaaaa-0000-4000-8000-000000005e1f';
const dir = tempInstanceDir('ythril-vote-outcomes-');
const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const entry = (i, over = {}) => ({
  roundId: `r${String(i).padStart(2, '0')}`, type: 'remove', space: null, subjectLabel: `Subject ${i}`, openedAt: iso(NOW - 7_200_000),
  deadline: iso(NOW - 3_600_000), concludedAt: iso(NOW + i * 1000), outcome: 'expired', yes: 0, veto: 0, eligible: 2, ...over,
});

let act;
before(async () => {
  await bootInstance(dir, {
    instanceId: SELF,
    networks: [
      { id: 'full', label: 'Full', type: 'closed', origin: 'created', syncSchedule: '', spaces: ['general'], members: [], votingDeadlineHours: 24, createdAt: '2026-01-01T00:00:00.000Z', pendingRounds: [], roundOutcomes: Array.from({ length: 50 }, (_, i) => entry(i)) },
      { id: 'empty', label: 'Empty', type: 'closed', origin: 'created', syncSchedule: '', spaces: ['general'], members: [], votingDeadlineHours: 24, createdAt: '2026-01-01T00:00:00.000Z', pendingRounds: [] },
    ],
  });
  ({ voteOutcomesAct: act } = await import('../../server/dist/networks/vote-acts.js'));
});
after(() => removeInstanceDir(dir));

describe('what the act answers', () => {
  it('is exported by the one module both doors read their acts from', () => {
    assert.equal(typeof act, 'function', 'networks/vote-acts.ts exports no voteOutcomesAct');
  });

  it('newest first, with the whole log counted beside the page', async () => {
    const res = await act('full', 3);
    assert.equal(res.status, 200, JSON.stringify(res));
    assert.deepEqual(res.body.outcomes.map(e => e.roundId), ['r49', 'r48', 'r47']);
    assert.equal(res.body.total, 50);
  });

  it('the default is 20', async () => {
    for (const none of [undefined, '']) {
      const res = await act('full', none);
      assert.equal(res.status, 200);
      assert.equal(res.body.outcomes.length, 20, `limit ${JSON.stringify(none)} did not mean the default`);
      assert.equal(res.body.total, 50);
    }
  });

  it('a network with no log answers an empty page, not an error', async () => {
    assert.deepEqual((await act('empty', 20)).body, { outcomes: [], total: 0 });
  });

  it('an unknown network is the 404 every network act gives', async () => {
    const res = await act('nope', 20);
    assert.deepEqual([res.status, res.error], [404, 'Network not found']);
  });

  it('shows no credential even for a join round whose invite-key hash was recorded (the poll may keep it; the door must not show it)', async () => {
    const { getConfig } = await import('../../server/dist/config/loader.js');
    const { recordRoundOutcome } = await import('../../server/dist/networks/round-outcomes.js');
    const net = getConfig().networks.find(n => n.id === 'empty');
    recordRoundOutcome(net, {
      roundId: 'join-1', type: 'join', subjectInstanceId: 'j', subjectLabel: 'Joiner', subjectUrl: '', openedAt: iso(NOW - 7_200_000), deadline: iso(NOW - 3_600_000),
      votes: [], concluded: true, passed: false, outcome: 'vetoed', concludedAt: iso(NOW), inviteKeyHash: 'SECRET-INVITE-HASH', pendingMember: { instanceId: 'j', tokenHash: 'SECRET-TOKEN-HASH' },
    }, NOW);
    const res = await act('empty', 50);
    assert.deepEqual(res.body.outcomes.map(e => e.roundId), ['join-1']);
    assert.ok(!/SECRET|hash/i.test(JSON.stringify(res.body)), `a credential reached the outcome door: ${JSON.stringify(res.body)}`);
    net.roundOutcomes = [];
  });

  it('answers the fields the operator reads and no others', async () => {
    const e = (await act('full', 1)).body.outcomes[0];
    for (const k of ['roundId', 'type', 'outcome', 'concludedAt', 'deadline', 'openedAt', 'yes', 'veto', 'eligible']) assert.ok(k in e, `the entry has no ${k}`);
    assert.ok(!/hash|token|votes|pendingMember|pendingMeta/i.test(Object.keys(e).join(' ')), `the entry carries ${Object.keys(e).join(', ')}`);
  });
});

describe('limit: 1 to 50, one refusal for everything else', () => {
  const ok = [[1, 1], [50, 50], ['1', 1], ['50', 50], [20, 20], ['7', 7]];
  const refused = [0, 51, -1, 100, 'abc', 1.5, '1.5', '0', '51', '-1', NaN, null, {}, []];

  for (const [given, length] of ok) {
    it(`${JSON.stringify(given)} is taken: ${length} row(s)`, async () => {
      const res = await act('full', given);
      assert.equal(res.status, 200, JSON.stringify(res));
      assert.equal(res.body.outcomes.length, length);
    });
  }

  const sentences = new Set();
  for (const given of refused) {
    it(`${Object.is(given, NaN) ? 'NaN' : JSON.stringify(given)} is refused with 400`, async () => {
      const res = await act('full', given);
      assert.equal(res.status, 400, `limit ${JSON.stringify(given)} was answered ${res.status}`);
      assert.match(res.error, /limit/);
      assert.match(res.error, /\b1\b/);
      assert.match(res.error, /\b50\b/);
      sentences.add(res.error);
    });
  }

  it('and it is the same sentence every time', () => {
    assert.equal(sentences.size, 1, `the refusal reads differently by value: ${[...sentences].join(' | ')}`);
  });
});

describe('the limit is parsed in one place, for both acts that take one', () => {
  it('syncHistoryAct still answers 1 to 100 and refuses the rest in its own bounds', async () => {
    const { syncHistoryAct } = await import('../../server/dist/networks/vote-acts.js');
    for (const bad of [0, 101, 'abc', 1.5, -1]) {
      const res = await syncHistoryAct('full', bad);
      assert.equal(res.status, 400);
      assert.match(res.error, /\b1\b.*\b100\b/);
    }
  });

  it('the refusal sentence is written once in server/src, and both acts call what writes it', () => {
    const files = trackedSources('server/src', { untracked: true, floor: 100 });
    const holders = files.filter(f => /must be an integer from/.test(stripComments(fs.readFileSync(f, 'utf8'))));
    assert.equal(holders.length, 1, `the sentence is written in ${holders.length} files: ${holders.join(', ')}`);
    const acts = stripComments(fs.readFileSync('server/src/networks/vote-acts.ts', 'utf8'));
    assert.doesNotMatch(acts, /must be an integer from/, 'the acts spell the refusal themselves instead of calling the parse that owns it');
    const sync = /syncHistoryAct[\s\S]*?\n\}/.exec(acts)?.[0] ?? '';
    const outcomes = /voteOutcomesAct[\s\S]*?\n\}/.exec(acts)?.[0] ?? '';
    assert.ok(sync && outcomes, 'an act is gone — re-anchor this gate');
    const call = (s) => /(?:const|let)\s+\w+\s*=\s*([A-Za-z_$][\w$]*)\s*\(/.exec(s)?.[1];
    assert.ok(call(outcomes) && call(outcomes) === call(sync), `the two acts parse their limit through different functions (${call(sync)} / ${call(outcomes)})`);
  });
});
