/**
 * A file-stamp verdict says "likely stamped here" only when EVERY piece of evidence holds, and says why it cannot
 * tell otherwise (`Q-433`).
 *
 * ## What the verdict is about
 *
 * Between 4.0 and 5.5 a receiver that pulled a peer's file bytes wrote the file row under its OWN author and a fresh
 * local seq (a "stamp"). `file_stamp_report` lists the rows that may be such a stamp, and says nothing it cannot back:
 * the owner's ruling (D-22, D-26) is a REPORT, never a repair, so a row wrongly called "likely" sends an operator to
 * correct the metadata of a file that was genuinely theirs. The only party that knows is the peer, so the verdict is a
 * pure function of what this row holds and what each peer's file feed said about the same path.
 *
 * ## The contract this file pins (the plan's items 3, 9, 10, 11, 14 and rev 3 R1-R6)
 *
 * `stampVerdict({ selfId, ours, evidence })`, PURE:
 *
 *  - `selfId` — this instance's id. Required: an absent one would make "the peer's author is not us" true of every
 *    author-less row, so it THROWS.
 *  - `ours` — the local row: `{ seq, createdAt, sha256?, description?, descriptionSource?, tags?, properties? }`.
 *  - `evidence` — one entry per peer asked: `{ peerId, row?, failure? }`. `row` is what that peer's feed holds for the
 *    path: `{ author, seq, createdAt, updatedAt?, sha256?, description?, tags?, properties? }` (`author` is the author's
 *    instance id). `failure` is one of `unreachable | refused | too-old | address-refused | no-credentials |
 *    not-checked`. An entry with neither holds nothing.
 *  - the answer — `{ verdict, reason, peerId? }`: `verdict` is `'likely-stamped-here'` or `'cannot-tell'`; `reason` is a
 *    value of `FILE_STAMP_REASONS` (a frozen enum of FIXED strings, so no peer text reaches a report through it);
 *    `peerId` names the peer whose evidence made it likely, and is absent otherwise.
 *
 * The rows below keys the enum by the names this file uses; the implementation's enum has those keys, with whatever
 * sentences it chooses as values.
 *
 * ## How the table is built, and why it is tight
 *
 * `BASE` is a single peer whose row satisfies every condition at once. Every other single-peer row differs from it in
 * EXACTLY ONE condition and must answer "cannot tell" with the reason that condition owns. So an implementation that
 * drops, inverts or weakens any one condition fails the row that owns it — there is no row that two conditions could
 * both explain. The enum is then held to the table from the other side: every value of `FILE_STAMP_REASONS` must come
 * out of some row, so a reason nobody can reach (or a new one added without a row) fails here.
 *
 * Run: node --test testing/standalone/a-file-stamp-verdict-says-likely-only-on-every-piece-of-evidence.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Top-level, because the table below is built from these when the file loads. A module that is not there fails the
// whole file with its own name in the message, which is the red this test is written to start from.
const { stampVerdict, FILE_STAMP_REASONS, CLOCK_TOLERANCE_MS } = await import('../../server/dist/files/file-stamp-report.js');
const { MACHINE_MADE_SOURCES } = await import('../../server/dist/files/derived-fields.js');

const LIKELY = 'likely-stamped-here';
const CANNOT = 'cannot-tell';

const SELF = 'self-instance';
const P = 'peer-p';
const Q = 'peer-q';
const OTHER = 'peer-other';
const HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);
const OURS_AT = Date.parse('2026-09-01T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const DAY = 86_400_000;

/** A deep-frozen copy: a verdict that edits its input throws in strict mode, so purity is checked by every row. */
function frozen(value) {
  if (value && typeof value === 'object') { for (const v of Object.values(value)) frozen(v); Object.freeze(value); }
  return value;
}

/** The local row of a stamp: authored here, created later than the peer's copy, no content of its own. */
const ours = (over = {}) => ({ seq: 12, createdAt: iso(OURS_AT), sha256: HASH, tags: [], ...over });
/** What peer `P`'s feed holds for the same path when it really is the author and every condition is met. */
const peerRow = (over = {}) => ({ author: P, seq: 5, createdAt: iso(OURS_AT - DAY), updatedAt: iso(OURS_AT - DAY), sha256: HASH, tags: [], ...over });
const asked = (peerId, row) => ({ peerId, row });
const verdictOf = (input) => stampVerdict(frozen(structuredClone({ selfId: SELF, ...input })));

const R = (key) => {
  assert.ok(FILE_STAMP_REASONS && key in FILE_STAMP_REASONS,
    `FILE_STAMP_REASONS has no ${key}; it has: ${Object.keys(FILE_STAMP_REASONS ?? {}).join(', ')}`);
  return FILE_STAMP_REASONS[key];
};

