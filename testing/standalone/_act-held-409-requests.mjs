/**
 * The table the standing-act 409 gate holds, and the routes it is held to — one copy for the pure case and the database cases (Q-969).
 *
 * `a-write-a-standing-act-refuses-answers-409-on-every-rest-record-route.test.js` asks whether every mounted record write route has a
 * request here, and needs no database; `...-db.test.js` sends each request while a restore stands. Both read this table, so a route
 * mounted next month is found by the local preflight and then asked by the database run, from one list.
 *
 * Imports no database harness: a module that did would make its pure caller a database file (`splitStandalone`).
 */
import { mountedRoutes } from './_routes.mjs';

export const PREFIX = '/api/brain/spaces/:spaceId/';
export const FLOOR = 15;

/**
 * One valid write per route, as `{ params, query, body }`. The ids name records the database file seeds, so an update, a delete or a merge reaches the
 * writer rather than a 404.
 */
export const REQUESTS = {
  'POST /api/brain/spaces/:spaceId/facts': { body: { fact: 'written during the restore', tags: [] }, coll: 'facts', match: { fact: 'written during the restore' } },
  'PATCH /api/brain/spaces/:spaceId/facts/:id': { params: { id: 'aaaaaaaa-0000-4000-8000-0000000000f1' }, body: { fact: 'changed during the restore' }, coll: 'facts', match: { fact: 'changed during the restore' } },
  'DELETE /api/brain/spaces/:spaceId/facts/:id': { params: { id: 'aaaaaaaa-0000-4000-8000-0000000000f2' }, gone: { coll: 'facts', _id: 'aaaaaaaa-0000-4000-8000-0000000000f2' } },
  'POST /api/brain/spaces/:spaceId/entities': { body: { name: 'Written during', type: 'concept' }, coll: 'entities', match: { name: 'Written during' } },
  'PATCH /api/brain/spaces/:spaceId/entities/:id': { params: { id: 'aaaaaaaa-0000-4000-8000-0000000000e1' }, body: { name: 'Changed during' }, coll: 'entities', match: { name: 'Changed during' } },
  'DELETE /api/brain/spaces/:spaceId/entities/:id': { params: { id: 'aaaaaaaa-0000-4000-8000-0000000000e2' }, gone: { coll: 'entities', _id: 'aaaaaaaa-0000-4000-8000-0000000000e2' } },
  'POST /api/brain/spaces/:spaceId/entities/:survivorId/merge/:absorbedId': { params: { survivorId: 'aaaaaaaa-0000-4000-8000-0000000000e3', absorbedId: 'aaaaaaaa-0000-4000-8000-0000000000e4' }, body: {}, gone: { coll: 'entities', _id: 'aaaaaaaa-0000-4000-8000-0000000000e4' } },
  'POST /api/brain/spaces/:spaceId/edges': { body: { from: 'aaaaaaaa-0000-4000-8000-0000000000e1', to: 'aaaaaaaa-0000-4000-8000-0000000000e3', label: 'written_during' }, coll: 'edges', match: { label: 'written_during' } },
  'PATCH /api/brain/spaces/:spaceId/edges/:id': { params: { id: 'aaaaaaaa-0000-4000-8000-0000000000a1' }, body: { label: 'changed_during' }, coll: 'edges', match: { label: 'changed_during' } },
  'DELETE /api/brain/spaces/:spaceId/edges/:id': { params: { id: 'aaaaaaaa-0000-4000-8000-0000000000a2' }, gone: { coll: 'edges', _id: 'aaaaaaaa-0000-4000-8000-0000000000a2' } },
  'POST /api/brain/spaces/:spaceId/chrono': { body: { title: 'Written during', type: 'event', startsAt: '2026-10-21T00:00:00.000Z' }, coll: 'chrono', match: { title: 'Written during' } },
  'PATCH /api/brain/spaces/:spaceId/chrono/:id': { params: { id: 'aaaaaaaa-0000-4000-8000-0000000000c1' }, body: { title: 'Changed during' }, coll: 'chrono', match: { title: 'Changed during' } },
  'DELETE /api/brain/spaces/:spaceId/chrono/:id': { params: { id: 'aaaaaaaa-0000-4000-8000-0000000000c2' }, gone: { coll: 'chrono', _id: 'aaaaaaaa-0000-4000-8000-0000000000c2' } },
  'POST /api/brain/spaces/:spaceId/links': { body: { from: 'aaaaaaaa-0000-4000-8000-0000000000f2', fromKind: 'fact', to: 'aaaaaaaa-0000-4000-8000-0000000000e1', toKind: 'entity' }, coll: 'links', match: { from: 'aaaaaaaa-0000-4000-8000-0000000000f2', to: 'aaaaaaaa-0000-4000-8000-0000000000e1' } },
  'DELETE /api/brain/spaces/:spaceId/links/:id': { params: { id: 'aaaaaaaa-0000-4000-8000-0000000000b1' }, gone: { coll: 'links', _id: 'aaaaaaaa-0000-4000-8000-0000000000b1' } },
  'PATCH /api/brain/spaces/:spaceId/files': { query: { path: 'held.txt' }, body: { tags: ['changed-during'] }, coll: 'files', match: { tags: 'changed-during' } },
  // Review's fork resolve (bundle-81): the fork of the fact seeded below as `f1`; a refused resolve neither deletes it nor writes its text on the parent.
  // Q-624 (design rev 4 section 9): the resolve takes five parameters, all required, so the body names the kind and both versions as listed (the fork
  // at 3, its parent `f1` at 1); `{ keep }` alone is a 400 before the act is asked.
  'POST /api/brain/spaces/:spaceId/forks/:forkId/resolve': { params: { forkId: 'aaaaaaaa-0000-4000-8000-0000000000f3' }, body: { kind: 'fact', keep: 'fork', ifMatchSeq: 3, ifMatchParentSeq: 1 }, gone: { coll: 'facts', _id: 'aaaaaaaa-0000-4000-8000-0000000000f3' }, coll: 'facts', match: { _id: 'aaaaaaaa-0000-4000-8000-0000000000f1', fact: 'the fork text, resolved during the restore' } },
  'POST /api/brain/spaces/:spaceId/bulk': { body: { facts: [{ fact: 'bulk during the restore' }] }, coll: 'facts', match: { fact: 'bulk during the restore' } },
  // The RDF import (bundle-270): one entity as JSON-LD, which the door reads from a JSON body. A space another act holds takes no import: the
  // door answers that act's code before it registers an act of its own, and no record of the file lands.
  'POST /api/brain/spaces/:spaceId/import/rdf': { query: { format: 'jsonld' }, body: { '@context': { name: 'http://schema.org/name' }, '@id': 'https://example.org/actheld409/imported-during', name: 'Imported during' }, coll: 'entities', match: { name: 'Imported during' } },
  // SPARQL Update (bundle-272, Q-761): an INSERT DATA of one entity, sent as the protocol's own media type (`text` under `contentType`, not JSON);
  // a standing act refuses it with its own code, and the entity is not stored.
  'POST /api/brain/spaces/:spaceId/sparql/update': { contentType: 'application/sparql-update', text: 'INSERT DATA { <https://example.org/actheld409/entity/updated-during> a <https://w3id.org/ythril/ns#Entity>, <https://example.org/actheld409/vocab/entity/person> ; <http://www.w3.org/2000/01/rdf-schema#label> "Updated during" }', coll: 'entities', match: { name: 'Updated during' } },
  // The triple index rebuild (bundle-273): it writes no record, but a rebuild during a restore would read records the restore is replacing,
  // so it answers the act's 409 and code like every write door, and no build of the space's index starts (its build row stays empty).
  'POST /api/brain/spaces/:spaceId/rdf-index/rebuild': { body: {}, coll: 'rdf_state', match: { _id: 'build' } },
};

