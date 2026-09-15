/**
 * `save_bulk` says where it loses data quietly, and each claim is pinned to the code.
 *
 * ## Two silent losses and one asymmetry
 *
 * **1. Items past 500 per collection vanish.** `slice(v, 0, BULK_MAX_PER_TYPE)` runs before validation, so
 * entry 501 is not rejected — it is never seen. It appears in neither `inserted` nor `errors`, and nothing in
 * the reply hints that the payload was truncated. The old description mentioned the cap inside one
 * parameter's own text ("excess entries are dropped") where a caller reading the tool summary would not meet
 * it, and never said the loss was unreported.
 *
 * **2. A successful call may have written nothing.** Partial success is the contract, so there is no failure
 * status: every rejection lands in `errors` and the call still returns normally. A caller who treats the
 * result as proof of success is wrong, and this tool invites exactly that.
 *
 * **3. References are checked for SHAPE, never existence** — unlike `remember` and `update_fact`, which
 * call `assertRefsResolve` under strict linkage and refuse a link that points at nothing. Bulk deliberately
 * does not, and the cost is real and worth stating: bulk can store a dangling link the single-record path
 * would have refused.
 *
 * **This file used to say the reason was forward references, and that was W-12.** It was one of six copies of
 * a claim the ID-IS-ID ruling had made false: a supplied id addresses an existing record but never becomes a
 * new one's identity, so an entity created by a batch is stored under a minted id and an edge in the same
 * payload naming the caller's id points at nothing. Two of the cases below asserted the false sentence into
 * place, which is why correcting the tool broke them — the gate was holding the defect. What the asymmetry is
 * actually for is a space that permits dangling references, and
 * `a-bulk-payload-cannot-reference-its-own-new-records-db.test.js` now holds the whole claim across all five
 * surfaces, in both directions.
 *
 * Run: node --test testing/standalone/bulk-write-states-its-silent-losses.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

const TOOL = stripComments(readFileSync('server/src/mcp/tools/bulk.ts', 'utf8'));
const CORE = stripComments(readFileSync('server/src/brain/bulk.ts', 'utf8'));
const MEMORY_TOOL = stripComments(readFileSync('server/src/mcp/tools/memory.ts', 'utf8'));

const DESC = (() => {
  const at = TOOL.indexOf("name: 'save_bulk'");
  assert.ok(at > 0, 'bulk_write not found — the scanner is wrong, not the code');
  const d = TOOL.indexOf('description:', at);
  const end = TOOL.slice(d).search(/\n {2,}(mutating|spaceRequired|skipSchemaValidation|inputSchema|async handle):/);
  assert.ok(end > 0, 'could not find the end of bulk_write\'s description');
  return TOOL.slice(d, d + end);
})();

describe('the 500 cap is described as the silent loss it is', () => {
  it('says it is SILENT, not merely that a cap exists', () => {
    assert.match(DESC, /SILENTLY DROPPED/,
      'a cap a caller can see in `errors` is survivable; one they cannot is not');
  });

  it('says the drop appears in neither counter', () => {
    assert.match(DESC, /not counted in\s*'?\s*\+?\s*'?`errors`|not counted in `errors`/,
      'the reply gives no way to detect the truncation, which is the actionable half');
  });

  it('says the cap is PER COLLECTION, so a caller does not split unnecessarily', () => {
    assert.match(DESC, /per collection/i, '500 memories and 500 entities in one call is fine');
  });

  it('and the truncation really happens before validation', () => {
    // Pinned to the implementation: if the slice ever moved after validation, or started reporting, this
    // description would be overstating the danger.
    assert.match(CORE, /export const BULK_MAX_PER_TYPE = 500/, 'the cap');
    assert.match(CORE, /v\.slice\(0, BULK_MAX_PER_TYPE\)/, 'applied by a plain slice');
    assert.doesNotMatch(CORE, /truncated|droppedCount/,
      'a truncation report appeared — say so in the description instead of calling it silent');
  });
});

describe('partial success is stated as the trap it is', () => {
  it('leads with "may have written nothing"', () => {
    assert.match(DESC, /MAY HAVE WRITTEN NOTHING/,
      'there is no failure status, so the caller has to be told to look');
  });

  it('names both response fields the caller must read', () => {
    assert.match(DESC, /`inserted`/, 'what landed');
    assert.match(DESC, /`errors`/, 'and what did not');
  });

  it('and says errors are indexed, so a caller can map them back', () => {
    assert.match(DESC, /INDEX/, 'an error without a position is not actionable on a 500-item batch');
    assert.match(CORE, /errors\.push\(\{ type: 'memory', index: i/, 'and they really are');
  });
});

describe('the reference-checking asymmetry is stated', () => {
  it('says shape is always checked, and existence only on a converted space', () => {
    /*
     * This asserted `SHAPE, NEVER FOR EXISTENCE` — true until `F-27` item 2, when the owner ruled that a
     * space using link records checks resolution here as everywhere else. Re-pointed rather than relaxed:
     * the description still has to state BOTH halves, because "sometimes" is the one answer a caller cannot
     * act on.
     */
    assert.match(DESC, /CHECKED FOR SHAPE/, 'the half that is always true');
    assert.match(DESC, /EXISTENCE ONLY ON A CONVERTED SPACE/i, 'and the condition on the other half');
    assert.match(DESC, /UNCONVERTED/i, 'stated from both sides, or a reader has to infer the complement');
  });

  it('states the COST of the asymmetry, and what to do about it', () => {
    /*
     * The reason used to be given as forward references, which was false — see the note at the top. What is
     * left is the honest half: the caller has to know a dangling link can land here, and how to find one.
     */
    assert.match(DESC, /dangling link/i, 'a caller cannot act on an asymmetry whose consequence is unstated');
    assert.match(DESC, /`traverse`/, 'and needs to be told how to find one after a large import');
  });

  it('and does NOT offer a forward reference as the reason', () => {
    // The claim itself is gated across all five surfaces elsewhere; this is the local floor, so a rewrite of
    // this description cannot quietly reintroduce it while these cases stay green.
    assert.doesNotMatch(DESC, /forward reference|created LATER in the same/i,
      'a supplied id never becomes a new record\'s identity, so a batch cannot reference a record it creates '
      + '— see a-bulk-payload-cannot-reference-its-own-new-records-db.test.js');
  });

  it('and the asymmetry is real: bulk checks format, the single-record path checks resolution', () => {
    assert.match(CORE, /UUID_V4_RE\.test\(id\)/, 'bulk checks the shape');
    /*
     * The asymmetry is CONDITIONAL since `F-27` item 2, on the owner's ruling: a converted space
     * existence-checks, an unconverted one keeps the import trade. Asserting the check is absent would now
     * pin the old behaviour — what has to hold is that the description states the condition, so the claim
     * and the code cannot drift apart.
     */
    assert.match(CORE, /assertRefsResolve/, 'a converted space must check that a reference resolves');
    assert.match(DESC, /CONVERTED SPACE/i,
      'the description must say WHEN existence is checked, or the asymmetry it describes is simply wrong');
    assert.match(MEMORY_TOOL, /assertRefsResolve\(/,
      'and the single-record path still resolves, which is what makes this a contrast');
  });
});