/** Every reason a row of the table came out with — read after the table ran, to hold the enum to it. */
const observed = new Set();

/** A single-peer row of the table: the input, and the one condition it breaks (`null` for the base). */
const single = (over) => ({ ours: ours(over.ours), evidence: [asked(P, over.row === null ? undefined : peerRow(over.row))] });

describe('the enum and the constant', () => {
  it('the reasons are fixed strings in a frozen object, each different', () => {
    assert.ok(Object.isFrozen(FILE_STAMP_REASONS), 'FILE_STAMP_REASONS must be frozen: a reason is a constant, not a place for peer text');
    const values = Object.values(FILE_STAMP_REASONS);
    assert.ok(values.length >= 12, `only ${values.length} reasons — the table below needs a reason for each way a verdict can fail`);
    for (const v of values) assert.ok(typeof v === 'string' && v.trim() !== '', `a reason is not a non-empty string: ${JSON.stringify(v)}`);
    assert.equal(new Set(values).size, values.length, 'two reasons share one sentence, so a reader cannot tell the conditions apart');
  });

  it('the clock tolerance is two minutes, one named constant', () => {
    assert.equal(CLOCK_TOLERANCE_MS, 120_000);
  });
});

describe('the base row: one peer, every condition met', () => {
  it('is LIKELY, and names the peer whose evidence it is', () => {
    const v = verdictOf(single({}));
    assert.equal(v.verdict, LIKELY, JSON.stringify(v));
    assert.equal(v.reason, R('LIKELY'));
    assert.equal(v.peerId, P);
    observed.add(v.reason);
  });

  it('is the same answer every time, and never edits what it was handed', () => {
    const input = frozen(structuredClone({ selfId: SELF, ...single({}) }));
    assert.deepEqual(stampVerdict(input), stampVerdict(input));
  });
});

describe('one condition broken at a time, each answers "cannot tell" with its own reason', () => {
  /** [name, input, reason key]: every row differs from the base in exactly the condition its name says. */
  const ROWS = [
    // The author is the evidence (rev 3 R4: the asked peer's answered author must BE that peer).
    ['the peer says the author is THIS instance (an own pushed upload, or a stamp that already reached it)', single({ row: { author: SELF } }), 'PEER_SAYS_SELF'],
    ['the peer names a third author (it is a relay: the stamp may live on it as well)', single({ row: { author: OTHER } }), 'RELAYED'],
    ['the peer row has no author', single({ row: { author: undefined } }), 'PEER_ROW_INCOMPLETE'],
    ['the peer holds nothing for the path', single({ row: null }), 'PEER_HOLDS_NOTHING'],
    // The placeholder test is the seq (rev 3 R3): an arrival placeholder carries seq 0.
    ['the peer seq is 0 (an arrival placeholder)', single({ row: { seq: 0 } }), 'PEER_HOLDS_PLACEHOLDER'],
    ['the peer seq is absent', single({ row: { seq: undefined } }), 'PEER_HOLDS_PLACEHOLDER'],
    // Creation order needs a margin (item 10): strictly MORE than the tolerance earlier.
    ['the peer created it exactly the tolerance earlier (within it)', single({ row: { createdAt: iso(OURS_AT - CLOCK_TOLERANCE_MS) } }), 'CREATED_NOT_EARLIER'],
    ['the peer created it one minute earlier (within the tolerance)', single({ row: { createdAt: iso(OURS_AT - 60_000) } }), 'CREATED_NOT_EARLIER'],
    ['the peer created it at the very same instant', single({ row: { createdAt: iso(OURS_AT) } }), 'CREATED_NOT_EARLIER'],
    ['the peer created it LATER', single({ row: { createdAt: iso(OURS_AT + DAY) } }), 'CREATED_NOT_EARLIER'],
    ['the peer createdAt cannot be parsed', single({ row: { createdAt: 'last tuesday' } }), 'CREATED_UNPARSABLE'],
    ['the peer createdAt is absent', single({ row: { createdAt: undefined } }), 'CREATED_UNPARSABLE'],
    ['OUR createdAt cannot be parsed', single({ ours: { createdAt: 'not a date' } }), 'CREATED_UNPARSABLE'],
    // An absent hash is never a match, on either side (item 14) — and absent against absent is the case that looks equal.
    ['neither side has a sha256 (absent equals absent is not a match)', single({ ours: { sha256: undefined }, row: { sha256: undefined } }), 'HASH_UNKNOWN'],
    ['only the peer has a sha256', single({ ours: { sha256: undefined } }), 'HASH_UNKNOWN'],
    ['only this instance has a sha256', single({ row: { sha256: undefined } }), 'HASH_UNKNOWN'],
    ['the two sha256 differ (other bytes)', single({ row: { sha256: OTHER_HASH } }), 'HASH_DIFFERS'],
    // Content (item 9): a description a person wrote HERE is an obstacle; the peer's own words copied by the 5.6.3 drain are not.
    ['a description was written here and differs from the peer\'s', single({ ours: { description: 'my own words' }, row: { description: 'the author\'s words' } }), 'EDITED_HERE'],
    ['a description was written here and the peer has none', single({ ours: { description: 'my own words' } }), 'EDITED_HERE'],
    ['tags were set here that the peer does not have', single({ ours: { tags: ['mine'] } }), 'EDITED_HERE'],
    ['properties were set here that differ from the peer\'s', single({ ours: { properties: { k: 1 } }, row: { properties: { k: 2 } } }), 'EDITED_HERE'],
  ];

  for (const [name, input, key] of ROWS) {
    it(`${name}`, () => {
      const v = verdictOf(input);
      assert.equal(v.verdict, CANNOT, `${name}: called ${v.verdict} (${JSON.stringify(v)})`);
      assert.equal(v.reason, R(key), `${name}: the reason is ${JSON.stringify(v.reason)}, not ${key}`);
      assert.equal(v.peerId, undefined, 'a "cannot tell" names no peer as its evidence');
      observed.add(v.reason);
    });
  }
});

