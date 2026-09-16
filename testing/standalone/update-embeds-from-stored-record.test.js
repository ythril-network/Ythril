/**
 * A record's vector must describe the record as STORED, never as the writer read it.
 *
 * ## The defect this closes
 *
 * All four update functions used to compute the embedding themselves — from the record they had read, plus
 * the caller's patch — and write it in the same `$set`. Every CONTENT field in that `$set` was guarded by
 * `updates.X !== undefined`. The embedding never was: it went in unconditionally.
 *
 * So two concurrent patches touching DIFFERENT fields both landed and lost no field, exactly as the guide
 * promises — while each wrote a whole embedding describing only its own view. The later write won, and the
 * stored vector then described a record that existed nowhere. Not a lost field: a permanent disagreement
 * between a record and its own index, on a record whose every field is correct.
 *
 * **Nothing could have detected it.** No field was lost, so no `If-Match` precondition would have been
 * violated and the lost-update counter would have said `clean`. Recall would rank the record on a
 * `matchedText` it no longer contains, and the only symptom is a slightly wrong search result.
 *
 * ## Why this is asserted on the source
 *
 * The property is "the text came from the stored document", and the only way to observe it at runtime is to
 * lose a race against an embedding round trip on purpose. That is not a test, it is a coin flip. What CAN be
 * pinned is the mechanism: the update path must not build embed text at all, and must hand the record to the
 * queue, whose `embedStoredRecord` re-reads the document after the write and is correct by construction.
 *
 * Comments are stripped first. Every one of these functions now carries a comment explaining why the inline
 * embed is gone, and those comments name the very builders being searched for — an assertion that reads them
 * would pass on the explanation and go green if someone put the inline embed back.
 *
 * Run: node --test testing/standalone/update-embeds-from-stored-record.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const withoutComments = (text) =>
  text.replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * Every write path that stores a vector, and the embed-text builder each one used to call inline.
 *
 * `file` is here twice on purpose. `updateFileMeta` had the defect this file is named for; `upsertFileMeta`
 * had it too AND had already drifted — its text omitted `excerpt`, so a re-upload silently dropped a
 * converted document's opening prose out of the vector while the sibling function kept it. Three copies of
 * "what goes into a file's embedding" existed and two disagreed. Listing both is what stops a fix to one
 * leaving the other behind, which is exactly how they came to disagree.
 */
const UPDATES = [
  { type: 'entity', file: 'server/src/brain/entities.ts', fn: 'updateEntityById', builder: 'entityEmbedText' },
  { type: 'fact', file: 'server/src/brain/fact.ts', fn: 'updateFact', builder: 'factEmbedText' },
  { type: 'edge', file: 'server/src/brain/edges.ts', fn: 'updateEdgeById', builder: 'edgeEmbedText' },
  { type: 'chrono', file: 'server/src/brain/chrono.ts', fn: 'updateChrono', builder: 'chronoEmbedText' },
  { type: 'file', file: 'server/src/files/file-meta.ts', fn: 'updateFileMeta', builder: 'fileEmbedText' },
  { type: 'file', file: 'server/src/files/file-meta.ts', fn: 'upsertFileMeta', builder: 'fileEmbedText' },
];

/**
 * The body of an exported async function.
 *
 * The parameter list has to be walked with paren depth before looking for the body brace. Every one of
 * these signatures declares an inline object type — `updates: { name?: string; … }` — so taking the first
 * `{` after the name lands inside the parameters and returns ~160 characters of type declaration. That is
 * not hypothetical: the first version of this file did exactly that, and the enumeration floor below is
 * what caught it rather than four assertions passing against a body they never saw.
 */
function functionBody(text, name) {
  const m = new RegExp(`export async function ${name}\\s*\\(`).exec(text);
  if (!m) return null;

  let i = m.index + m[0].length;
  let parens = 1;
  for (; i < text.length && parens > 0; i++) {
    if (text[i] === '(') parens++;
    else if (text[i] === ')') parens--;
  }
  if (parens !== 0) return null;

  const open = text.indexOf('{', i);
  if (open < 0) return null;
  let depth = 1;
  let j = open + 1;
  for (; j < text.length && depth > 0; j++) {
    if (text[j] === '{') depth++;
    else if (text[j] === '}') depth--;
  }
  return depth === 0 ? text.slice(open + 1, j - 1) : null;
}

describe('an update never embeds from its own read', () => {
  for (const u of UPDATES) {
    it(`${u.fn} builds no embed text and enqueues instead`, () => {
      const body = functionBody(withoutComments(read(u.file)), u.fn);
      assert.ok(body !== null,
        `${u.fn} was not found in ${u.file} — it was renamed or moved, which makes this gate examine `
        + 'nothing. Re-point it rather than deleting the entry.');
      assert.ok(body.length > 400,
        `only parsed ${body.length} chars of ${u.fn}; the brace match broke, not the code`);

      assert.doesNotMatch(body, new RegExp(`${u.builder}\\s*\\(`),
        `${u.fn} builds its own embed text with ${u.builder}(). Whatever it builds comes from the record as `
        + 'this function READ it, so a concurrent write to another field leaves the stored vector describing '
        + 'a record that exists nowhere. Hand the record to the queue instead — embedStoredRecord re-reads it '
        + 'after the write.');

      assert.doesNotMatch(body, /await embed\(/,
        `${u.fn} calls embed() directly. Same reason: the only text available here is stale.`);

      assert.match(body, new RegExp(`enqueueEmbedJob\\(spaceId, '${u.type}'`),
        `${u.fn} does not enqueue a re-embed, so an edit would leave the previous vector in place forever`);
    });
  }

  it('the enqueue is unconditional, not gated on which fields changed', () => {
    // It used to fire only when `excludeFromVectorSearch` was present, because every other path embedded
    // inline. A condition here would have to be evaluated against this function's stale read — the exact
    // reasoning that made the inline embedding wrong, reintroduced one level up.
    for (const u of UPDATES) {
      const body = withoutComments(functionBody(withoutComments(read(u.file)), u.fn));
      const line = body.split('\n').find(l => l.includes('enqueueEmbedJob'));
      assert.ok(line, `${u.fn}: no enqueue line found`);
      assert.doesNotMatch(line, /^\s*if\s*\(/,
        `${u.fn} enqueues conditionally (${line.trim()}). The condition can only be computed from the stale `
        + 'read; an unconditional enqueue costs one queue write and cannot be wrong.');
    }
  });

  it('embedStoredRecord — the thing that makes this correct — reads the record back', () => {
    // The floor under the whole design. If this ever stopped re-reading and took the text from its caller,
    // every assertion above would still pass while the bug returned.
    const body = functionBody(withoutComments(read('server/src/brain/embed-record.ts')), 'embedStoredRecord');
    assert.ok(body !== null, 'embedStoredRecord not found — the queue path this gate assumes is gone');
    assert.match(body, /findOne\(/,
      'embedStoredRecord no longer loads the record, so the text it embeds no longer comes from what is '
      + 'stored — which is the single property the update path relies on');
    assert.match(body, /buildEmbedText\(/,
      'embedStoredRecord no longer uses the shared builder, so the queued text can drift from the creators');
  });
});
