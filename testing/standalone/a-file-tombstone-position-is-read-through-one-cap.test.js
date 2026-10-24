/**
 * Every ordering read of a file tombstone's position is capped by ONE function, `settledPositionCap` — so no page, and no
 * prune, can take a position that an earlier, uncommitted write may still land below (Q-346, bundle-71 D1, gate T6b).
 *
 * **Extended by bundle-81 to every stream of `util/position-clock.ts`** (design rev 8 §9, "gates the change inverts"): the records stream's
 * reader (`util/position-keyset.ts`) is held to the same rule, and the streams are DERIVED (every module that imports the clock and declares a
 * stream), with a floor, so a third stream added next year is owed its cap the day it is declared. The file stream's cap is this module's own
 * `settledPositionCap(spaceId)` over the clock's `settledPositionCap(stream, spaceId)`, and the check below holds that the former IS the latter.
 *
 * ## Why a gate, and why it is the position twin of the seq keyset's
 *
 * The hold that keeps a position from being acknowledged early is only a hold on whoever READS below it. The seq horizon
 * has one such reader family (`settledSeqRange`); the position's readers are the served page (`publishedFileTombstones`,
 * `publishedFileTombstonePage`, the legacy `since` read), the push's pages, and the prune. A reader added next year that
 * orders by `positionAt` and does not ask the cap is the defect again, silently: the hold is registered and honoured by
 * every other reader, and this one reads straight through it.
 *
 * ## What is derived, and the floor
 *
 * The readers are every top-level function of `server/src/files/tombstones.ts` (comments blanked) whose code COMPARES
 * `positionAt` to something in a query: a range operator on it (`positionAt: { $lt | $lte | $gt | $gte }`) or the shared keyset
 * (`isoKeysetFilters('positionAt', …)`). An equality, an existence test and a sort are not comparisons. Each must call
 * `settledPositionCap(`, and the module must define and export it. The floor is two readers (the page and the prune), because an
 * empty derivation passes every loop written over it.
 *
 * **The position's QUESTIONS moved with Q-462, and this gate stays on the readers.** `FILE_TOMBSTONE_QUERIES.cappedPage` / `.prunePage`
 * are now the store's (`files/tombstone-store.ts`), built from `belowCap(cap)` and `prunable(upTo, cap)` — a cap handed in, never taken —
 * so the READERS that run them are still the functions of `tombstones.ts` this derives, and the store is held by a second check below:
 * every comparison of `positionAt` it spells is inside one of those two cap-taking builders, so no reader can be born there that orders
 * by a position with no cap in its hands.
 *
 * The rule is the call, not a site: a reader added to the module is held to it the day it is written, and one that bounds
 * itself by a hand-written clock read is exactly what this refuses. The scanner is itself shown to see both outcomes on a
 * fixture below, so a scan that finds nothing to refuse is told apart from one that was never able to.
 *
 * Run: node --test testing/standalone/a-file-tombstone-position-is-read-through-one-cap.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';
import { topLevelFunctionSpans } from './_call-graph.mjs';

const OWNER = 'server/src/files/tombstones.ts';
/** The store: where the position's comparisons are built from a cap the caller hands in (Q-462). */
const STORE = 'server/src/files/tombstone-store.ts';
/** The two builders of the store a position comparison may sit in: each takes the cap as a parameter. */
const CAP_BUILDERS = ['belowCap', 'prunable'];
const CAP = 'settledPositionCap';
/**
 * A comparison of the position in a query: a range operator on it, the shared keyset over it, or asking one of the module's two
 * position questions (`FILE_TOMBSTONE_QUERIES.cappedPage` / `.prunePage`), whose builders hold the keyset the readers run.
 */
