/**
 * Every writer of a space's counter doc sits in `util/version-stamp.ts` or `sync/positions-owed.ts` (Q-556, bundle-163).
 *
 * ## The finding this holds
 *
 * The version mark kept in config.json (`util/version-mark.ts`) is read in ONE place: inside the allocation of `util/version-stamp.ts`,
 * before the stamp, so no restart or restore path can skip it. That is only true while no other code moves the counter: a second
 * writer that RAISES it is harmless, but one that creates the doc, replaces it, deletes it, or sets it back (a rename's move, a rollback,
 * a wipe) is a way for the counter to go below the mark, or to start from nothing, without passing through the one place that raises
 * it. The allowed homes are the stamping module (allocate, raise, repair) and the owed-marker module (the marker fields, the ready
 * counter of a new space, the whole-doc move of a rename).
 *
 * ## What is derived, with a floor
 *
 * - **The writers:** every tracked `server/src` file (comments blanked) with a write call on a handle of the counters collection. A handle
 *   is the collection named at the call (`col('ythril_counters')`, `db.collection(COUNTERS)`) or an identifier bound to it on one line
 *   (`const counters = () => col<...>(COUNTERS);`). A write is any method that adds, changes, replaces or removes a document, or drops
 *   or renames the collection. The rule is about the write call, not the file that names the collection: `util/seq.ts` and
 *   `sync/positions-ready.ts` name it and only read.
 * - **Floors:** at least the two allowed modules are among the writers found, and at least seven files name the collection at all (the
 *   count at 7c81b63e; a lower number means the derivation lost its subject). The writers found at 7c81b63e are THREE: the two allowed
 *   modules and `sync/positions-rollback.ts` (below).
 * - **The detector is held too:** synthetic sources for each way a handle is spelled must be flagged, and a read of the same handle must not.
 *
 * ## Seen red
 *
 * Red on 7c81b63e, for a real finding and not a mutation: `sync/positions-rollback.ts` writes the counter itself (`counters.updateOne({ _id },
 * { $set: { seq: counterAfter, positionsOwed: 'repair' } }, { upsert: true })`, the 6.0 to 5.6 rollback tool). It only raises the counter (`max`),
 * but it is a writer outside the two modules, so the design's gate needs either that write moved into `sync/positions-owed.ts` or the file named
 * in `EXEMPT` below with its reason. Mutation for the newly covered part: append `await col('ythril_counters').deleteOne({ _id: 'x' });` to a
 * function of `spaces/rename.ts` (a file that names the counters only in comments): the offender list gains `spaces/rename.ts`. Restore by hand.
 *
 * Run: node --test testing/standalone/every-counter-writer-sits-behind-the-version-mark.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';

/** The two homes of a counter write, and why each is one. */
const ALLOWED = Object.freeze({
  'server/src/util/version-stamp.ts': 'the allocation, the raise and the poison repair: where the version mark is read before the stamp',
  'server/src/sync/positions-owed.ts': 'the owed marker fields, the ready counter of a new space and the whole-doc move of a rename: none lowers the version',
});
/** A writer outside both, with its reason. A row here is a counter write nobody put behind the mark: each says why it cannot lower or recreate the counter. */
const EXEMPT = Object.freeze({
  'server/src/sync/positions-rollback.ts': 'the offline 6.0 to 5.6 rollback tool: a raise only (max of the counter and the highest version held), run with no instance running, so no stamp can follow it before the next start',
});

const WRITE_METHODS = 'findOneAndUpdate|findOneAndReplace|findOneAndDelete|updateOne|updateMany|replaceOne|insertOne|insertMany|deleteOne|deleteMany|bulkWrite|drop|rename';
const NAME = String.raw`(?:['"\`]ythril_counters['"\`]|\bCOUNTERS\b)`;
/** The counters collection named, then a write on it: `col<T>('ythril_counters').updateOne(`, `db.collection(COUNTERS)\n  .deleteOne(`. */
const DIRECT = new RegExp(`${NAME}\\s*\\)\\s*\\.\\s*(?:${WRITE_METHODS})\\b`);
/** A name bound to the counters collection on one line: `const counters = db.collection<...>(COUNTERS);`, `const counters = () => col(...)`. */
const BINDING = new RegExp(String.raw`\b(?:const|let|var)\s+(\w+)\s*(?::[^=\n]+)?=[^\n]*${NAME}`, 'g');
const NAMES_COUNTERS = new RegExp(NAME);
const WRITER_FLOOR = Object.keys(ALLOWED).length;
const NAMING_FLOOR = 7;

