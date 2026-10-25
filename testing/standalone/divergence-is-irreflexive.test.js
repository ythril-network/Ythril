/**
 * `divergesFrom(kind, x, x)` is false for every `x`: a copy never forks against itself (Q-624, design rev 4 section 2, decision D8,
 * section 16 test 23).
 *
 * ## The defect this prevents
 *
 * Two earlier decisions made a document diverge from itself. "An unparseable copy differs" meant a stored row that failed its
 * `Incoming*` schema forked against its own arrival at every cycle, and "an undefined hash means not read" hid a projection that was
 * never made. Either is invisible in a run with valid documents and, once it happens, never stops: each cycle plans a fork row the next
 * cycle plans again. A fork is the one verdict that WRITES something for an equal seq, so a false divergence is a row nobody wrote
 * and nobody can explain.
 *
 * ## What it holds
 *
 *  - over every document of the corpus (`_fork-body-fixtures.mjs`: the planner's fixtures, nested keys spelled like version
 *    metadata, defaulted-against-absent fields, rows a pre-fix `deleteFields` left with `null`, documents failing their schema, a
 *    document with no fields), against itself, against its own wire round trip, and against its key order reversed, for every forking
 *    family: no divergence;
 *  - the control, so "never diverges" is not "never answers": a copy that says something different at the same seq DOES diverge;
 *  - a stored copy at an EQUAL seq whose body was not read is a programming error: `divergesFrom` throws `BodyNotRead`, and never
 *    treats such a copy as different (nor as the same). At another seq the body is not needed, and nothing is thrown.
 *
 * ## Red on the unchanged code
 *
 * On b857da8f `sync/authored-content.ts` does not exist and `divergesFrom` takes no kind and compares the `fact` text alone.
 *
 * Run: node --test testing/standalone/divergence-is-irreflexive.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { corpus, base, MAIN_FIELD } from './_fork-body-fixtures.mjs';

const plan = await import('../../server/dist/sync/upsert-plan.js');
let hash;
try { hash = await import('../../server/dist/sync/authored-content.js'); } catch (err) { hash = { __missing: String(err?.code ?? err?.message) }; }

/** The hash leaf, or the failing case's own message: one missing module must name itself in each case that needs it. */
const leaf = () => {
  assert.ok(!hash.__missing, `dist/sync/authored-content.js is not built (${hash.__missing}): there is no body hash for the planner, the writer and the fork module to share`);
  assert.equal(typeof hash.authoredContentHash, 'function', 'authored-content.ts does not export authoredContentHash');
  return hash;
};
const families = () => {
  assert.ok(Array.isArray(plan.FORKING_FAMILIES) && plan.FORKING_FAMILIES.length > 0, 'FORKING_FAMILIES is not exported by sync/upsert-plan.ts');
  return plan.FORKING_FAMILIES;
};

/** What the door reads of a stored copy at an equal seq: its seq, whether it is a fork, and the hash of its body. */
const held = (family, doc) => ({ seq: doc.seq, ...(doc.forkOf ? { forkOf: doc.forkOf } : {}), bodyHash: leaf().authoredContentHash(family, doc) });
const reversed = (doc) => Object.fromEntries(Object.entries(doc).reverse());
const wire = (doc) => JSON.parse(JSON.stringify(doc));

describe('a copy never diverges from itself', () => {
  const CORPUS = corpus();

  it('the corpus is whole: a floor, the families, a document with no fields and one failing its schema', () => {
    assert.ok(CORPUS.length >= 60, `only ${CORPUS.length} documents in the corpus`);
    assert.ok(CORPUS.some(([, , d]) => Object.keys(d).length === 0), 'no document with no fields');
    assert.ok(CORPUS.some(([n]) => /fails its schema/.test(n)), 'no document failing its schema');
    assert.ok(CORPUS.some(([n]) => /description null/.test(n)), 'no row a pre-fix deleteFields left with null');
  });

  it('divergesFrom(kind, x, x) is false, for every forking family and every document', () => {
    leaf();
    const failures = [];
    for (const kind of families()) {
      for (const [name, , doc] of CORPUS) {
        // A document is read as the family under test: one that fails that family's schema is hashed raw, on both sides.
        if (plan.divergesFrom(kind, doc, held(kind, doc))) failures.push(`${kind}: ${name}`);
      }
    }
    assert.deepEqual(failures, [], 'these documents diverge from themselves, so the same equal-seq copy forks at every cycle');
  });

  it('nor from its own wire round trip, nor from its keys written in reverse', () => {
    leaf();
    const failures = [];
    for (const kind of families()) {
      for (const [name, family, doc] of CORPUS) {
        if (family !== kind) continue; // a round trip loses a Date, which is a local field; only a document of its own family is the claim
        for (const [how, copy] of [['wire', wire(doc)], ['reversed', reversed(doc)]]) {
          if (plan.divergesFrom(kind, doc, held(kind, copy))) failures.push(`${kind}: ${name} (${how})`);
          if (plan.divergesFrom(kind, copy, held(kind, doc))) failures.push(`${kind}: ${name} (${how}, arriving)`);
        }
      }
    }
    assert.deepEqual(failures, [], 'key order, the wire round trip or a local field makes a copy diverge from itself');
  });

  it('the control: a copy that says something different at the same seq diverges, and at another seq it does not', () => {
    leaf();
    for (const kind of families()) {
      const field = MAIN_FIELD[kind];
      const stored = base(kind);
      const arriving = base(kind, { [field]: `${String(stored[field])} (edited)` });
      assert.equal(plan.divergesFrom(kind, arriving, held(kind, stored)), true, `${kind}: a different ${field} at one seq does not diverge: the rule answers false for everything`);
      assert.equal(plan.divergesFrom(kind, { ...arriving, seq: 6 }, held(kind, stored)), false, `${kind}: a different seq is newer or older, never a divergence`);
    }
  });
});

describe('a stored copy whose body was not read is a programming error, never a difference', () => {
  it('at an equal seq divergesFrom throws BodyNotRead, for every forking family', () => {
    leaf();
    for (const kind of families()) {
      const doc = base(kind);
      const unread = { seq: doc.seq };
      assert.throws(() => plan.divergesFrom(kind, doc, unread),
        (e) => /BodyNotRead/.test(`${e?.name} ${e?.constructor?.name} ${e?.code}`),
        `${kind}: a copy at an equal seq whose body was not read is treated as something other than an error`);
    }
  });

  it('at another seq the body is not needed: no throw, and no divergence; with no copy at all, none', () => {
    leaf();
    for (const kind of families()) {
      const doc = base(kind);
      assert.equal(plan.divergesFrom(kind, doc, { seq: doc.seq - 1 }), false);
      assert.equal(plan.divergesFrom(kind, doc, { seq: doc.seq + 1 }), false);
      assert.equal(plan.divergesFrom(kind, doc, undefined), false);
    }
  });
});
