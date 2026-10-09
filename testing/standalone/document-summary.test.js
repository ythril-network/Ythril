/**
 * A converted document gets a description, so the record a human browses is findable.
 *
 * ## The report
 *
 * After a PDF converts, its file-meta carries `convertedFileId`, `chunkCount` and `embeddingStatus` —
 * and no description, with `matchedText` being literally the filename. Meanwhile every
 * `_extracted/<id>/image-N.jpg` the same document produced gets a full generated caption from the vision
 * model. The parent was findable only by filename while its derived children carried summaries, which is
 * exactly backwards: the parent is the thing anyone opens.
 *
 * ## The mechanism already existed
 *
 * `derivedDescription` is written to the parent by the worker — only when the operator has not written
 * one, and re-embedded afterwards so it becomes searchable. Images set it. Documents never did. Same
 * shape as the audio `partial` status: the rule was implemented one branch over and not applied here.
 *
 * ## Extractive on purpose
 *
 * No model call. Partly cost — this would put a VLM call on every upload, on instances with no VLM at
 * all — but mainly honesty: a generated summary can assert something the document does not say, and a
 * description that misrepresents a record is worse than none, because search matches it and a reader
 * believes it. Taking the document's own opening prose cannot invent anything.
 *
 * Run: node --test testing/standalone/document-summary.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { summariseMarkdown } = await import('../../server/dist/files/converters/summarise.js');
const WORKER = readFileSync('server/src/files/media/worker.ts', 'utf8');

const chunk = (headingText, content, chunkIndex = 0) => ({ headingText, content, chunkIndex });

describe('it reads the document, and only the document', () => {
  it('takes the opening prose', () => {
    const s = summariseMarkdown('# Quarterly report\n\nRevenue grew by eleven percent this quarter. Costs were flat.');
    assert.match(s, /Quarterly report/);
    assert.match(s, /Revenue grew by eleven percent/);
  });

  it('keeps heading TEXT while dropping the hashes', () => {
    const s = summariseMarkdown('### Executive summary\n\nThe migration completed without downtime.');
    assert.match(s, /Executive summary/);
    assert.doesNotMatch(s, /#/);
  });

  it('never invents anything — every word is from the source', () => {
    // The property that makes an extractive summary safe to put in a searchable field.
    const src = 'The contract renews annually. Termination requires ninety days notice.';
    const s = summariseMarkdown(src);
    for (const word of s.replace(/[.…]/g, '').split(/\s+/).filter(Boolean)) {
      assert.ok(src.includes(word), `"${word}" is not in the source`);
    }
  });
});

describe('scaffolding is removed, content is not', () => {
  it('drops YAML front-matter', () => {
    const s = summariseMarkdown('---\ntitle: x\nauthor: y\n---\n\nThe actual opening sentence is here.');
    assert.match(s, /actual opening sentence/);
    assert.doesNotMatch(s, /author/);
  });

  it('drops fenced code, which reads as noise in a one-liner', () => {
    const s = summariseMarkdown('```js\nconst x = 1;\n```\n\nThis document explains the build process.');
    assert.match(s, /explains the build process/);
    assert.doesNotMatch(s, /const x/);
  });

  it('keeps link text but not the URL', () => {
    const s = summariseMarkdown('See [the appendix](https://example.test/a) for the full table of results here.');
    assert.match(s, /the appendix/);
    assert.doesNotMatch(s, /example\.test/);
  });

  it('drops table rows rather than emitting cell soup', () => {
    const s = summariseMarkdown('| a | b |\n| - | - |\n| 1 | 2 |\n\nThe table above lists the measured values.');
    assert.match(s, /table above lists/);
    assert.doesNotMatch(s, /\|/);
  });

  it('drops list markers and emphasis, keeping the words', () => {
    const s = summariseMarkdown('- **First** item of the introduction\n- _Second_ item of the introduction');
    assert.doesNotMatch(s, /[*_]/);
    assert.match(s, /First item/);
  });

  it('strips image syntax entirely', () => {
    const s = summariseMarkdown('![a diagram](x.png)\n\nThe diagram shows the request path end to end.');
    assert.match(s, /diagram shows the request path/);
    assert.doesNotMatch(s, /x\.png/);
  });
});

describe('it refuses to produce a misleading description', () => {
  it('empty input yields nothing', () => {
    assert.equal(summariseMarkdown(''), undefined);
    assert.equal(summariseMarkdown(null), undefined);
    assert.equal(summariseMarkdown('   \n\n  '), undefined);
  });

  it('a document of pure scaffolding yields nothing', () => {
    assert.equal(summariseMarkdown('```\ncode\n```\n\n| a |\n| - |'), undefined);
  });

  it('page furniture is not a summary', () => {
    assert.equal(summariseMarkdown('Page 4'), undefined);
    assert.equal(summariseMarkdown('12345'), undefined);
  });
});

describe('it falls back to chunks when there is no converted Markdown', () => {
  it('md and txt sources yield null Markdown, so chunks are the source', () => {
    const s = summariseMarkdown(null, [chunk('Overview', 'This note records the outage timeline.')]);
    assert.match(s, /Overview/);
    assert.match(s, /outage timeline/);
  });

  it('prefers the Markdown when both are present', () => {
    const s = summariseMarkdown('The converted document body is authoritative here.', [chunk(null, 'chunk text')]);
    assert.match(s, /converted document body/);
    assert.doesNotMatch(s, /chunk text/);
  });
});

describe('length', () => {
  const long = `${'Sentence number one is reasonably long and descriptive. '.repeat(40)}`;

  it('is bounded', () => {
    assert.ok(summariseMarkdown(long).length <= 241, summariseMarkdown(long).length);
  });

  it('never ends mid-word', () => {
    const s = summariseMarkdown(`${'x'.repeat(50)} ${long}`);
    assert.doesNotMatch(s, /\w…$/, 'a description cut mid-word looks like corruption');
  });

  it('a short document is returned whole, with no ellipsis', () => {
    const s = summariseMarkdown('A short note about the migration.');
    assert.equal(s, 'A short note about the migration.');
  });
});

describe('the worker wires it to the parent record', () => {
  const strip = s => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const w = strip(WORKER);

  it('the document path sets derivedDescription', () => {
    // Through `describeDocument` now, which asks a model what the file IS and keeps this extractive text
    // as the record's excerpt and its fallback. The rest of this file still pins the extraction itself —
    // it is the value an instance with no model configured gets, so it never stopped mattering.
    // See document-description.test.js for the generated half.
    assert.match(w, /const described = await describeDocument\(convertedMarkdown, chunks\)/);
    assert.match(w, /derivedDescription = described\.text/);
  });

  it('through the SAME writer images use, which respects an operator-set description', () => {
    // Not a second write path: an operator-written description must outrank a generated one.
    //
    // The RULE is unchanged; where it lives has moved. It used to be `operatorWrote`, computed from a read and then acted
    // on — a read-modify-write that lost anything landing in between. It is now a condition in the update FILTER, so the
    // database arbitrates. Asserting the old three lines would demand the defect back.
    assert.match(w, /setDerivedDescriptionIfUnset\(spaceId, filePath, derivedDescription, derivedSource\)/,
      'the description must go through the conditional writer, not a plain update');
    assert.ok(!/operatorWrote/.test(w),
      'a read-then-decide guard is back; the condition belongs in the write, not in a snapshot');

    // And the condition itself, at the writer, so this cannot pass against a function that ignores its own name.
    // In `files/derived-fields.ts` since bundle-89, with the other writers of what the bytes produced. The condition is
    // what this case is about and it is unchanged — read from wherever the function lives, so the next move re-points one line.
    const meta = strip(readFileSync('server/src/files/derived-fields.ts', 'utf8'));
    assert.match(meta, /export async function setDerivedDescriptionIfUnset/);
    assert.match(meta, /description: \{ \$exists: false \}/, 'absent counts as unwritten');
    // An exact substring, not a regex. Writing a regex that matches a regex literal is where this assertion went wrong
    // once already — the `\s` collapsed and it stopped meaning what it read as.
    assert.ok(meta.includes('$regex: /^\\s*$/'),
      'the whitespace-only case must be in the filter, matching the `.trim()` guard it replaced');
  });
});
