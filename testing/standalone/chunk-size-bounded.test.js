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
 * ## Q-699 (bundle-237): the old rule was wrong for tables and fences
 *
 * This file used to allow one indivisible block (a table, a fence, one long line) to exceed any size, and called the embedder's
 * truncation "the backstop". Two pages of the shipped documentation (`16-mcp.md` 38 KB, `11-setup-api.md` 50 KB, each ONE table
 * block) went to an HTTP embedder whole, were refused with HTTP 400, and were stored with no vector: the backstop is the local model's
 * alone. The rule now: the chunkers keep their soft cap (2,000 characters, retrievability), and the conversion pipeline's one exit
 * (`chunkForLevel`) splits every chunk whose embed text would pass the embedder's input ceiling (`embedding.maxInputBytes`, 6,000
 * UTF-8 bytes by default, the task prefix and the heading counted) into parts: tables cut at row lines, fences and single lines at
 * the furthest character, no pair cut in two, every part keeping its (capped) heading, `chunkIndex` renumbered once.
 *
 * What stays pinned: the chunkers alone leave an oversized paragraph whole (the soft cap does not cut a paragraph) and keep a table
 * whole UNDER the ceiling; `embed` level is still one vector for the whole document; the local model still truncates.
 *
 * Run: node --test testing/standalone/chunk-size-bounded.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs, { readFileSync } from 'node:fs';
import os from 'node:os';
import path, { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { closureCode } from './_import-closure.mjs';
import { stripComments } from './_strip-comments.mjs';

const ROOT = process.cwd();

// The chunk budget reads the ceiling and the configured prefix scheme from the instance config: give it one, with no embedder URL
// (so the scheme is the bundled model's, `nomic`).
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-chunk-bounded-'));
process.env['CONFIG_PATH'] = path.join(scratch, 'config.json');
delete process.env['EMBEDDING_URL'];
fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({ spaces: [{ id: 'general', label: 'General' }], networks: [], tokens: [] }, null, 2));

/** `embedding.maxInputBytes` at its default: the most one embedder request may carry, task prefix included. */
const CEILING = 6_000;

let sectionChunk, normaliseMarkdown, DEFAULT_MAX_BODY_LENGTH, runConversionPipeline, chunkEmbedText, prepareInput;

before(async () => {
  ({ sectionChunk, DEFAULT_MAX_BODY_LENGTH } =
    await import('../../server/dist/files/converters/section-chunker.js'));
  ({ normaliseMarkdown } = await import('../../server/dist/files/converters/normaliser.js'));
  ({ runConversionPipeline } = await import('../../server/dist/files/converters/pipeline.js'));
  ({ chunkEmbedText } = await import('../../server/dist/brain/embed-text.js'));
  ({ prepareInput } = await import('../../server/dist/brain/embedding.js'));
  (await import('../../server/dist/config/loader.js')).loadConfig();
});

/** What the conversion pipeline hands the store for a Markdown file: the real entry, every chunker and the one exit. */
async function chunksOf(md, opts = {}, format = 'md') {
  return (await runConversionPipeline(Buffer.from(md, 'utf8'), format === 'md' ? 'doc.md' : 'doc.txt', format, opts)).chunks;
}

/** The bytes the HTTP embedder is sent for a chunk, under both tasks of the bundled scheme: the largest of them. */
const sentBytes = (c) => Math.max(...['document', 'query'].map(task =>
  Buffer.byteLength(prepareInput(chunkEmbedText(c.headingText, c.content), task, { prefixScheme: 'nomic' }), 'utf8')));

