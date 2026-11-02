/**
 * "This vector index cannot be queried YET" is ONE recogniser, and it knows every wording mongot uses for it (Q-325).
 *
 * ## The defect
 *
 * A collection's vector index is built after its first record, asynchronously, and mongot refuses a query against an
 * index it has not finished building. Recall answers that refusal as an empty collection — the promise
 * `spaces/search-index-presence.ts` makes for an absent index — but recognised the refusal by a regex written inside
 * `recallByType`, and the regex did not know mongot's first wording, `Index <name> not initialized`. So in the first
 * tens of milliseconds of a space's life a recall answered 503, and a moment later 200.
 *
 * ## What is asserted
 *
 *  - every wording the test store was SEEN giving for an index it was still building (bundle-30 I9 probe: create an
 *    index over one record and query it every 20 ms until it serves), verbatim, is recognised;
 *  - the wordings the old regex already knew still are (an absent index is a "not yet": case (a) of bundle-72);
 *  - the lexical form of the same state, `cannot query search index ... while in state UNKNOWN`, which has no Executor
 *    prefix, is recognised;
 *  - what is NOT "not yet" is not swallowed: a deadline, a failed index (`while in state FAILED`, `STALE`), an index
 *    that exists and will not serve (a dimension mismatch, a path not indexed as vector, a synonym mapping in state
 *    INVALID), a dead mongot (code 125 `Error connecting to Search Index Management service.`, code 6 HostUnreachable),
 *    a `research_index` namespace that merely contains the word "search", a malformed query, an `_id` filter the index
 *    refuses, an unrelated executor error. Each of those, read as an empty collection, is an incomplete answer
 *    reported as a complete one (bundle-72 P8: the old `search.*index` and any-state `cannot query.*vector index`
 *    alternatives swallowed code 125, STALE and `research_index`);
 *  - no other server source spells its own copy, where a copy is ANY regex literal naming a mongot index state, not
 *    only the three first seen (the shape of the defect: one rule, two spellings, the weaker wins).
 *
 * The end-to-end half — recall, findSimilar and checkDuplicates answering through the refusal — is
 * `a-recall-while-the-index-initialises-is-answered-db.test.js`.
 *
 * Run: node --test testing/standalone/an-index-not-queryable-yet-is-an-empty-collection.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { MongoServerError } from 'mongodb';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const MODULE = 'server/src/brain/index-not-queryable.ts';

const executor = (ns, cause) => `Executor error during aggregate command on namespace: ${ns} :: caused by :: ${cause}`;
const serverError = (errmsg, code = 8, codeName = 'UnknownError') => new MongoServerError({ ok: 0, code, codeName, errmsg });
const cannotQuery = (state) => executor('i9probe.c0', 'cannot query vector index 6ac200536babb9145b2f38d3 (vector index '
  + `c0_embedding collection c0 (1f5dc6dd-5793-469f-8217-0740a958d21a) in database i9probe) while in state ${state}`);

/** Seen from the test store while an index was being built, in this order, all code 8. */
const SEEN_WHILE_BUILDING = [
  ['not initialized (the wording the old regex missed)',
    executor('ythril_harness_initwin.initwininj_entities', 'Index initwininj_entities_embedding not initialized')],
  ['NOT_STARTED', cannotQuery('NOT_STARTED')],
  ['INITIAL_SYNC', cannotQuery('INITIAL_SYNC')],
];

/** The lexical (`$search`) index says the same thing in its own words: no Executor prefix, UNKNOWN before INITIAL_SYNC (bundle-72 PROBE). */
const LEXICAL_NOT_YET = [
  ['UNKNOWN', 'cannot query search index 6ac200536babb9145b2f38d4 (search index c0_text collection c0 '
    + '(1f5dc6dd-5793-469f-8217-0740a958d21a) in database i9probe) while in state UNKNOWN'],
  ['INITIAL_SYNC', 'cannot query search index 6ac200536babb9145b2f38d4 (search index c0_text collection c0 '
    + '(1f5dc6dd-5793-469f-8217-0740a958d21a) in database i9probe) while in state INITIAL_SYNC'],
];

/** Wordings the recogniser knew before it was shared; kept: an absent index is "not yet" too (case (a)). */
const KNOWN_BEFORE = [
  'index not found',
  'no such index: x_entities_embedding',
  'cannot query vector index while in state PENDING',
  'while in state BUILDING',
  'while in state STARTING',
];

