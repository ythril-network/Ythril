/**
 * A test that writes an ARRAY LINK field aims it at a space it created itself.
 *
 * ## The trap, measured rather than assumed
 *
 * `convertPendingSpaces` converts every non-proxy space that is not already marked, at every boot. So
 * `general` — created by first-run setup, marked at the boot after — is **always `completeLinkage` on a
 * running test stack**, and `array-write-refusal` then refuses `entityIds`, `memoryIds` and `chronoIds`
 * on it. Both halves are correct: the migration is the point, and refusing the legacy field on a
 * converted space is what it is for.
 *
 * A space a test creates through the API is NOT converted, because no boot has happened since. So the
 * same call succeeds or fails depending on which space the test chose, and the failure names a
 * migration the test knows nothing about:
 *
 * ```
 * this space's links are all link records (`completeLinkage`), so entityIds is no longer written
 * directly — use POST /api/brain/spaces/:spaceId/links
 * ```
 *
 * **`Q-26` first blamed a standalone DB test for converting `general`, and that was wrong.** Every DB
 * test gets its own database and its own temp config; running the whole standalone suite changes no
 * space field in the shared config. The boot conversion does it, and the container log says so. The
 * cost of the wrong cause is why this file explains the right one.
 *
 * ## The rule
 *
 * A hard-coded space id in a test path is a SHARED space — it outlives the test, and on a running stack
 * it has been through the conversion. An array-link field aimed at one is a failure waiting for the next
 * boot. `linkEntities` and its siblings work on a converted space and an unconverted one alike (`Q-28`),
 * so there is a spelling that is always right.
 *
 * **Not "never use `general`".** Reading it is fine, writing a record to it is fine, and 113 calls do.
 * It is the ARRAY LINK FIELDS specifically, because those are what the conversion retires.
 *
 * ## Seen red
 *
 * By mutation: adding `entityIds` to a `general` write in `brain.test.js` makes this name the line.
 *
 * Run: node --test testing/standalone/a-test-does-not-write-array-links-to-a-shared-space.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

/** The fields the conversion retires. A converted space refuses every one of them. */
const ARRAY_LINK_FIELDS = ['entityIds', 'memoryIds', 'chronoIds'];

/**
 * A space id is SHARED when it is a literal — no `${…}` in it.
 *
 * A test that creates its own space builds the id from a nonce (`` `probe-${RUN}` ``), so the template
 * marker is the signal, and it needs no list of shared names to maintain. `general` is the one that
 * exists today; a second built-in would be covered on the day it is added.
 */
const SHARED_SPACE_IN_PATH = /spaces\/([a-z0-9][a-z0-9-]*)\//g;

/** Every call in the test tree that targets a shared space, with the text of that call. */
function sharedSpaceCalls() {
  const found = [];
  for (const { file, text } of readTrackedSources('testing', { ext: ['.test.js', '.mjs'], floor: 100 })) {
    const src = stripComments(text);
    /*
     * Line numbers come from the ORIGINAL text, never the stripped copy.
     *
     * `stripComments` removes whole lines, so an offset in `src` names a different line in the file a
     * reader opens — the first version of this gate reported lines 24 and 912 for a mutation at line 38.
     * A gate that fires correctly and points somewhere else sends the next person to the wrong code.
     *
     * Matched by OCCURRENCE: the nth hit of this path in the stripped source is the nth in the raw one,
     * because stripping removes comments and comments are not code.
     */
    const seen = new Map();
    const rawLineOf = (needle) => {
      const n = (seen.get(needle) ?? 0);
      seen.set(needle, n + 1);
      let at = -1;
      for (let k = 0; k <= n; k++) at = text.indexOf(needle, at + 1);
      return at < 0 ? 0 : text.slice(0, at).split('\n').length;
    };
    for (const m of src.matchAll(SHARED_SPACE_IN_PATH)) {
      /*
       * The ENCLOSING call, bounded by its own parentheses rather than by a character count — a fixed
       * window spans different lines on CRLF than on LF, and one that can fall short of its subject is
       * a gate that passes by looking away.
       *
       * Scanning back to the nearest `(` was the first version and it found NOTHING, every time: in
       * `post(INSTANCES.a, token(), '/api/brain/spaces/general/facts', {…})` the nearest `(` before the
       * path belongs to `token()`, which closes before the body is reached. The gate passed a mutation
       * that added `entityIds` to exactly the call it exists to refuse. The `(` wanted is the one whose
       * match comes AFTER the path, so the walk back has to count depth.
       */
      let depth = 0, open = -1;
      for (let k = m.index; k >= 0; k--) {
        if (src[k] === ')') depth++;
        else if (src[k] === '(') { if (depth === 0) { open = k; break; } depth--; }
      }
      if (open < 0) continue;
      let d = 0, j = open;
      for (; j < src.length; j++) {
        d += (src[j] === '(' ? 1 : 0) - (src[j] === ')' ? 1 : 0);
        if (d === 0) break;
      }
      found.push({
        file: file.replace(/\\/g, '/'),
        space: m[1],
        line: rawLineOf(m[0]),
        call: src.slice(open, j + 1),
      });
    }
  }
  return found;
}

describe('a test does not write array links to a shared space', () => {
  it('the sweep finds shared-space calls at all, so an empty set cannot pass', () => {
    // An empty scan passes every loop written over it and reports a green tick about nothing.
    const calls = sharedSpaceCalls();
    assert.ok(calls.length >= 50,
      `only ${calls.length} shared-space call(s) found — the sweep is broken, not the tests`);
    assert.ok(calls.some(c => c.space === 'general'),
      `\`general\` must be among them: ${JSON.stringify([...new Set(calls.map(c => c.space))].slice(0, 8))}`);
  });

  it('none of them carries an array link field', () => {
    const offenders = sharedSpaceCalls()
      .filter(c => ARRAY_LINK_FIELDS.some(f => new RegExp(`\\b${f}\\s*:`).test(c.call)))
      .map(c => `${c.file}:${c.line}  (space '${c.space}')
        ${c.call.replace(/\s+/g, ' ').slice(0, 160)}`);
    assert.deepEqual(offenders, [],
      `these calls write a legacy array link field to a SHARED space:\n`
      + offenders.map(o => `  ${o}`).join('\n')
      + `\n\n      A shared space has been through the link conversion — every boot converts every space`
      + `\n      that is not already marked — so \`array-write-refusal\` answers 400 and names a migration`
      + `\n      the test knows nothing about. It passes today only while the stack has not rebooted since`
      + `\n      the space was made. Use \`linkEntities\` / \`linkFacts\` / \`linkChronos\`, which work on a`
      + `\n      converted space and an unconverted one alike, or create a space in the test and use that.`);
  });
});