const row = (i) => `| row ${String(i).padStart(4, '0')} | ${'v'.repeat(70)} |`;
const table = (n) => ['| n | value |', '|---|---|', ...Array.from({ length: n }, (_, i) => row(i))].join('\n');
const endsOnHighSurrogate = (s) => s.length > 0 && (s.charCodeAt(s.length - 1) & 0xfc00) === 0xd800;
const startsOnLowSurrogate = (s) => s.length > 0 && (s.charCodeAt(0) & 0xfc00) === 0xdc00;

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

  it('no document produces a chunk the embedder would refuse — not even one indivisible block', async () => {
    // The number that matters, and it is what the embedder is SENT: the heading, the body and the task prefix, in bytes. The
    // old allowance (one table or fence may be any size, the embedder's truncation is the backstop) is what shipped two pages
    // with no vector: an HTTP embedder refuses an over-long input with a 400, it does not truncate.
    const offenders = [];
    for (const rel of docs) {
      for (const c of await chunksOf(readFileSync(join(ROOT, rel), 'utf8'))) {
        const sent = sentBytes(c);
        if (sent > CEILING) offenders.push(`${rel} #${c.chunkIndex}: ${sent} bytes sent over a ${CEILING}-byte ceiling`);
      }
    }
    assert.deepEqual(offenders, [], `these chunks would reach the embedder over its ceiling:\n  ${offenders.join('\n  ')}`);
  });

  for (const page of ['docs/integration-guide/16-mcp.md', 'docs/integration-guide/11-setup-api.md']) {
    it(`${page} (one table block of ${page.includes('16-mcp') ? '38' : '50'} KB, refused by the embedder as reported) re-chunks into parts, none over the ceiling and no row lost`, async () => {
      const text = readFileSync(join(ROOT, page), 'utf8');
      const normalised = normaliseMarkdown(text);
      const raw = sectionChunk(normalised, {});
      const chunks = await chunksOf(text);
      assert.ok(raw.some(c => sentBytes(c) > CEILING), `precondition: the chunker alone still emits an oversized block for ${page}`);
      assert.ok(chunks.length > raw.length, `${page} still comes out as ${chunks.length} chunks, as many as the chunker emits`);
      assert.ok(chunks.every(c => sentBytes(c) <= CEILING), 'a part is still over the ceiling');
      assert.deepEqual(chunks.map(c => c.chunkIndex), chunks.map((_, i) => i), 'chunkIndex must be one contiguous run');
      const stored = chunks.map(c => c.content).join('\n');
      const lost = normalised.split('\n').filter(l => l.startsWith('|') && l.trim().length > 3).filter(l => !stored.includes(l));
      assert.deepEqual(lost, [], 'table rows that no chunk holds: a cut dropped or broke them');
    });
  }

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

  it('the chunker alone leaves a single oversized paragraph whole — the soft cap never cuts a paragraph; the ceiling below does', () => {
    const md = '## Big\n\n' + 'y'.repeat(DEFAULT_MAX_BODY_LENGTH * 3) + '\n';
    const chunks = sectionChunk(md, {});
    assert.equal(chunks.length, 1);
    assert.ok(chunks[0].content.length >= DEFAULT_MAX_BODY_LENGTH * 3);
  });

  it('a table under the ceiling stays whole through the pipeline (Q-699 keeps it; the chunker alone also does)', async () => {
    // Table blocks were already protected from being split across heading boundaries; neither the size splitter nor the
    // ceiling may undo that for a table the embedder accepts.
    const rows = Array.from({ length: 60 }, (_, i) => `<tr><td>row ${i} ${'z'.repeat(60)}</td></tr>`).join('\n');
    const md = `## Data\n\n<table>\n${rows}\n</table>\n`;
    for (const chunks of [sectionChunk(md, {}), await chunksOf(md)]) {
      const withTable = chunks.filter(c => c.content.includes('<table'));
      assert.equal(withTable.length, 1, 'the table appears in more than one chunk');
      assert.ok(withTable[0].content.includes('</table>'), 'the table was cut before its closing tag');
    }
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

describe('the ceiling on what one chunk sends the embedder (Q-699), through the real conversion entry', () => {
  const FENCE_LINES = Array.from({ length: 1_200 }, (_, i) => `line ${String(i).padStart(5, '0')} ${'.'.repeat(15)}`);   // ~30,000 chars

  it('a 30,000-character fenced block splits into parts, each under the ceiling with its heading, nothing lost', async () => {
    const md = '## Big\n\n```text\n' + FENCE_LINES.join('\n') + '\n```\n';
    const chunks = await chunksOf(md);
    assert.ok(chunks.length >= 6, `a 30 KB fence came back as ${chunks.length} chunk(s)`);
    for (const c of chunks) {
      assert.equal(c.headingText, 'Big', 'every part keeps its heading');
      assert.ok(sentBytes(c) <= CEILING, `chunk ${c.chunkIndex} sends ${sentBytes(c)} bytes over a ${CEILING}-byte ceiling`);
    }
    assert.deepEqual(chunks.map(c => c.chunkIndex), chunks.map((_, i) => i), 'chunkIndex must be renumbered into one run');
    const stored = chunks.map(c => c.content).join('\n');
    assert.deepEqual(FENCE_LINES.filter(l => !stored.includes(l)), [], 'lines of the fence that no chunk holds');
  });

  it('a 30,000-character single line splits at the furthest character, nothing lost', async () => {
    const line = 'a'.repeat(2_000) + 'HEAD-MARK' + 'b'.repeat(26_000) + 'c'.repeat(2_000) + 'TAIL-MARK';
    const chunks = await chunksOf('## Wide\n\n' + line + '\n');
    assert.ok(chunks.length >= 5, `a 30,000-character line came back as ${chunks.length} chunk(s)`);
    for (const c of chunks) assert.ok(sentBytes(c) <= CEILING, `chunk ${c.chunkIndex} sends ${sentBytes(c)} bytes`);
    assert.ok(chunks[0].content.includes('HEAD-MARK') && chunks[chunks.length - 1].content.endsWith('TAIL-MARK'), 'the line lost its head or its tail');
    assert.ok(chunks.reduce((n, c) => n + c.content.length, 0) >= line.length, 'the parts hold fewer characters than the line');
  });

  it('counts BYTES: 4,000 CJK characters are under 6,000 UTF-16 units and over 6,000 bytes, and are split', async () => {
    const chunks = await chunksOf('## Han\n\n' + '漢字'.repeat(2_000) + '\n');
    assert.ok(chunks.length >= 2, 'a 12,000-byte paragraph stayed whole because its length in characters is small');
    for (const c of chunks) assert.ok(sentBytes(c) <= CEILING, `chunk ${c.chunkIndex} sends ${sentBytes(c)} bytes`);
  });

  it('emoji are never cut in two: no part ends on the first half of a pair or starts on the second', async () => {
    const text = '😀'.repeat(2_500);
    const chunks = await chunksOf('## Faces\n\n' + text + '\n');
    assert.ok(chunks.length >= 2);
    for (const c of chunks) {
      assert.ok(sentBytes(c) <= CEILING, `chunk ${c.chunkIndex} sends ${sentBytes(c)} bytes`);
      assert.ok(!endsOnHighSurrogate(c.content) && !startsOnLowSurrogate(c.content), `chunk ${c.chunkIndex} cuts a surrogate pair`);
    }
  });

  it('a table over the ceiling is cut at row lines; a part never holds half a row', async () => {
    const chunks = await chunksOf('## Rows\n\n' + table(400) + '\n');
    assert.ok(chunks.length >= 5, `a 32 KB table came back as ${chunks.length} chunk(s)`);
    for (const c of chunks) {
      assert.ok(sentBytes(c) <= CEILING, `chunk ${c.chunkIndex} sends ${sentBytes(c)} bytes`);
      for (const l of c.content.split('\n').filter(l => l.trim())) assert.match(l, /^\|.*\|$/, `a row was cut: ${l.slice(0, 40)}`);
    }
    const stored = chunks.map(c => c.content).join('\n');
    for (let i = 0; i < 400; i++) assert.ok(stored.includes(row(i)), `row ${i} is in no chunk`);
  });

  it('the overlap counts: a 38 KB table is not copied whole into the next section, and the next section stays under the ceiling', async () => {
    // The chunker prepends the previous section's last paragraph to the next chunk. Here that paragraph IS the table.
    const md = '## A\n\n' + table(400) + '\n\n## B\n\n' + 'B body sentence. '.repeat(60) + '\n';
    const chunks = await chunksOf(md);
    const b = chunks.filter(c => c.headingText === 'B');
    assert.ok(b.length >= 1, 'section B has no chunk');
    for (const c of chunks) assert.ok(sentBytes(c) <= CEILING, `chunk ${c.chunkIndex} sends ${sentBytes(c)} bytes`);
    assert.ok(b.some(c => c.content.includes('B body sentence.')), 'section B lost its own body');
    for (const c of b) {
      assert.ok(!(c.content.includes(row(0)) && c.content.includes(row(399))), 'the whole table was copied into section B as overlap');
    }
  });

  it('a 7,000-byte heading is capped to a quarter of the budget, stored as the heading, and the parts still fit', async () => {
    const heading = 'H'.repeat(7_000);
    const body = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} ` + 'w'.repeat(380)).join('\n\n');
    const chunks = await chunksOf(`## ${heading}\n\n${body}\n`);
    assert.ok(chunks.length >= 2);
    for (const c of chunks) {
      assert.ok(sentBytes(c) <= CEILING, `chunk ${c.chunkIndex} sends ${sentBytes(c)} bytes`);
      assert.ok(c.headingText && Buffer.byteLength(c.headingText) <= CEILING / 4,
        `chunk ${c.chunkIndex} keeps a ${Buffer.byteLength(c.headingText ?? '')}-byte heading, over a quarter of the budget`);
      assert.ok(heading.startsWith(c.headingText), 'the stored heading must be a prefix of the real one (the rebuild embeds the stored one)');
    }
  });

  it('a 1,400-byte heading is counted: the body part is smaller by the heading it carries', async () => {
    const heading = 'T'.repeat(1_400);
    const chunks = await chunksOf(`## ${heading}\n\n` + '```text\n' + FENCE_LINES.join('\n') + '\n```\n');
    assert.ok(chunks.length >= 6);
    for (const c of chunks) {
      assert.equal(c.headingText, heading);
      assert.ok(sentBytes(c) <= CEILING, `chunk ${c.chunkIndex} sends ${sentBytes(c)} bytes: the heading was not counted`);
    }
  });

  it('a plain-text file (the paragraph chunker) is bounded too', async () => {
    const chunks = await chunksOf('x'.repeat(30_000) + '\n\nand a closing paragraph\n', {}, 'txt');
    assert.ok(chunks.length >= 5, `a 30,000-character paragraph in a .txt came back as ${chunks.length} chunk(s)`);
    for (const c of chunks) assert.ok(sentBytes(c) <= CEILING, `chunk ${c.chunkIndex} sends ${sentBytes(c)} bytes`);
  });

  it('a chunk right at the ceiling is not split, and one byte over is (the boundary is the ceiling, not a rule of thumb)', async () => {
    const { embedTextBudget } = await import('../../server/dist/brain/embed-text.js');
    const budget = embedTextBudget();
    assert.ok(Number.isInteger(budget) && budget > 5_000 && budget <= CEILING, `embedTextBudget() is ${budget}`);
    const fit = 'H '.length;                      // "<heading> " precedes the body in the embed text
    const atBudget = 'x'.repeat(budget - fit);
    const exact = await chunksOf('## H\n\n' + atBudget + '\n');
    assert.equal(exact.length, 1, `a body that fills the budget exactly came back as ${exact.length} chunks`);
    const over = await chunksOf('## H\n\n' + atBudget + 'y\n');
    assert.ok(over.length >= 2, 'a body one byte over the budget stayed whole');
  });

  it('`embed` level is still ONE chunk for the whole document (one vector per file, as documented); what is sent is cut where it is embedded', async () => {
    const text = 'whole document line\n'.repeat(1_500);
    const chunks = await chunksOf(text, { textLevel: 'embed' });
    assert.equal(chunks.length, 1);
    assert.ok(chunks[0].content.length > 25_000, 'the stored content of an embed-level document stays whole (lexical search reads it)');
  });
});

describe('every chunk the conversion makes leaves through chunkForLevel, which bounds them (gate, with its own mutation)', () => {
  const braceBlock = (src, openIndex) => {
    let depth = 0;
    for (let i = openIndex; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return [openIndex, i + 1];
    }
    throw new Error('unbalanced braces');
  };

  /** Problems with a pipeline source, as a list: what a gate that cannot be fooled must find. */
  function problemsIn(rawSrc) {
    const src = stripComments(rawSrc);
    const problems = [];
    if (!/\bexport\s+function\s+chunkForLevel\b/.test(src)) problems.push('chunkForLevel is not exported, so no test can drive the exit');
    const at = src.search(/function\s+chunkForLevel\b/);
    if (at < 0) return [...problems, 'no chunkForLevel at all'];
    const [from, to] = braceBlock(src, src.indexOf('{', src.indexOf(')', at)));
    const body = src.slice(from, to);
    const outside = src.slice(0, from) + src.slice(to);
    if (!/\bboundChunks\s*\(/.test(body)) problems.push('chunkForLevel does not pass the chunkers\' chunks through the bounding pass');
    if (/\b(?:sectionChunk|paragraphChunk)\s*\(/.test(outside.replace(/\bimport\b[^;]*;/g, '')))
      problems.push('a chunker is called outside chunkForLevel, so its chunks skip the ceiling');
    const callSites = (outside.match(/\bchunkForLevel\s*\(/g) ?? []).length;
    if (callSites < 2) problems.push(`only ${callSites} call site(s) of chunkForLevel outside its definition (the document path and the PDF/DOCX/EPUB path)`);
    return problems;
  }

  const real = () => readFileSync(join(ROOT, 'server/src/files/converters/pipeline.ts'), 'utf8');

  it('pipeline.ts exports chunkForLevel, bounds the chunkers there, and both call sites use it', () => {
    assert.deepEqual(problemsIn(real()), []);
  });

  it('the gate sees a bounding pass that is dropped (mutated source)', () => {
    const mutated = real().replace(/\bboundChunks\s*\(/g, '(');
    assert.notDeepEqual(problemsIn(mutated), [], 'dropping the bounding pass went unseen: the gate above proves nothing');
  });

  it('the gate sees a call site that bypasses the exit (mutated source)', () => {
    const mutated = real().replace(/(chunks:\s*)chunkForLevel\(/, '$1sectionChunk(');
    assert.notEqual(mutated, real(), 'the mutation found no call site to change');
    assert.notDeepEqual(problemsIn(mutated), [], 'a chunker called directly went unseen: the gate above proves nothing');
  });
});

describe('the embed call is the backstop for the LOCAL model, and the HTTP branch has its own cut', () => {
  /** The text between the braces that open at `openAt` and close them, braces included. Template `${}` inside is balanced. */
  const block = (src, openAt) => {
    let depth = 0;
    for (let i = openAt; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return [openAt, i + 1];
    }
    throw new Error('unbalanced braces');
  };

  /** `embed()` split by structure: the `if (cfg.baseUrl) { … }` block is the HTTP branch, everything else in the function is the local one. */
  const embedBranches = () => {
    const src = stripComments(readFileSync(join(ROOT, 'server/src/brain/embedding.ts'), 'utf8'));
    const head = src.indexOf('export async function embed(');
    assert.ok(head >= 0, 'embedding.ts has no `export async function embed(`');
    const [fnFrom, fnTo] = block(src, src.indexOf('{', src.indexOf(')', head)));
    const fn = src.slice(fnFrom, fnTo);
    const ifAt = fn.indexOf('if (cfg.baseUrl) {');
    assert.ok(ifAt >= 0, 'embed() has no `if (cfg.baseUrl) {` branch');
    const [from, to] = block(fn, fn.indexOf('{', ifAt));
    return { http: fn.slice(from, to), local: fn.slice(0, from) + fn.slice(to) };
  };

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

  it('the LOCAL branch warns about an oversized input rather than silently averaging it, and does not cut it (the model truncates)', () => {
    const { local } = embedBranches();
    assert.match(local, /MAX_LOCAL_EMBED_CHARS/);
    assert.match(local, /log\.warn\([^)]*Embedding input is/);
    assert.ok(!/\bboundedPrefix\s*\(/.test(local), 'the local branch cuts the input itself: the inference process owns that, and a second cut here changes what the bundled model embeds');
  });

  it('the HTTP branch cuts an input over the ceiling once, before the retry, and warns once (a different sentence from the local one)', () => {
    const { http } = embedBranches();
    const cut = http.search(/\bboundedPrefix\s*\(/);
    const retry = http.search(/\bembedViaHttpWithRetry\s*\(/);
    assert.ok(cut >= 0, 'the HTTP branch of embed() has no boundedPrefix cut: an input over the ceiling reaches the embedder whole, which refuses it');
    assert.ok(retry >= 0 && cut < retry, 'the cut must sit OUTSIDE the retry closure, so a 503 retry does not cut and warn again');
    // The repo's idiom is `const said = warnOnce<string>(...)` at module level, then `said(key, ...)` at the site: the gate finds the
    // instances warnOnce made in embedding.ts and requires the HTTP branch to call one of them.
    const source = stripComments(readFileSync(join(ROOT, 'server/src/brain/embedding.ts'), 'utf8'));
    const instances = [...source.matchAll(/\bconst\s+(\w+)\s*=\s*warnOnce\s*</g)].map(m => m[1]);
    assert.ok(instances.length > 0, 'embedding.ts makes no warnOnce instance: the cut would be said once per call');
    assert.ok(instances.some(name => new RegExp(`\\b${name}\\s*\\(`).test(http)),
      `the HTTP branch calls none of embedding.ts's warnOnce instances (${instances.join(', ')}): the cut is said once per call`);
    assert.ok(!/MAX_LOCAL_EMBED_CHARS/.test(http), 'the HTTP branch is bounded by the setting, not by the local warn threshold');
  });
});
