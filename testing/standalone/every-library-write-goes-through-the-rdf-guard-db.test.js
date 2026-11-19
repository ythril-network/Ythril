/**
 * Every library write that changes what a linking RDF-enabled space's terms are named goes through the one guard, and a refused write
 * changes nothing, not even in memory (Q-748, slice A-fix, review findings 6, 9 and 10).
 *
 * - `POST /api/schema-library/export-space` works on a COPY of the library: the rename guard compares the library before the export with
 *   the library after it (it used to compare the cached array with itself, so it never fired), and a refused export leaves the cached
 *   library as it was (it used to stay live in memory until a restart, although the answer said nothing was stored).
 * - `DELETE /api/schema-library/:name` goes through the guard too (409 `rdf_term_rename` unless `?rebase=true`).
 * - The term-clash rule runs at space create (`POST /api/spaces`, 422 `rdf_term_clash`) and at group apply
 *   (`POST /api/schema-library/groups/:group/apply`), which also runs the rename guard (409 `rdf_term_rename` unless `rebase: true`).
 *
 * Run: node --test testing/standalone/every-library-write-goes-through-the-rdf-guard-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { tempInstanceDir, callRoute } from './_vote-round-instance.mjs';
import { bootSchemaInstance } from './_schema-doors.mjs';

const AUTH = { rights: { instanceAdmin: true, perSpace: {} } };
const dir = tempInstanceDir('ythril-library-rdf-guard-');
const skip = await mongoSkipReason();
const NS = 'https://acme.example/ns/';
const BASE = 'https://ythril.example.org/ld/linked/';
const RDF = { enabled: true, base: BASE, vocab: `${BASE}vocab/`, baseEpoch: 0 };
const LIBRARY = [
  { name: 'acme-entity-person', knowledgeType: 'entity', typeName: 'person', schemaGroup: 'acme', schema: { propertySchemas: { email: { type: 'string' } } } },
];
const SPACES = [
  { id: 'linked', label: 'Linked', folders: [], meta: { rdf: RDF, typeSchemas: { entity: { person: { $ref: 'library:acme-entity-person' } } } } },
  { id: 'source', label: 'Source', folders: [], meta: { typeSchemas: { entity: { person: { propertySchemas: { name: { type: 'string' } } } } } } },
];

describe('every library write goes through the RDF guard', { skip }, () => {
  let inst, validation, schemaLibraryRouter;
  before(async () => {
    await openTestMongo('library_rdf_guard');
    inst = await bootSchemaInstance(dir, { spaces: SPACES, library: LIBRARY });
    inst.loader.getConfig().schemaLibraryNamespaces = { acme: { prefix: 'acme', iri: NS } };
    validation = await import('../../server/dist/spaces/schema-validation.js');
    ({ schemaLibraryRouter } = await import('../../server/dist/api/schema-library.js'));
  });
  after(async () => {
    inst?.close();
    await closeTestMongo();
  });

  const personIri = () => validation.inlineResolvableRefs(inst.heldMeta('linked')).typeSchemas.entity.person.iri;

  it('export-space: a rename of a linked entry is refused 409 rdf_term_rename, and the cached library is untouched', async () => {
    inst.reset();
    const before = inst.heldEntries();
    assert.equal(personIri(), `${NS}person`);
    // The export's entry name lands on the linked entry and moves it to another group, so its namespace no longer names it.
    const answer = await inst.library.exportSpace({ spaceId: 'source', groupName: 'other', namePrefix: 'acme' });
    assert.equal(answer.status, 409, `the export renamed a linked RDF term unrefused: ${answer.text.slice(0, 300)}`);
    assert.match(answer.text, /rdf_term_rename/);
    assert.deepEqual(inst.heldEntries(), before, 'a refused export stayed live in the cached library');
    assert.equal(personIri(), `${NS}person`, 'a refused export moved a term address');
  });

  // Review finding 9: the term-clash rule ran on PATCH and on the library's entry writes only; a space created with a clash, or a group
  // applied over one, was stored with it, and every later library write then answered rdf_term_clash for that space.
  it('space create: a new RDF-enabled space whose terms clash is refused 422 rdf_term_clash and not created', async () => {
    inst.reset();
    const meta = { rdf: { enabled: true, base: 'https://x.example/ld/fresh/' },
      typeSchemas: { entity: { A: { iri: 'https://e.example/x' }, B: { iri: 'https://e.example/x' } } } };
    const answer = await inst.doors['space-create']('clashing', meta);
    assert.equal(answer.status, 422, `a space was created with two terms of one address: ${answer.text.slice(0, 300)}`);
    assert.match(answer.text, /rdf_term_clash/);
    assert.equal(inst.loader.getConfig().spaces.some(s => s.id === 'clashing-new'), false);
  });

  it('group apply: a group that would rename an RDF-enabled space\'s term is 409 rdf_term_rename unless rebase, and a clash is 409 rdf_term_clash', async () => {
    inst.reset();
    const cfg = inst.loader.getConfig();
    const apply = (spaceId, extra = {}) => callRoute(schemaLibraryRouter, 'post', '/groups/:group/apply',
      { params: { group: 'acme' }, body: { spaceId, ...extra }, authToken: AUTH }).then(r => ({ status: r.code, text: JSON.stringify(r.body ?? null) }));
    // An inline `person` named by the space's vocab: applying the group replaces it with the namespaced entry.
    cfg.spaces.push({ id: 'inline', label: 'Inline', folders: [], meta: { rdf: { ...RDF, base: 'https://ythril.example.org/ld/inline/', vocab: 'https://ythril.example.org/ld/inline/vocab/' },
      typeSchemas: { entity: { person: { propertySchemas: { email: { type: 'string' } } } } } } });
    const renamed = await apply('inline');
    assert.equal(renamed.status, 409, `a group apply renamed an RDF term unrefused: ${renamed.text.slice(0, 300)}`);
    assert.match(renamed.text, /rdf_term_rename/);
    assert.equal(cfg.spaces.find(s => s.id === 'inline').meta.typeSchemas.entity.person.$ref, undefined, 'a refused apply was stored');
    assert.equal((await apply('inline', { rebase: true })).status, 200);
    // An own type already named by the address the group's entry takes.
    cfg.spaces.push({ id: 'taken', label: 'Taken', folders: [], meta: { rdf: { ...RDF, base: 'https://ythril.example.org/ld/taken/', vocab: 'https://ythril.example.org/ld/taken/vocab/' },
      typeSchemas: { entity: { human: { iri: `${NS}person` } } } } });
    const clash = await apply('taken', { rebase: true });
    assert.equal(clash.status, 409, `a group apply stored a clash: ${clash.text.slice(0, 300)}`);
    assert.match(clash.text, /rdf_term_clash/);
  });

  // Review finding 10: the entry DELETE saved with no guard, so a linked term fell from its namespace address to its vocab address untold.
  it('DELETE of a linked namespaced entry is 409 rdf_term_rename unless rebase, and a refused delete keeps the entry', async () => {
    inst.reset();
    const del = (query = {}) => callRoute(schemaLibraryRouter, 'delete', '/:name', { params: { name: 'acme-entity-person' }, query, authToken: AUTH })
      .then(r => ({ status: r.code, text: JSON.stringify(r.body ?? null) }));
    const refused = await del();
    assert.equal(refused.status, 409, `a delete renamed a linked RDF term unrefused: ${refused.text.slice(0, 300)}`);
    assert.match(refused.text, /rdf_term_rename/);
    assert.ok(inst.heldEntry('acme-entity-person'), 'a refused delete removed the entry');
    assert.equal((await del({ rebase: 'true' })).status, 204);
    assert.equal(inst.heldEntry('acme-entity-person'), undefined);
  });
});