describe('the rows that are not an obstacle', () => {
  it('one tick past the tolerance is enough', () => {
    const v = verdictOf(single({ row: { createdAt: iso(OURS_AT - CLOCK_TOLERANCE_MS - 1) } }));
    assert.equal(v.verdict, LIKELY, JSON.stringify(v));
  });

  it('creation times are compared as instants, whatever offset each is written in', () => {
    // 02:00+02:00 is 00:00Z, twelve hours before ours.
    const v = verdictOf(single({ row: { createdAt: '2026-09-01T02:00:00.000+02:00' } }));
    assert.equal(v.verdict, LIKELY, JSON.stringify(v));
  });

  it('a description copied from the peer by the drain (it equals the peer\'s) is no obstacle, though no source marks it', () => {
    const v = verdictOf(single({
      ours: { description: 'what the author wrote', tags: ['a'], properties: { k: 1 } },
      row: { description: 'what the author wrote', tags: ['a'], properties: { k: 1 } },
    }));
    assert.equal(v.verdict, LIKELY, JSON.stringify(v));
  });

  it('a row with no content of its own is no obstacle when the peer has some (nothing was edited here)', () => {
    const v = verdictOf(single({ row: { description: 'the author\'s words', tags: ['t'], properties: { k: 1 } } }));
    assert.equal(v.verdict, LIKELY, JSON.stringify(v));
  });

  for (const source of MACHINE_MADE_SOURCES) {
    it(`a description this instance made from the bytes (descriptionSource ${source}) is no obstacle though it differs`, () => {
      const v = verdictOf(single({
        ours: { description: 'what a model said', descriptionSource: source },
        row: { description: 'what the author wrote' },
      }));
      assert.equal(v.verdict, LIKELY, JSON.stringify(v));
    });
  }

  it('a source that is not machine-made is not one', () => {
    const v = verdictOf(single({
      ours: { description: 'my words', descriptionSource: 'typed' },
      row: { description: 'the author\'s words' },
    }));
    assert.equal(v.verdict, CANNOT);
    assert.equal(v.reason, R('EDITED_HERE'));
  });
});

describe('every piece of evidence is needed: no row of the table is satisfied by fewer', () => {
  it('breaking any ONE condition of the base row takes it from likely to cannot-tell', () => {
    const base = verdictOf(single({}));
    assert.equal(base.verdict, LIKELY);
    const breaks = {
      author: { row: { author: SELF } },
      seq: { row: { seq: 0 } },
      createdAt: { row: { createdAt: iso(OURS_AT) } },
      sha256: { row: { sha256: OTHER_HASH } },
      content: { ours: { description: 'mine' }, row: { description: 'theirs' } },
    };
    for (const [condition, over] of Object.entries(breaks)) {
      assert.equal(verdictOf(single(over)).verdict, CANNOT, `with ${condition} broken the verdict is still likely: some piece of evidence is not needed`);
    }
  });

  it('an absent self id throws, rather than treating every author-less row as "not us"', () => {
    for (const selfId of [undefined, '', null]) {
      assert.throws(() => stampVerdict(frozen({ selfId, ours: ours(), evidence: [asked(P, peerRow({ author: undefined }))] })),
        `selfId ${JSON.stringify(selfId)} was accepted`);
    }
  });

  it('no evidence at all is never likely', () => {
    let v;
    try { v = stampVerdict(frozen({ selfId: SELF, ours: ours(), evidence: [] })); } catch { return; }
    assert.equal(v.verdict, CANNOT, JSON.stringify(v));
  });
});

