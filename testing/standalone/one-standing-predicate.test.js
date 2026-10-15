/**
 * ONE answer to "does a deletion, wipe or rename stand for this space" — spelled in one place, asked by every refusal, hold and admission (bundle-106 PR A, X1, §2.5a).
 *
 * ## What the rule prevents
 *
 * The first design had three predicates over three different sets: (owed or in flight or marker or `pendingSpaceOp`) for the write gate,
 * (in flight or owed or marker) for the hold, the marker alone for the rest — and the weakest one let a write land that the act then
 * deleted. The rule is `spaceActStands(cfg, localId, { types?, except? })` in the runner, which reads the act entries and the
 * body's `pendingSpaceOp` write-ahead, and which every asker calls; nothing else reads those lists to DECIDE.
 *
 * ## The gate holds the rule, not a list of sites
 *
 * - The reads of `pendingSpaceActs` are derived over `server/src`: only the runner reads them, plus the exemption table below, each with its reason, each failing when its
 *   file stops matching (a reason once written is never re-read).
 * - The askers of `spaceActStands(` are derived, and a floor names the ones the design's table gives: the write gate, the hold, rename and the runner.
 * - `pendingSpaceOp` is read to decide only by the write gate, the runner, and the table's exemptions; `spaceActOwed(` (a property of a ROUND) is
 *   called from no door that refuses, holds or admits — those ask the predicate, which reads the entry the round's owed state agrees with.
 * - The two askers whose BODY is the rule are read: `spaceWriteRefusal` passes its family, and `spaceHold` asks without one (an exchange moves every family).
 *
 * ## Seen red
 *
 * On the base the predicate does not exist. After it does: make the write gate read `state: 'running'` entries only (design §6.3 step 34), or read
 * `pendingSpaceActs` in `spaceHold` directly — the second is this gate's red.
 *
 * Run: `node --test testing/standalone/one-standing-predicate.test.js`
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RUNNER, requireSource, bodyOf, filesMatching } from './_space-act-sources.mjs';

const WRITE_GATE = 'server/src/spaces/space-write-gate.ts';

/** Files that may name `pendingSpaceActs` besides the runner, and why. Each must still match (else this table is stale). */
const ACT_LIST_EXEMPT = new Map([
  ['server/src/config/types.ts', 'the declaration of the field and of SpaceActEntry; it decides nothing'],
  ['server/src/spaces/rename.ts', 'applySpaceRenameToConfig rewrites an entry\'s localId inside the rename\'s one commit (X3); a rewrite, never a refusal, hold or admission'],
]);

/** Files that may name `pendingSpaceOp` besides the write gate and the runner, and why. Each must still match. */
const MARKER_EXEMPT = new Map([
  ['server/src/config/types.ts', 'the declaration of the marker'],
  ['server/src/spaces/lifecycle.ts', 'the delete body\'s own write-ahead and its crash resume (AM3: phase 1 reads ONLY this)'],
  ['server/src/spaces/rename.ts', 'the rename body\'s own write-ahead and its commit'],
  ['server/src/config/reload-space-diff.ts', 'a reload must not read the space a marker names as removed; it refuses nobody'],
  ['server/src/networks/network-spaces.ts', 'defers one heal pass while a body is moving a space; it refuses nobody'],
]);

/** The directories whose files REFUSE, HOLD or ADMIT a caller: none of them decides from a round's owed state. */
const DECIDING_DIRS = ['server/src/sync/', 'server/src/api/', 'server/src/mcp/', 'server/src/auth/', 'server/src/files/', 'server/src/brain/', 'server/src/db/'];

