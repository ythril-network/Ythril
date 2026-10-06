/**
 * Load a built server module for a test of a module that may not exist yet, and say so per rule when it does not.
 *
 * ## What it prevents
 *
 * A top-level `import` of a module that is absent crashes the whole file at load: every rule in it reports the same
 * stack trace, and the one reason that matters (this module has not been written) is spelled by a loader, not by the
 * rule that needed it. Loading inside `before` and asserting per rule keeps each rule its own named failure.
 *
 * Only "the file itself is not there" counts as missing. A syntax error, a throw while it loads, or a missing module
 * INSIDE it still throws, because reporting those as "module missing" would hide a real defect.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import assert from 'node:assert/strict';

/**
 * @param {string} relativeToTestFile the path as the test file would write an import, e.g. `../../server/dist/util/seq-keyset.js`
 * @param {string} importMetaUrl      the caller's `import.meta.url`
 * @returns {Promise<{ mod: Record<string, any> | null, path: string }>}
 */
export async function loadDistModule(relativeToTestFile, importMetaUrl) {
  const path = resolve(dirname(fileURLToPath(importMetaUrl)), relativeToTestFile);
  if (!existsSync(path)) return { mod: null, path };
  return { mod: await import(pathToFileURL(path).href), path };
}

/** Assert the module loaded and exports every name in `names`; the message names the rule that needed it. */
export function needModule(loaded, names, rule) {
  assert.ok(loaded.mod !== null,
    `${rule}: ${loaded.path.replace(/\\/g, '/').split('/server/')[1] ?? loaded.path} does not exist, and this rule is about it`);
  for (const n of names) {
    assert.ok(n in loaded.mod, `${rule}: the module does not export \`${n}\``);
  }
  return loaded.mod;
}