describe('several peers, combined (item 11)', () => {
  const likelyFrom = (peerId) => asked(peerId, peerRow({ author: peerId }));

  it('the failures, each as the only peer: cannot tell, with the reason of the failure', () => {
    const FAILURES = [['unreachable', 'PEER_UNREACHABLE'], ['refused', 'PEER_REFUSED'], ['too-old', 'PEER_TOO_OLD'],
      ['address-refused', 'PEER_ADDRESS_REFUSED'], ['no-credentials', 'NO_CREDENTIALS'], ['not-checked', 'NOT_CHECKED_BEFORE_DEADLINE']];
    for (const [failure, key] of FAILURES) {
      const v = verdictOf({ ours: ours(), evidence: [{ peerId: P, failure }] });
      assert.equal(v.verdict, CANNOT, `${failure}: ${JSON.stringify(v)}`);
      assert.equal(v.reason, R(key), `${failure}: reason ${JSON.stringify(v.reason)}`);
      observed.add(v.reason);
    }
  });

  it('one peer saying "author self", another unreachable, another holding nothing: no evidence, so cannot tell', () => {
    const v = verdictOf({ ours: ours(), evidence: [asked(P, peerRow({ author: SELF })), { peerId: Q, failure: 'unreachable' }, { peerId: OTHER }] });
    assert.equal(v.verdict, CANNOT, JSON.stringify(v));
  });

  it('an unreachable peer does not spoil a peer that gave likely evidence', () => {
    const v = verdictOf({ ours: ours(), evidence: [{ peerId: Q, failure: 'unreachable' }, likelyFrom(P)] });
    assert.equal(v.verdict, LIKELY, JSON.stringify(v));
    assert.equal(v.peerId, P);
  });

  it('a peer holding nothing, or saying "author self", does not spoil it either', () => {
    for (const quiet of [{ peerId: Q }, asked(Q, peerRow({ author: SELF }))]) {
      const v = verdictOf({ ours: ours(), evidence: [quiet, likelyFrom(P)] });
      assert.equal(v.verdict, LIKELY, JSON.stringify(quiet) + ' -> ' + JSON.stringify(v));
      assert.equal(v.peerId, P);
    }
  });

  it('two peers each naming a DIFFERENT non-self author: the peers disagree', () => {
    const v = verdictOf({ ours: ours(), evidence: [likelyFrom(P), likelyFrom(Q)] });
    assert.equal(v.verdict, CANNOT, JSON.stringify(v));
    assert.equal(v.reason, R('PEERS_DISAGREE'));
    assert.equal(v.peerId, undefined);
    observed.add(v.reason);
  });

  it('a likely peer and a peer naming a third author: the peers disagree (the stamp may be on the relay)', () => {
    const v = verdictOf({ ours: ours(), evidence: [likelyFrom(P), asked(Q, peerRow({ author: OTHER }))] });
    assert.equal(v.verdict, CANNOT, JSON.stringify(v));
    assert.equal(v.reason, R('PEERS_DISAGREE'));
  });

  it('a relay naming the SAME author as the likely peer agrees with it', () => {
    const v = verdictOf({ ours: ours(), evidence: [likelyFrom(P), asked(Q, peerRow({ author: P }))] });
    assert.equal(v.verdict, LIKELY, JSON.stringify(v));
    assert.equal(v.peerId, P);
  });

  it('two relays naming one author, and nobody who is that author: no likely evidence', () => {
    const v = verdictOf({ ours: ours(), evidence: [asked(P, peerRow({ author: OTHER })), asked(Q, peerRow({ author: OTHER }))] });
    assert.equal(v.verdict, CANNOT, JSON.stringify(v));
  });
});

describe('the enum is held to the table', () => {
  it('every reason of FILE_STAMP_REASONS comes out of some row above', () => {
    const missing = Object.entries(FILE_STAMP_REASONS).filter(([, text]) => !observed.has(text)).map(([key]) => key);
    assert.deepEqual(missing, [],
      'these reasons are unreachable from every row of the table (add the row that reaches each, or remove the reason): ' + missing.join(', '));
  });

  it('every answer the table produced is a reason of the enum, and nothing else', () => {
    const known = new Set(Object.values(FILE_STAMP_REASONS));
    const stray = [...observed].filter(r => !known.has(r));
    assert.deepEqual(stray, [], `answers outside the enum: ${JSON.stringify(stray)}`);
    assert.ok(observed.size >= 12, `the table reached only ${observed.size} distinct reasons`);
  });
});
