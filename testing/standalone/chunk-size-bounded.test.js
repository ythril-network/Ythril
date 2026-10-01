/**
 * A document must chunk into retrievable pieces — and a CRLF file must chunk at all.
 *
 * ## The defect, from a customer report (2026-08-02)
 *
 * They measured `04-brain-api.md` (57,642 B in their copy) as **2 chunks**, and could not retrieve anything
 * specific from it: three searches for a feature documented inside it returned unrelated smaller files instead.
 * Then their pod went **3.98 → 9.996 GiB inside one 15-second scrape window**, was OOMKilled at a 16 GiB limit,
 * and sat at **15.40 GiB at idle with an empty queue**.
 *
 * One cause, in two layers:
 *
 * 1. **CRLF defeated the chunker silently.** Every rule downstream splits on `\n` and anchors with `$`, and in
 *    JavaScript `$` never matches before a `\r` while `.` cannot match one either — so on a CRLF document
 *    `/^#{2,3}\s+(.+)$/` matched nothing and the ENTIRE FILE came back as one chunk.
 * 2. **The chunker had a minimum section size and no maximum**, so even with correct line endings one long
 *    section stayed one chunk.
 *
 * The memory follows arithmetically: self-attention is quadratic, so one ~14,700-token embed is
 * `14,700² × 4 B × 12 heads ≈ 9.6 GiB` of fp32 scores for a single layer, and the ONNX arena allocator keeps
 * its high-water mark — which is why the number never came back down.
 *
 * ## What is asserted
 *
 * Measured against **this repository's own docs**, which are the files they ingested — not fixtures. The
 * assertion is on the worst-case chunk **SIZE**, because the count is what looked fine while the size was
 * catastrophic: two chunks of 28 KB and thirty of 2 KB are both "chunked".
 *
 * Run: node --test testing/standalone/chunk-size-bounded.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { closureCode } from './_import-closure.mjs';
import { stripComments } from './_strip-comments.mjs';

const ROOT = process.cwd();

let sectionChunk, normaliseMarkdown, DEFAULT_MAX_BODY_LENGTH;

before(async () => {
  ({ sectionChunk, DEFAULT_MAX_BODY_LENGTH } =
    await import('../../server/dist/files/converters/section-chunker.js'));
  ({ normaliseMarkdown } = await import('../../server/dist/files/converters/normaliser.js'));
});

/** Every tracked Markdown doc — the real corpus, enumerated from git rather than a hand-written list. */
const docs = execFileSync('git', ['ls-files', 'docs'], { encoding: 'utf8', cwd: ROOT })
  .split('\n').map(s => s.trim()).filter(f => f.endsWith('.md'));

/** What the pipeline does: normalise, then chunk. */
const pipeline = (text) => sectionChunk(normaliseMarkdown(text), {});

describe('line endings cannot decide whether a document is chunked', () => {
  it('a CRLF document chunks exactly like its LF twin', () => {
    // The root cause, in one assertion. Before the fix the CRLF side came back as a single chunk.
    const lf = '## One\n\n' + 'a'.repeat(1_500) + '\n\n## Two\n\n' + 'b'.repeat(1_500) + '\n';
    const crlf = lf.replace(/\n/g, '\r\n');
    const fromLf = pipeline(lf);
    const fromCrlf = pipeline(crlf);
    assert.ok(fromLf.length >= 2, `the LF baseline itself only produced ${fromLf.length} chunk(s)`);
    assert.deepEqual(fromCrlf.map(c => c.content), fromLf.map(c => c.content));
    assert.deepEqual(fromCrlf.map(c => c.headingText), fromLf.map(c => c.headingText));
  });

  it('a lone-CR document does not collapse either', () => {
    const cr = ('## One\n\n' + 'a'.repeat(1_500) + '\n\n## Two\n\n' + 'b'.repeat(1_500)).replace(/\n/g, '\r');
    assert.ok(pipeline(cr).length >= 2);
  });

  it('no `\\r` survives normalisation', () => {
    // Anything downstream that anchors with `$` breaks on one, so the invariant is worth stating directly.
    assert.equal(normaliseMarkdown('a\r\nb\rc\n').includes('\r'), false);
  });

  it('the raw chunker on RAW CRLF is what used to fail — so this test can fail', () => {
    // A gate that only exercises the fixed path cannot prove the fix. Skipping normalisation must still show
    // the collapse, which is what makes the assertion above meaningful.
    const crlf = ('## One\n\n' + 'a'.repeat(1_500) + '\n\n## Two\n\n' + 'b'.repeat(1_500)).replace(/\n/g, '\r\n');
    assert.equal(sectionChunk(crlf, { maxBodyLength: Number.MAX_SAFE_INTEGER }).length, 1,
      'the pre-fix collapse no longer reproduces — has HEADING_RE been made CRLF-tolerant too? then relax this');
  });
});

