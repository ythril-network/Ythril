/**
 * The codes a file act answers with, read out of the server module that defines them (`server/src/files/act-answers.ts`).
 *
 * The client words each code (`files.refusal.<code>`, `conflicts.refusal.<code>`), and nothing ties its sentences to the codes
 * the server really sends: a code the server gains has no words until a spec reads the list, and a code the server drops leaves a
 * sentence nobody can reach. Two specs ask that question, so it is asked here once.
 *
 * **It throws on an empty answer.** A moved file or a changed spelling in that module would otherwise yield no codes, and every
 * loop written over "each code" would pass over nothing and report clean.
 *
 * **It reads the code, not the prose.** The module's comments are removed first, by the stripper every source gate uses
 * (`testing/standalone/_strip-comments.mjs`, line comments before block comments): a code spelled in a docblock (`code: 'x'` as an
 * example, or a retired one named in a note) is not a code a branch answers with, and a loop over "each code" would demand words for it.
 *
 * Read by PATH from the repository root, as the specs that use it always did: a client spec cannot import server code, and the stripper
 * is loaded by a path the type-checker does not follow for the same reason (`rootDir` is `src`).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ACT_ANSWERS = resolve(__dirname, '../../../../server/src/files/act-answers.ts');
const STRIP_COMMENTS = resolve(__dirname, '../../../../testing/standalone/_strip-comments.mjs');

const { stripComments } = await import(/* @vite-ignore */ pathToFileURL(STRIP_COMMENTS).href) as { stripComments: (src: string) => string };

/** Fewer than the server has ever had: it tells "none found" from "found". */
const FLOOR = 5;

export function serverActCodes(): string[] {
  const codes = [...stripComments(readFileSync(ACT_ANSWERS, 'utf8')).matchAll(/code: '([a-z_]+)'/g)]
    .map(m => m[1]!)
    .filter((v, i, all) => all.indexOf(v) === i);
  if (codes.length < FLOOR) {
    throw new Error(`found ${codes.length} act codes in ${ACT_ANSWERS} — fewer than ${FLOOR}, so the module moved or its spelling changed, `
      + 'and a check over each code would report clean about nothing.');
  }
  return codes;
}
