/**
 * The arguments of one call in a source text, split at the commas that belong to the call itself.
 *
 * A gate that asks "what does this call pass as its Nth argument" cannot use a regex over the line: an argument holds commas of its
 * own (`this.transloco.getActiveLang()`, an object literal, a string with a comma in it), and a pattern that stops at the first one
 * reads the wrong argument and reports clean about the right one. Written by hand in `i18n-key-coverage.spec.ts` (the `pluralText`
 * bases) and again in `data-acts-have-words.spec.ts` (the `keyPrefix` of a refusal), so it is a module.
 *
 * It throws on an unterminated call instead of returning what it had: a source that does not parse is not a call with no arguments.
 * Strings and template literals are skipped whole, so a parenthesis inside one does not end the call.
 */

/** The trimmed arguments of the call whose opening `(` is at `open` in `src`. */
export function callArguments(src: string, open: number): string[] {
  if (src[open] !== '(') throw new Error(`no call opens at index ${open}`);
  const args: string[] = [];
  let depth = 0;
  let quote = '';
  let from = open + 1;
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (quote) { if (c === quote && src[i - 1] !== '\\') quote = ''; continue; }
    if (c === '\'' || c === '"' || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) { args.push(src.slice(from, i).trim()); return args; }
    } else if (c === ',' && depth === 1) { args.push(src.slice(from, i).trim()); from = i + 1; }
  }
  throw new Error(`the call opened at ${open} is never closed`);
}
