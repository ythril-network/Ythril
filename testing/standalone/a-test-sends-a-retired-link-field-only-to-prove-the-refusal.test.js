/**
 * A test sends a RETIRED link field only where the refusal is the subject.
 *
 * ## What this used to be about, and why the rule got simpler
 *
 * It was about WHICH SPACE. A converted space refused `entityIds` and an unconverted one stored it,
 * so the same call passed or failed depending on whether the boot conversion had reached the space the
 * test happened to pick — and the failure named a migration the test knew nothing about.
 *
 * 5.0 removed the arrays. Every space refuses them, so the space no longer decides anything and the
 * rule is the shorter one: a test that sends a retired name is a test that will be refused, unless
 * being refused is the thing it is asserting.
 *
 * ## The exemption is a LIST, and each entry is checked
 *
 * Three suites send the old spelling on purpose — that the refusal happens, and that it names the
 * field to send instead, is exactly what they exist to prove. Each is required to assert a refusal,
 * so an entry cannot outlive the case it excuses.
 *
 * ## Seen red
 *
 * By mutation: adding `entityIds` to a write in `brain.test.js` makes this name the line.
 *
 * Run: node --test testing/standalone/a-test-sends-a-retired-link-field-only-to-prove-the-refusal.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

/** The fields the conversion retires. A converted space refuses every one of them. */
const ARRAY_LINK_FIELDS = ['entityIds', 'memoryIds', 'chronoIds'];

/**
 * A space id is SHARED when it RESOLVES to a literal, whether it is written inline or through a const.
 *
 * A test that creates its own space builds the id from a nonce (`` `probe-${RUN}` ``), so an
 * interpolation that survives resolution is the signal — and it needs no list of shared names.
 *
 * **The first version matched inline literals only, and that was a hole a live failure found.**
 * `entity-merge.test.js` writes `` `/api/brain/spaces/${SPACE}/facts` `` with `const SPACE = 'general'`
 * at the top, so the path in the source has no literal segment at all. The gate reported clean while
 * that exact call was failing in CI with the refusal this file exists to prevent. A title claiming "a
 * shared space" over a body that checked one way of WRITING one is this repo's most-repeated gate
 * failure, and it happened inside the gate written against it.
 */
const SHARED_SPACE_IN_PATH = /spaces\/([a-z0-9][a-z0-9-]*)\//g;
/** `spaces/${NAME}/` — resolved below against a `const NAME = '…'` in the same file. */
const SPACE_VAR_IN_PATH = /spaces\/\$\{(\w+)\}\//g;

/**
 * The string constants a file binds, so `${SPACE}` can be read as what it is.
 *
 * Only single-quoted literals: a const built from a template already contains its own interpolation and
 * is therefore the nonce case this rule means to allow through.
 */
function stringConsts(src) {
  const out = new Map();
  for (const m of src.matchAll(/const\s+(\w+)\s*=\s*'([^']*)'\s*;/g)) out.set(m[1], m[2]);
  return out;
}

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
    const consts = stringConsts(src);
    /*
     * Both spellings, in one pass: an inline literal, and a `${NAME}` that a const in this file
     * binds to one. A `${NAME}` the file does not bind is left alone — it is built elsewhere, and
     * guessing would be the heuristic this gate's own history argues against.
     */
    const hits = [...src.matchAll(SHARED_SPACE_IN_PATH)].map(m => ({ m, space: m[1] }))
      .concat([...src.matchAll(SPACE_VAR_IN_PATH)]
        .filter(m => consts.has(m[1]))
        .map(m => ({ m, space: consts.get(m[1]) })));
    for (const { m, space } of hits) {
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
        space,
        line: rawLineOf(m[0]),
        call: src.slice(open, j + 1),
      });
    }
  }
  return found;
}

/** The suites where the refusal IS the subject, each checked to assert one. */
const ASSERTS_THE_REFUSAL = [
  'testing/integration/entity-refs.test.js',
  'testing/integration/a-link-reaches-a-reader-on-any-space.test.js',
  'testing/integration/filter-answers-by-entity-name.test.js',
  'testing/standalone/a-files-metadata-replicates-db.test.js',
  'testing/standalone/brain-list-sort-unit.test.js',
  'testing/standalone/a-retired-write-field-is-refused-by-name.test.js',
  'testing/standalone/one-definition-of-a-link-class.test.js',
  'testing/standalone/the-retired-arrays-leave-the-disk-db.test.js',
  'testing/standalone/the-link-baseline-3x-answered-db.test.js',
  'testing/standalone/the-conversion-is-idempotent-db.test.js',
  'testing/standalone/a-test-sends-a-retired-link-field-only-to-prove-the-refusal.test.js',
];

describe('a test sends a retired link field only to prove it is refused', () => {
  it('the sweep finds calls at all, so an empty set cannot pass', () => {
    // An empty scan passes every loop written over it and reports a green tick about nothing.
    const calls = sharedSpaceCalls();
    assert.ok(calls.length >= 50,
      `only ${calls.length} space-scoped call(s) found — the sweep is broken, not the tests`);
    assert.ok(calls.some(c => c.space === 'general'),
      `\`general\` must be among them: ${JSON.stringify([...new Set(calls.map(c => c.space))].slice(0, 8))}`);
  });

  it('no call outside those suites carries one', () => {
    /*
     * BOTH SPELLINGS: `entityIds: […]` and the shorthand `{ fact, entityIds, tags }`.
     *
     * Requiring the colon was a hole, and a live CI failure found it rather than this gate:
     * `entity-merge.test.js` passed the field as shorthand, so the gate reported clean while that
     * exact call was being refused. And a KEY, never a VALUE: `{ linkEntities: entityIds }` passes a
     * variable named `entityIds` as the value of the correct field, which is not the defect.
     */
    const offenders = sharedSpaceCalls()
      .filter(c => !ASSERTS_THE_REFUSAL.includes(c.file))
      .filter(c => ARRAY_LINK_FIELDS.some(f => new RegExp(`[{,]\\s*${f}\\s*[:,}]`).test(c.call)))
      .map(c => `${c.file}:${c.line}  (space '${c.space}')`);
    assert.deepEqual(offenders, [],
      `these send a retired link field to a write door:\n`
      + offenders.map(o => `  ${o}`).join('\n')
      + `\n\n      The six arrays went in 5.0 and every door refuses them by name. Send`
      + `\n      \`linkEntities\` / \`linkFacts\` / \`linkChronos\` instead — the same ids.`);
  });

  it('and every exempted suite really does assert a refusal', () => {
    // A stale entry is an exemption nobody can trigger, and it hides that the case was deleted rather
    // than fixed.
    const stale = [];
    for (const f of ASSERTS_THE_REFUSAL) {
      let text;
      try { text = readFileSync(f, 'utf8'); } catch { stale.push(`${f} (gone)`); continue; }
      const proves = /400|isError|refus|REFUSED|must not be sortable|no longer|entityIds/.test(text);
      if (!proves) stale.push(`${f} (asserts no refusal)`);
    }
    assert.deepEqual(stale, [], `exemptions that excuse nothing: ${stale.join(', ')}`);
  });
});
