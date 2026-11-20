/**
 * A schema-library group is any name the library accepts, and its namespace is kept and removed with it (Q-748, bundle-269 lens sweep,
 * findings 6 and 7).
 *
 * Finding 6. The namespaces are a plain object keyed by group, and four readers looked a group up by indexing it: the `DELETE`
 * handler, `GET /groups`, the effective entries and the resolver's view of a state. A group called `constructor` found the `Object`
 * function there, so `DELETE .../groups/constructor/namespace` answered `removed: true` and removed nothing, its entries were given
 * an address built from a function's missing `iri`; and a group called `__proto__` found `Object.prototype`, so `GET /groups` listed
 * an empty namespace the client showed as "undefined: undefined", and a stored namespace of that name was never an own key of what
 * `libraryNamespaces()` built. A group named so behaves as any other, on every route that takes a group.
 *
 * Finding 7. A namespace names the terms of a group's entries and holds its prefix. When the last entry of a group was deleted (or
 * moved to another group, or lost its group) the namespace stayed: hidden from `GET /groups` and the client, which list only groups
 * with entries, yet still holding its prefix, so no other group could take it (`namespace_prefix_taken`) and nobody could remove it.
 * A write that leaves a group with no entry takes the group's namespace with it.
 *
 * Run: node --test testing/standalone/a-library-group-named-like-an-object-property-keeps-its-namespace-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { tempInstanceDir, callRoute } from './_vote-round-instance.mjs';
import { bootSchemaInstance } from './_schema-doors.mjs';

const dir = tempInstanceDir('ythril-library-group-names-');
const skip = await mongoSkipReason();
const AUTH = { rights: { instanceAdmin: true, perSpace: {} } };
const NS = (g) => `https://${g.replace(/[^a-z]/g, '')}.example/ns/`;
const ODD_GROUPS = ['constructor', '__proto__', 'toString', 'hasOwnProperty'];
const LIBRARY = [
  ...ODD_GROUPS.map((g, i) => ({ name: `odd-${i}-thing`, knowledgeType: 'entity', typeName: 'thing', schemaGroup: g, schema: {} })),
  { name: 'plain-thing', knowledgeType: 'entity', typeName: 'plain', schemaGroup: 'plain', schema: {} },
  { name: 'solo-thing', knowledgeType: 'entity', typeName: 'solo', schemaGroup: 'solo', schema: {} },
];
const SPACES = [{ id: 'general', label: 'General', builtIn: true, folders: [], meta: {} }];

describe('a library group named like an Object property', { skip }, () => {
  let inst, router, terms;
  before(async () => {
    await openTestMongo('library_group_names');
    inst = await bootSchemaInstance(dir, { spaces: SPACES, library: LIBRARY });
    ({ schemaLibraryRouter: router } = await import('../../server/dist/api/schema-library.js'));
    terms = await import('../../server/dist/spaces/library-terms.js');
  });
  after(async () => {
    inst?.close();
    await closeTestMongo();
  });

  const put = (group, body) => callRoute(router, 'put', '/groups/:group/namespace', { params: { group }, body, authToken: AUTH });
  const del = (group) => callRoute(router, 'delete', '/groups/:group/namespace', { params: { group }, query: {}, authToken: AUTH });
  /** The list as a client reads it: through JSON, which drops what a JSON body cannot carry (a function). */
  const groups = async () => JSON.parse(JSON.stringify((await callRoute(router, 'get', '/groups', { authToken: AUTH })).body.groups));
  const held = () => inst.loader.getConfig().schemaLibraryNamespaces ?? {};
  const effective = (name) => terms.effectiveLibraryEntries().find(e => e.name === name);
  const reset = () => { inst.reset(); delete inst.loader.getConfig().schemaLibraryNamespaces; };

  for (const group of ODD_GROUPS) {
    describe(`the group "${group}"`, () => {
      const entry = `odd-${ODD_GROUPS.indexOf(group)}-thing`;

      it('has no namespace: GET /groups lists none, its entries get no address, and a DELETE is 404 namespace_not_found', async () => {
        reset();
        const listed = (await groups()).find(g => g.name === group);
        assert.ok(listed, `GET /groups lists no group "${group}"`);
        assert.equal(listed.count, 1);
        assert.equal(Object.hasOwn(listed, 'namespace'), false, `GET /groups gave "${group}" a namespace it never had: ${JSON.stringify(listed)}`);
        assert.equal(effective(entry)?.schema?.iri, undefined, `an entry of "${group}" was given the address ${effective(entry)?.schema?.iri}`);
        const removed = await del(group);
        assert.equal(removed.code, 404, `DELETE answered ${removed.code} ${JSON.stringify(removed.body)} for a group with no namespace`);
        assert.equal(removed.body.code, 'namespace_not_found');
      });

      it('is set, listed, applied to its entries and removed as any other group is', async () => {
        reset();
        const ns = NS(group);
        const set = await put(group, { prefix: 'odd', iri: ns, rebase: true });
        assert.equal(set.code, 200, JSON.stringify(set.body));
        assert.ok(Object.hasOwn(held(), group), `the namespace of "${group}" is not an own key of what config.json holds`);
        assert.deepEqual(Object.getOwnPropertyDescriptor(held(), group)?.value, { prefix: 'odd', iri: ns });
        assert.deepEqual((await groups()).find(g => g.name === group)?.namespace, { prefix: 'odd', iri: ns });
        assert.equal(effective(entry)?.schema?.iri, `${ns}thing`, 'the entry of the group is not named under its namespace');
        assert.deepEqual(Object.keys(terms.libraryNamespaces()), [group], 'libraryNamespaces() did not keep the group as an own key');
        const removed = await del(group);
        assert.equal(removed.code, 200, JSON.stringify(removed.body));
        assert.equal(Object.hasOwn(held(), group), false, `DELETE answered removed: true and left the namespace of "${group}" in config.json`);
        assert.equal(Object.hasOwn((await groups()).find(g => g.name === group) ?? {}, 'namespace'), false);
        assert.equal(effective(entry)?.schema?.iri, undefined, 'the entry kept the address of a namespace that was removed');
      });
    });
  }