const COMPARES_POSITION = /positionAt['"]?\s*:\s*\{\s*\$(?:lt|lte|gt|gte)\b|isoKeysetFilters\s*\(\s*['"]positionAt['"]|FILE_TOMBSTONE_QUERIES\s*\.\s*(?:cappedPage|prunePage)\s*\(/;

/** `{ readers, uncapped }`: the functions that compare `positionAt`, and those among them that never ask the cap. */
export function positionReaders(code) {
  const readers = [...topLevelFunctionSpans(code)].filter(([, span]) => COMPARES_POSITION.test(span.body)).map(([name]) => name);
  const bodies = new Map([...topLevelFunctionSpans(code)].map(([name, span]) => [name, span.body]));
  const uncapped = readers.filter(name => !new RegExp(`\\b${CAP}\\s*\\(`).test(bodies.get(name)));
  return { readers, uncapped };
}

describe('every ordering read of a file tombstone position is capped by one function', () => {
  const code = blankComments(readFileSync(join(REPO_ROOT, OWNER), 'utf8'));
  const { readers, uncapped } = positionReaders(code);

  it('the derivation finds the readers, so an empty set cannot pass', () => {
    assert.ok(readers.length >= 2, `only ${readers.length} reader(s) of the position found in ${OWNER} (${readers}) — the scan is broken`);
    assert.ok(readers.includes('pruneFileTombstonesUpTo'), 'the prune is not among the readers derived — re-anchor the scan');
  });

  it(`${OWNER} defines and exports ${CAP}, the one way a read is capped`, () => {
    // `ok` and not `match`: a failed `match` prints the whole module as its "actual".
    assert.ok(new RegExp(`export\\s+(?:async\\s+)?function\\s+${CAP}\\b`).test(code),
      `${OWNER} exports no ${CAP}: nothing caps a page or a prune below an open position hold, so an acknowledgement can cover a row that has not landed`);
  });

  it('every reader that compares positionAt asks it', () => {
    assert.deepEqual(uncapped, [],
      `these functions in ${OWNER} compare positionAt and never call ${CAP}(): ${uncapped.join(', ')} — a page or a prune that reads straight `
      + 'through an open position hold can acknowledge, and then remove, a tombstone whose write has not yet landed');
  });

  it('the store spells a comparison of positionAt only inside a builder that takes the cap', () => {
    const lines = blankComments(readFileSync(join(REPO_ROOT, STORE), 'utf8')).split(/\r?\n/);
    const builderLines = new Set(CAP_BUILDERS.map(name => lines.findIndex(l => new RegExp(`^(?:export\\s+)?const\\s+${name}\\s*=\\s*\\([^)]*\\bcap\\b`).test(l))));
    assert.ok(![...builderLines].includes(-1), `${STORE} no longer defines ${CAP_BUILDERS.join(' and ')} with a cap parameter — re-anchor this check`);
    const compares = lines.map((l, i) => [i, l]).filter(([, l]) => /positionAt['"]?\s*:\s*\{\s*\$(?:lt|lte|gt|gte)\b/.test(l));
    assert.ok(compares.length >= 2, `only ${compares.length} comparison(s) of positionAt found in ${STORE}: the scan looks at the wrong thing`);
    assert.deepEqual(compares.filter(([i]) => !builderLines.has(i)).map(([i, l]) => `${i + 1}: ${l.trim()}`), [],
      `these compare positionAt in ${STORE} outside ${CAP_BUILDERS.join(' / ')}: a reader there orders by a position with no cap handed to it`);
    const keysets = lines.map((l, i) => [i, l]).filter(([, l]) => /isoKeysetFilters\s*\(\s*['"]positionAt['"]/.test(l));
    assert.ok(keysets.length >= 2, `only ${keysets.length} keyset read(s) over positionAt in ${STORE}`);
    assert.deepEqual(keysets.filter(([, l]) => !new RegExp(`\\b(?:${CAP_BUILDERS.join('|')})\\s*\\(`).test(l)).map(([i, l]) => `${i + 1}: ${l.trim()}`), [],
      `these read a keyset over positionAt in ${STORE} without a cap built by ${CAP_BUILDERS.join(' / ')}`);
  });

  it('the scan tells a capped module from an uncapped one (it can see both outcomes)', () => {
    // Top-level, as the module's functions are: the scan reads declarations from the start of a line.
    const capped = [
      `async function page(s) { const cap = await ${CAP}(s); return find({ positionAt: { $lt: cap } }); }`,
      `async function prune(s, upTo) { const cap = await ${CAP}(s); return del({ positionAt: { $lte: upTo, $lt: cap } }); }`,
      'async function legacy(s) { return upd({ positionAt: { $exists: false } }); }',
    ].join('\n');
    assert.deepEqual(positionReaders(capped), { readers: ['page', 'prune'], uncapped: [] });
    const oneMissing = capped.replace(`const cap = await ${CAP}(s); return del(`, 'return del(');
    assert.deepEqual(positionReaders(oneMissing).uncapped, ['prune'], 'a reader that drops the cap is not seen');
    const keyset = `async function since(s) { const { tie, range } = isoKeysetFilters('positionAt', after); return tieThenRange(find, tie, range); }`;
    assert.deepEqual(positionReaders(keyset), { readers: ['since'], uncapped: ['since'] }, 'the shared keyset over positionAt is not a comparison to the scan');
    const asked = `async function page(s) { return ask(s, FILE_TOMBSTONE_QUERIES.cappedPage({ spaceId: s, after, cap: 'x' })); }\n`
      + `async function prune(s, upTo) { const cap = await ${CAP}(s); return ask(s, FILE_TOMBSTONE_QUERIES.prunePage({ after, cap, upTo })); }`;
    assert.deepEqual(positionReaders(asked), { readers: ['page', 'prune'], uncapped: ['page'] }, 'a reader that asks the position questions is not seen');
  });
});

describe('bundle-81: every stream of the position clock is read below one cap (the rule, not the file)', () => {
  const CLOCK = 'server/src/util/position-clock.ts';
  const clockCode = blankComments(readFileSync(join(REPO_ROOT, CLOCK), 'utf8'));
  const sources = trackedSources('server/src', { floor: 100 });
  const imports = (code) => /from\s+['"][^'"]*util\/position-clock\.js['"]|from\s+['"]\.\/position-clock\.js['"]/.test(code);
  const DECLARES_A_STREAM = /:\s*PositionStream\b|\bnew\s+PositionStream\b|\b(?:define|create)\w*Stream\s*\(/;

  it('the streams are derived: every module that imports the clock and declares one (a floor of two: the records and the file tombstones)', () => {
    const definers = sources.filter(f => f !== CLOCK && imports(blankComments(readFileSync(join(REPO_ROOT, f), 'utf8')))
      && DECLARES_A_STREAM.test(blankComments(readFileSync(join(REPO_ROOT, f), 'utf8'))));
    assert.ok(definers.length >= 2, `only ${definers.length} stream definer(s) derived (${definers}): the derivation is broken`);
    assert.ok(definers.includes('server/src/files/tombstones.ts') && definers.includes('server/src/sync/record-position-stream.ts'), `derived: ${definers}`);
  });

  it('the clock exports the one cap and computes it, never stores it (a read must not move the clock)', () => {
    assert.match(clockCode, /export\s+async\s+function\s+settledPositionCap\b/, 'the clock exports no settledPositionCap');
    const body = topLevelFunctionSpans(clockCode).get('settledPositionCap')?.body ?? '';
    assert.ok(body.length > 0 && !/\.last\s*=/.test(body), 'settledPositionCap writes the clock: a read would move it');
  });

  it('the file stream\'s cap is the clock\'s: ' + OWNER + ' exports settledPositionCap over the clock\'s, never a clock of its own', () => {
    const body = topLevelFunctionSpans(code0()).get(CAP)?.body ?? '';
    assert.match(body, /\bcapOf\s*\(\s*fileTombstonePositions\b|\bsettledPositionCap\s*\(\s*fileTombstonePositions\b/, `${OWNER}'s ${CAP} does not ask the clock's cap for the file stream`);
  });

  it('the records\' reader compares pos only below a cap it is handed or takes from the clock', () => {
    const READER = 'server/src/util/position-keyset.ts';
    const rcode = blankComments(readFileSync(join(REPO_ROOT, READER), 'utf8'));
    const spans = [...topLevelFunctionSpans(rcode)];
    const comparing = spans.filter(([, span]) => /\bpos['"]?\s*:\s*\{\s*\$(?:lt|lte|gt|gte)\b/.test(span.body));
    assert.ok(comparing.length >= 1, `no function of ${READER} compares \`pos\`: the scan looks at the wrong thing`);
    /** The parameter list of a top-level function, from its declaration. */
    const paramsOf = (name) => new RegExp(`function\\s+${name}\\s*(?:<[^>(]*>)?\\(([^)]*)\\)`).exec(rcode)?.[1] ?? '';
    const uncapped = comparing.filter(([name, span]) => !/\bcap\b/.test(paramsOf(name)) && !/\bsettledPositionCap\s*\(/.test(span.body)).map(([name]) => name);
    assert.deepEqual(uncapped, [], `these compare pos in ${READER} with no cap handed in and none taken from the clock: ${uncapped}`);
    assert.ok(/\bsettledPositionCap\s*\(\s*recordPositions\b/.test(rcode), `${READER} never asks the clock's cap for the records stream`);
  });
});

/** The owner's code, comments blanked: read once for the case above. */
function code0() { return blankComments(readFileSync(join(REPO_ROOT, OWNER), 'utf8')); }
