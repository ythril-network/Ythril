/**
 * Can the value of this `${…}` carry text — asked of the COMPILER, not of the spelling.
 *
 * ## Why a module
 *
 * A log gate that rules on a value by its NAME (`spaceId`, `kind`, `t`) keeps a list of names, and the list is one more
 * ruling about local values beside the gate that already holds one (`a-steerable-value-reaches-a-log-line-only-bounded`,
 * which asks the type: a number, a boolean, a literal or a union of literals cannot carry what a peer sent). This answers
 * the same question for a gate that reads source text: given a file and the offset where an interpolation's expression
 * starts, what is the expression's type, and could a string a caller chose be one of its values?
 *
 * ## What it does not do
 *
 * It rules on the TYPE only. A plain `string` is not text-free whatever it is called, and an `any` is not either.
 *
 * The program is built over the files asked about, on the first call, so a gate that finds nothing to ask pays nothing.
 */
import path from 'node:path';
import ts from 'typescript';
import { REPO_ROOT } from './_sources.mjs';

const TEXT_FREE = ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.Null
  | ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Never | ts.TypeFlags.StringLiteral | ts.TypeFlags.EnumLike;

/** A type no value of which can carry text: numbers, booleans, literals and unions of them. */
export function cannotCarryText(type) {
  if (type.isUnion()) return type.types.every(cannotCarryText);
  return (type.flags & TEXT_FREE) !== 0;
}

/**
 * For each `{ file, exprStart }` (a repo-relative path and the offset in the ORIGINAL text where the interpolated
 * expression's first character is), whether that expression's type cannot carry text. `null` for a request whose
 * expression is not found at that offset, so a gate cannot take "not found" for "text-free".
 *
 * @param {{ file: string, exprStart: number }[]} requests
 * @returns {(boolean | null)[]}
 */
export function interpolationsCannotCarryText(requests) {
  if (requests.length === 0) return [];
  const cfg = ts.readConfigFile(path.join(REPO_ROOT, 'server', 'tsconfig.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, path.join(REPO_ROOT, 'server'));
  const files = [...new Set(requests.map(r => path.join(REPO_ROOT, r.file)))];
  const program = ts.createProgram({ rootNames: files, options: { ...parsed.options, noEmit: true } });
  const checker = program.getTypeChecker();
  return requests.map(({ file, exprStart }) => {
    const sf = program.getSourceFile(path.join(REPO_ROOT, file));
    if (!sf) return null;
    let found = null;
    const visit = (node) => {
      if (found !== null) return;
      if (ts.isTemplateSpan(node) && node.expression.getStart(sf) === exprStart) {
        found = cannotCarryText(checker.getTypeAtLocation(node.expression));
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return found;
  });
}