describe('the processing order is stated with its consequence', () => {
  it('names the order', () => {
    // EDGES LAST since `F-27` item 2: a reference cannot point forwards, so an edge to a chrono entry in
    // the same payload could never have resolved under the old order.
    assert.match(DESC, /memories → entities → chrono → edges/, 'the order itself');
  });

  it('and says what it buys — an UPDATED record is written before an edge reads it', () => {
    /*
     * This case used to accept `/same batch/`, which is why it stayed green through the correction while
     * asserting nothing: the phrase survives in the true sentence too. The order is worth stating because of
     * what it does for records the batch UPDATES — a supplied id that already resolves is written before the
     * edges pass — and that is a narrower claim than the one it replaces.
     */
    assert.match(DESC, /UPDATES|already exists/,
      'the order is only worth stating for what it does to a record the batch updates');
    assert.match(DESC, /before an edge/i, 'and the consequence has to be spelled out, not implied by the arrow');
  });

  it('and the code really runs in that order', () => {
    const iMem = CORE.indexOf('const memories = slice(input.memories)');
    const iEnt = CORE.indexOf('const entities = slice(input.entities)');
    const iEdge = CORE.indexOf('const edges = slice(input.edges)');
    const iChrono = CORE.indexOf('const chrono = slice(input.chrono)');
    // EDGES LAST since `F-27` item 2. A reference cannot point forwards, so under the old order an edge to
    // a chrono entry created in the same payload could never have resolved.
    assert.ok(iMem > 0 && iEnt > iMem && iChrono > iEnt && iEdge > iChrono,
      `order changed: memories=${iMem} entities=${iEnt} chrono=${iChrono} edges=${iEdge}. Every record array `
      + 'must be written before any edge, or a batch reference to a record of a later kind cannot resolve.');
  });
});