describe('chunk size is bounded on the real corpus', () => {
  it('walked a real set of docs', () => {
    assert.ok(docs.length > 15, `only found ${docs.length} tracked docs`);
  });

  it('no document produces a chunk large enough to be unretrievable', () => {
    // The number that matters. A vector over 28 KB averages away everything specific in it, and costs
    // gigabytes of attention to compute.
    const HARD_CEILING = 8_000;   // the `embed()` warn threshold — past this a single vector is not about anything
    const offenders = [];
    for (const rel of docs) {
      const chunks = pipeline(readFileSync(join(ROOT, rel), 'utf8'));
      for (const c of chunks) {
        if (c.content.length <= HARD_CEILING) continue;
        // A single indivisible block (one enormous table or fenced code block) may exceed the cap: bisecting it
        // destroys the only thing that made it a unit. That is allowed, and `embed()`'s truncation is the
        // backstop — but it must be ONE block, not an accumulation the splitter failed to break up.
        const blocks = c.content.split(/\n{2,}/).filter(p => p.trim().length > 0);
        if (blocks.length > 1) offenders.push(`${rel}: ${c.content.length} chars across ${blocks.length} blocks`);
      }
    }
    assert.deepEqual(offenders, [], 'these chunks are large AND divisible, so the splitter did not do its '
      + `job:\n  ${offenders.join('\n  ')}`);
  });

  it('the largest doc is many chunks, not one', () => {
    const biggest = docs
      .map(rel => ({ rel, text: readFileSync(join(ROOT, rel), 'utf8') }))
      .sort((a, b) => b.text.length - a.text.length)[0];
    assert.ok(biggest.text.length > 20_000, `the largest tracked doc is only ${biggest.text.length} bytes`);
    const chunks = pipeline(biggest.text);
    assert.ok(chunks.length >= 10,
      `${biggest.rel} is ${biggest.text.length} bytes and produced only ${chunks.length} chunk(s)`);
  });
});

describe('the maximum body length', () => {
  it('splits an oversized section and keeps its heading on every part', () => {
    // Provenance has to survive the split, or a reader cannot tell which section an answer came from.
    const md = '## Long Section\n\n' + Array.from({ length: 20 }, (_, i) => `Paragraph ${i} ` + 'x'.repeat(300)).join('\n\n');
    const chunks = sectionChunk(md, {});
    assert.ok(chunks.length >= 3, `expected several parts, got ${chunks.length}`);
    for (const c of chunks) {
      assert.equal(c.headingText, 'Long Section');
      assert.ok(c.content.length <= DEFAULT_MAX_BODY_LENGTH * 2,
        `a part is ${c.content.length} chars, well past the ${DEFAULT_MAX_BODY_LENGTH} cap`);
    }
    assert.deepEqual(chunks.map(c => c.chunkIndex), chunks.map((_, i) => i), 'chunkIndex must stay contiguous');
  });

  it('leaves a section under the cap exactly as it was', () => {
    const md = '## Small\n\nOne paragraph of perfectly reasonable length that nobody needs to split up at all.\n';
    assert.equal(sectionChunk(md, {}).length, 1);
  });

  it('emits a single oversized paragraph alone rather than mangling it', () => {
    const md = '## Big\n\n' + 'y'.repeat(DEFAULT_MAX_BODY_LENGTH * 3) + '\n';
    const chunks = sectionChunk(md, {});
    assert.equal(chunks.length, 1);
    assert.ok(chunks[0].content.length >= DEFAULT_MAX_BODY_LENGTH * 3);
  });

  it('never bisects a table', () => {
    // Table blocks were already protected from being split across heading boundaries; the size splitter must
    // not undo that.
    const rows = Array.from({ length: 60 }, (_, i) => `<tr><td>row ${i} ${'z'.repeat(60)}</td></tr>`).join('\n');
    const md = `## Data\n\n<table>\n${rows}\n</table>\n`;
    const chunks = sectionChunk(md, {});
    const withTable = chunks.filter(c => c.content.includes('<table'));
    assert.equal(withTable.length, 1, 'the table appears in more than one chunk');
    assert.ok(withTable[0].content.includes('</table>'), 'the table was cut before its closing tag');
  });

  it('floors the cap above the merge threshold', () => {
    // A maximum below `minBodyLength` is a rule fighting itself: the splitter cuts a section into parts that the
    // merge threshold considers too short to stand alone. The floor lifts the cap to `minBodyLength * 2`, so
    // parts are always big enough to survive the rule that produced them.
    //
    // Needs MANY paragraphs to exercise: one long paragraph is indivisible and comes back whole whatever the
    // cap says, which is how an earlier version of this test passed without the floor.
    const md = '## A\n\n' + Array.from({ length: 20 }, (_, i) => `p${i} ` + 'q'.repeat(296)).join('\n\n');
    const parts = sectionChunk(md, { maxBodyLength: 10, minBodyLength: 400 });
    assert.ok(parts.length >= 2, `expected several parts, got ${parts.length}`);
    for (const c of parts.slice(0, -1)) {
      assert.ok(c.content.length >= 400,
        `a part is only ${c.content.length} chars — the cap was not floored against minBodyLength 400`);
    }
  });
});

describe('the embed call is the backstop', () => {
  it('the local pipeline is called with truncation', () => {
    // Without it, one long input is quadratic attention memory — 9.6 GiB of fp32 scores for a single layer at
    // ~14,700 tokens.
    //
    // Re-pointed by Q-99 part 1: the call moved WITH the inference, into the child process. It is asked of
    // everything the child entry imports rather than of one named file, because which of the child's modules
    // holds the call is a detail and "the call that runs the model truncates" is the rule. A named file that
    // moved would make this an assertion about a file that no longer runs the model.
    const src = closureCode('server/src/brain/embed-process.ts');
    assert.match(src, /\bpipe\s*\(\s*[\w.]+\s*,\s*\{[^}]*truncation:\s*true/,
      'the local embed no longer truncates, so one unchunked body can cost gigabytes again');
    assert.ok(!/truncation:\s*true/.test(stripComments(readFileSync(join(ROOT, 'server/src/brain/embedding.ts'), 'utf8'))),
      'embedding.ts still carries pipeline options: the inference is in the child now, and a stale copy here would be believed');
  });

  it('an oversized input is warned about rather than silently averaged', () => {
    const src = readFileSync(join(ROOT, 'server/src/brain/embedding.ts'), 'utf8');
    assert.match(src, /MAX_LOCAL_EMBED_CHARS/);
    assert.match(src, /log\.warn\([^)]*Embedding input is/);
  });
});
