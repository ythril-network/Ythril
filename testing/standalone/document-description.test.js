/**
 * The converted parent's description is generated prose — and says so when it is not.
 *
 * ## The report
 *
 * `summariseMarkdown` (#567) is **extractive**: it takes the head of the converted text. On a real invoice
 * that is a payment reference cut mid-identifier. The release note called the field *generated*, and the
 * images the same document produced DO get generated captions — so the parent read as unfinished sitting
 * beside its own children.
 *
 * ## What this pins
 *
 * Three things, and the third is the one that keeps the feature honest:
 *
 *  1. A model's answer is cleaned up before it is stored — models wrap answers in quotes, label them
 *     `Description:`, and sometimes answer the wrong question entirely.
 *  2. With no model configured the extractive text survives, because it beats nothing.
 *  3. It is never CALLED generated in that case. `descriptionSource` records which one an instance
 *     produced, because "generated" is a claim about provenance and the release note already made it
 *     once while the value was a truncation.
 *
 * Plus the embedding: the document's own opening prose stays an embedding input in its own right. Once
 * `description` became generated prose, a search for a phrase a reader remembers FROM the document had
 * nothing on the parent record to match — the extractive text used to BE the description.
 *
 * Run: node --test testing/standalone/document-description.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { between, blockAfter, enclosingBlockFrom } from './_structural-window.mjs';
import { readFileSync } from 'node:fs';

const { sanitiseDescription } = await import('../../server/dist/files/converters/describe.js');
const { fileEmbedText } = await import('../../server/dist/brain/embed-text.js');
const { summariseMarkdown } = await import('../../server/dist/files/converters/summarise.js');

describe('sanitiseDescription — what a chat model actually returns', () => {
  it('keeps a good answer as it is', () => {
    const s = sanitiseDescription('An invoice from Northwind Traders to Acme GmbH, dated 3 March 2026, for cloud hosting.');
    assert.equal(s, 'An invoice from Northwind Traders to Acme GmbH, dated 3 March 2026, for cloud hosting.');
  });

  it('strips the label the prompt asked it not to write', () => {
    assert.equal(sanitiseDescription('Description: A lease agreement between two parties.'),
      'A lease agreement between two parties.');
    assert.equal(sanitiseDescription('Summary:  A quarterly report.'), 'A quarterly report.');
  });

  it('strips wrapping quotes and Markdown scaffolding', () => {
    assert.equal(sanitiseDescription('"A shipping manifest."'), 'A shipping manifest.');
    assert.equal(sanitiseDescription('## A shipping manifest.'), 'A shipping manifest.');
    assert.equal(sanitiseDescription('```\nA shipping manifest.\n```'), 'A shipping manifest.');
  });

  it('collapses the newlines a model uses for a list it was told not to produce', () => {
    assert.equal(sanitiseDescription('An invoice.\n\nFrom Northwind.'), 'An invoice. From Northwind.');
  });

  it('REFUSES a non-answer rather than storing it as content', () => {
    // A refusal or a preamble stored as a description is worse than the extractive text, because it
    // reads as content and search will match it.
    for (const junk of [
      "I'm sorry, I cannot help with that.",
      'As an AI language model, I cannot read documents.',
      "Sure! Here's a description of the document.",
      'Certainly, this document appears to be…',
      '',
      '   ',
      '...',
      '- ',
    ]) {
      assert.equal(sanitiseDescription(junk), undefined, `should have been refused: ${JSON.stringify(junk)}`);
    }
  });

  it('does not refuse a document that is genuinely ABOUT an AI assistant', () => {
    // The non-answer patterns are anchored at the start for exactly this: matching them anywhere would
    // deny a description to a whole class of real documents.
    const s = sanitiseDescription('A design note on how the assistant handles refusals, written by the platform team.');
    assert.match(s, /^A design note/);
  });

  it('caps a rambling answer, preferring a sentence end over a word break', () => {
    const long = `${'A '.repeat(100)}invoice. ${'B '.repeat(200)}`;
    const s = sanitiseDescription(long);
    assert.ok(s.length <= 401, `length ${s.length}`);
    assert.ok(s.endsWith('invoice.') || s.endsWith('…'), s.slice(-20));
  });
});

describe('the extractive text is not lost', () => {
  it('is a separate embedding input, so a remembered phrase still finds the parent', () => {
    // The `[]` that used to sit between properties and the excerpt was the entity-names argument, removed in
    // A-3: a file embedded the names of what it linked to, which cost 1.5 points of strict evidence recall.
    const withExcerpt = fileEmbedText('invoices/2026-03.pdf', ['invoice'], 'An invoice from Northwind to Acme.',
      undefined, 'Payment reference NW-8831-2026 is due within 30 days.');
    assert.match(withExcerpt, /NW-8831-2026/);
    assert.match(withExcerpt, /An invoice from Northwind/);
  });

  it('is not embedded twice when it IS the description', () => {
    // The no-model case: the extractive text is the description. Embedding it twice would weight one
    // paragraph of one record against everything else in the space.
    const same = 'Payment reference NW-8831-2026 is due within 30 days.';
    const text = fileEmbedText('invoices/2026-03.pdf', [], same, undefined, same);
    assert.equal(text.split('NW-8831-2026').length - 1, 1, text);
  });

  it('changes nothing for a record that has no excerpt', () => {
    // Every existing file record is in this case, and a changed embedding input means a changed vector.
    const before = fileEmbedText('a/b.pdf', ['x'], 'desc', { k: 'v' });
    const after = fileEmbedText('a/b.pdf', ['x'], 'desc', { k: 'v' }, undefined);
    assert.equal(before, after);
  });

  it('still produces the extractive text itself — unchanged, and still the fallback', () => {
    const s = summariseMarkdown('# Quarterly report\n\nRevenue grew by eleven percent this quarter.');
    assert.match(s, /Revenue grew by eleven percent/);
  });
});

describe('provenance is recorded, not assumed', () => {
  const strip = src => src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const src = path => strip(readFileSync(path, 'utf8'));

  it('the extractive fallback is never labelled generated', () => {
    const describeSrc = src('server/src/files/converters/describe.ts');
    // Every place a source is chosen: `extracted` must accompany the excerpt fallback, and `generated`
    // must only follow a model answer that survived sanitising.
    // A WINDOW, converted: the subject is the object that CARRIES both fields, bounded by its own brace. 80
    // characters could not tell "the excerpt is in the same returned object" from "the word excerpt appears
    // 80 characters later" — and the claim is precisely about one object holding both.
    const genAt = describeSrc.indexOf("source: 'generated'");
    assert.ok(genAt > -1, 'the generated-source branch is gone — re-anchor this gate');
    assert.match(enclosingBlockFrom(describeSrc, genAt, 'the generated description object'), /excerpt/,
      'a generated description keeps the excerpt too');
    assert.ok(!/source: 'generated'\s*,\s*excerpt\s*}\s*;?\s*}\s*$/.test(describeSrc));
    assert.match(describeSrc, /text: excerpt, source: 'extracted'/,
      'the no-model path must label the extractive text as extracted');
  });

  it('an unacknowledged assist host is never sent document text', () => {
    // The ACK is re-checked at call time rather than trusted from save time — the same rule the repair
    // path applies, because config.json can be hand-edited.
    const describeSrc = src('server/src/files/converters/describe.ts');
    assert.match(describeSrc, /egressConsented\(assist\)/, 'the consent rule every egressing slot shares (config/egress-consent.ts)');
    /*
     * And the fall-through has to be the LOCAL model, not "send it anyway".
     *
     * A WINDOW, converted, and the conversion changes what is claimed. `if (acknowledged) … 400 characters …
     * resolveVlmEndpoint('repair')` says the two are NEAR each other, which is true whether the local model is
     * reached by falling out of the branch or by sitting inside it. Only one of those is the security property:
     * the local endpoint must be what runs when the host was NOT acknowledged. So the branch is bounded by its
     * own brace, and the claim is stated on both sides of it.
     */
    const ackAt = describeSrc.indexOf('if (egressConsented(assist)) {');
    assert.ok(ackAt > -1, 'the acknowledged branch is gone — re-anchor this gate');
    const branch = blockAfter(describeSrc, ackAt, 'the acknowledged branch');
    assert.doesNotMatch(branch, /resolveVlmEndpoint\('repair'\)/,
      'the local model inside the acknowledged branch means an unacknowledged host reaches neither');
    assert.match(describeSrc.slice(ackAt + branch.length), /resolveVlmEndpoint\('repair'\)/,
      'an unacknowledged host must fall through to the local document model');
  });

  it('a description a person writes drops the provenance rather than inheriting it', () => {
    const metaSrc = src('server/src/files/file-meta.ts');
    assert.match(metaSrc, /\$unset\['descriptionSource'\]/,
      'a stale `generated` would have the record claim a model wrote what an operator typed');
  });

  it('the worker writes the excerpt even when an operator owns the description', () => {
    // The excerpt is the document's own text, not a competing summary: only the description is theirs.
    //
    // This used to assert the shape `operatorWrote … derivedExcerpt ? { excerpt: derivedExcerpt }` — the excerpt riding
    // along in the same object as the guarded description. That guard was a read-modify-write and is gone; the excerpt is
    // now written on its own, unconditionally, which is STRICTLY STRONGER than "even when an operator owns the
    // description". So the assertion is the property: an excerpt write that no description condition can reach.
    const workerSrc = src('server/src/files/media/worker.ts');
    assert.match(workerSrc, /updateFileMeta\(spaceId, filePath, \{ excerpt: derivedExcerpt \}\)/,
      'the excerpt must be written by itself, not inside a description-conditional object');
    assert.ok(!/operatorWrote/.test(workerSrc),
      'the read-modify-write guard is gone — if it is back, the excerpt may be gated on it again');
  });

  it('an image caption is labelled generated too — it always was model output', () => {
    const workerSrc = src('server/src/files/media/worker.ts');
    /*
     * A WINDOW, converted: the subject is the switch ARM that captions an image, and the claim is that the same arm
     * labels what it produced. 400 characters could not tell "this arm labels its own output" from "some later arm
     * sets the label" — and a caption written in one arm while the label is set in another is precisely the record
     * that claims a model wrote what nobody did.
     *
     * The ARM, not `enclosingBlockFrom`. A `case` label carries no braces of its own, so the nearest enclosing
     * brace is the SWITCH — under which `derivedSource = 'generated'` in the audio arm would have answered for the
     * image arm, and the bound would be LOOSER than the number it replaced. Structural is only tighter when the
     * structure chosen is the subject; here that is `case` to `break`.
     */
    assert.match(between(workerSrc, "case 'image':", 'break;', 'the image arm'), /derivedSource = 'generated'/,
      'the arm that captions an image must label that caption generated');
  });

  it('a reindex re-embeds the excerpt instead of dropping it', () => {
    // The whole-space reindex builds its own embed text. Missing the excerpt there would silently strip
    // the document's own words out of every converted record's embedding.
    // The reindex loops moved to `brain/reindex.ts`; the guarantee is unchanged.
    assert.match(src('server/src/brain/reindex.ts'), /fileEmbedText\([^)]*doc\.excerpt\)/);
  });
});
