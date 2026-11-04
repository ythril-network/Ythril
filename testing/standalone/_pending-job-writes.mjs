/**
 * Which functions of the media job queue write a job back to `pending`, and how: the question "does this writer go through the one
 * reset spread (`RUN_RESET`), by hand, or not at all", answered once for every gate that asks it (bundle-236, Q-698).
 *
 * ## Why a module
 *
 * Two gates read the same shapes of source. `a-file-row-reads-pending-before-its-job-can-be-claimed` asks the ORDER of a writer's
 * row mark and job write; `every-write-returning-a-media-job-to-pending-goes-through-run-reset` asks whether the write is the spread.
 * When the reset moved from a `status: 'pending'` literal in each writer into one spread, the first gate stopped seeing the writers that
 * use it, and a gate that sees none passes: the shape was read twice, and only one copy would have been taught.
 *
 * ## What it reads
 *
 *  - {@link jobPendingWrite}: a job written `pending`, in any form a gate must order: a `$set` that names the status, an inserted
 *    document, or a use of the `RUN_RESET` spread (which carries it). A FILTER on `status: 'pending'` is not a write.
 *  - {@link resetWriters}: per top-level function of a source, whether it RETURNS A JOB TO pending (a `$set` naming the status, `by
 *    hand`) and whether it does so through `RUN_RESET` (`spread`). An inserted document is a new job, not a return, and is neither.
 *  - {@link runResetDeclaration}: the text of the `RUN_RESET` declaration, for the gate that says what it may not name.
 *
 * It reads comment-stripped source (`_strip-comments.mjs`) and does not run it.
 */
import { topLevelFunctions } from './_call-graph.mjs';
import { stripComments } from './_strip-comments.mjs';

/** A `$set` that names `status: 'pending'`: a job returned to pending by hand. Built fresh per use. */
const byHand = () => /\$set\s*:\s*\{[^}]*?\bstatus\s*:\s*'pending'/;
/** A use of the reset spread. Built fresh per use. */
const spreadUse = () => /\bRUN_RESET\b/;

/** A job written `pending`: by hand, as an inserted document, or through the `RUN_RESET` spread. Global; built fresh per use. */
export const jobPendingWrite = () => /(?:\$set\s*:\s*\{[^}]*?|const\s+doc\b[^=]*=\s*\{[^}]*?)\bstatus\s*:\s*'pending'|\bRUN_RESET\b/g;

/**
 * @param {string} src  TypeScript source (comments are stripped here)
 * @returns {{ byHand: string[], spread: string[] }}  the names of the top-level functions that return a job to pending by hand,
 *   and of those that use `RUN_RESET`; a function may be in both
 */
export function resetWriters(src) {
  const out = { byHand: [], spread: [] };
  for (const [name, body] of topLevelFunctions(stripComments(src))) {
    if (byHand().test(body)) out.byHand.push(name);
    if (spreadUse().test(body)) out.spread.push(name);
  }
  return out;
}

/**
 * The text of the `RUN_RESET` declaration (from its name to the end of its balanced brackets), or `null` when the source declares none.
 * A string holding a bracket is not told from a bracket: the declaration is a short literal.
 *
 * @param {string} src
 * @returns {string | null}
 */
export function runResetDeclaration(src) {
  const text = stripComments(src);
  const decl = /\b(?:const|let|function)\s+RUN_RESET\b/.exec(text);
  if (!decl) return null;
  let depth = 0;
  let opened = false;
  // A type annotation may hold brackets of its own: a `const` is read from its `=`, not from its name.
  const eq = decl[0].startsWith('function') ? decl.index : text.slice(decl.index).search(/=(?!>)/) + decl.index;
  for (let i = eq; i < text.length; i++) {
    const c = text[i];
    if (c === '{' || c === '(' || c === '[') { depth++; opened = true; }
    else if (c === '}' || c === ')' || c === ']') { depth--; if (opened && depth === 0) return text.slice(decl.index, i + 1); }
  }
  return null;
}