describe('one standing predicate: spaceActStands answers, everything else asks', () => {
  it('the predicate exists, in the runner, with the signature the design gives', () => {
    const src = requireSource(RUNNER);
    assert.match(src, /export\s+function\s+spaceActStands\s*\(\s*cfg\s*:\s*Config\s*,\s*localId\s*:\s*string/, 'the runner exports no spaceActStands(cfg, localId, …)');
    assert.match(src, /\bpendingSpaceOp\b/, 'the predicate does not include the body\'s pendingSpaceOp write-ahead (AM3, §2.5a)');
  });

  it('only the runner reads pendingSpaceActs, except the exemption table, and every exemption still matches', () => {
    const readers = filesMatching(/\bpendingSpaceActs\b/).map(([f]) => f);
    assert.ok(readers.includes(RUNNER), `the runner does not touch pendingSpaceActs: ${readers.join(', ')}`);
    const stray = readers.filter(f => f !== RUNNER && !ACT_LIST_EXEMPT.has(f));
    assert.deepEqual(stray, [], `a module other than the runner reads the act list: ${stray.join(', ')} — ask spaceActStands( instead`);
    for (const [f, why] of ACT_LIST_EXEMPT) assert.ok(readers.includes(f), `the exemption for ${f} (${why}) no longer matches: remove or re-reason it`);
  });

  it('the askers of spaceActStands( are derived, and include the write gate, the hold, rename and the runner', () => {
    const askers = filesMatching(/(?<![\w.$])spaceActStands\s*\(/).map(([f]) => f);
    assert.ok(askers.includes(WRITE_GATE), 'the write gate does not ask the predicate');
    assert.ok(askers.includes('server/src/spaces/rename.ts'), 'rename does not ask the predicate (X3: refuse while a deletion or wipe stands, excluding its own entry)');
    assert.ok(askers.includes(RUNNER), 'the runner does not ask its own predicate');
    const holds = filesMatching(/function\s+spaceHold\b/).map(([f]) => f);
    assert.equal(holds.length, 1, `spaceHold is defined in ${holds.length} places: ${holds.join(', ')}`);
    assert.ok(askers.includes(holds[0]), `${holds[0]} (hold (a)) does not ask the predicate`);
    assert.ok(askers.length >= 4, `only ${askers.length} asker file(s) found: the derivation is broken`);
  });

  it('pendingSpaceOp decides nothing outside the write gate, the runner and the exemption table', () => {
    const readers = filesMatching(/\.\s*pendingSpaceOp\b|\bpendingSpaceOp\s*[?:]/).map(([f]) => f);
    assert.ok(readers.length >= 3, `only ${readers.length} reader(s) of pendingSpaceOp found: the derivation is broken`);
    const stray = readers.filter(f => f !== WRITE_GATE && f !== RUNNER && !MARKER_EXEMPT.has(f));
    assert.deepEqual(stray, [], `a module decides from the marker instead of asking the predicate: ${stray.join(', ')}`);
    for (const [f, why] of MARKER_EXEMPT) assert.ok(readers.includes(f), `the marker exemption for ${f} (${why}) no longer matches`);
  });

  it('no door that refuses, holds or admits reads a round\'s owed state: spaceActOwed( is called from no deciding directory', () => {
    const callers = filesMatching(/(?<![\w.$])spaceActOwed\s*\(/).map(([f]) => f);
    const deciding = callers.filter(f => DECIDING_DIRS.some(d => f.startsWith(d)));
    assert.deepEqual(deciding, [], `a refusal, hold or admission decides from spaceActOwed( — ask spaceActStands(: ${deciding.join(', ')}`);
    assert.ok(filesMatching(/export\s+function\s+spaceActOwed\b/).length === 1, 'spaceActOwed is not defined exactly once (the round\'s one owed predicate, W5)');
  });

  it('spaceWriteRefusal passes the write\'s family to the predicate; the hold asks without one', () => {
    const refusal = bodyOf(WRITE_GATE, 'spaceWriteRefusal');
    assert.match(refusal, /spaceActStands\s*\([^)]*\{[^}]*types\s*:/s, 'spaceWriteRefusal does not scope the question to the write\'s family');
    const holdFile = filesMatching(/function\s+spaceHold\b/).map(([f]) => f)[0];
    assert.ok(holdFile, 'spaceHold is not defined');
    const hold = bodyOf(holdFile, 'spaceHold');
    const ask = /spaceActStands\s*\(([^)]*)\)/s.exec(hold);
    assert.ok(ask, 'spaceHold does not ask spaceActStands(');
    assert.doesNotMatch(ask[1], /types\s*:/, 'spaceHold scopes its question to a family: an exchange moves every family (§2.5a)');
  });
});
