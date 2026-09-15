/**
 * Every `delete_*` tool says what it does NOT delete, and which of them can refuse.
 *
 * ## The asymmetry a caller cannot guess
 *
 * `delete_entity`, `delete_fact` and `delete_chrono` each consult the blockers for their own kind and,
 * under strict linkage, refuse while anything still points at the record. `delete_edge` deletes
 * unconditionally, and that is the real asymmetry: an edge IS the link, so there is nothing structural
 * left dangling when it goes.
 *
 * **This paragraph said three of the four delete unconditionally, and that a chrono entry's `memoryIds`
 * could be left holding a dead id "silently, on a space configured to forbid exactly that shape".** Two of
 * those three gained the check, and the body of this very file says so in an inline comment — *"The
 * asymmetry this block was written for is GONE"* — and asserts the refusals. So the header described the
 * old world while the assertions ten lines down proved the new one, and a reader who stopped at the header
 * wrote no handling for a refusal they will get.
 *
 * The point that survives is why `delete_edge` is different, and that a refusal is not inferable from a
 * description: the four read identically before this file existed — *"Delete an X by ID. Creates a
 * tombstone for sync propagation."*
 *
 * ## The other three things a delete has to say
 *
 * - **Retire vs delete.** `suppressEmbeddings` is what "stop it appearing in search" actually means;
 *   deleting is a much larger change and there is no undo. A caller who wanted the first and used the second
 *   cannot get the record back.
 * - **The tombstone is why re-creating with the same id does not undo it.** The deletion propagates, and the
 *   tombstone outranks a later write of that id — which is the surprising half.
 * - **What survives.** Deleting an edge leaves both endpoints; deleting a chrono entry leaves everything it
 *   linked. Stated because "delete the relationship" and "delete the things" are one keystroke apart.
 *
 * Run: node --test testing/standalone/delete-tools-state-what-survives.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

const description = (file, name) => {
  const s = stripComments(readFileSync(file, 'utf8'));
  const at = s.indexOf(`name: '${name}'`);
  assert.ok(at > 0, `${name} not found in ${file} — the scanner is wrong, not the code`);
  const d = s.indexOf('description:', at);
  const end = s.slice(d).search(/\n {2,}(mutating|spaceRequired|admin|spaceAdmin|inputSchema|async handle):/);
  assert.ok(end > 0, `could not find the end of ${name}'s description`);
  return s.slice(d, d + end);
};

const TOOLS = {
  delete_entity: description('server/src/mcp/tools/entity.ts', 'delete_entity'),
  delete_edge: description('server/src/mcp/tools/edge.ts', 'delete_edge'),
  delete_fact: description('server/src/mcp/tools/memory.ts', 'delete_fact'),
  delete_chrono: description('server/src/mcp/tools/chrono.ts', 'delete_chrono'),
};

describe('every delete says it cannot be undone, and what to use instead', () => {
  for (const [name, d] of Object.entries(TOOLS)) {
    it(`${name} says IRREVERSIBLE`, () => {
      assert.match(d, /IRREVERSIBLE/, 'a destructive tool must lead with that');
    });

    it(`${name} points at the retire alternative`, () => {
      // The mistake this pre-empts: wanting a record out of search results and reaching for delete.
      assert.match(d, /suppressEmbeddings/,
        'a caller who wanted "stop showing this" must be told the non-destructive option exists');
    });

    it(`${name} explains the tombstone, not just that there is one`, () => {
      // "Creates a tombstone for sync propagation" was the whole of three of these descriptions and told a
      // caller nothing they could act on. The actionable half is that it outranks a later write of that id.
      assert.match(d, /tombstone/i, 'name it');
      assert.match(d, /peer/i, 'and say it propagates');
    });
  }
});

describe('which deletes can be refused, and each one says so where the caller is', () => {
  it('delete_entity says it CAN be refused, and that a refusal is usually correct', () => {
    assert.match(TOOLS.delete_entity, /REFUSAL HERE IS USUALLY CORRECT/,
      'a caller who reads a refusal as an obstacle will work around it');
    assert.match(TOOLS.delete_entity, /strictLinkage/, 'and say what turns the guard on');
  });

  /*
   * **The asymmetry this block was written for is GONE, and that is the change rather than the gate
   * relaxing.** It read: three of the four are NEVER refused, because strict linkage guards entity deletion
   * only. That was true, and it was true for a bad reason — three of the six link fields had no reader
   * anywhere in the server, so a chrono entry naming a memory was a reference nothing could see. The
   * referring record was quietly left pointing at something that no longer existed, which is the outcome
   * `strictLinkage` is bought to prevent.
   *
   * `M-2` gave those fields readers. Two of the three now behave like the entity delete, and their
   * descriptions have to say so — a caller who read the old paragraph built on it.
   */
  for (const name of ['delete_fact', 'delete_chrono']) {
    it(`${name} says it CAN be refused now, and that this CHANGED`, () => {
      assert.match(TOOLS[name], /REFUSED IF SOMETHING STILL POINTS AT IT/,
        'the guard applies to this delete and the description still says it never does');
      assert.match(TOOLS[name], /CHANGED IN 4\.0/,
        'a caller with a working script needs to know this is new, not that it is the rule — the sentence that only states the rule leaves them reading it as something they had missed');
      assert.match(TOOLS[name], /strict linkage OFF/i,
        'and where it does not apply, because that is the way out for a caller who does not want it');
    });
  }

  it('delete_edge is still never refused, and now says WHY rather than citing the old asymmetry', () => {
    /*
     * The one that did not change, and it did not change for a structural reason rather than a policy one:
     * links run FROM a memory, chrono entry or file TO what it is about, and no link class has an edge at
     * its `to` end. Nothing can point at an edge, so there is nothing to block on.
     *
     * Its old paragraph explained itself with 'strict linkage guards ENTITY deletion only', which is no
     * longer true of the product — a correct conclusion resting on a stale premise, which is the shape that
     * survives review because the visible half still reads right.
     */
    assert.match(TOOLS.delete_edge, /NEVER REFUSED FOR BEING REFERENCED/,
      'still true of an edge, and worth stating beside three tools where it is not');
    assert.doesNotMatch(TOOLS.delete_edge, /ENTITY deletion only/,
      'delete_edge still explains itself with an asymmetry that no longer exists');
    assert.match(TOOLS.delete_edge, /point AT an edge|never the target/i,
      'and must give the reason it is exempt, which is that nothing links to an edge');
  });

  it('and the claims are true — source, not prose', () => {
    // Read from source, so a description and its behaviour cannot drift apart in either direction.
    const has = (f) => /entityDeleteBlockers\(/.test(stripComments(readFileSync(f, 'utf8')));
    for (const f of ['server/src/mcp/tools/entity.ts', 'server/src/mcp/tools/memory.ts',
      'server/src/mcp/tools/chrono.ts']) {
      assert.ok(has(f), `${f} promises a reference guard and does not consult one`);
    }
    assert.ok(!has('server/src/mcp/tools/edge.ts'),
      'delete_edge gained a reference guard — nothing can point at an edge, so it would block on nothing, and its description says it is never refused');
  });
});
