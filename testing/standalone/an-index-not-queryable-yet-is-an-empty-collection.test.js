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
 *  - the wordings the old regex already knew still are;
 *  - what is NOT "not yet" is not swallowed: a deadline, an index that failed to build, a malformed query, an `_id`
 *    filter the index refuses, an unrelated executor error. Each of those, read as an empty collection, is an
 *    incomplete answer reported as a complete one. ONE wording of a failed index is swallowed today, and the test says
 *    so rather than leaving the header to claim otherwise: the module keeps its any-state `cannot query … vector
 *    index` alternative as it was, so `… while in state FAILED` reads as not-yet. Narrowing that is its own change and
 *    flips that one case on purpose;
 *  - a long message costs bounded time: the alternatives are unanchored and chained with `.*`, so the time to match
 *    grows with the square or cube of the text, and a driver's message can quote a caller's filter at any length. The
 *    worst message for each alternative (its own words, repeated, never completing it) is derived from the module;
 *  - no other server source spells its own copy (the shape of the defect: one rule, two spellings, the weaker wins) —
 *    as a regex literal, as the text of `new RegExp(…)`, or as a string handed to `includes` / `indexOf` /
 *    `startsWith` / `endsWith`. The words searched for are READ OUT of the module's own alternatives, so a seventh
 *    wording added there is covered without anyone touching this file.
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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readTrackedSources, REPO_ROOT } from './_sources.mjs';
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

/** Wordings the recogniser knew before it was shared; kept, because narrowing it is a different change. */
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
  // An index that failed to build is not one that will serve in a moment. These wordings say "failed" without saying
  // "cannot query … vector index", which is the one shape the module reads as not-yet whatever the state (below).
  ['an index that failed to build', serverError(executor('db.c', 'Index c0_embedding failed to build: out of memory'))],
  ['an index in the FAILED state, said as a state', serverError(executor('db.c', 'Index c0_embedding is in FAILED state'))],
  ['an index build failure', serverError(executor('db.c', 'index build failed'))],
];

/**
 * The module's any-state alternative: a refusal of the form `cannot query … vector index … while in state <S>` is read as
 * not-yet for EVERY state, FAILED included. The module's docblock keeps it that way on purpose ("narrowing them changes
 * which failures answer 503, which is its own change"). Pinned here so that change flips these cases deliberately and a
 * reader of the header does not take "a failed index is not swallowed" to cover this wording.
 */
const SWALLOWED_BY_THE_ANY_STATE_ALTERNATIVE = ['FAILED', 'DOES_NOT_EXIST', 'STALE'];

// ---- What the module says, read out of it ---------------------------------------------------------------------------

/** The module's alternatives as regex sources, read out of its `new RegExp([ /…/.source, … ].join('|'))`. */
function alternativesOf(code) {
  const list = code.match(/new RegExp\(\[([\s\S]*?)\]\.join/);
  assert.ok(list, `${MODULE} no longer builds its recogniser as new RegExp([ /…/.source, … ].join('|')) — re-point this reader`);
  return [...list[1].matchAll(/\/((?:\\.|[^/\\\n])+)\/\.source/g)].map(m => m[1]);
}

/**
 * The literal words of one alternative, in order, lower-cased: what is left when its wildcards, word boundaries, groups
 * and character classes are taken away. `no.*such.*index` is `no`, `such`, `index`. A group's members are returned
 * separately (`membersOf`), since each is a word of its own.
 */
function piecesOf(alt) {
  return alt.replace(/\\b/g, '').replace(/\[[^\]]*\]/g, '.')
    .split(/\([^)]*\)|[.*+?|\\^${}]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
}

/** The members of every `( A | B | … )` group of the alternatives: mongot's state names, as the module spells them. */
function membersOf(alts) {
  return alts.flatMap(a => [...a.matchAll(/\(([^)]*)\)/g)].flatMap(m => m[1].split('|')));
}

/** One message the alternative accepts: wildcards become a space, a group its first member, a class its first character. */
function sampleOf(alt) {
  return alt.replace(/\\b/g, '').replace(/\(([^)|]*)[^)]*\)/g, '$1').replace(/\[([^\]])[^\]]*\]/g, '$1').replace(/\.\*/g, ' ');
}

