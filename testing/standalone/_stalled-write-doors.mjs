/**
 * The doors a caller writes through, each with the way to STALL it and the way to CALL it — the table two -db tests
 * walk: `a-write-timeout-answers-503-on-every-door-db` (what a stalled write is answered) and
 * `a-write-the-bound-ended-never-lands-db` (what a stalled write does AFTER it was answered).
 *
 * ## Why a module
 *
 * The second test is a rule over every door the first one asks about. A table kept in the first file's body cannot be
 * imported (a test file runs its tests when it is loaded), so the second would either copy it — and the copy that
 * drifts is the door the rule silently stopped covering — or read the first's source for names. One table, here, that
 * both walk.
 *
 * ## The doors, and why the push half is the FACT routes
 *
 * The write bound covers every operation issued while a seq hold is active. On the push door the one write inside a
 * hold is a FORK (`acceptArrivingPage` allocates a block for it), and only facts fork — so the push routes that can
 * time out are the single `/facts` route and `/batch-upsert` carrying facts; both are listed. The REST door is
 * `PATCH /api/brain/spaces/:spaceId/facts/:id` through the whole app (its errors reach the app's error handler, so
 * calling the route's handler alone would test a door no request reaches); the MCP door is `update_fact` through
 * `callTool`, the dispatch every MCP request goes through.
 *
 * ## What the table does not do
 *
 * It does not decide how many doors there are: a caller derives its cases from `stalledWriteDoors(...)`, and floors
 * the count. It holds no lock of its own across calls — `lock()` hands back `holdDocumentLock`'s handle, and the
 * caller releases it.
 */
import { openPushDoor, build } from './_push-door.mjs';
import { holdDocumentLock } from './_write-faults.mjs';

/** The fact every door writes to or forks from, and the peer's divergent text that makes a push FORK it. */
export const DOOR_FACT_ID = 'bbbbbbbb-0000-4000-8000-0000000000f3';
export const DIVERGENT = 'the same fact, as the peer tells it';

/**
 * Open a push door with `spaces` registered, plus the app (REST) and the MCP dispatch on it — everything the doors
 * need. `env` is what `stalledWriteDoors` reads, filled here and read lazily by each door's closures.
 *
 * @param {object} o
 * @param {string} o.suite  harness database slug (unique per file: `a-db-harness-name-is-unique`)
 * @param {string[]} o.spaces  space ids to register
 * @param {number} [o.mongoPort]  connect through a relay on this port instead of the stack's
 * @returns {Promise<{ env: object, close: () => Promise<void> }>}
 */
export async function openStalledWriteDoors({ suite, spaces, mongoPort }) {
  // A merge embeds its survivor inline unless the space suppresses it; never let a test fetch a model.
  process.env['YTHRIL_MODELS_OFFLINE'] = '1';
  const door = await openPushDoor({
    mongoPort,
    // `completeLinkage`: a space's links are converted, as every space's are after its first boot — a holder case that cascades
    // an entity reads its references through the link records, which refuse a space that was never converted.
    suite, spaces: spaces.map(id => ({ id, label: id, folders: [], completeLinkage: true, meta: { suppressEmbeddings: true } })),
  });
  let server;
  try {
    const plan = await import('../../server/dist/sync/upsert-plan.js');
    const { callTool } = await import('../../server/dist/mcp/call-tool.js');
    const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
    const ADMIN = { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: Object.fromEntries(SPACE_AREAS.map(a => [a, 'admin'])) };
    const tokens = await import('../../server/dist/auth/tokens.js');
    const adminKey = (await tokens.createToken({ name: 'admin', admin: true })).plaintext;
    const { createApp } = await import('../../server/dist/app.js');
    server = createApp().listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    return {
      env: { door, plan, callTool, ADMIN, adminKey, base },
      async close() {
        await new Promise(r => server.close(r));
        await door.close();
      },
    };
  } catch (err) {
    await new Promise(r => (server ? server.close(r) : r()));
    await door.close();
    throw err;
  }
}

/** What one door's fixture holds before a case: the fact it updates or forks, and the counter at its seq. */
export async function seedDoorSpace(door, space) {
  await door.wipe(space);
  await door.coll(space, 'facts').insertOne(build.fact(space, DOOR_FACT_ID, 3));
  await door.setCounter(space, 3);
}

/**
 * Every door, for `space`: `{ name, collection, lock(), call() }` — `collection` is the one `lock()` holds, `call()` answers
 * `{ status, body, text }`. The doors read `env` when they run, so the table can be built before `openStalledWriteDoors` has
 * been awaited.
 */
export function stalledWriteDoors(env, space) {
  const F = DOOR_FACT_ID;
  const forkLock = () => holdDocumentLock(env.door.mongo, `${space}_facts`,
    { insert: { _id: env.plan.forkIdFor(F, 3, DIVERGENT), spaceId: space, fact: 'lock', seq: 0 } });
  const factLock = () => holdDocumentLock(env.door.mongo, `${space}_facts`, { filter: { _id: F } });
  return [
    {
      name: 'sync push POST /facts (a fork)',
      collection: `${space}_facts`,
      lock: forkLock,
      call: async () => {
        const r = await env.door.push('/facts', build.fact(space, F, 3, { fact: DIVERGENT }), { spaceId: space });
        return { status: r.code, body: r.body, text: JSON.stringify(r.body) };
      },
    },
    {
      name: 'sync push POST /batch-upsert (a fork)',
      collection: `${space}_facts`,
      lock: forkLock,
      call: async () => {
        const r = await env.door.push('/batch-upsert', { facts: [build.fact(space, F, 3, { fact: DIVERGENT })] }, { spaceId: space });
        return { status: r.code, body: r.body, text: JSON.stringify(r.body) };
      },
    },
    {
      name: 'REST PATCH /api/brain/spaces/:spaceId/facts/:id',
      collection: `${space}_facts`,
      lock: factLock,
      call: async () => {
        const r = await fetch(`${env.base}/api/brain/spaces/${space}/facts/${F}`, {
          method: 'PATCH', headers: { Authorization: `Bearer ${env.adminKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fact: 'an edit the store cannot take in time' }),
        });
        const text = await r.text();
        let body; try { body = JSON.parse(text); } catch { body = text; }
        return { status: r.status, body, text };
      },
    },
    {
      name: 'MCP update_fact (callTool)',
      collection: `${space}_facts`,
      lock: factLock,
      call: async () => {
        const out = await env.callTool({
          name: 'update_fact', args: { space, id: F, fact: 'an edit the store cannot take in time' },
          caller: { rights: env.ADMIN, ip: '127.0.0.1', authMethod: 'pat', oidcSubject: null, transport: 'mcp', tokenId: 't', tokenLabel: 't' },
        });
        const text = (out.result.content ?? []).map(c => c.text ?? '').join('\n');
        return { status: out.status, body: out.result.structuredContent ?? {}, text };
      },
    },
  ];
}
