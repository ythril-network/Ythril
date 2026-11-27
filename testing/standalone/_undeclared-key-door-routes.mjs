/**
 * The REST doors that store a record from a body, as the route each is mounted at — one copy for the pure case and the database cases (Q-969).
 *
 * `an-undeclared-property-key-is-judged-alike-on-every-rest-door.test.js` holds this table to the routes the router mounts and needs no database;
 * `...-db.test.js` builds its doors (the requests, and what each answer is read as) over the same routes. A door is a kind's create, its patch
 * and the bulk route, so the table is three routes per kind, and a route added next year is found by the local preflight.
 *
 * Imports no database harness: a module that did would make its pure caller a database file (`splitStandalone`).
 */
export const KINDS = ['entity', 'fact', 'chrono', 'edge'];
export const SEGMENT = { entity: 'entities', fact: 'facts', chrono: 'chrono', edge: 'edges' };

/** The three routes of a kind's doors, each as `[method, path]`. */
export const routesOf = (kind) => ({
  create: ['POST', `/api/brain/spaces/:spaceId/${SEGMENT[kind]}`],
  patch: ['PATCH', `/api/brain/spaces/:spaceId/${SEGMENT[kind]}/:id`],
  bulk: ['POST', '/api/brain/spaces/:spaceId/bulk'],
});