/** Whether this code (comments already blanked) writes the counters collection through a handle of it. */
function writesCounters(code) {
  if (DIRECT.test(code)) return true;
  for (const [, alias] of code.matchAll(BINDING)) {
    if (new RegExp(String.raw`\b${alias}\s*(?:\(\s*\))?\s*\.\s*(?:${WRITE_METHODS})\b`).test(code)) return true;
  }
  return false;
}

const codeOf = (file) => blankComments(readFileSync(join(REPO_ROOT, file), 'utf8'));
const sources = () => trackedSources('server/src', { floor: 200 });

describe('every writer of a counter doc sits behind the version mark', () => {
  it('the detector flags every way a handle is spelled, and a read of the same handle is not a write', () => {
    const flagged = {
      'the collection named at the call': "await col('ythril_counters').updateOne({ _id }, update);",
      'the constant, across a line break': 'await db.collection(COUNTERS)\n    .deleteOne({ _id });',
      'a typed call': "await col<SpaceCounterDoc>('ythril_counters').findOneAndUpdate(f, u);",
      'a binding to the collection': 'const counters = db.collection<{ _id: string; seq?: number }>(COUNTERS);\nawait counters.updateOne(f, u);',
      'a binding to a function returning it': "const counters = () => col<Doc>('ythril_counters');\nawait counters().replaceOne(f, d);",
      'a drop': 'await db.collection(COUNTERS).drop();',
    };
    for (const [what, code] of Object.entries(flagged)) assert.ok(writesCounters(code), `not flagged: ${what}`);
    const notFlagged = {
      'a read': "const doc = await col('ythril_counters').findOne({ _id });",
      'a read through a binding': 'const counters = db.collection(COUNTERS);\nconst d = await counters.findOne(f);',
      'a write on another collection beside a binding': 'const counters = db.collection(COUNTERS);\nawait other.updateOne(f, u);',
      'a count': "await col('ythril_counters').estimatedDocumentCount();",
    };
    for (const [what, code] of Object.entries(notFlagged)) assert.ok(!writesCounters(code), `flagged but only reads: ${what}`);
  });

  it('the writers are derived, and the floor shows the derivation found its subject', () => {
    const naming = sources().filter(f => NAMES_COUNTERS.test(codeOf(f)));
    assert.ok(naming.length >= NAMING_FLOOR, `only ${naming.length} file(s) name the counters collection (${naming}): the derivation is broken`);
    const writers = naming.filter(f => writesCounters(codeOf(f)));
    assert.ok(writers.length >= WRITER_FLOOR, `only ${writers.length} counter writer file(s) found (${writers}): the write pattern is broken`);
    for (const home of Object.keys(ALLOWED)) {
      assert.ok(writers.includes(home), `${home} is not among the writers found (${writers}): it no longer writes the counters, or the pattern lost it`);
    }
  });

  it('no counter write is outside the two modules (an exemption is named in EXEMPT with its reason)', () => {
    const offenders = sources()
      .filter(f => NAMES_COUNTERS.test(codeOf(f)) && writesCounters(codeOf(f)))
      .filter(f => !(f in ALLOWED) && !(f in EXEMPT));
    assert.deepEqual(offenders, [],
      `these files write the counters collection outside ${Object.keys(ALLOWED).join(' and ')}: a counter write that skips the version mark can leave a space's counter below versions this instance already handed out. `
      + 'Move the write into one of the two modules, or name the file in EXEMPT with the reason it cannot lower or recreate the counter.');
  });
});
