/**
 * The library group namespaces live in `config.json` and follow its rules: an unreadable file is never read as "no namespaces", and a
 * namespace that file holds and no door would accept names nothing (Q-748, slice A, design r4 §4.2 [S12]).
 *
 * - A reload of a `config.json` that cannot be read keeps the namespaces in memory: the reload refuses, as for every other key, and the
 *   terms of a linking space keep their addresses.
 * - A namespace written survives the file round trip: saved, read back from disk, still there.
 * - A namespace in the file with a prefix or an IRI no door would accept (a hand edit) is left out of the effective entries and named, never
 *   turned into an address.
 *
 * Run: node --test testing/standalone/the-namespaces-survive-an-unreadable-config-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { tempInstanceDir } from './_vote-round-instance.mjs';
import { bootSchemaInstance } from './_schema-doors.mjs';

const dir = tempInstanceDir('ythril-namespace-config-');
const skip = await mongoSkipReason();
const NS = 'https://acme.example/ns/';
const LIBRARY = [{ name: 'acme-person', knowledgeType: 'entity', typeName: 'person', schemaGroup: 'acme', schema: {} }];
const SPACES = [{ id: 'linked', label: 'Linked', folders: [], meta: { typeSchemas: { entity: { person: { $ref: 'library:acme-person' } } } } }];

describe('the namespaces survive an unreadable config', { skip }, () => {
  let inst, terms;
  before(async () => {
    await openTestMongo('namespace_config');
    inst = await bootSchemaInstance(dir, { spaces: SPACES, library: LIBRARY });
    terms = await import('../../server/dist/spaces/library-terms.js');
  });
  after(async () => {
    inst?.close();
    await closeTestMongo();
  });

  const cfgPath = () => process.env['CONFIG_PATH'];
  const entryIri = () => terms.effectiveLibraryEntries().find(e => e.name === 'acme-person')?.schema?.iri;

  it('a namespace written is read back from the file', async () => {
    const cfg = inst.loader.getConfig();
    cfg.schemaLibraryNamespaces = { acme: { prefix: 'acme', iri: NS } };
    inst.loader.saveConfig(cfg);
    await inst.loader.flushConfig();
    inst.loader.reloadConfig();
    assert.deepEqual(inst.loader.getConfig().schemaLibraryNamespaces, { acme: { prefix: 'acme', iri: NS } });
    assert.equal(entryIri(), `${NS}person`);
  });

  it('a reload of an unreadable config.json keeps the namespaces, and the entry keeps its address', async () => {
    const good = fs.readFileSync(cfgPath(), 'utf8');
    try {
      fs.writeFileSync(cfgPath(), '{ "this is": not json', { mode: 0o600 });
      assert.throws(() => inst.loader.reloadConfig(), 'a reload of an unreadable file refuses');
      assert.deepEqual(inst.loader.getConfig().schemaLibraryNamespaces, { acme: { prefix: 'acme', iri: NS } }, 'the namespaces were read as absent');
      assert.equal(entryIri(), `${NS}person`);
    } finally {
      fs.writeFileSync(cfgPath(), good, { mode: 0o600 });
      inst.loader.reloadConfig();
    }
  });

  it('a namespace the file holds that no door would accept names nothing, and is named', () => {
    const cfg = inst.loader.getConfig();
    cfg.schemaLibraryNamespaces = { acme: { prefix: 'schema', iri: 'not an iri' } };
    assert.equal(entryIri(), undefined, 'a namespace no door accepts became an address');
    assert.deepEqual(terms.unusableNamespaces().map(n => n.group), ['acme']);
    delete cfg.schemaLibraryNamespaces;
  });
});
