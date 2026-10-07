/**
 * Reading source as a syntax tree — the three questions every gate that parses a file asks first: how to parse it,
 * what line a node is on, and how to walk a body without wandering into the functions nested inside it.
 *
 * ## Why a module
 *
 * `poll-loops.mjs`, `_test-bodies.mjs` and `proxy-questions.mjs` each wrote all three, and the copies had already
 * parted: one chose the script kind by `/\.tsx?$/`, one by `/\.[cm]?ts$/`, one never chose; one `walk` skipped the root
 * and could not stop early, one `walkOwnCode` visited it and could, over two different lists of what a function is
 * (`ts.isFunctionLike`, and a hand-typed seven). A gate that reads a `.mts` file as JavaScript parses a type annotation
 * as a syntax error and reports clean about the file; a walk that enters a nested function reads that callback's
 * `return` as the test's own. Each is the kind of wrong nobody sees from the gate's output.
 *
 * ## What each one decides
 *
 * - {@link parseSource} — the script kind comes from the file name (`.ts`, `.tsx`, `.mts`, `.cts` are TypeScript,
 *   anything else is JavaScript), so a caller cannot pass a kind that disagrees with the name it reports findings by.
 * - {@link lineOf} — 1-based, from the node's real start (leading trivia excluded), against the ORIGINAL source the
 *   tree was parsed from.
 * - {@link walkOwnCode} — never enters a nested function, because that function's body is another function's code:
 *   a loop in a callback is not the enclosing function's loop, and a `return` there ends the callback.
 *
 * Syntax only — no type checker. What a gate asks OF the tree (a poll, a test body, a proxy test) stays in its own
 * module; this one answers only how to read one.
 */
import ts from 'typescript';

export { ts };

/** The last tree parsed for each file name, kept while its text is the same: see {@link parseSource}. */
const lastParse = new Map();

/**
 * The parsed tree of `text`, read as `file`'s language says (`.ts`, `.tsx`, `.mts`, `.cts` are TypeScript; else JavaScript).
 *
 * One parse per file and text: the poll gate and the fixed-delay gate each read the same few hundred sources, and a file
 * asked twice with the same text gets the tree it was given the first time. The tree is read-only for every caller here
 * (a gate asks questions of it); one that rewrote a node would change the answer to the next.
 */
export function parseSource(file, text) {
  const kept = lastParse.get(file);
  if (kept?.text === text) return kept.tree;
  const kind = /\.([cm]?ts|tsx)$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  lastParse.set(file, { text, tree });
  return tree;
}

/** The 1-based line a node starts on, in the source `sf` was parsed from. */
export const lineOf = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

/**
 * Visit `node` and what it holds, NOT entering a nested function: a `return` inside a callback ends the
 * callback, never the test that contains it. `visit` returns `true` to stop and say "found".
 *
 * The root is visited even when it is itself a function, so a caller that hands it a loop or a body gets that node
 * too. Answers whether a visit said "found".
 */
export function walkOwnCode(node, visit) {
  if (visit(node) === true) return true;
  let found = false;
  ts.forEachChild(node, (child) => {
    if (found || ts.isFunctionLike(child)) return;
    if (walkOwnCode(child, visit)) found = true;
  });
  return found;
}
