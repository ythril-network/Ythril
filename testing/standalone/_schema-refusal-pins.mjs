/**
 * The two spaces and the in-process doors every "what does a write door answer a schema violation today" pin shares — answered once.
 *
 * ## The question it answers
 *
 * *"This write breaks the space's type schema: what does each door say, and what did it store?"* Three characterization files
 * (`a-record-write-...`, `a-warn-space-and-an-unknown-field-...`, `a-bulk-row-and-a-merge-refusal-...`) pin the answers
 * bundle-23 changes. They need the same fixture — a strict and a warn space with one type per record kind that declares a
 * property the write can break — and the same two ways in: a REST route's own handler and a tool through `callTool` (the dispatch
 * the MCP transport and `POST /api/<tool>` share). A copy in each would drift on the one thing they are compared on: the schema.
 *
 * ## What a hand-written copy drops
 *
 * - **The route's own handler.** `rest` runs the handler production runs, past auth and rate limit (`_tool-door.mjs`'s
 *   `routeHandler`), and throws when a route has moved, so a pin cannot pass by reaching nothing.
 * - **The seeded records carry a seq the counter has passed.** A record inserted without `bumpSeq` is behind the space's counter and
 *   the writers read it as a stale copy; `seed` bumps it.
 * - **Nothing is embedded.** Both spaces suppress embeddings, so no case fetches a model.
 *
 * ## What it does not do
 *
 * It decides no answer. The expected values live in the files that pin them, as literals: a fixture that derived them from the
 * server would assert that the server equals itself.
 */
import { randomUUID } from 'node:crypto';
import { openToolDoor } from './_tool-door.mjs';

/** The two modes the pins ask, and the space each lives in. */
export const MODES = Object.freeze(['strict', 'warn']);
export const spaceOf = (mode) => `pin${mode}`;

/** One type per kind that DECLARES a property a write can break; `org` declares none and `employs` has an endpoint rule. */
const meta = (validationMode) => ({
  validationMode,
  suppressEmbeddings: true,
  typeSchemas: {
    entity: { person: { propertySchemas: { age: { type: 'number', required: true }, rank: { type: 'string' } } }, org: {} },
    chrono: { event: { propertySchemas: { priority: { type: 'string', enum: ['low', 'high'] } } } },
    fact: { claim: { propertySchemas: { confidence: { type: 'number', required: true } } } },
    edge: {
      knows: { propertySchemas: { since: { type: 'number', required: true } } },
      employs: { endpoints: { from: ['org'], to: ['person'] } },
    },
  },
});

/** The REST route of each record kind: the router's module, its export, and the collection path. Literal: `routeHandler` throws on a move. */
const ROUTES = Object.freeze({
  entity: { module: 'entities', router: 'entitiesRouter', path: '/spaces/:spaceId/entities' },
  fact: { module: 'facts', router: 'memoriesRouter', path: '/spaces/:spaceId/facts' },
  edge: { module: 'edges', router: 'edgesRouter', path: '/spaces/:spaceId/edges' },
  chrono: { module: 'chrono', router: 'chronoRouter', path: '/spaces/:spaceId/chrono' },
});
export const KINDS = Object.freeze(Object.keys(ROUTES));
export const COLLECTION = Object.freeze({ entity: 'entities', fact: 'facts', edge: 'edges', chrono: 'chrono' });

const T0 = '2026-09-01T00:00:00.000Z';
const AUTHOR = { instanceId: 'pin-author', instanceLabel: 'Pin author' };

/**
 * @param {object} o
 * @param {string} o.suite  harness database slug, unique per file (`a-db-harness-name-is-unique`)
 * @returns `{ door, spaces, rest, bulkRest, call, seed, stored, close }`
 */
export async function openPinDoors({ suite }) {
  const door = await openToolDoor({
    suite,
    spaces: MODES.map(mode => ({ id: spaceOf(mode), label: spaceOf(mode), folders: [], meta: meta(mode) })),
  });
  try {
    const routers = {};
    for (const [kind, r] of Object.entries(ROUTES)) routers[kind] = (await import(`../../server/dist/api/brain/${r.module}.js`))[r.router];
    const { bulkRouter } = await import('../../server/dist/api/brain/bulk.js');
    const { bumpSeq } = await import('../../server/dist/util/seq.js');

    /** A REST record write: `create` posts to the collection, `update` patches `<collection>/:id`. Answers `{ status, body }`. */
    function rest(kind, verb, space, { id, body }) {
      const r = ROUTES[kind];
      if (verb === 'create') return door.request(door.routeHandler(routers[kind], 'post', r.path), { params: { spaceId: space }, body });
      return door.request(door.routeHandler(routers[kind], 'patch', `${r.path}/:id`), { params: { spaceId: space, id }, body });
    }
    /** `POST /api/brain/spaces/:spaceId/bulk`, answered `{ status, body }`. */
    const bulkRest = (space, body) =>
      door.request(door.routeHandler(bulkRouter, 'post', '/spaces/:spaceId/bulk'), { params: { spaceId: space }, body });

    /** A tool call through `callTool`: `{ status, isError, text, structured }`. `transport: 'rest'` is `POST /api/<tool>`. */
    async function call(name, args, opts) {
      const out = await door.call(name, args, opts);
      return { status: out.status, isError: out.result.isError === true, text: out.text, structured: out.structured };
    }

    /**
     * Empty the space and store one valid record of every kind, directly (the write path is the subject, not the setup).
     * Returns the ids: two persons joined by a `knows` edge, an org, a claim and an event.
     */
    async function seed(space) {
      await door.wipe(space);
      const ids = { person1: randomUUID(), person2: randomUUID(), org: randomUUID(), fact: randomUUID(), chrono: randomUUID(), edge: randomUUID() };
      const base = (seq) => ({ spaceId: space, tags: [], seq, author: AUTHOR, createdAt: T0, updatedAt: T0 });
      await door.coll(space, 'entities').insertMany([
        { _id: ids.person1, name: 'Person One', type: 'person', properties: { age: 3 }, ...base(1) },
        { _id: ids.person2, name: 'Person Two', type: 'person', properties: { age: 4 }, ...base(2) },
        { _id: ids.org, name: 'Org One', type: 'org', properties: {}, ...base(3) },
      ]);
      await door.coll(space, 'facts').insertOne({ _id: ids.fact, fact: 'a seeded fact', type: 'claim', properties: { confidence: 1 }, ...base(4) });
      await door.coll(space, 'chrono').insertOne({ _id: ids.chrono, title: 'a seeded event', type: 'event', startsAt: T0, status: 'upcoming', properties: { priority: 'low' }, ...base(5) });
      await door.coll(space, 'edges').insertOne({ _id: ids.edge, from: ids.person1, to: ids.person2, label: 'knows', properties: { since: 1 }, ...base(6) });
      await bumpSeq(space, 6);
      return ids;
    }

    /** Every stored record of a kind in a space, whole, in `_id` order — so "nothing stored" is an identity check and not a count. */
    const stored = (space, kind) => door.coll(space, COLLECTION[kind]).find({}).sort({ _id: 1 }).toArray();

    return { door, rest, bulkRest, call, seed, stored, close: () => door.close() };
  } catch (err) {
    await door.close();
    throw err;
  }
}