/** Not "not yet": each must reach the caller. */
const NOT_SWALLOWED = [
  ['a deadline', serverError('operation exceeded time limit', 50, 'MaxTimeMSExpired')],
  ['an unrelated executor error', serverError(executor('db.c', 'BSONObj size: 17000000 is invalid'))],
  ['a malformed query', serverError(executor('db.c', 'queryVector must have 768 dimensions'))],
  ['a path the index does not hold', serverError(executor('db.c', 'embedding is not indexed as vector'))],
  ['an _id filter the index refuses', serverError(executor('db.c', "Path '_id' needs to be indexed as token"))],
  ['an authentication failure', serverError('Authentication failed.', 18, 'AuthenticationFailed')],
  // The index exists and will not serve without action. FAILED itself could not be produced on atlas-local (bundle-72
  // PROBE), so the rule is an allowlist of the not-yet states and each of these is "any other state or wording".
  ['an index in state FAILED', serverError(cannotQuery('FAILED'))],
  ['an index in state STALE', serverError(cannotQuery('STALE'))],
  ['a lexical index in state FAILED', new Error('cannot query search index 6ac200536babb9145b2f38d4 (search index c0_text '
    + 'collection c0 (1f5dc6dd-5793-469f-8217-0740a958d21a) in database i9probe) while in state FAILED')],
  ['a vector dimension mismatch (probe wording)',
    serverError(executor('i9probe.c0', 'vector field is indexed with 32 dimensions but queried with 64'))],
  ['a path not indexed as vector (probe wording)', serverError(executor('i9probe.c0', 'emb is not indexed as vector'))],
  ['a synonym mapping in state INVALID (probe wording)',
    serverError(executor('i9probe.c0', 'synonym mapping "m" is in state INVALID and is not ready to service queries'))],
  ['mongot refusing with code 125 (index management service unreachable)',
    serverError('Error connecting to Search Index Management service.', 125, 'CommandFailed')],
  ['mongot unreachable (code 6 HostUnreachable)',
    serverError(executor('i9probe.c0', 'Error connecting to localhost:27027 :: caused by :: Connection refused'), 6, 'HostUnreachable')],
  ['a namespace that only contains the word "search" (research_index)',
    serverError(executor('research_index.c0', 'BSONObj size: 17000000 is invalid'))],
];

/** Every state mongot reports for an index (the `while in state` text and listSearchIndexes `status`). */
const MONGOT_STATES = ['UNKNOWN', 'NOT_STARTED', 'INITIAL_SYNC', 'PENDING', 'BUILDING', 'STARTING', 'FAILED', 'STALE', 'READY',
  'DOES_NOT_EXIST', 'DELETING', 'RECOVERY_NON_TRANSIENT', 'STEADY'];

/** Does this comment-free source hold a regex literal naming a mongot index state, or the not-initialised wording? */
function regexLiteralNamingAMongotState(code) {
  const named = new RegExp(`(${MONGOT_STATES.join('|')}|not\\.\\*initiali|not initiali[sz]ed)`);
  const literal = /(?<![\w)\]/])\/(?![/*])((?:[^/\n\\]|\\.)+)\/[gimsuy]*/g;
  for (const m of code.matchAll(literal)) if (named.test(m[1])) return true;
  return false;
}

let isIndexNotQueryableYet;
before(async () => {
  ({ isIndexNotQueryableYet } = await import('../../server/dist/brain/index-not-queryable.js'));
});

describe('an index not queryable yet is an empty collection', () => {
  for (const [what, msg] of SEEN_WHILE_BUILDING) {
    it(`recognises mongot's ${what}, as the driver delivers it`, () => {
      assert.equal(isIndexNotQueryableYet(serverError(msg)), true, msg);
      // And as bare text: a caller may hold only the message (a wrapped or re-thrown error).
      assert.equal(isIndexNotQueryableYet(msg), true, msg);
    });
  }

  for (const [what, msg] of LEXICAL_NOT_YET) {
    it(`recognises the lexical index's ${what} (while in state ..., no Executor prefix)`, () => {
      assert.equal(isIndexNotQueryableYet(new Error(msg)), true, msg);
      assert.equal(isIndexNotQueryableYet(msg), true, msg);
    });
  }

  for (const msg of KNOWN_BEFORE) {
    it(`still recognises "${msg}"`, () => {
      assert.equal(isIndexNotQueryableYet(new Error(msg)), true);
    });
  }

  for (const [what, err] of NOT_SWALLOWED) {
    it(`does not swallow ${what}`, () => {
      assert.equal(isIndexNotQueryableYet(err), false, err.message);
    });
  }

  it('no other server source spells its own "index not ready" recogniser', () => {
    // The hallmark of a copy: a regex literal naming ANY mongot index state (not only the three first seen: a copy that
    // matches FAILED or STALE is as much a second recogniser) or the not-initialised wording. Read from every tracked
    // server source with comments stripped, so prose explaining the rule is not a copy of it.
    const copies = [];
    let scanned = 0;
    for (const { file, text } of readTrackedSources('server/src', { ext: ['.ts'], floor: 100, exclude: [MODULE] })) {
      scanned++;
      if (regexLiteralNamingAMongotState(stripComments(text))) copies.push(file);
    }
    assert.ok(scanned >= 100, `only ${scanned} server source(s) read — the sweep is broken, not the code`);
    assert.deepEqual(copies, [], `these sources recognise "index not ready" themselves instead of through ${MODULE}`);
  });

  it('the copy gate sees a planted copy naming any mongot state, and not a plain string or a division', () => {
    // A gate is worth its green only when a planted copy turns it red; each state a copy might spell.
    for (const state of MONGOT_STATES) {
      assert.ok(regexLiteralNamingAMongotState(`const r = /while in state (${state}|X)/i;`), `a regex naming ${state} was not seen`);
    }
    assert.ok(regexLiteralNamingAMongotState('const r = /not initialized/;'), 'the not-initialised wording was not seen');
    assert.ok(!regexLiteralNamingAMongotState("const label = 'READY';"), 'a plain string is not a recogniser');
    assert.ok(!regexLiteralNamingAMongotState('const n = a / b + c / d;'), 'division is not a regex literal');
  });
});