/** The text of the call whose `(` is at `open`, balanced. */
function callTextFrom(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '(') depth++;
    else if (code[i] === ')' && --depth === 0) return code.slice(open, i + 1);
  }
  return code.slice(open);
}

/** A regex literal in expression position: after an opener, an operator, `return` or a line start; never `//` or `/*`. */
const REGEX_LITERAL = /(?<=[(,=:[!&|?{};<>+~^%*-]\s*|\breturn\s+|^\s*)\/(?![/*])((?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+)\/[dgimsuyv]*/gm;

/**
 * Every place the code states a pattern to match text against: a regex literal, the argument text of `RegExp(…)`
 * (`new RegExp('…')` and a bare call alike), and the argument text of the string searches `includes`, `indexOf`,
 * `startsWith` and `endsWith`. A recogniser can be written as any of them.
 */
function patternSpansIn(code) {
  const spans = [...code.matchAll(REGEX_LITERAL)].map(m => ({ kind: 'regex literal', text: m[1] }));
  for (const m of code.matchAll(/\bRegExp\s*\(/g)) spans.push({ kind: 'RegExp(…)', text: callTextFrom(code, m.index + m[0].length - 1) });
  for (const m of code.matchAll(/\.(includes|indexOf|startsWith|endsWith)\s*\(/g)) {
    spans.push({ kind: `.${m[1]}(…)`, text: callTextFrom(code, m.index + m[0].length - 1) });
  }
  return spans;
}

const inOrder = (haystack, pieces) => {
  let at = 0;
  for (const p of pieces) {
    const i = haystack.indexOf(p, at);
    if (i < 0) return false;
    at = i + p.length;
  }
  return true;
};

/**
 * Sources that state a pattern sharing the words of an alternative while asking a DIFFERENT question — each with the
 * alternative it shares and the reason. Not exemptions from the rule: the rule is "no second recogniser of an index that
 * cannot be queried yet", and neither of these is one. Checked for staleness below, so a row that no longer matches fails.
 */
const ASKS_ANOTHER_QUESTION = [
  { file: 'server/src/brain/store-failure.ts', shares: ['search.*index'],
    why: 'classifies a failure as one of the search stack (`vector search index` among its markers) to pick the answer text; it never decides to read the collection as empty' },
  { file: 'server/src/ready.ts', shares: ['search.*index', 'no.*such.*index'],
    why: 'the readiness probe asking whether the store supports the search stages at all (`no such command … search index`); not a per-collection index state' },
];

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

  for (const state of SWALLOWED_BY_THE_ANY_STATE_ALTERNATIVE) {
    it(`today reads a cannot-query refusal in state ${state} as not-yet (the any-state alternative, kept as it was)`, () => {
      const msg = cannotQuery(state);
      assert.equal(isIndexNotQueryableYet(serverError(msg)), true, msg);
    });
  }

  describe('what the module says, read out of it', () => {
    const code = stripComments(readFileSync(join(REPO_ROOT, MODULE), 'utf8'));
    const alts = alternativesOf(code);

    it('is read from the module, and each alternative it names recognises its own wording', () => {
      assert.ok(alts.length > 0, `no alternatives read out of ${MODULE}`);
      for (const alt of alts) {
        assert.ok(piecesOf(alt).length > 0, `no literal words in the alternative ${alt}`);
        const sample = sampleOf(alt);
        assert.equal(isIndexNotQueryableYet(sample), true,
          `the alternative ${alt} reads as "${sample}" and the module does not recognise it — this reader no longer matches the module`);
      }
      assert.ok(membersOf(alts).length > 0, 'no state names read out of a group — the reader is looking at the wrong thing');
    });
  });

  describe('a long message costs bounded time', () => {
    // A driver's message can quote a caller's filter at any length, and the alternatives are chained with `.*` and
    // unanchored, so the time to match the RAW regex grows with the square or cube of the text (12 KB took 1.7 s of
    // event loop; read through the bound, about a millisecond). The worst message for an alternative never completes it:
    // its own words, repeated.
    const SIZE = 12 * 1024;
    const BOUND_MS = 250;
    const alts = alternativesOf(stripComments(readFileSync(join(REPO_ROOT, MODULE), 'utf8')));
    const repeatedToSize = (unit) => unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);
    const prefixes = alts.map(a => piecesOf(a)).filter(p => p.length > 1).map(p => `${p.slice(0, -1).join(' ')} `);

    it('has a worst message to try for the alternatives that chain wildcards', () => {
      assert.ok(prefixes.length > 0, 'no chained alternative found in the module — the reader is looking at the wrong thing');
    });

    for (const [what, build] of [
      ...prefixes.map(p => [`the words of "${p.trim()}", repeated`, () => repeatedToSize(p)]),
      ['every chained alternative\'s words, interleaved', () => repeatedToSize(prefixes.join(''))],
    ]) {
      it(`${what}, answers within the bound`, () => {
        const text = build();
        assert.equal(text.length, SIZE);
        const started = performance.now();
        isIndexNotQueryableYet(new Error(text));
        const took = performance.now() - started;
        assert.ok(took < BOUND_MS, `a ${SIZE}-character message took ${Math.round(took)} ms to read (bound ${BOUND_MS} ms): the match is no longer bounded`);
      });
    }

    it('still recognises mongot\'s wording when a long quoted filter follows it', () => {
      const msg = `${executor('db.c', 'Index c0_embedding not initialized')} ${'{"a":"no such field"}'.repeat(SIZE / 20)}`;
      assert.ok(msg.length > SIZE);
      assert.equal(isIndexNotQueryableYet(new Error(msg)), true);
    });
  });

  it('no other server source spells its own "index not ready" recogniser', () => {
    // A copy is a pattern — regex literal, RegExp(…) text, or a string search — that holds the words of an alternative
    // of the module, in order (case-insensitively, as the module's regex is), or one of its state names as written
    // (mongot says them in capitals; `pending-spaces` is not the state). Both are READ OUT of the module. Comments are
    // stripped from every tracked server source, so prose explaining the rule is not a copy of it.
    const alts = alternativesOf(stripComments(readFileSync(join(REPO_ROOT, MODULE), 'utf8')));
    const wordings = alts.map(alt => ({ alt, pieces: piecesOf(alt) }));
    const states = membersOf(alts).map(name => new RegExp(`\\b${name}\\b`));
    const copies = [];
    const shared = new Map();
    let scanned = 0;
    let spans = 0;
    for (const { file, text } of readTrackedSources('server/src', { ext: ['.ts'], floor: 100, exclude: [MODULE] })) {
      scanned++;
      const exempt = ASKS_ANOTHER_QUESTION.find(e => e.file === file);
      for (const span of patternSpansIn(stripComments(text))) {
        spans++;
        const lower = span.text.toLowerCase();
        for (const w of wordings) {
          if (!inOrder(lower, w.pieces)) continue;
          if (exempt?.shares.includes(w.alt)) shared.set(`${file}\0${w.alt}`, true);
          else copies.push(`${file}: ${span.kind} holds the words of ${w.alt}: ${span.text.slice(0, 100)}`);
        }
        for (const state of states) {
          if (state.test(span.text)) copies.push(`${file}: ${span.kind} names the state ${state.source}: ${span.text.slice(0, 100)}`);
        }
      }
    }
    assert.ok(scanned >= 100, `only ${scanned} server source(s) read — the sweep is broken, not the code`);
    assert.ok(spans >= 100, `only ${spans} pattern(s) found across them — the pattern finder is broken, not the code`);
    assert.deepEqual(copies, [], `these sources recognise "index not ready" themselves instead of through ${MODULE}`);
    for (const e of ASKS_ANOTHER_QUESTION) {
      for (const alt of e.shares) {
        assert.ok(alts.includes(alt), `${e.file} is listed as sharing "${alt}", which the module no longer has — drop the row`);
        assert.ok(shared.has(`${e.file}\0${alt}`), `${e.file} no longer shares "${alt}" — drop the row (${e.why})`);
      }
    }
  });
});
