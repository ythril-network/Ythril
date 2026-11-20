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
 *
 * The one implementation is `testing/standalone/_call-arguments.mjs`, because a tool under `tools/flow-checks/` asks the same question of the
 * same sources (`_refusal-prefixes.mjs`) and cannot import TypeScript. It is loaded by PATH, as `server-act-codes.ts` loads the comment
 * stripper: a client spec cannot import a file outside `src`, and the type-checker does not follow the path (`rootDir` is `src`).
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MODULE = resolve(__dirname, '../../../../testing/standalone/_call-arguments.mjs');

/** The trimmed arguments of the call whose opening `(` is at `open` in `src`. */
export const { callArguments } = await import(/* @vite-ignore */ pathToFileURL(MODULE).href) as {
  callArguments: (src: string, open: number) => string[];
};