/** Derived routes under the prefix that are not one write of a record, each with why. */
export const NOT_A_RECORD_WRITE = new Map([
  ['POST /api/brain/spaces/:spaceId/traverse', 'a graph read sent as POST for its body; it writes nothing'],
  ['POST /api/brain/spaces/:spaceId/sparql', 'a SPARQL query sent as POST for its body; the endpoint refuses SPARQL Update, so it writes nothing'],
  ['POST /api/brain/spaces/:spaceId/events/ticket', 'issues a short-lived ticket for the space\'s event stream; it writes no record'],
  ['POST /api/brain/spaces/:spaceId/reindex', 'rebuilds the space\'s search index; it writes no record'],
  ['POST /api/brain/spaces/:spaceId/embedding-queue/records/retry', 'requeues embedding jobs; a record\'s content is not written'],
  ['POST /api/brain/spaces/:spaceId/embedding-queue/media/retry-failed', 'requeues media jobs; a record\'s content is not written'],
  ['POST /api/brain/spaces/:spaceId/ingest', 'starts an extraction run; its records are written later by the run through the gated writers, not in this request'],
]);

const derived = mountedRoutes()
  .filter(r => r.method !== 'GET' && r.path.startsWith(PREFIX))
  .map(r => `${r.method} ${r.path}`);
export const subjects = [...new Set(derived)].filter(k => !NOT_A_RECORD_WRITE.has(k));
