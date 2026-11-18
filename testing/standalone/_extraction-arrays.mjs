/**
 * The arrays a caller-supplied ingest `extraction` carries, read from the type the writer reads — not from the list of bounds.
 *
 * ## Why a module
 *
 * Two gates ask which arrays an ingest extraction holds: `every-quantity-a-caller-sends-has-a-bound` (each must carry a
 * `maxItems` in the tool schema) and `an-ingest-extraction-array-has-a-count-bound-on-both-doors` (each must be refused one
 * past its bound by the shared parser). A list of bounds cannot answer that question about itself — an array added to the
 * `Extraction` interface and left out of the list would be reported clean — so the names come from the interface in
 * `server/src/extractor/conversation/assemble.ts`, the one declaration the validator and the writer both read.
 *
 * The floor throws: a derivation that stopped matching returns a short list, and a short list passes every loop over it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const EXTRACTION_TYPE = 'server/src/extractor/conversation/assemble.ts';

/** Every top-level array property of the `Extraction` interface, by name. A property whose type ends in `[];` is an array. */
export function extractionArrays({ floor = 6 } = {}) {
  const src = stripComments(readFileSync(join(REPO_ROOT, EXTRACTION_TYPE), 'utf8'));
  const open = src.indexOf('export interface Extraction {');
  if (open < 0) throw new Error(`no \`export interface Extraction\` in ${EXTRACTION_TYPE} — the type moved`);
  const body = src.slice(open, src.indexOf('\n}', open));
  const names = [...body.matchAll(/^ {2}([A-Za-z_$][\w$]*)\??:.*\[\];\s*$/gm)].map(m => m[1]);
  if (names.length < floor) throw new Error(`only ${names.length} array(s) found in \`Extraction\`, below ${floor} — the derivation broke`);
  return names;
}
