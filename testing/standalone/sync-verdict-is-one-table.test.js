/**
 * One verdict for a sync cycle: `syncVerdict(members)` is ONE ordered table over the members' outcomes, and
 * `classifyMemberTurn` gives each member ONE outcome by one precedence (bundle-39, Q-331, Q-220; plan D2 v3 / v5, v6 S13).
 *
 * ## The failure that bought it
 *
 * A waited sync answered the same cycle three ways: the REST trigger said `ok: true` whenever the cycle RAN (every member
 * failed included), the MCP tool said `isError` from an error count written by hand in three branches, and the generic
 * `POST /api/network_sync` door answered 422 for the same thing. The owner (2026-11-01): "how can they differ? its
 * different doors to the same house?? the answer should be truthful". The verdict is now computed once, from the members'
 * outcomes, by the one table below, and every door, the history row and the metric read it.
 *
 * The regex pins that held the old hand-written rules (`a-refused-push-is-not-counted-as-pushed`'s engine text,
 * `read-tools-state-their-blind-spots`' `isError: result.errors > 0`) are replaced by THIS truth table: it asserts what
 * each mix of member outcomes comes to, not how a source file spells it.
 *
 * ## The contract this file asserts (the implementation is written against it)
 *
 * - `server/dist/sync/cycle-outcome.js` exports `syncVerdict(members)`, `members` being `[{ outcome, ... }]` (a MemberResult:
 *   `networkId`, `instanceId`, `label`, `outcome`, `reason`), and it returns `{ outcome, ok, status, code? }`:
 *   `outcome` the cycle's one word (success | partial | refused | failed | interrupted), `ok` true only for `success`,
 *   `status` the HTTP status the REST doors answer, `code` the refusal code a 502 / 503 carries.
 * - It also exports `classifyMemberTurn(exchangeOrThrown)`, returning the member's outcome word (a string, or an object whose
 *   `outcome` is that word). A thrown `PeerPagesBySeq` / `PeerBelowFloor` is `peer-too-old`; any other throw is `failed`;
 *   a `MemberExchange` (plus its `localFaults`) is read by the precedence below.
 * - Member outcome words (one closed list): success | catching-up | records-refused | peer-too-old | local-fault | interrupted | failed.
 *
 * ## The ordered table (first row that matches wins)
 *
 *  1. any `interrupted`                                                         -> interrupted, 503 `shutting_down`
 *  2. every member `success` (and none: `[]`)                                   -> success, 200
 *  3. no member in {success, catching-up, records-refused}, every one `peer-too-old` -> refused, 200
 *  4. no member in {success, catching-up, records-refused}, every member that is not `peer-too-old` is `local-fault` -> failed, 503 `sync_store_failed`
 *  5. no member in {success, catching-up, records-refused}                      -> failed, 502 `sync_failed`
 *     (Design v7: a too-old member no longer keeps a cycle in which nothing synced out of `failed`)
 *  6. otherwise                                                                 -> partial, 200
 *
 * A member's own outcome is the first that holds of: interrupted > failed > local-fault > peer-too-old > records-refused >
 * catching-up > success (v6 S13).
 *
 * Red at a0efade0a: neither export exists.
 *
 * Run: node --test testing/standalone/sync-verdict-is-one-table.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

/** Every member outcome word, in the plan's order. The closed list: a word added to the server is added here and to the table. */
const WORDS = ['success', 'catching-up', 'records-refused', 'peer-too-old', 'local-fault', 'interrupted', 'failed'];

let cycle, errors, floor;

before(async () => {
  cycle = await import('../../server/dist/sync/cycle-outcome.js');
  errors = await import('../../server/dist/util/errors.js');
  floor = await import('../../server/dist/sync/peer-floor.js');
});

const member = (outcome, i = 0) => ({ networkId: 'net', instanceId: `peer-${i}`, label: `Peer ${i}`, outcome, reason: `a reason for ${outcome}` });
const verdictOf = (outcomes) => {
  assert.equal(typeof cycle.syncVerdict, 'function', 'sync/cycle-outcome.js does not export syncVerdict: there is no one function a door asks for the cycle\'s verdict');
  const members = outcomes.map(member);
  const copy = structuredClone(members);
  const v = cycle.syncVerdict(members);
  assert.deepEqual(members, copy, 'syncVerdict changed the members it was given');
  return v;
};

