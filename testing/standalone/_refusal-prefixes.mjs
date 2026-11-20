/**
 * The families of translation keys a refusal's `code` is looked up under, read from the client's source (bundle-162, Q-567; bundle-270 H7).
 *
 * `refusalText` looks a code up as `<prefix>.<code>` under the prefix its CALLER hands it, so no file spells the keys of a refusal: they are
 * built at run time from whatever code the server sends. Two readers need the prefixes and asked the question in two places: the client spec
 * that holds every write-closed code to its sentence under each prefix (`data-acts-have-words.spec.ts`), and the unused-translation-keys check
 * (`tools/flow-checks/check-i-accessibility-i18n-deep-untranslated-and-unused.mjs`), which could not see these keys and named them unused: each
 * write-closed code added seven. They read the prefixes here, from the same sources, so no second list exists and a prefix a screen adds is
 * known to both.
 *
 * Derived from the client source, never listed: the string constants named for refusals (`FILE_REFUSAL_PREFIX`, the module-local
 * `DATA_REFUSALS`), `refusalText`'s default prefix, and every literal (or such a constant) a call hands as the prefix argument of
 * `refusalText` / `describeRefusal`, which is how a screen that spells its prefix inline is found. A prefix argument that is none of those is
 * reported (`unresolved`), not skipped.
 *
 * It throws when `refusalText`'s module is not among the sources or has no default prefix, so a moved module or a changed spelling cannot
 * pass by finding nothing.
 *
 * It also reads the keys a screen spells itself under such a constant (`spelled`): the unused-keys check counts a key under a prefix used only
 * when the server can answer its last part (`_server-refusal-codes.mjs`) or the client spells it, so a sentence nothing looks up is named.
 */
import { callArguments } from './_call-arguments.mjs';
import { stripComments } from './_strip-comments.mjs';

/** The position of the prefix among each reader's arguments. */
const PREFIX_ARGUMENT = { refusalText: 3, describeRefusal: 4 };

/**
 * @param {Array<{ file: string, src: string }>} sources the client's tracked non-spec `.ts` sources, `file` as the caller names them
 * @returns {{ prefixes: string[], unresolved: string[], spelled: string[] }} `spelled`: the keys built as `${REFUSAL_CONSTANT}.<name>`
 */
export function refusalPrefixes(sources) {
  const constants = new Map();
  for (const { src } of sources) {
    // A string constant named for refusals, exported (`FILE_REFUSAL_PREFIX`) or module-local (`DATA_REFUSALS`).
    for (const m of src.matchAll(/\bconst (\w*REFUSAL\w*)\s*=\s*'([a-z][a-zA-Z.]*)'/g)) constants.set(m[1], m[2]);
  }
  const prefixes = new Set(constants.values());
  const refusalText = sources.find(s => s.file.endsWith('core/refusal-text.ts'));
  if (!refusalText) throw new Error('core/refusal-text.ts is not among the tracked sources: the module moved, and a check over its prefixes would report clean about nothing');
  const defaults = [...refusalText.src.matchAll(/keyPrefix = '([a-z][a-zA-Z.]*)'/g)].map(m => m[1]);
  if (!defaults.length) throw new Error('refusalText has no default keyPrefix any more - the spelling changed');
  for (const d of defaults) prefixes.add(d);
  const unresolved = [];
  for (const { file, src } of sources) {
    if (file === refusalText.file) continue;
    for (const [fn, at] of Object.entries(PREFIX_ARGUMENT)) {
      for (const m of src.matchAll(new RegExp(`(?<!function )\\b${fn}\\(`, 'g'))) {
        const arg = callArguments(src, m.index + m[0].length - 1)[at];
        if (arg === undefined) continue; // the default prefix
        const where = `${file}:${src.slice(0, m.index).split('\n').length}`;
        const literal = /^'([a-z][a-zA-Z.]*)'$/.exec(arg);
        if (literal) prefixes.add(literal[1]);
        else if (!constants.has(arg)) unresolved.push(`${where}: ${fn} gets prefix \`${arg}\`, which is no literal and no *_REFUSAL_PREFIX constant`);
      }
    }
  }
  // A key the client spells itself under a refusal constant (`${FORK_REFUSALS}.generic`): looked up by a name of the client's own, not by a code
  // the server sends, so it is used whatever the server answers. Only a constant named for refusals spells one (second review F13).
  const spelled = new Set();
  for (const { src } of sources) {
    for (const m of stripComments(src).matchAll(/\$\{(\w+)\}\.([A-Za-z]\w*)/g)) {
      if (constants.has(m[1])) spelled.add(`${constants.get(m[1])}.${m[2]}`);
    }
  }
  return { prefixes: [...prefixes].sort(), unresolved, spelled: [...spelled].sort() };
}
