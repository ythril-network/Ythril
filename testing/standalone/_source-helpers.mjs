/**
 * Which function does a position in a source sit inside — the OUTERMOST one, by name — answered once.
 *
 * ## The question it answers
 *
 * *"A call is written here: what is the unit of code that call belongs to?"* A gate that attributes a call to its function
 * (every opener of a vote round is inside `proposeRound`; every answer that carries a round is built by a door the table knows)
 * needs the function the reader would NAME, and the nearest enclosing function is rarely it: a call inside a `.forEach(() => …)`
 * inside `settleRounds` sits in an arrow, and a gate that stops at the arrow reads the call as outside `settleRounds`.
 * `enclosingBlockMatching` (`_structural-window.mjs`) returns the innermost match for the same reason.
 *
 * ## What it decides, and what a copy drops
 *
 * - **Outermost, not innermost.** Every function-like ancestor is walked to the top of the file; the last one is the answer. A
 *   callback, a nested helper and an `async () => …` passed to `.map` are all the code of the function they sit in.
 * - **A name for every answer.** A declaration or a `const f = () => …` is named for its binding; a method for its class and name;
 *   a route handler written inline (`router.post('/x', mw, async (req, res) => …)`) for the route it registers, `POST /x` —
 *   because a door that is an anonymous arrow has no name to put in a table, and a gate that skipped it would skip every REST door
 *   written that way. Any other anonymous function is named for the call it is an argument of, never silently dropped.
 * - **Syntax, not text.** The position is resolved in a parsed tree (`_shared/syntax-tree.mjs`), so a brace in a string or a
 *   comment cannot end a function early, and the same file name picks the same language the other gates read it as.
 *
 * ## What it does not do
 *
 * It does not resolve what a function CALLS. A caller that wants the functions reachable from a door asks `_call-graph.mjs`.
 */
import { outermostFunctionOf, parseSource, ts } from '../_shared/syntax-tree.mjs';

const ROUTE_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all']);

function innermostNodeAt(sf, index) {
  let found = sf;
  const visit = (node) => {
    if (index < node.getStart(sf) || index >= node.getEnd()) return;
    found = node;
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return found;
}

/** The name a reader gives this function: its binding, its class method, the route it handles, or the call it is handed to. */
function nameOf(fn, sf) {
  if (fn.name && ts.isIdentifier(fn.name)) {
    const owner = ts.isMethodDeclaration(fn) && ts.isClassLike(fn.parent) && fn.parent.name ? `${fn.parent.name.text}.` : '';
    return `${owner}${fn.name.text}`;
  }
  const parent = fn.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (parent && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (parent && ts.isCallExpression(parent)) {
    const callee = parent.expression;
    const verb = ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
    const first = parent.arguments[0];
    if (ROUTE_VERBS.has(verb) && first && ts.isStringLiteralLike(first)) return `${verb.toUpperCase()} ${first.text}`;
    return `<callback of ${callee.getText(sf).replace(/\s+/g, ' ').slice(0, 60)}>`;
  }
  return '<anonymous>';
}

/**
 * The outermost function containing character `index` of `text`, or `null` at module level.
 *
 * @param {string} file the file's name, which decides the language it is read as (`.ts` is TypeScript)
 * @param {string} text the source, as it was read (comments included: the offsets are the ORIGINAL source's)
 * @param {number} index an offset into `text`
 * @returns {{ name: string, start: number, end: number } | null} `start`/`end` bound the function in `text`
 */
export function outermostFunctionAt(file, text, index) {
  const sf = parseSource(file, text);
  const at = innermostNodeAt(sf, index);
  // The node at the index may itself be the function (its first character); the shared walk starts at the parent.
  const outer = outermostFunctionOf(at) ?? (ts.isFunctionLike(at) && !ts.isSourceFile(at) ? at : null);
  return outer ?{ name: nameOf(outer, sf), start: outer.getStart(sf), end: outer.getEnd() } : null;
}
