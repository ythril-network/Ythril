/**
 * The pure rules of the file tombstones import no code that touches the disk, the database or the configuration (Q-415 item 1).
 *
 * ## The finding this holds
 *
 * `files/tombstone-shadow.ts` says it is the PURE half of "does a held tombstone shadow an arriving file": decided over rows already
 * read, so the rule can be read, tested and changed without the reads. It imported `parentOfSidecar` from `files/moved-paths.ts`, which
 * also held the three functions that look at the disk (`sidecarsOwnedBy`, `kindAt`, `movedSidecars`), so the "pure" module pulled the
 * sandbox (the configuration) and the stored-bytes reader (the file system, the secret box) into its closure — and, through
 * `sync/upsert-plan.ts`, the whole brain. Nothing said so, because a module's docblock is not a check.
 *
 * ## The rule
 *
 * A module that declares itself a pure rule leaf with the marker `@pure-rules` in its docblock has an import closure — every relative
 * import, followed transitively, type-only imports included — that reaches none of the I/O boundaries below, and imports no package
 * that is one. The entries are DERIVED (the files carrying the marker, with a floor), so a pure module written next year is held to the
 * same rule by writing the marker, and one that drops the marker drops out of the floor.
 *
 * ## Mutation that turns it red
 *
 * Re-add `import { isStoredDirectory } from './stored-bytes.js'` to `files/moved-paths.ts`, or an `import 'node:fs'` to any module in
 * the closure: the test names the import chain.
 *
 * Run: node --test testing/standalone/the-shadow-rules-import-no-io.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { relativeImports, bareImports } from './_import-closure.mjs';

const MARKER = '@pure-rules';
/** Pure leaves a stream of rules is built from: the floor that means the derivation found them. */
const ENTRY_FLOOR = 3;
/** Modules a pure rule must not reach: the configuration, the database, the sandbox (the configuration and the file system) and the stored-bytes reader. */
const IO_MODULES = ['server/src/config/loader.ts', 'server/src/db/mongo.ts', 'server/src/files/sandbox.ts', 'server/src/files/stored-bytes.ts'];
/** Packages and built-ins that are I/O (or carry it): the file system, the database driver, the network, processes. */
const IO_PACKAGES = /^(?:node:)?(?:fs|fs\/promises|child_process|net|http|https|http2|dns|dgram|tls|worker_threads|cluster)$|^mongodb$/;

const entries = trackedSources('server/src', { floor: 100 }).filter(f => readFileSync(join(REPO_ROOT, f), 'utf8').includes(MARKER));

/** The closure of `entry`, each member with the file that first reached it, so a finding can say how. */
function closureWithParents(entry) {
  const parent = new Map([[entry, null]]);
  const queue = [entry];
  while (queue.length) {
    const f = queue.shift();
    for (const dep of relativeImports(f)) {
      if (parent.has(dep)) continue;
      parent.set(dep, f);
      queue.push(dep);
    }
  }
  return parent;
}

const chainTo = (parent, f) => { const out = []; for (let x = f; x; x = parent.get(x)) out.unshift(x); return out.join(' -> '); };

describe('the pure rules of the file tombstones import no I/O', () => {
  it('the derivation found the modules that declare themselves pure (a floor)', () => {
    assert.ok(entries.length >= ENTRY_FLOOR, `only ${entries.length} module(s) carry ${MARKER}: ${entries.join(', ')}`);
  });

  it('the shadow rules and the path algebra are among them', () => {
    for (const must of ['server/src/files/tombstone-shadow.ts', 'server/src/files/moved-paths.ts']) {
      assert.ok(entries.includes(must), `${must} does not carry ${MARKER}`);
    }
  });

  it('no closure reaches an I/O module or imports an I/O package', () => {
    const findings = [];
    for (const entry of entries) {
      const parent = closureWithParents(entry);
      for (const f of parent.keys()) {
        if (IO_MODULES.includes(f)) findings.push(`${entry} reaches ${f}: ${chainTo(parent, f)}`);
        for (const pkg of bareImports(f)) if (IO_PACKAGES.test(pkg)) findings.push(`${entry} reaches '${pkg}' in ${chainTo(parent, f)}`);
      }
    }
    assert.deepEqual(findings, [], `a pure rule module reaches code that does I/O:\n  ${findings.join('\n  ')}`);
  });
});
