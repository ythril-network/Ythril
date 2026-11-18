/**
 * Import a module by its repository path, and make a module that is not there a failed case with a sentence, never a crash at load.
 *
 * ## What it prevents
 *
 * A test written before the module it states exists (tests first) that imports it at the top of the file dies when the file loads: node reports one
 * module error for the whole file and no case runs, so the red line names a missing file and not the behaviour each case is about. With the import
 * inside the case, through this function, every case fails on its own assertion and says which module and which rule it was waiting for. It also
 * keeps a module that EXISTS but throws while loading a failure of the case, with the module's own first error line.
 *
 * One question: *"give me this module, or fail the case saying what is missing"*. It holds no rule about what a module must export.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { REPO_ROOT } from '../standalone/_sources.mjs';

/**
 * @param {string} path repo-relative, forward slashes (`testing/_shared/text-only-test.mjs`)
 * @param {string} [needed] the behaviour the case needs from it, said in the failure
 * @returns {Promise<Record<string, unknown>>} the module namespace
 */
export async function importOrFail(path, needed = 'the behaviour this case states') {
  try {
    return await import(pathToFileURL(join(REPO_ROOT, path)).href);
  } catch (error) {
    const first = String(error?.message ?? error).split(/\r?\n/)[0];
    return assert.fail(`${path} cannot be loaded (${first}); it is the module that provides ${needed}`);
  }
}
