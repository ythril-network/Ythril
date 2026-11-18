/**
 * Which blank lines in a JavaScript or TypeScript source are surplus: the ONE place that answers it, for the lint and for the fixer (Q-867, bundle-312).
 *
 * ## What it prevents
 *
 * A double blank line went into bundle-311 and nothing refused it: the project carries no source-style lint, and 133 tracked files already held one.
 * The rule is "no two blank lines in a row". The part a copy forgets is that a blank line is not always layout: inside a template literal it is CONTENT. Collapsing it changes a runtime text, or the output a test
 * expects. A line-by-line rule that counts every empty line (`awk`, a regular expression) reports those as surplus, and a fixer built on it rewrites
 * them. So the rule here reads the source as a syntax tree, finds the literal tokens, and counts only the blank lines outside them. Comments are layout
 * and count.
 *
 * ## The rule
 *
 * - A BLANK line holds nothing but spaces and tabs (an empty line included); the line ending (`\n`, `\r\n` or `\r`) is not part of it.
 * - A blank line INSIDE a template literal (head, middle and tail parts alike), a string literal, a regular expression or JSX text is content, never
 *   blank for this rule, and it ends a run.
 * - A run of two or more blank lines in a row is surplus from its second line on: {@link surplusBlankLines} names those lines, and
 *   {@link collapseBlankLines} removes exactly them, each file keeping its own line ending.
 *
 * The lint and the fixer share {@link surplusBlankLines}, so a line the lint refuses is a line the fixer removes and no other.
 *
 * Reads the source with the repository's one parser (`syntax-tree.mjs`), which needs the `typescript` package: a test that imports this module is
 * therefore not text-only (it cannot run before an install), and says so honestly rather than reading strings with a pattern.
 */
import { parseSource, ts } from './syntax-tree.mjs';
import { trackedSources } from '../standalone/_sources.mjs';

/** The extensions the rule covers. */
export const BLANK_LINE_EXTENSIONS = Object.freeze(['.js', '.mjs', '.ts']);

/**
 * The tracked files the rule covers: one listing for the lint and the fixer, so a file one reads is a file the other reads. Git answers it (never the
 * filesystem); the floor inside `trackedSources` makes an empty listing throw.
 * @param {{ root?: string, floor?: number }} [options] the checkout, default this repository; the fewest files that means the listing worked
 * @returns {string[]} repo-relative paths, forward slashes
 */
export function blankLineSources({ root, floor = 100 } = {}) {
  return trackedSources(['.'], { ext: [...BLANK_LINE_EXTENSIONS], floor, ...(root ? { root } : {}) });
}

/** Line terminators, longest first so `\r\n` is one. */
const TERMINATOR = /\r\n|\n|\r/g;

/** The lines of `text` as `{ start, end, next }`: `end` is where the content stops, `next` where the following line starts (after the terminator). */
function linesOf(text) {
  const lines = [];
  let start = 0;
  for (const m of text.matchAll(TERMINATOR)) {
    lines.push({ start, end: m.index, next: m.index + m[0].length });
    start = m.index + m[0].length;
  }
  if (start < text.length) lines.push({ start, end: text.length, next: text.length });
  return lines;
}

/** The `[start, end)` offsets of every token whose text is content: a literal of any kind. */
function literalRanges(file, text) {
  const tree = parseSource(file, text);
  const out = [];
  const visit = (node) => {
    switch (node.kind) {
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      case ts.SyntaxKind.TemplateHead:
      case ts.SyntaxKind.TemplateMiddle:
      case ts.SyntaxKind.TemplateTail:
      case ts.SyntaxKind.RegularExpressionLiteral:
      case ts.SyntaxKind.JsxText:
        out.push([node.getStart(tree), node.getEnd()]);
        break;
      default:
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return out;
}

/**
 * The 1-based numbers of the lines that are blank layout, in order: the candidates of a run. A blank line inside a literal is not among them.
 * @param {string} file the name the source is read as (its extension picks JavaScript or TypeScript)
 * @param {string} text the source
 */
function layoutBlankLines(file, text) {
  const ranges = literalRanges(file, text);
  const out = [];
  linesOf(text).forEach((line, i) => {
    if (!/^[ \t]*$/.test(text.slice(line.start, line.end))) return;
    // The line is inside a literal when the terminator before it and the one after it both lie within one literal token.
    const inside = ranges.some(([from, to]) => from < line.start && line.end < to);
    if (!inside) out.push(i + 1);
  });
  return out;
}

/**
 * The lines that make two or more blank lines in a row: every blank layout line after the first of its run, 1-based and ascending.
 * Empty when the source has none.
 * @param {string} file the name the source is read as
 * @param {string} text the source
 * @returns {number[]}
 */
export function surplusBlankLines(file, text) {
  const out = [];
  let previous = -1;
  for (const n of layoutBlankLines(file, text)) {
    if (n === previous + 1) out.push(n);
    previous = n;
  }
  return out;
}

/**
 * The source with each run of blank lines reduced to its first line, line endings untouched: the lines {@link surplusBlankLines} names are removed
 * whole, terminator included, so a file keeps `\n`, `\r\n` or a mix as it was.
 * @param {string} file the name the source is read as
 * @param {string} text the source
 */
export function collapseBlankLines(file, text) {
  const drop = new Set(surplusBlankLines(file, text));
  if (drop.size === 0) return text;
  const lines = linesOf(text);
  let out = '';
  lines.forEach((line, i) => { if (!drop.has(i + 1)) out += text.slice(line.start, line.next); });
  return out;
}

/** The blank lines inside literal tokens, 1-based: content a rule over every empty line would wrongly refuse. For the tests that prove the rule leaves them alone. */
export function contentBlankLines(file, text) {
  const layout = new Set(layoutBlankLines(file, text));
  const out = [];
  linesOf(text).forEach((line, i) => {
    if (/^[ \t]*$/.test(text.slice(line.start, line.end)) && !layout.has(i + 1)) out.push(i + 1);
  });
  return out;
}
