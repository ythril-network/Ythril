/**
 * Every sentence that states the ORDER the replicated families travel in names them in `REPLICATED_FAMILIES` order, and every known such
 * sentence says it is one (bundle-39 D6, `Q-347`).
 *
 * ## The defect it prevents
 *
 * The order of the family list is a rule (every family a reference can point at comes before every family that holds references), and prose
 * quotes it: a doc paragraph, a source docblock, a test header. The list was reordered once (bundle-30 I13: targets first) and the quotes were
 * not. `linkage-check.ts` still said a pull lands "facts, entities, edges, chrono, links, filemeta" (the order the list had BEFORE the
 * reorder) beside the code that reads it, `09-sync-api.md` listed the batch families in the old order, and a test header repeated it: a
 * reader who trusts the sentence builds the wrong mental model of why an edge to a chrono entry is safe. Nothing compared a sentence with
 * the list, so a reorder could never have been caught.
 *
 * ## What it holds
 *
 * Prose cannot be linted wholesale: about a hundred lines name three or four families in some order that means nothing (a list of record kinds,
 * the tabs of a page, an unordered set), so an unmarked-line rule would be a false alarm per line (the design tried it, v1, and dropped it). Order
 * claims therefore OPT IN, and the gate holds the opt-in is not forgotten:
 *
 *  - (a) A line carrying the `order` marker (an HTML comment spelling `replicated-family-order`, in a doc or in a source comment) opens a BLOCK: the
 *    rest of that line and the lines after it up to the next blank line (a doc), the next blank or non-comment line (source) or a heading. Every
 *    run of three or more family names in a block (a sequence joined by commas, slashes, `and`, `then`) must be in the list's order, with the
 *    aliases file metadata / files / filemeta for the file-metadata family; and a block must carry at least one run of four, or the marker is
 *    decoration over a sentence that states no order.
 *  - (b) A FIXED list of known order claims (`ORDER_CLAIMS`: where a sentence is anchored by wording that survives fixing it) must each lie inside
 *    a marked block, so a sentence cannot be reworded out of the check, and a marker cannot be left off one of them.
 *  - (c) A quote of an OLD order kept as history (`HISTORY_QUOTES`) carries the marker's `history` form instead and is exempt from (a): the
 *    wrong order there is the point of the sentence.
 *  - (d) A floor: fewer marked blocks than the known claims is a convention nobody follows, and a scan that read fewer files than the
 *    repository has fails loudly.
 *
 * The rule is also run on synthetic text (a planted wrong-order copy fails, an in-order copy, the alias spellings, a slash list and the history
 * form pass), so weakening the block, the sequence read or the aliases fails here without waiting for a page to drift.
 *
 * ## Red at a0efade0a
 *
 * No block carries the marker yet, so (b) fails for every known claim and (d) for the floor; the claims in `linkage-check.ts`, the
 * `a-linkage-violation-waits-for-the-whole-transfer-db` header and `09-sync-api.md` state the old order, which (a) names once they are marked. The
 * history quote in `replicated-families.ts` is unmarked as history, which (c) names.
 *
 * Run: node --test testing/standalone/every-family-order-sentence-matches-the-list.test.js (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { REPLICATED_FAMILIES } from '../../server/dist/sync/replicated-families.js';

const OWN = 'testing/standalone/every-family-order-sentence-matches-the-list.test.js';

// ── the marker, spelled in parts so this file never contains it as a literal (a scan of the tests must not find a block here) ────────────────
const WORD = ['replicated', 'family', 'order'].join('-');
const ORDER_MARKER = new RegExp(`<!--\\s*${WORD}\\s*-->`);
const HISTORY_MARKER = new RegExp(`<!--\\s*${WORD}\\s*:\\s*history\\s*-->`);
const orderMarker = () => `<!-- ${WORD} -->`;
const historyMarker = () => `<!-- ${WORD}: history -->`;

// ── the list, as the code has it ────────────────────────────────────────────────────────────────────────────────────────────────────
/** Names a family goes by in prose: its payload key, its collection and the spoken alias of the one row that has two. */
const SPOKEN = { filemeta: ['file metadata'] };
const FAMILY_NAMES = REPLICATED_FAMILIES.map(f => [...new Set([f.payloadKey, f.collection, ...(SPOKEN[f.payloadKey] ?? [])])]);
const INDEX_OF = new Map(FAMILY_NAMES.flatMap((names, i) => names.map(n => [n.toLowerCase(), i])));
const LIST_ORDER = REPLICATED_FAMILIES.map(f => f.payloadKey);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const NAME = `(?:${[...INDEX_OF.keys()].sort((a, b) => b.length - a.length).map(escapeRe).join('|')})`;
/** Between two names of one run: a comma, a slash or a semicolon or just space, optionally followed by `then` / `and` / `or`. */
const SEP = '(?:\\s*[,/;]\\s*|\\s+)(?:(?:then|and|or)\\s*,?\\s+)?';
const RUN = () => new RegExp(`(?<![\\w])${NAME}(?![\\w])(?:${SEP}(?<![\\w])${NAME}(?![\\w]))+`, 'gi');

