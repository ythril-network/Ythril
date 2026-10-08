/**
 * The six replicated families are listed ONCE, and both directions iterate that list.
 *
 * ## What this replaces
 *
 * `sync/engine.ts` enumerated them twice — six `pullType` calls with six result assignments, then six
 * `pushCollection` calls with five more. A seventh family was six edits in two places, which is exactly
 * how the SIXTH came to be missing from three separate lists: `Q-2` found `filemeta` absent from pull's
 * watermark max, from push's, and from the local seq bump, and each omission was silent.
 *
 * `Q-2` removed the derived lists by building one object per direction. This removes the enumerations that
 * BUILD those objects, which is the half that was left — and it is what pays back the god-file raise that
 * `Q-2` took (975 → 979), rather than shortening lines to get under it.
 *
 * ## Why a gate rather than trusting the refactor
 *
 * The defect it prevents is additive: nothing breaks when a seventh family is added to one list and not
 * the other. It compiles, it runs, and one direction silently ignores a whole record type. That is the
 * shape `CLAUDE.md` names as this repo's most expensive, and it has already cost one release here.
 *
 * Run: node --test testing/standalone/the-replicated-families-are-one-table.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

const ENGINE = 'server/src/sync/engine.ts';
/*
 * The list lives in its OWN module, not in the engine. Which record types replicate is a fact about
 * replication rather than about the engine's loop — the merkle hash, the ingest schemas and the
 * retention sweep each hold an opinion of the same set, and each has been wrong about it at least once.
 *
 * It also had to leave: folding the two enumerations into a table INSIDE `engine.ts` made that file
 * BIGGER (986 -> 993), and `A-12` exists to pay back a god-file raise rather than take another one.
 */
const FAMILIES = 'server/src/sync/replicated-families.ts';
const code = (f) => stripComments(readFileSync(f, 'utf8'));

describe('one list of families, iterated by both directions', () => {
  it('the list exists at all', () => {
    /*
     * Presence only. WHICH families belong in it is asserted by `one-watermark-every-transfer`, which
     * derives them from `BRAIN_COLLECTIONS` — the first version of this case wrote the six names out,
     * which made the gate against two hand-written lists into the second hand-written list.
     */
    const src = code(FAMILIES);
    const at = src.indexOf('REPLICATED_FAMILIES');
    assert.ok(at > 0, 'there is no single list of replicated families');
    const table = src.slice(at, src.indexOf('] as const', at));
    const rows = [...table.matchAll(/payloadKey:/g)].length;
    assert.ok(rows >= 5, `only ${rows} rows in the family list — it has stopped being the list`);
  });

  /*
   * Re-anchored for bundle-52: the per-family transfers moved out of the engine (`pullType` -> `pullFamily` in
   * `sync/pull-family.ts`, `pushCollection` -> `pushFamily` in `sync/push-family.ts`) so that the engine could shrink. The
   * rule is unchanged — ONE call site per direction, inside the loop over the list — and each case asserts the anchor
   * is FOUND before it counts, so a rename that leaves it matching nothing fails here rather than passing.
   */
  it('PULL iterates it instead of naming each family', () => {
    const src = code(ENGINE);
    assert.match(src, /import \{[^}]*\bpullFamily\b[^}]*\} from '\.\/pull-family\.js'/, 'the engine no longer imports the per-family pull — re-anchor this case');
    const loop = src.search(/for \(const family of REPLICATED_FAMILIES\) \{\s*pulled\[family\.payloadKey\] = await pullFamily\(/);
    assert.notEqual(loop, -1, 'the pull is no longer a loop over REPLICATED_FAMILIES calling pullFamily — re-anchor this case');
    const calls = [...src.matchAll(/await pullFamily[<(]/g)].length;
    assert.equal(calls, 1,
      `${calls} pullFamily call sites — the pull side must call it once, inside the loop over the list, or a `
      + 'seventh family is an edit here as well as in the list');
  });

  it('and PUSH iterates it too', () => {
    const src = code(ENGINE);
    assert.match(src, /import \{[^}]*\bpushFamily\b[^}]*\} from '\.\/push-family\.js'/, 'the engine no longer imports the per-family push — re-anchor this case');
    const calls = [...src.matchAll(/await pushFamily[<(]/g)].length;
    assert.equal(calls, 1,
      `${calls} pushFamily call sites — the push side must call it once, inside the loop`);
    assert.match(src, /for \(const family of REPLICATED_FAMILIES\) \{\s*pushed\[family\.payloadKey\] = await pushFamily\(/,
      'the push call is not inside the loop over REPLICATED_FAMILIES');
    // And the engine must not have grown a per-family transfer of its own back.
    assert.doesNotMatch(src, /\basync function (?:pullType|pushCollection|pullFamily|pushFamily)\b/, 'a per-family transfer is declared in the engine again');
  });

  it('the per-family transfers read the family row, not a name', () => {
    // The filter and the url come from the ROW (`family.pushFilter`, `family.payloadKey`): a transfer that took them as
    // arguments from the engine is where a seventh family with its own filter would be forgotten.
    const push = code('server/src/sync/push-family.ts');
    assert.match(push, /family\.pushFilter\b/, 'the push no longer reads the family\'s own filter');
    assert.match(push, /family\.collection\b/, 'the push no longer reads the family\'s collection');
    const pull = code('server/src/sync/pull-family.ts');
    assert.match(pull, /family\.payloadKey\b/, 'the pull no longer reads the family\'s payload key');
  });

  it('the file-metadata push filter travels WITH the list, not beside it', () => {
    /*
     * `filemeta` pushes parents only: a chunk is derived from the blob and the receiver makes its own,
     * with its own chunker and model — sent, it would carry passage text and a vector another instance
     * cannot rank. That is a property OF the family, so it belongs in the row rather than in a special
     * case at the call site, which is where a seventh family with its own filter would be forgotten.
     */
    const src = code(FAMILIES);
    const at = src.indexOf('REPLICATED_FAMILIES');
    const table = src.slice(at, src.indexOf('] as const', at));
    // The row names the one live-file filter (bundle-48: parents only AND not soft-deleted); that filter must still hold
    // the parents-only half, or naming it in the row would prove nothing.
    assert.match(table, /payloadKey: 'filemeta'[^}]*pushFilter: LIVE_FILE_ROW/,
      'the parents-only filter is not in the family list, so it is a special case at a call site');
    assert.match(code('server/src/files/live-file-row.ts'), /parentFileId:\s*Object\.freeze\(\{ \$exists: false \}\)/,
      'the live-file filter the families table names no longer keeps chunks off the wire');
  });
});
