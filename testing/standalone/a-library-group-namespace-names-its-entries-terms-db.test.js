/**
 * A schema-library group can declare a namespace, and its entries' types and properties are named under it in every space that links them
 * (Q-748, slice A, design r4 §4.2).
 *
 * - `PUT /api/schema-library/groups/:group/namespace` `{ prefix, iri, rebase? }` stores `{ prefix, iri }` in `config.json`
 *   (`schemaLibraryNamespaces`); `GET /groups` shows it; `DELETE …/namespace` removes it.
 * - An entry of the group is EFFECTIVE with `iri = <ns><kind>/<seg(type)>` and each property `<ns><kind>/<seg(type)>/<seg(prop)>`, unless
 *   the entry sets one: the space's resolved meta carries it, so the one resolver names the term by it, the round trip of a `$ref` type keeps
 *   working, and the schema fingerprint of an RDF-enabled linking space changes with it. A linking space with RDF off is untouched: the
 *   same fingerprint and the same payload to its peers (RDF is inert when off).
 * - Refusals: a prefix another group holds (409 `namespace_prefix_taken`), a reserved prefix or a bad IRI (400), a group with no entries (404).
 * - The rename guard: when an RDF-enabled space links the group, a namespace change or removal and an entry edit that renames a term
 *   (`typeName`, `knowledgeType`, `schemaGroup`, `iri`) are 409 `rdf_term_rename` without `rebase`, and go through with it.
 * - The clash guard: a library write that would leave two terms of a linking RDF-enabled space with one address is 409 `rdf_term_clash`.
 * - `prefixesFor` names a group prefix a space's terms use.
 *
 * Run: node --test testing/standalone/a-library-group-namespace-names-its-entries-terms-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { tempInstanceDir, callRoute } from './_vote-round-instance.mjs';
import { bootSchemaInstance } from './_schema-doors.mjs';

const dir = tempInstanceDir('ythril-library-namespace-');
const skip = await mongoSkipReason();
const NS = 'https://acme.example/ns/';
const BASE = 'https://ythril.example.org/ld/linked/';
const AUTH = { rights: { instanceAdmin: true, perSpace: {} } };
const LIBRARY = [
  { name: 'acme-person', knowledgeType: 'entity', typeName: 'person', schemaGroup: 'acme', schema: { propertySchemas: { email: { type: 'string' }, 'nick name': { type: 'string' } } } },
  { name: 'acme-knows', knowledgeType: 'edge', typeName: 'person', schemaGroup: 'acme', schema: {} },
  { name: 'beta-thing', knowledgeType: 'entity', typeName: 'thing', schemaGroup: 'beta', schema: {} },
];
const SPACES = [
  { id: 'linked', label: 'Linked', folders: [], meta: { rdf: { enabled: true, base: BASE, vocab: `${BASE}vocab/`, baseEpoch: 0 },
    typeSchemas: { entity: { person: { $ref: 'library:acme-person' } }, edge: { person: { $ref: 'library:acme-knows' } } } } },
  { id: 'plain', label: 'Plain', folders: [], meta: { typeSchemas: { entity: { person: { $ref: 'library:acme-person' } } } } },
];

describe('a library group namespace names its entries\' terms', { skip }, () => {
  let inst, router, termIri, validation, internal;
  before(async () => {
    await openTestMongo('library_namespace');
    inst = await bootSchemaInstance(dir, { spaces: SPACES, library: LIBRARY });
    ({ schemaLibraryRouter: router } = await import('../../server/dist/api/schema-library.js'));
    termIri = await import('../../server/dist/rdf/term-iri.js');
    validation = await import('../../server/dist/spaces/schema-validation.js');
    internal = await import('../../schema/dist/internal.js');
  });
  after(async () => {
    inst?.close();
    await closeTestMongo();
  });

  const put = (group, body) => callRoute(router, 'put', '/groups/:group/namespace', { params: { group }, body, authToken: AUTH });
  const del = (group, query = {}) => callRoute(router, 'delete', '/groups/:group/namespace', { params: { group }, query, authToken: AUTH });
  const said = (r) => JSON.stringify(r.body ?? null);
  const resolved = (spaceId) => validation.inlineResolvableRefs(inst.heldMeta(spaceId));
  function reset() {
    inst.reset();
    delete inst.loader.getConfig().schemaLibraryNamespaces;
  }

  it('a namespace is stored, shown on GET /groups, and refused for a group with no entries', async () => {
    reset();
    const ok = await put('acme', { prefix: 'acme', iri: NS, rebase: true });
    assert.equal(ok.code, 200, said(ok));
    assert.deepEqual(inst.loader.getConfig().schemaLibraryNamespaces?.acme, { prefix: 'acme', iri: NS });
    const groups = await callRoute(router, 'get', '/groups', { authToken: AUTH });
    assert.deepEqual(groups.body.groups.find(g => g.name === 'acme')?.namespace, { prefix: 'acme', iri: NS });
    const none = await put('nobody', { prefix: 'nobody', iri: 'https://nobody.example/ns/' });
    assert.equal(none.code, 404, said(none));
  });

  it('the group\'s entries carry iri = <ns><kind>/<type>[/<prop>], and the resolver names the terms by it', () => {
    const meta = resolved('linked');
    assert.equal(termIri.resolveTermIri(meta, 'entity', 'person'), `${NS}entity/person`);
    assert.equal(termIri.resolveTermIri(meta, 'entity', 'person', 'nick name'), `${NS}entity/person/nick%20name`);
    assert.equal(termIri.resolveTermIri(meta, 'edge', 'person'), `${NS}edge/person`, 'one type name in two kinds has two addresses');
    const prefixes = termIri.prefixesFor(meta, Object.values(inst.loader.getConfig().schemaLibraryNamespaces));
    assert.equal(prefixes.acme, NS, 'a group prefix the space uses is declared');
  });

  it('the round trip of a $ref type still writes back', async () => {
    const shown = inst.heldMeta('plain');
    const back = await inst.doors['space-patch']('plain', { typeSchemas: shown.typeSchemas });
    assert.equal(back.refused, false, back.text.slice(0, 300));
  });

  // Review finding 5 (slice A-fix): this case used to assert that a namespace changes the schema of EVERY space linking its group. A space
  // with RDF off then carried `iri` to its peers (which a member before 6.6 refuses whole) and changed its fingerprint: RDF was not inert.
  it('a namespace changes the schema of an RDF-enabled linking space only: one with RDF off keeps its fingerprint and its peer payload', async () => {
    const { schemaFingerprintOf } = await import('../../server/dist/spaces/schema-stamp.js');
    const { roundForPeer } = await import('../../server/dist/networks/round-local-state.js');
    const spaceOf = (id) => inst.loader.getConfig().spaces.find(s => s.id === id);
    const peerPayload = (id) => JSON.stringify(roundForPeer({ type: 'meta_change', spaceId: id, pendingMeta: inst.heldMeta(id) }, spaceOf(id).meta?.rdf).pendingMeta);
    const seen = (id) => ({ fp: schemaFingerprintOf(spaceOf(id)), peer: peerPayload(id), served: JSON.stringify(resolved(id)) });
    reset();
    const plainBefore = seen('plain');
    const linkedBefore = seen('linked');
    assert.equal((await put('acme', { prefix: 'acme', iri: NS, rebase: true })).code, 200);
    assert.deepEqual(seen('plain'), plainBefore, 'a namespace changed what a space with RDF off sends its peers or its fingerprint');
    assert.ok(!seen('plain').peer.includes(NS), 'a space with RDF off sent a namespace address to its peers');
    const linkedAfter = seen('linked');
    assert.notEqual(linkedAfter.fp, linkedBefore.fp, 'a namespace changes the schema of an RDF-enabled space linking its group');
    assert.ok(linkedAfter.peer.includes(`${NS}entity/person`), 'an RDF-enabled space sends its namespace addresses to its peers');
  });

  it('a prefix another group holds is 409; a reserved prefix and a bad IRI are 400', async () => {
    reset();
    assert.equal((await put('acme', { prefix: 'acme', iri: NS, rebase: true })).code, 200);
    const taken = await put('beta', { prefix: 'acme', iri: 'https://beta.example/ns/' });
    assert.equal(taken.code, 409, said(taken));
    assert.match(said(taken), /namespace_prefix_taken/);
    assert.equal((await put('beta', { prefix: 'schema', iri: 'https://beta.example/ns/' })).code, 400);
    assert.equal((await put('beta', { prefix: 'beta', iri: 'not an iri' })).code, 400);
    assert.equal((await put('beta', { prefix: 'beta', iri: 'https://beta.example/ns' })).code, 400, 'a namespace ends in / or #');
  });

  it('the rename guard: a linked group\'s namespace and its entries\' names change only with rebase', async () => {
    reset();
    const first = await put('acme', { prefix: 'acme', iri: NS });
    assert.equal(first.code, 409, `setting a namespace renames the terms of an RDF-enabled space that links the group: ${said(first)}`);
    assert.match(said(first), /rdf_term_rename/);
    assert.match(said(first), /linked/, 'the refusal names the space');
    assert.deepEqual(first.body.spaces, ['linked'], 'the spaces are named in a field a client words itself');
    assert.equal((await put('acme', { prefix: 'acme', iri: NS, rebase: true })).code, 200);
    const moved = await put('acme', { prefix: 'acme', iri: 'https://acme.example/v2/' });
    assert.equal(moved.code, 409, said(moved));
    const removed = await del('acme');
    assert.equal(removed.code, 409, said(removed));
    const renamed = await inst.library.patch('acme-person', { typeName: 'human' });
    assert.equal(renamed.status, 409, renamed.text.slice(0, 300));
    assert.match(renamed.text, /rdf_term_rename/);
    const renamedOk = await inst.library.patch('acme-person', { typeName: 'human', rebase: true });
    assert.equal(renamedOk.refused, false, renamedOk.text.slice(0, 300));
    assert.equal((await del('acme', { rebase: 'true' })).code, 200);
    assert.equal(inst.loader.getConfig().schemaLibraryNamespaces?.acme, undefined);
  });

  it('a group no RDF-enabled space links is renamed freely', async () => {
    reset();
    assert.equal((await put('beta', { prefix: 'beta', iri: 'https://beta.example/ns/' })).code, 200);
    assert.equal((await put('beta', { prefix: 'beta', iri: 'https://beta.example/v2/' })).code, 200);
  });

  it('the clash guard: a library write that gives two terms of a linking space one address is 409 rdf_term_clash', async () => {
    reset();
    const meta = inst.heldMeta('linked');
    const own = { ...meta, typeSchemas: { ...meta.typeSchemas, entity: { ...meta.typeSchemas.entity, human: { iri: `${NS}entity/person` } } } };
    inst.loader.getConfig().spaces.find(s => s.id === 'linked').meta = own;
    const clash = await put('acme', { prefix: 'acme', iri: NS, rebase: true });
    assert.equal(clash.code, 409, said(clash));
    assert.match(said(clash), /rdf_term_clash/);
    assert.match(said(clash), /human/);
    assert.deepEqual([...clash.body.terms].sort(), ['entity:human', 'entity:person'], 'both terms are named in a field a client words itself');
    assert.equal(clash.body.space, 'linked');
    assert.equal(clash.body.iri, `${NS}entity/person`);
    assert.equal(inst.loader.getConfig().schemaLibraryNamespaces?.acme, undefined, 'a refused write stored nothing');
  });
});
