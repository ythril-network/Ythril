/**
 * Where a write-plan function lives, DERIVED — so a gate about it follows the function when it is moved.
 *
 * ## What this prevents
 *
 * The edge refusal was one block inside `planEdge`; it is its own function now, and several gates assert things
 * about it (`write-functions-validate-not-their-callers`, `every-writer-validates-internally`,
 * `a-property-default-is-applied-and-stored`, `an-edge-refusal-writes-nothing-and-embeds-nothing`, and the
 * connections gates). Hard-coded file names in each are as many places to be wrong the day it moves to a sibling.
 * They ask THIS module "which file declares it" instead, and it FAILS LOUDLY when the answer is none or several: a
 * gate that resolved a missing function to an empty body would pass every `doesNotMatch` written over it.
 *
 * The question is "where is the function NAMED X declared under `brain/write-plan/`" — not "what does it contain",
 * which stays each gate's own.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf } from './_structural-window.mjs';

export const WRITE_PLAN_DIR = 'server/src/brain/write-plan';

/** Untracked too: a function extracted in the change under test is the one this most needs to see. */
export function writePlanFiles() {
  return trackedSources(WRITE_PLAN_DIR, { floor: 8, untracked: true });
}

/**
 * The comment-stripped source, and the body, of the one top-level function `name` declared under write-plan/.
 * Throws when it is declared nowhere or in more than one file.
 */
export function writePlanFunction(name) {
  const declared = new RegExp(
    String.raw`^(?:export\s+)?(?:async\s+function|function|const)\s+${name}\b`, 'm');
  const homes = writePlanFiles()
    .map(file => ({ file, src: stripComments(readFileSync(join(REPO_ROOT, file), 'utf8')) }))
    .filter(f => declared.test(f.src));
  assert.ok(homes.length > 0,
    `\`${name}\` is declared in no file under ${WRITE_PLAN_DIR}/ — it is the function this gate asserts about, so `
    + 'there is nothing to assert it of. Extract it there (or re-point this gate if it deliberately lives elsewhere).');
  assert.equal(homes.length, 1,
    `\`${name}\` is declared in ${homes.length} files (${homes.map(h => h.file).join(', ')}) — one rule, `
    + 'two homes, which is the defect these gates exist to prevent');
  const [{ file, src }] = homes;
  return { file, src, body: bodyOf(src, name, `${name} in ${file}`) };
}
