/**
 * `remember`'s description agrees with `remember`'s code about whether an `id` updates anything.
 *
 * ## The defect
 *
 * The tool description said, in its second paragraph:
 *
 * > "Always an INSERT. **There is no id to update** and nothing deduplicates …"
 *
 * The schema sitting directly beside it declared `id: uuidSchema('UUID v4 of an EXISTING record to
 * update…')`, and `brain/memory.ts` has the branch to match — a supplied id that already names a record
 * CONVERGES, unioning tags and shallow-merging properties exactly as `upsertEntity` does. That branch is the
 * retry-safety contract: it is what makes a repeated call after a timeout safe.
 *
 * So one tool told a caller two opposite things about the same parameter, and the wrong half was the prose —
 * which is what a client shows first. A caller who believed it would retry a timed-out write by issuing a
 * fresh insert, and get two records where the feature exists to give them one.
 *
 * Found while rewriting the thin parameter descriptions, not by looking for it. Same shape as the chrono
 * `status` paragraph in the release before: a sentence that was authoritative, prominent, and false.
 *
 * ## Why this asserts against the code
 *
 * A gate that pins the corrected sentence is a spelling check — it goes green the moment somebody rephrases
 * the same wrong claim. The branch is read from `brain/memory.ts`, and the description is held to it.
 *
 * Run: node --test testing/standalone/remember-describes-its-idempotent-path.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

let ALL_TOOLS;
before(async () => {
  ({ ALL_TOOLS } = await import('../../server/dist/mcp/tools/index.js'));
});

const STUB = {
  requiredSpace: { type: 'string', description: 'Space ID to operate on.' },
  optionalSpace: { type: 'string', description: 'Optional space ID.' },
};
const remember = () => ALL_TOOLS.find(t => t.name === 'save_fact');

describe('the code really does converge on a supplied id', () => {
  const src = () => stripComments(readFileSync('server/src/brain/memory.ts', 'utf8'));

  it('there is an existing-record branch, and it merges rather than replacing', () => {
    const s = src();
    const at = s.indexOf('if (existing)');
    assert.ok(at > 0, 'the idempotent branch was not found — the scanner is wrong, not the code');
    // Bounded by the branch's own closing brace at that indentation, not by a character count: a count
    // spans different lines on a CRLF working copy than on CI's LF checkout.
    const branch = s.slice(at, s.indexOf('\n  }', at));
    assert.match(branch, /mergeTags\(existing\.tags, tags\)/, 'tags are unioned');
    assert.match(branch, /mergeProperties\(existing\.properties, properties\)/, 'properties are shallow-merged');
  });

  it('and `remember` accepts an id at all', () => {
    const schema = remember().inputSchema(STUB);
    assert.ok(schema.properties.id, 'the parameter the description denied the existence of');
    assert.ok(!schema.required.includes('id'), 'but it is optional — without one every call inserts');
  });
});

describe('the description agrees with it', () => {
  it('does NOT claim there is no id to update', () => {
    // The exact sentence that was there, refused case-insensitively — the paragraph it lived in was
    // capitalised, and a case-sensitive pattern let a restored copy through on the chrono gate.
    const text = remember().description ?? '';
    assert.doesNotMatch(text, /there is no id to update/i,
      'the `id` parameter is right beside this sentence, and the branch it denies is the retry contract');
    assert.doesNotMatch(text, /^always an insert/im,
      'unqualified, that reads as covering the id case too — say "without `id`"');
  });

  it('says what an id DOES, and that convergence merges', () => {
    const text = remember().description ?? '';
    assert.match(text, /converge/i, 'a caller retrying a timed-out write needs to know it is safe');
    assert.match(text, /merge[sd]?/i, 'and that a partial payload will not erase the rest');
  });

  it('and still says the no-id case inserts and does not deduplicate', () => {
    // The half that was TRUE must survive the correction. Storing the same fact twice really does store it
    // twice, and that was worth warning about.
    const text = remember().description ?? '';
    assert.match(text, /insert/i);
    assert.match(text, /deduplicat/i);
  });

  it('the pattern really matches the sentence it exists to refuse', () => {
    // Mutation-proof for the regex itself: a gate that misses its own subject reports clean, which is worse
    // than no gate because the wrong sentence then looks reviewed.
    const ORIGINAL = 'Always an INSERT. There is no id to update and nothing deduplicates: remembering the '
      + 'same fact twice stores it twice.';
    assert.match(ORIGINAL, /there is no id to update/i);
    assert.match(ORIGINAL, /^always an insert/im);
    const CORRECTED = 'WITHOUT `id` IT IS ALWAYS AN INSERT, and nothing deduplicates by content. WITH an '
      + '`id` that already names a record it CONVERGES instead of duplicating.';
    assert.doesNotMatch(CORRECTED, /there is no id to update/i);
    assert.doesNotMatch(CORRECTED, /^always an insert/im);
  });
});