/** The table, row by row, as the plan states it: the ONE place this file spells the rules out (the cases below are the authority; this cross-checks every mix). */
function reference(outcomes) {
  const has = (...ws) => outcomes.some(o => ws.includes(o));
  const every = (w) => outcomes.every(o => o === w);
  if (has('interrupted')) return { outcome: 'interrupted', ok: false, status: 503, code: 'shutting_down' };
  if (outcomes.length === 0 || every('success')) return { outcome: 'success', ok: true, status: 200 };
  if (!has('success', 'catching-up', 'records-refused') && every('peer-too-old')) return { outcome: 'refused', ok: false, status: 200 };
  if (!has('success', 'catching-up', 'records-refused')) {
    return outcomes.every(o => o === 'local-fault' || o === 'peer-too-old')
      ? { outcome: 'failed', ok: false, status: 503, code: 'sync_store_failed' }
      : { outcome: 'failed', ok: false, status: 502, code: 'sync_failed' };
  }
  return { outcome: 'partial', ok: false, status: 200 };
}

/** The pinned rows: what a mix comes to, in words, so a failure names the mix. */
const ROWS = [
  // row 2, and the empty network (a network with no members, or a start refused while closing is NOT this: it is row 1's answer at the door)
  { name: '[] (a network with no members) is success', mix: [], outcome: 'success', ok: true, status: 200 },
  { name: 'one success', mix: ['success'], outcome: 'success', ok: true, status: 200 },
  { name: 'every member success', mix: ['success', 'success', 'success'], outcome: 'success', ok: true, status: 200 },
  // catching-up is not success (decision 33): partial on its own, and beside success
  { name: 'catching-up alone is partial', mix: ['catching-up'], outcome: 'partial', ok: false, status: 200 },
  { name: 'success + catching-up is partial', mix: ['success', 'catching-up'], outcome: 'partial', ok: false, status: 200 },
  { name: 'records-refused alone is partial (the peer answered, it discarded some)', mix: ['records-refused'], outcome: 'partial', ok: false, status: 200 },
  // row 3
  { name: 'every member too old is refused', mix: ['peer-too-old', 'peer-too-old'], outcome: 'refused', ok: false, status: 200 },
  { name: 'one member too old and alone is refused', mix: ['peer-too-old'], outcome: 'refused', ok: false, status: 200 },
  { name: 'too old + success is partial', mix: ['peer-too-old', 'success'], outcome: 'partial', ok: false, status: 200 },
  { name: 'too old + catching-up is partial', mix: ['peer-too-old', 'catching-up'], outcome: 'partial', ok: false, status: 200 },
  // row 4
  { name: 'all local-fault is failed, 503 sync_store_failed', mix: ['local-fault'], outcome: 'failed', ok: false, status: 503, code: 'sync_store_failed' },
  { name: 'two local-faults are failed, 503 sync_store_failed', mix: ['local-fault', 'local-fault'], outcome: 'failed', ok: false, status: 503, code: 'sync_store_failed' },
  // row 5
  { name: 'every member failed is failed, 502 sync_failed', mix: ['failed', 'failed'], outcome: 'failed', ok: false, status: 502, code: 'sync_failed' },
  { name: 'one member failed and alone is failed, 502 sync_failed', mix: ['failed'], outcome: 'failed', ok: false, status: 502, code: 'sync_failed' },
  { name: 'local-fault + failed: nobody succeeded and not all are this instance\'s: 502 sync_failed', mix: ['local-fault', 'failed'], outcome: 'failed', ok: false, status: 502, code: 'sync_failed' },
  // rows 4 and 5 with a too-old member (Design v7), then row 6
  { name: 'success + failed is partial', mix: ['success', 'failed'], outcome: 'partial', ok: false, status: 200 },
  { name: 'success + local-fault is partial', mix: ['success', 'local-fault'], outcome: 'partial', ok: false, status: 200 },
  { name: 'records-refused + failed is partial (a member that answered is not "no member succeeded")', mix: ['records-refused', 'failed'], outcome: 'partial', ok: false, status: 200 },
  { name: 'catching-up + failed is partial', mix: ['catching-up', 'failed'], outcome: 'partial', ok: false, status: 200 },
  { name: 'too old + failed is failed, 502 sync_failed (v7: nothing synced)', mix: ['peer-too-old', 'failed'], outcome: 'failed', ok: false, status: 502, code: 'sync_failed' },
  { name: 'too old + local-fault is failed, 503 sync_store_failed (v7: every member that is not too old is a local fault)', mix: ['peer-too-old', 'local-fault'], outcome: 'failed', ok: false, status: 503, code: 'sync_store_failed' },
  { name: 'too old + local-fault + failed is failed, 502 sync_failed', mix: ['peer-too-old', 'local-fault', 'failed'], outcome: 'failed', ok: false, status: 502, code: 'sync_failed' },
  // row 1 beats every other row
  { name: 'interrupted alone', mix: ['interrupted'], outcome: 'interrupted', ok: false, status: 503, code: 'shutting_down' },
  { name: 'success + interrupted is interrupted, not partial', mix: ['success', 'interrupted'], outcome: 'interrupted', ok: false, status: 503, code: 'shutting_down' },
  { name: 'failed + interrupted is interrupted, not failed (a shutdown is not a sync result)', mix: ['failed', 'interrupted'], outcome: 'interrupted', ok: false, status: 503, code: 'shutting_down' },
  { name: 'local-fault + interrupted is interrupted, not a store failure', mix: ['local-fault', 'interrupted'], outcome: 'interrupted', ok: false, status: 503, code: 'shutting_down' },
];

