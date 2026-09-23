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
 * **3. References are checked for SHAPE, never existence** — unlike `saveFact` and `update_fact`, which
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
const LINKS = stripComments(readFileSync('server/src/brain/links.ts', 'utf8'));

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
    assert.match(CORE, /errors\.push\(\{ type: 'fact', index: i/, 'and they really are');
  });
});

describe('the reference-checking asymmetry is stated — and that it is GONE', () => {
  it('says shape and existence are both checked, as the single-record tools check them', () => {
    /*
     * This asserted `SHAPE, NEVER FOR EXISTENCE`, then `EXISTENCE ONLY ON A CONVERTED SPACE` when `F-27`
     * item 2 made it conditional. 5.0 removed the second shape, so the condition has one value and the
     * asymmetry is over — but the description still has to SAY so, because a caller who built around the
     * looser door is the person this text is for.
     */
    assert.match(DESC, /CHECKED FOR SHAPE AND FOR EXISTENCE/i, 'both halves, unconditionally');
    assert.match(DESC, /CONVERTED SPACE/i,
      'and what the condition used to be, or a caller written against 4.x cannot tell their dangling-link '
      + 'trade is gone');
  });

  it('states what a caller who relied on the trade has to do now', () => {
    /*
     * The cost moved sides. It used to be *"this door can write a dangling link"*; it is now *"an import
     * that used to land will be refused"*, and the caller needs to know which reference to fix.
     */
    assert.match(DESC, /refused/i, 'a caller cannot act on a tightening whose consequence is unstated');
    // The tool it names was `traverse` until 5.0 renamed it. Pinned to the LIVE name, so this case
    // fails if the pointer rots again rather than preserving the rot.
    assert.match(DESC, /`graph_traverse`/, 'and needs to be told how to check linkage after a large import');
  });
  it('and does NOT offer a forward reference as the reason', () => {
    // The claim itself is gated across all five surfaces elsewhere; this is the local floor, so a rewrite of
    // this description cannot quietly reintroduce it while these cases stay green.
    assert.doesNotMatch(DESC, /forward reference|created LATER in the same/i,
      'a supplied id never becomes a new record\'s identity, so a batch cannot reference a record it creates '
      + '— see a-bulk-payload-cannot-reference-its-own-new-records-db.test.js');
  });

  it('and the asymmetry is real: bulk checks format, the single-record path checks resolution', () => {
    /*
     * The shape check is the SHARED one since `Q-44`, not a UUID pattern written out here.
     *
     * This asserted `UUID_V4_RE.test(id)` — bulk's own copy, which checked less than the module every
     * single-record door calls: a `linkFiles` on a fact was accepted and never read, and a non-array
     * `linkEntities` was treated as empty. Pinning the copy would have made the gate an argument for
     * keeping it, which is the failure mode of asserting on a SITE rather than on the rule.
     */
    assert.match(CORE, /itemConnectionError\(/, 'bulk checks the shape, through the shared refusal');
    assert.match(CORE, /connectionInputError\(/, 'and that refusal is the one every other door calls');
    /*
     * The asymmetry is CONDITIONAL since `F-27` item 2, on the owner's ruling: a converted space
     * existence-checks, an unconverted one keeps the import trade. Asserting the check is absent would now
     * pin the old behaviour — what has to hold is that the description states the condition, so the claim
     * and the code cannot drift apart.
     */
    assert.match(CORE, /firstMissingEnd\(/, 'and existence, which is no longer conditional');
    assert.match(DESC, /CONVERTED SPACE/i,
      'the description must say what the condition USED to be, or a caller written against 4.x has no way '
      + 'to tell that their dangling-link trade is gone');
    /*
     * The single-record path resolves at the WRITER since 5.0 — `reconcileLinks` asserts every named class
     * exists — rather than at each door. Asserting on the tool file would pin the old location and fail on
     * the change that made the check true of `linkEntities` as well, which never had one.
     */
    assert.match(LINKS, /assertRefsResolve\(/,
      'the single-record path must still resolve, which is what makes the shapes agree');
  });
});

describe('the processing order is stated with its consequence', () => {
  it('names the order', () => {
    // EDGES LAST since `F-27` item 2: a reference cannot point forwards, so an edge to a chrono entry in
    // the same payload could never have resolved under the old order.
    assert.match(DESC, /facts → entities → chrono → edges/, 'the order itself');
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
    const iMem = CORE.indexOf('const facts = slice(input.facts)');
    const iEnt = CORE.indexOf('const entities = slice(input.entities)');
    const iEdge = CORE.indexOf('const edges = slice(input.edges)');
    const iChrono = CORE.indexOf('const chrono = slice(input.chrono)');
    // EDGES LAST since `F-27` item 2. A reference cannot point forwards, so under the old order an edge to
    // a chrono entry created in the same payload could never have resolved.
    assert.ok(iMem > 0 && iEnt > iMem && iChrono > iEnt && iEdge > iChrono,
      `order changed: facts=${iMem} entities=${iEnt} chrono=${iChrono} edges=${iEdge}. Every record array `
      + 'must be written before any edge, or a batch reference to a record of a later kind cannot resolve.');
  });
});