describe('a write that leaves a group with no entry takes its namespace with it', () => {
  const call = (method, path, args) => callRoute(router, method, path, { authToken: AUTH, ...args });
  const held = () => inst.loader.getConfig().schemaLibraryNamespaces ?? {};
  const reset = () => { inst.reset(); delete inst.loader.getConfig().schemaLibraryNamespaces; };
  const setSolo = async () => {
    const r = await call('put', '/groups/:group/namespace', { params: { group: 'solo' }, body: { prefix: 'solo', iri: NS('solo'), rebase: true } });
    assert.equal(r.code, 200, JSON.stringify(r.body));
  };
  /** The prefix the dead group held is free for another group. */
  const prefixIsFree = async () => {
    const r = await call('put', '/groups/:group/namespace', { params: { group: 'plain' }, body: { prefix: 'solo', iri: NS('plain'), rebase: true } });
    assert.equal(r.code, 200, `the prefix of a group with no entry is still held: ${JSON.stringify(r.body)}`);
  };

  it('deleting its last entry', async () => {
    reset();
    await setSolo();
    assert.equal((await call('delete', '/:name', { params: { name: 'solo-thing' } })).code, 204);
    assert.equal(Object.hasOwn(held(), 'solo'), false, 'the namespace outlived the last entry of its group');
    await prefixIsFree();
  });

  it('moving its last entry to another group', async () => {
    reset();
    await setSolo();
    const r = await call('patch', '/:name', { params: { name: 'solo-thing' }, body: { schemaGroup: 'plain' } });
    assert.equal(r.code, 200, JSON.stringify(r.body));
    assert.equal(Object.hasOwn(held(), 'solo'), false, 'the namespace outlived the move of its last entry');
    await prefixIsFree();
  });

  it('clearing the group of its last entry', async () => {
    reset();
    await setSolo();
    const r = await call('patch', '/:name', { params: { name: 'solo-thing' }, body: { schemaGroup: null } });
    assert.equal(r.code, 200, JSON.stringify(r.body));
    assert.equal(Object.hasOwn(held(), 'solo'), false, 'the namespace outlived the loss of its last entry\'s group');
  });

  it('deleting an entry of a group that keeps another keeps its namespace', async () => {
    reset();
    const second = await call('put', '/:name', { params: { name: 'solo-second' }, body: { knowledgeType: 'entity', typeName: 'second', schema: {}, schemaGroup: 'solo' } });
    assert.ok(second.code === 200 || second.code === 201, `the second entry of the group was not stored: ${second.code} ${JSON.stringify(second.body)}`);
    await setSolo();
    assert.equal((await call('delete', '/:name', { params: { name: 'solo-thing' } })).code, 204);
    assert.ok(Object.hasOwn(held(), 'solo'), 'a namespace was dropped while its group still has an entry');
  });
});
});