/** Every order of a mix the table must not depend on: the original, reversed and each rotation. */
const orders = (mix) => [mix, [...mix].reverse(), ...mix.map((_, i) => [...mix.slice(i), ...mix.slice(0, i)])];

describe('syncVerdict is one ordered table over the members\' outcomes', () => {
  for (const row of ROWS) {
    it(row.name, () => {
      for (const mix of orders(row.mix)) {
        const v = verdictOf(mix);
        assert.equal(v.outcome, row.outcome, `${JSON.stringify(mix)} came to outcome '${v.outcome}', not '${row.outcome}'`);
        assert.equal(v.ok, row.ok, `${JSON.stringify(mix)}: ok is ${v.ok}; ok is true only when the outcome is success`);
        assert.equal(v.status, row.status, `${JSON.stringify(mix)}: the REST status is ${v.status}, not ${row.status}`);
        assert.equal(v.code, row.code, `${JSON.stringify(mix)}: the code is ${String(v.code)}, not ${String(row.code)}`);
      }
    });
  }

  it('every mix of up to three members comes to what the table says (the pinned rows above are the authority; this finds the mix no row names)', () => {
    let checked = 0;
    const seen = [[]];
    for (const a of WORDS) {
      seen.push([a]);
      for (const b of WORDS) {
        seen.push([a, b]);
        for (const c of WORDS) seen.push([a, b, c]);
      }
    }
    for (const mix of seen) {
      const want = reference(mix);
      const got = verdictOf(mix);
      assert.deepEqual({ outcome: got.outcome, ok: got.ok, status: got.status, code: got.code },
        { outcome: want.outcome, ok: want.ok, status: want.status, code: want.code },
        `the members ${JSON.stringify(mix)} came to ${JSON.stringify(got)}, not ${JSON.stringify(want)}`);
      checked++;
    }
    assert.equal(checked, 1 + 7 + 49 + 343, 'fixture check: the enumeration did not cover every mix');
  });

  it('`ok` is true for the one outcome `success` and for nothing else, over every mix', () => {
    for (const a of WORDS) for (const b of [...WORDS, null]) {
      const mix = b === null ? [a] : [a, b];
      const v = verdictOf(mix);
      assert.equal(v.ok, v.outcome === 'success', `${JSON.stringify(mix)}: ok ${v.ok} beside outcome '${v.outcome}'`);
    }
  });

  it('only the 502 and the 503 rows carry a code; a cycle that ran and says what happened is a 200 with none', () => {
    for (const a of WORDS) for (const b of [...WORDS, null]) {
      const mix = b === null ? [a] : [a, b];
      const v = verdictOf(mix);
      assert.equal(v.status >= 500, v.code !== undefined, `${JSON.stringify(mix)}: status ${v.status} and code ${String(v.code)} disagree`);
      assert.ok([200, 502, 503].includes(v.status), `${JSON.stringify(mix)}: status ${v.status} is none of 200, 502, 503`);
    }
  });
});

