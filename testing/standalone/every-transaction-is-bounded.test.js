/**
 * Every transaction the server starts is started where its bound lives: `server/src/db/bounded-transaction.ts`
 * (bundle-44 plan rev 3, D2).
 *
 * ## The defect
 *
 * A MongoDB session was started by hand at two sites and the third copy was about to be written. `brain/held-transaction.ts`
 * gave its session a bound; `files/media/lease.ts` `writeUnderClaim` started its own with none, so a document lock held
 * elsewhere kept it retrying a write conflict for the driver's default 120 s (plan F12). The bound is the half of a
 * transaction a hand-written copy forgets, together with the read-back of a commit whose reply was lost, the
 * `endSession` in a `finally`, and the one-batch read of a timed transaction.
 *
 * ## The rule this file holds
 *
 * **Every call that starts a session in `server/src` is inside `db/bounded-transaction.ts`.** Not "every call site
 * that is known": the sites are DERIVED from the tracked sources, so a fourth `startSession(` written next year in any
 * file fails here on the day it is written, and the module that owns them is the one place the bound can be wrong.
 *
 * ## What counts as starting a session
 *
 * A call of `startSession(` (`getMongo().startSession(…)`, `client.startSession(…)`) or of `withSession(` (the driver's
 * `client.withSession(…)`, which starts one itself). Comments are blanked first, line numbers kept: a sentence in a
 * docblock that names `startSession` (this module's own explanation of what it replaced is one) is not a call, and
 * must neither fail the gate nor satisfy it, and a reported line points at the original source.
 *
 * ## It cannot pass by looking at nothing
 *
 * The derived set has a floor (at least one site: the module's own), the module must exist and hold a call, and the
 * detector is itself exercised on literal sources — a comment, a string-free call, a call through a client — so a
 * detector that matched nothing, or matched a mention, fails its own cases before it is believed about the tree.
 *
 * Run: node --test testing/standalone/every-transaction-is-bounded.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';

/** The one module that may start a session. */
const HOME = 'server/src/db/bounded-transaction.ts';

/** Where sessions are started, in one source: `[{ line }]`, comments blanked and line numbers those of the original. */
function sessionStartsIn(src) {
  const code = blankComments(src);
  // Built fresh per use: a module-level global regex keeps `lastIndex` between a caller's assertion and its loop.
  const re = /\b(startSession|withSession)\s*\(/g;
  return [...code.matchAll(re)].map(m => ({
    call: m[1],
    line: code.slice(0, m.index).split('\n').length,
  }));
}

/** `[{ file, call, line }]` for every session start in `sources` (`[{ file, text }]`). */
function sessionStarts(sources) {
  return sources.flatMap(({ file, text }) => sessionStartsIn(text).map(s => ({ file, ...s })));
}

/** The starts that are NOT in the module that owns the bound, as `file:line (call)`. */
function outsideTheBound(starts) {
  return starts.filter(s => s.file !== HOME).map(s => `${s.file}:${s.line} (${s.call})`);
}

const read = (file) => readFileSync(join(REPO_ROOT, file), 'utf8');

describe('every transaction is started inside db/bounded-transaction.ts', () => {
  // ── the detector, on literal sources ─────────────────────────────────────────────────────────────────────

  it('the detector finds a call, a call through a client, and the driver\'s withSession, with their original lines', () => {
    const src = ['import x from "y";', '', 'const a = getMongo().startSession({ defaultTimeoutMS: 1 });', 'await client.withSession(async (s) => s);'].join('\r\n');
    assert.deepEqual(sessionStartsIn(src), [{ call: 'startSession', line: 3 }, { call: 'withSession', line: 4 }]);
  });

  it('the detector does not read a comment: a line comment, a block comment and a docblock that name the call are not calls', () => {
    const src = [
      '/**',
      ' * Replaces getMongo().startSession() at two sites.',
      ' */',
      '// getMongo().startSession(',
      'const fine = 1; // client.withSession(',
      '/* startSession( */',
    ].join('\n');
    assert.deepEqual(sessionStartsIn(src), [], 'a comment that names the call was read as one: the fix\'s own explanation would fail the gate');
  });

  it('a call after a comment is still found, on the line it is on in the original', () => {
    const src = ['/* a', ' * b', ' * c */', 'const s = getMongo().startSession();'].join('\n');
    assert.deepEqual(sessionStartsIn(src), [{ call: 'startSession', line: 4 }], 'the reported line is the stripped file\'s, not the original\'s');
  });

  it('the rule: a call outside db/bounded-transaction.ts is reported, one inside it is not', () => {
    const starts = [{ file: HOME, call: 'startSession', line: 10 }, { file: 'server/src/files/media/lease.ts', call: 'startSession', line: 114 }];
    assert.deepEqual(outsideTheBound(starts), ['server/src/files/media/lease.ts:114 (startSession)']);
    assert.deepEqual(outsideTheBound(starts.slice(0, 1)), []);
  });

  // ── the tree ─────────────────────────────────────────────────────────────────────────────────────────────

  const sources = trackedSources('server/src', { floor: 100 }).map(file => ({ file, text: read(file) }));
  const starts = sessionStarts(sources);

  it('the derivation finds session starts, so an empty set cannot pass', () => {
    assert.ok(starts.length >= 1, 'no session start derived in server/src: the sweep is broken, not the code (a transaction exists)');
  });

  it('db/bounded-transaction.ts exists and starts the session itself', () => {
    const own = starts.filter(s => s.file === HOME);
    assert.ok(own.length >= 1,
      `${HOME} ${sources.some(s => s.file === HOME) ? 'holds no startSession call' : 'is not a tracked source'}: the bounded transaction (plan rev 3, D2) `
      + 'is not where sessions are started yet, so there is nowhere for the others to be');
  });

  it('every session in server/src is started inside db/bounded-transaction.ts', () => {
    assert.deepEqual(outsideTheBound(starts), [],
      `a session is started outside ${HOME}: a hand-written start has no write bound (a document lock held elsewhere stalls it for the `
      + 'driver\'s 120 s), no read-back of a commit whose reply was lost, and no endSession in a finally, unless its writer remembered each one. '
      + 'Start it through inBoundedTransaction (or inHeldTransaction when it writes a seq-carrying record).');
  });
});