/** Text as prose: emphasis and code marks out, whitespace one space. */
const plain = (s) => s.replace(/[`*"]/g, '').replace(/\s+/g, ' ').trim();

/** The runs of three or more family names in `text`, each as `{ text, order: [list index, ...] }`. */
function runsIn(text) {
  const out = [];
  for (const m of plain(text).matchAll(RUN())) {
    const names = m[0].toLowerCase().match(new RegExp(NAME, 'g')) ?? [];
    if (names.length >= 3) out.push({ text: m[0], order: names.map(n => INDEX_OF.get(n)) });
  }
  return out;
}

const inListOrder = (order) => order.every((v, i) => i === 0 || v > order[i - 1]);

/** What is wrong with one ORDER block, as sentences (empty when it is right). */
function blockProblems(where, block) {
  const runs = runsIn(block);
  const problems = runs.filter(r => !inListOrder(r.order)).map(r =>
    `${where}: "${r.text}" names the families as [${r.order.map(i => LIST_ORDER[i]).join(', ')}], the list's order is [${LIST_ORDER.join(', ')}]`);
  if (!runs.some(r => r.order.length >= 4)) problems.push(`${where}: the block after the order marker names no run of four families, so it states no order (a marker over nothing)`);
  return problems;
}

// ── blocks ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const isSourceFile = (file) => !file.endsWith('.md');
/** A source line's comment text, or null when the line is code. */
function commentText(line) {
  const m = /^\s*(?:\/\*\*?|\*(?!\/)|\/\/)\s?(.*)$/.exec(line);
  if (m) return m[1].replace(/\*\/\s*$/, '');
  return /^\s*\*\/\s*$/.test(line) ? '' : null;
}

/**
 * The blocks a file's markers open: `{ kind: 'order' | 'history', text, line }`. A block is the rest of the marker's own line and the lines after it
 * up to a blank line, a heading (a doc), or a line that is not a comment (source).
 */
function blocksOf(file, text) {
  const lines = text.split(/\r?\n/);
  const source = isSourceFile(file);
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const own = source ? commentText(lines[i]) : lines[i];
    if (own === null) continue;
    const kind = HISTORY_MARKER.test(own) ? 'history' : ORDER_MARKER.test(own) ? 'order' : null;
    if (kind === null) continue;
    const parts = [own.replace(HISTORY_MARKER, '').replace(ORDER_MARKER, '')];
    for (let j = i + 1; j < lines.length; j++) {
      const next = source ? commentText(lines[j]) : lines[j];
      if (next === null || next.trim() === '' || (!source && /^#{1,6}\s/.test(next))) break;
      parts.push(next);
    }
    blocks.push({ kind, text: parts.join(' '), line: i + 1 });
  }
  return blocks;
}

/** The paragraph of a file (blank-line delimited; comment text only, for source) that holds `anchor`, or null. */
function paragraphHolding(file, text, anchor) {
  const source = isSourceFile(file);
  const want = plain(anchor);
  let para = [];
  const lines = [...text.split(/\r?\n/), ''];
  for (const raw of lines) {
    const line = source ? commentText(raw) : raw;
    if (line === null || line.trim() === '' || (!source && /^#{1,6}\s/.test(line))) {
      if (para.length > 0 && plain(para.join(' ')).includes(want)) return para.join(' ');
      para = [];
    } else para.push(line);
  }
  return null;
}

// ── what the repository must say ────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * The sentences that state the order the families travel in, found by wording that survives rewriting the order inside them. Each must lie in a
 * marked block. Re-anchor here when a sentence is reworded away from its anchor; do not delete the row.
 */
const ORDER_CLAIMS = [
  { file: 'docs/integration-guide/10-mfa-and-conflicts.md', anchor: 'A sender pushes one family per request' },
  { file: 'docs/integration-guide/12-admin-api.md', anchor: 'The families land in a fixed order' },
  { file: 'docs/integration-guide/09-sync-api.md', anchor: '/api/sync/batch-upsert | POST | Bulk upsert' },
  { file: 'server/src/sync/linkage-check.ts', anchor: 'A pull lands its families one page at a time' },
  { file: 'testing/standalone/a-linkage-violation-waits-for-the-whole-transfer-db.test.js', anchor: 'a pull lands its families one page at a time' },
];
/** Sentences that quote an order the list no longer has, kept on purpose as what was true before. */
const HISTORY_QUOTES = [
  { file: 'server/src/sync/replicated-families.ts', anchor: 'The order was' },
];
/** Fewer marked order blocks than there are known claims means the marker is not followed. */
const ORDER_BLOCKS_FLOOR = ORDER_CLAIMS.length;

// ── the repository, read once ───────────────────────────────────────────────────────────────────────────────────────────────────────
const files = [
  ...readTrackedSources(['docs'], { ext: ['.md'], floor: 50 }),
  ...readTrackedSources(['server/src', 'client/src'], { ext: ['.ts'], floor: 300 }),
  ...readTrackedSources(['testing/standalone'], { ext: ['.js', '.mjs'], floor: 200, exclude: [OWN] }),
];
const byFile = new Map(files.map(f => [f.file, f]));
const marked = files.flatMap(f => blocksOf(f.file, f.text).map(b => ({ ...b, file: f.file })));
const textOf = (file) => {
  const f = byFile.get(file);
  assert.ok(f, `${file} is not among the ${files.length} tracked files read: the file moved or the scan broke, re-anchor ORDER_CLAIMS`);
  return f.text;
};

describe('the family order sentences match the list', () => {
  it('reads the list and the repository (the derivation itself still works)', () => {
    assert.ok(REPLICATED_FAMILIES.length >= 6, `only ${REPLICATED_FAMILIES.length} replicated families`);
    assert.deepEqual(LIST_ORDER.slice(0, 3), ['facts', 'entities', 'chrono'], 'the list no longer starts with its target families');
    assert.ok(files.length >= 550, `only ${files.length} files were read`);
    for (const alias of ['file metadata', 'files', 'filemeta']) assert.equal(INDEX_OF.get(alias), LIST_ORDER.indexOf('filemeta'), `'${alias}' is not an alias of the file-metadata family`);
  });

  it('every marked order block names the families in the list\'s order, and names an order at all', () => {
    const problems = marked.filter(b => b.kind === 'order').flatMap(b => blockProblems(`${b.file}:${b.line}`, b.text));
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  for (const { file, anchor } of ORDER_CLAIMS) {
    it(`${file} states the order of the sentence at "${anchor}" as the list has it`, () => {
      const para = paragraphHolding(file, textOf(file), anchor);
      assert.ok(para !== null, `${file}: no paragraph holds "${anchor}": re-anchor ORDER_CLAIMS`);
      const wrong = runsIn(para).filter(r => !inListOrder(r.order)).map(r =>
        `"${r.text}" names the families as [${r.order.map(i => LIST_ORDER[i]).join(', ')}]`);
      assert.deepEqual(wrong, [], `${file}: the list's order is [${LIST_ORDER.join(', ')}] and the paragraph at "${anchor}" says ${wrong.join('; ')}`);
      assert.ok(runsIn(para).some(r => r.order.length >= 4), `${file}: the paragraph at "${anchor}" names no run of four families: it is not an order claim, drop or re-anchor the row`);
    });

    it(`${file} marks the sentence at "${anchor}" as an order claim`, () => {
      assert.ok(plain(textOf(file)).includes(plain(anchor)), `${file} no longer says "${anchor}": re-anchor ORDER_CLAIMS (the claim was reworded, not removed)`);
      const inBlock = marked.some(b => b.file === file && b.kind === 'order' && plain(b.text).includes(plain(anchor)));
      assert.ok(inBlock, `${file}: the sentence at "${anchor}" is not inside a block opened by the order marker (${orderMarker()} on or above its paragraph)`);
    });
  }

  for (const { file, anchor } of HISTORY_QUOTES) {
    it(`${file} marks the old order quoted at "${anchor}" as history`, () => {
      assert.ok(plain(textOf(file)).includes(plain(anchor)), `${file} no longer says "${anchor}": re-anchor HISTORY_QUOTES`);
      const inBlock = marked.some(b => b.file === file && b.kind === 'history' && plain(b.text).includes(plain(anchor)));
      assert.ok(inBlock, `${file}: the quote at "${anchor}" gives the order the list no longer has and is not inside a block opened by ${historyMarker()}`);
    });
  }

  it('enough blocks carry the order marker (the convention is followed)', () => {
    const n = marked.filter(b => b.kind === 'order').length;
    assert.ok(n >= ORDER_BLOCKS_FLOOR, `only ${n} block(s) carry the order marker; the ${ORDER_CLAIMS.length} known claims each need one`);
  });
});

describe('the rule itself, on synthetic text', () => {
  const GOOD = 'A sender pushes targets first: facts, entities, chrono, file metadata, then edges, then links.';
  const OLD = 'A pull lands facts, entities, edges, chrono, links, filemeta one page at a time.';

  it('an in-order sentence passes, in every spelling a doc uses', () => {
    assert.deepEqual(blockProblems('t', GOOD), []);
    assert.deepEqual(blockProblems('t', 'facts, entities, chrono, files, edges, links'), []);
    assert.deepEqual(blockProblems('t', 'facts/entities/chrono/filemeta/edges/links'), []);
    assert.deepEqual(blockProblems('t', '`facts`, `entities`, **chrono**, "file metadata", edges and links'), []);
    assert.deepEqual(blockProblems('t', 'facts,\nentities,\nchrono,\nfile metadata,\nedges,\nlinks'), []);
  });

  it('a planted wrong-order copy fails and says which order it names', () => {
    const [problem, ...more] = blockProblems('plant.md:1', OLD);
    assert.equal(more.length, 0);
    assert.match(problem, /plant\.md:1/);
    assert.match(problem, /facts, entities, edges, chrono, links, filemeta/);
    assert.equal(blockProblems('t', 'edges, links, facts, entities').length, 1, 'a reversed run is one problem (it still names four)');
  });

  it('a sentence naming two families in any order is not a claim; three out of order is', () => {
    assert.deepEqual(blockProblems('t', `${GOOD} A pull checks the links and edges it received.`), []);
    assert.equal(blockProblems('t', `${GOOD} It never sends links, edges, facts first.`).length, 1);
  });

  it('a marker over a sentence that names no run of four families is decoration, and fails', () => {
    assert.equal(blockProblems('t', 'Pushes facts, entities, chrono only.').length, 1);
    assert.equal(blockProblems('t', 'Nothing about families here.').length, 1);
  });

  it('a doc block runs to the blank line, a heading or the end, and takes the marker line\'s own tail (a table row)', () => {
    const doc = `intro\n${orderMarker()}\n${GOOD}\nsecond line.\n\n${OLD}\n`;
    const [b] = blocksOf('x.md', doc);
    assert.equal(b.kind, 'order');
    assert.ok(b.text.includes('second line') && !b.text.includes('filemeta one page'), `the block is "${b.text}"`);
    const row = blocksOf('x.md', `| a | b | facts/entities/chrono/filemeta/edges/links ${orderMarker()}\n| c | d |\n\n${OLD}`);
    assert.equal(row.length, 1);
    assert.ok(row[0].text.includes('facts/entities/chrono'), 'the marker\'s own line is part of the block');
    const heading = blocksOf('x.md', `${orderMarker()}\n${GOOD}\n## Next\n${OLD}`);
    assert.ok(!heading[0].text.includes('filemeta one page'));
  });

  it('a source block is the comment lines after the marker, not the code', () => {
    const src = `/**\n * intro\n * ${orderMarker()}\n * A pull lands its families in\n * ${GOOD}\n *\n * ${OLD}\n */\nconst x = 'facts, entities, edges, chrono, links, filemeta';\n`;
    const [b] = blocksOf('x.ts', src);
    assert.ok(b.text.includes(GOOD) && !b.text.includes('one page at a time'), `the block is "${b.text}"`);
    const noBlank = blocksOf('y.ts', `// ${orderMarker()}\n// ${GOOD}\nconst x = 'edges, links, facts, entities';\n`);
    assert.ok(!noBlank[0].text.includes('edges, links, facts'), 'a code line ends the block');
  });

  it('the history form is a block of its own kind, never read as an order claim', () => {
    const [b] = blocksOf('x.ts', `/**\n * ${historyMarker()}\n * ${OLD}\n */\n`);
    assert.equal(b.kind, 'history');
    assert.equal(blocksOf('x.md', `${historyMarker()}\n${OLD}`).filter(x => x.kind === 'order').length, 0);
  });

  it('a marker is found with any spacing inside the comment, and a look-alike is not one', () => {
    assert.equal(blocksOf('x.md', `<!--${WORD}-->\n${GOOD}`).length, 1);
    assert.equal(blocksOf('x.md', `<!--   ${WORD}   -->\n${GOOD}`).length, 1);
    assert.equal(blocksOf('x.md', `<!-- ${WORD}s -->\n${GOOD}`).length, 0);
    assert.equal(blocksOf('x.md', `${WORD}\n${GOOD}`).length, 0, 'the word without the comment is prose, not a marker');
  });
});