describe('classifyMemberTurn gives a member ONE outcome, by one precedence (v6 S13)', () => {
  const zero = () => ({ facts: 0, entities: 0, chrono: 0, filemeta: 0, edges: 0, links: 0, files: 0 });
  /** A member exchange that moved nothing, with the facets a case sets. */
  const exchange = (over = {}) => ({ pulled: zero(), pushed: zero(), incomplete: [], capped: [], refused: [], recorded: [], held: [], declined: [], localFaults: [], ...over });
  const wordOf = (r) => (typeof r === 'string' ? r : r?.outcome);
  const classify = (x) => {
    assert.equal(typeof cycle.classifyMemberTurn, 'function', 'sync/cycle-outcome.js does not export classifyMemberTurn: the two doors classify a member\'s turn by their own hand-written copies');
    return wordOf(cycle.classifyMemberTurn(x));
  };

  const EXCHANGES = [
    ['an exchange that moved everything is success', {}, 'success'],
    ['a pull that stopped at the cap is catching-up', { capped: ['facts of s'] }, 'catching-up'],
    ['records the peer refused are records-refused', { refused: ['facts: 2 refused by the peer'] }, 'records-refused'],
    ['refused records beat catching-up', { refused: ['facts: 2 refused'], capped: ['facts of s'] }, 'records-refused'],
    ['a page that failed to land on this instance is local-fault', { localFaults: ['facts of s: this instance could not land the page'] }, 'local-fault'],
    ['local-fault beats refused records and catching-up', { localFaults: ['facts of s'], refused: ['x'], capped: ['y'] }, 'local-fault'],
    ['a transfer the peer left incomplete is failed', { incomplete: ['facts of s: error'] }, 'failed'],
    ['failed beats local-fault, refused records and catching-up', { incomplete: ['facts'], localFaults: ['entities'], refused: ['x'], capped: ['y'] }, 'failed'],
    ['a family held by the peer or by this instance is not a failure (held is its own list)', { held: [{ spaceId: 's', reason: 'held by the member' }] }, 'success'],
    ['a declined space is not a failure', { declined: ['s'] }, 'success'],
  ];
  for (const [name, over, outcome] of EXCHANGES) {
    it(name, () => { assert.equal(classify(exchange(over)), outcome); });
  }

  it('a thrown PeerPagesBySeq (a pre-6.0 peer) is peer-too-old', () => {
    assert.equal(classify(new errors.PeerPagesBySeq()), 'peer-too-old');
  });
  it('a thrown PeerBelowFloor (a peer below the version floor) is peer-too-old, the same word, no counter move', () => {
    assert.equal(typeof floor.PeerBelowFloor, 'function', 'sync/peer-floor.js does not export PeerBelowFloor: a pre-6.0 peer after its first refusal is a plain Error and counts as failing every cycle');
    assert.equal(classify(new floor.PeerBelowFloor('peer is below the floor')), 'peer-too-old');
  });
  it('any other throw is failed (a peer\'s transport or JSON fault, an unknown error)', () => {
    assert.equal(classify(new Error('connect ECONNREFUSED')), 'failed');
    assert.equal(classify(new TypeError('x is not a function')), 'failed');
  });
});

describe('no door keeps its own copy of the verdict', () => {
  /**
   * The lines of a server source (comments out) that match `re`, as `file:line: text`, so a failure names the line to look at and not the
   * whole file. Block comments are replaced by their newlines, so the line numbers are the file's own.
   */
  const offenders = (rel, re) => {
    const raw = fs.readFileSync(new URL(`../../server/src/${rel}`, import.meta.url), 'utf8');
    const code = stripComments(raw.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, '')));
    return code.split('\n').flatMap((line, i) => (re.test(line) ? [`server/src/${rel}:${i + 1}: ${line.trim()}`] : []));
  };

  it('the MCP network_sync tool decides isError from the verdict, not from an error count written in each branch', () => {
    assert.deepEqual(offenders('mcp/tools/sync.ts', /errors\s*>\s*0/), [],
      'mcp/tools/sync.ts still decides a waited answer by `errors > 0` (once per branch: network, peer, all networks) instead of by the verdict');
    assert.deepEqual(offenders('mcp/tools/sync.ts', /totalErrors\s*>\s*0/), [], 'the all-networks branch still decides `isError` by `totalErrors > 0`');
  });

  it('the REST trigger does not answer `ok: true` for every cycle that ran', () => {
    assert.deepEqual(offenders('sync/trigger.ts', /ok:\s*true,\s*status:\s*'completed'/), [],
      'sync/trigger.ts still answers `ok: true, status: \'completed\'` whatever the members came to');
  });
});
