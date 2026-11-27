/**
 * The routes the standing-act 409 gate holds, and the mounted routes it holds them to — one copy for the pure case and the database cases (Q-969).
 *
 * `a-write-a-standing-act-refuses-answers-409-on-every-rest-record-route.test.js` asks whether every mounted record write route has a
 * request, and needs no database; `...-db.test.js` sends each request while a restore stands. Both read this table, so a route
 * mounted next month is found by the local preflight and then asked by the database run, from one list.
 *
 * Imports no database harness: a module that did would make its pure caller a database file (`splitStandalone`).
 */
import { mountedRoutes } from './_routes.mjs';

export const PREFIX = '/api/brain/spaces/:spaceId/';
export const FLOOR = 15;

/**
 * The routes the database file sends a request to, one entry per key of its REQUESTS table (which stays there, as a test file the contract gates
 * read for the routes it names). The database file asserts at load that its table's keys are exactly these.
 */
export const REQUEST_ROUTES = [
  'POST /api/brain/spaces/:spaceId/facts',
  'PATCH /api/brain/spaces/:spaceId/facts/:id',
  'DELETE /api/brain/spaces/:spaceId/facts/:id',
  'POST /api/brain/spaces/:spaceId/entities',
  'PATCH /api/brain/spaces/:spaceId/entities/:id',
  'DELETE /api/brain/spaces/:spaceId/entities/:id',
  'POST /api/brain/spaces/:spaceId/entities/:survivorId/merge/:absorbedId',
  'POST /api/brain/spaces/:spaceId/edges',
  'PATCH /api/brain/spaces/:spaceId/edges/:id',
  'DELETE /api/brain/spaces/:spaceId/edges/:id',
  'POST /api/brain/spaces/:spaceId/chrono',
  'PATCH /api/brain/spaces/:spaceId/chrono/:id',
  'DELETE /api/brain/spaces/:spaceId/chrono/:id',
  'POST /api/brain/spaces/:spaceId/links',
  'DELETE /api/brain/spaces/:spaceId/links/:id',
  'PATCH /api/brain/spaces/:spaceId/files',
  'POST /api/brain/spaces/:spaceId/forks/:forkId/resolve',
  'POST /api/brain/spaces/:spaceId/bulk',
  'POST /api/brain/spaces/:spaceId/import/rdf',
  'POST /api/brain/spaces/:spaceId/sparql/update',
  'POST /api/brain/spaces/:spaceId/rdf-index/rebuild',
];

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
