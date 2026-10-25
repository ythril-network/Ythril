/**
 * The schema leaf and the hash leaf import no sync machinery, and merkle imports neither of them (Q-624, design rev 4 section 2,
 * section 16 test 19).
 *
 * ## The defect this prevents
 *
 * Revision 2 put the body hash in `brain/merkle.ts` and imported the field table from `sync/arrival-shape.ts`. That closed a cycle,
 * merkle -> arrival-shape -> `api/sync/_shared.ts` -> `sync/upsert-plan.ts` -> merkle, and all 271 entry modules of the server failed
 * to load with a temporal-dead-zone error. The root cause is that the `Incoming*` schemas lived in a module that also re-exported
 * `MAX_FORK_DEPTH` from the planner. So the schemas moved into `sync/incoming-schemas.ts`, and the hash into
 * `sync/authored-content.ts`, and each must stay a leaf for the order in which modules load to stop mattering.
 *
 * ## What it checks, over the transitive imports (`_import-closure.mjs`: comments stripped, a broken import throws)
 *
 *  - the schema leaf's closure holds none of `brain/merkle`, `sync/upsert-plan`, `api/sync/_shared` and `sync/arrival-shape`, and
 *    no module that imports the store or the config loader (`util/seq.ts` does, which is why `MAX_SYNC_SEQ` moved to an import-free
 *    module): the schemas must load without a database;
 *  - the hash leaf's closure holds the same nothing, beside the schema leaf it reads;
 *  - merkle's closure holds neither leaf, because `docLeaf` needs only `DERIVED_FIELDS`.
 *
 * ## Red on the unchanged code
 *
 * On b857da8f neither leaf exists. After the change, seen red by hand (put back by hand): an import of `../brain/merkle.js` added to
 * the schema leaf, and one of `../sync/incoming-schemas.js` added to `brain/merkle.ts`.
 *
 * Run: node --test testing/standalone/the-schema-leaf-imports-no-sync-machinery.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { importClosure } from './_import-closure.mjs';
import { readTrackedSources, REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const SCHEMA_LEAF = 'server/src/sync/incoming-schemas.ts';
const HASH_LEAF = 'server/src/sync/authored-content.ts';
const MERKLE = 'server/src/brain/merkle.ts';

/** The modules whose load closes the cycle: the space hash, the planner, and the two homes the schemas had. */
const SYNC_MACHINERY = ['server/src/brain/merkle.ts', 'server/src/sync/upsert-plan.ts', 'server/src/api/sync/_shared.ts', 'server/src/sync/arrival-shape.ts'];

const exists = (f) => existsSync(join(REPO_ROOT, f));

/** Modules whose own text imports the database or the config loader: loading one needs a store or a config file. */
function storeImporters() {
  const found = readTrackedSources('server/src', { ext: ['.ts'], floor: 300, specs: false, untracked: true })
    .filter(s => /from\s*['"][^'"]*\/(?:db\/mongo|config\/loader)\.js['"]/.test(stripComments(s.text)))
    .map(s => s.file);
  assert.ok(found.length >= 20, `only ${found.length} module(s) found importing the store or the config loader: the derivation is broken`);
  return new Set(found);
}

describe('the leaves exist', () => {
  it('the schema leaf and the hash leaf are written', () => {
    assert.ok(exists(SCHEMA_LEAF), `${SCHEMA_LEAF} does not exist: the Incoming schemas still live in a module that re-exports the planner's constants`);
    assert.ok(exists(HASH_LEAF), `${HASH_LEAF} does not exist: there is no one body hash for the planner, the writer, the fork module and the client`);
  });
});

describe('each leaf loads without the sync machinery or the store', () => {
  for (const leaf of [SCHEMA_LEAF, HASH_LEAF]) {
    it(`${leaf.replace('server/src/', '')} reaches none of the machinery, and no module that imports the store`, () => {
      const closure = importClosure(leaf);
      assert.ok(closure.length >= 3, `only ${closure.length} module(s) in the closure of ${leaf}: the walk is broken`);
      const machinery = closure.filter(f => SYNC_MACHINERY.includes(f));
      assert.deepEqual(machinery, [], `${leaf} reaches ${machinery.join(', ')}: a cycle through the space hash or the planner makes every entry module fail to load`);
      const store = storeImporters();
      const reached = closure.filter(f => store.has(f));
      assert.deepEqual(reached, [], `${leaf} reaches ${reached.join(', ')}, which import the store or the config loader: the schemas must load without a database`);
    });
  }

  it('the hash leaf reads the schema leaf', () => {
    assert.ok(exists(HASH_LEAF), `${HASH_LEAF} does not exist`);
    assert.ok(importClosure(HASH_LEAF).includes(SCHEMA_LEAF), 'the hash leaf does not read the schema leaf: its field table is derived from the schemas');
  });
});

describe('merkle imports neither leaf', () => {
  it('the closure of brain/merkle.ts holds neither the schema leaf nor the hash leaf', () => {
    assert.ok(exists(SCHEMA_LEAF) && exists(HASH_LEAF), 'the leaves are not written, so this holds of nothing');
    const closure = importClosure(MERKLE);
    assert.ok(closure.length >= 5, `only ${closure.length} module(s) in the closure of ${MERKLE}: the walk is broken`);
    assert.deepEqual(closure.filter(f => f === SCHEMA_LEAF || f === HASH_LEAF), [],
      'merkle imports a leaf that reads the planner side: docLeaf needs only DERIVED_FIELDS, and the body hash is the planner\'s');
  });
});
