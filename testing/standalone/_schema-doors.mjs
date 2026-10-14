/**
 * The doors a type schema is stored by, driven through production's own handlers — answered once.
 *
 * ## The question it answers
 *
 * *"This schema, by this door: was it refused, with what status and words, and is what the instance holds unchanged?"* The
 * inline doors (the space PATCH, `schema_update`, `PUT .../schema`, the single-type PUT) and the library doors (`POST`, `PUT`,
 * `PATCH` on `/api/schema-library`) each answer in their own shape, and a test that compares them has to normalise the same way
 * for every door or it compares its own adapters. So the adapters are here, and every one returns `{ refused, status, text }`.
 *
 * ## The guards a hand-written copy drops
 *
 * - **The route's own handler** (`handlerFor`): what runs is the handler production runs, past auth and the rate limit, never a copy
 *   of its rule.
 * - **A reset between rows.** {@link SchemaInstance.reset} puts the space meta and the library back, so a row cannot pass because an
 *   earlier row stored something and cannot fail because one did.
 * - **"Nothing stored" is read from the instance**, not inferred from the status: {@link SchemaInstance.heldTypes} and
 *   {@link SchemaInstance.heldEntries} read what the config and library hold after the call.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { removeInstanceDir, bootInstance, callRoute } from './_vote-round-instance.mjs';

const RIGHTS = { instanceAdmin: true, perSpace: {} };
const AUTH = { rights: RIGHTS };

/** Normalise a route answer. A refusal is any 4xx/5xx; `text` is everything the body says, for a reason to be matched in. */
const fromRoute = ({ code, body }) => ({ refused: code >= 400, status: code, text: JSON.stringify(body ?? null), body });

/** Normalise an MCP tool answer. The status is the `Error (NNN)` the tool prints, or 200. */
const fromTool = (r) => {
  const text = (r.content ?? []).map(c => c.text ?? '').join('\n');
  const m = /Error \((\d{3})\)/.exec(text);
  return { refused: r.isError === true, status: m ? Number(m[1]) : (r.isError ? 500 : 200), text, body: r.structuredContent };
};

/**
 * Boot an in-process instance with the given spaces and library, and return its doors.
 *
 * @param {string} dir  the temp instance directory, made by tempInstanceDir() BEFORE anything imports the server's loader
 * @param {{spaces?: object[], library?: object[], networks?: object[], instanceId?: string}} [opts]
 */
export async function bootSchemaInstance(dir, { spaces, library = [], networks = [], instanceId = 'aaaaaaaa-0000-4000-8000-000000005e1f' } = {}) {
  process.env['DATA_ROOT'] = path.join(dir, 'data');
  fs.mkdirSync(process.env['DATA_ROOT'], { recursive: true });
  fs.writeFileSync(path.join(dir, 'schema-library.json'), JSON.stringify(library, null, 2), { mode: 0o600 });
  const seed = JSON.parse(JSON.stringify(spaces ?? [{ id: 'general', label: 'General', builtIn: true, folders: [] }]));
  const loader = await bootInstance(dir, { instanceId, spaces: seed, networks });
  const { spacesRouter } = await import('../../server/dist/api/spaces.js');
  const { schemaLibraryRouter } = await import('../../server/dist/api/schema-library.js');
  const spacesTools = await import('../../server/dist/mcp/tools/spaces.js');
  const librarySeed = JSON.parse(JSON.stringify(library));
  const metaSeed = new Map(seed.map(s => [s.id, JSON.parse(JSON.stringify(s.meta ?? {}))]));

  const mcpCtx = (spaceId, args) => ({
    callSpace: spaceId, callSpaces: [spaceId], accessibleSpaceIds: [spaceId], args: { space: spaceId, ...args }, rights: RIGHTS,
  });

  /** @type {SchemaInstance} */
  const instance = {
    dir, loader,
    doors: {
      'space-patch': (spaceId, meta) => callRoute(spacesRouter, 'patch', '/:id', { params: { id: spaceId }, body: { meta }, authToken: AUTH }).then(fromRoute),
      'mcp-schema-update': async (spaceId, meta) => fromTool(await spacesTools.schema_updateTool.handle(mcpCtx(spaceId, meta))),
      'put-schema': (spaceId, meta) => callRoute(spacesRouter, 'put', '/:id/schema', { params: { id: spaceId }, body: { typeSchemas: meta.typeSchemas }, authToken: AUTH }).then(fromRoute),
      'put-single-type': (spaceId, meta) => {
        const [kind, types] = Object.entries(meta.typeSchemas)[0];
        const [type, schema] = Object.entries(types)[0];
        return callRoute(spacesRouter, 'put', '/:id/meta/typeSchemas/:knowledgeType/:typeName',
          { params: { id: spaceId, knowledgeType: kind, typeName: type }, body: schema, authToken: AUTH }).then(fromRoute);
      },
    },
    library: {
      post: (body) => callRoute(schemaLibraryRouter, 'post', '/', { body, authToken: AUTH }).then(fromRoute),
      put: (name, body) => callRoute(schemaLibraryRouter, 'put', '/:name', { params: { name }, body, authToken: AUTH }).then(fromRoute),
      patch: (name, body) => callRoute(schemaLibraryRouter, 'patch', '/:name', { params: { name }, body, authToken: AUTH }).then(fromRoute),
      exportSpace: (body) => callRoute(schemaLibraryRouter, 'post', '/export-space', { body, authToken: AUTH }).then(fromRoute),
    },
    heldTypes: (spaceId) => structuredClone(loader.getConfig().spaces.find(s => s.id === spaceId)?.meta?.typeSchemas ?? {}),
    heldMeta: (spaceId) => structuredClone(loader.getConfig().spaces.find(s => s.id === spaceId)?.meta ?? {}),
    heldEntries: () => structuredClone(loader.getSchemaLibrary()),
    heldEntry: (name) => structuredClone(loader.getSchemaLibrary().find(e => e.name === name)),
    reset() {
      for (const s of loader.getConfig().spaces) {
        s.meta = structuredClone(metaSeed.get(s.id) ?? {});
        delete s.ownMeta;
      }
      loader.saveSchemaLibrary(structuredClone(librarySeed));
    },
    close() { removeInstanceDir(dir); },
  };
  assert.ok(instance.heldEntries().length === library.length, 'the library seed did not load — the harness cannot tell "refused" from "never reached"');
  return instance;
}

/** Every inline door's name, in the order the table reports them. */
export const INLINE_DOORS = Object.freeze(['space-patch', 'mcp-schema-update', 'put-schema', 'put-single-type']);

/**
 * @typedef {object} SchemaInstance
 * @property {string} dir
 * @property {any} loader
 * @property {Record<string, (spaceId: string, meta: any) => Promise<{refused: boolean, status: number, text: string, body: any}>>} doors
 * @property {{post: Function, put: Function, patch: Function, exportSpace: Function}} library
 * @property {(spaceId: string) => any} heldTypes
 * @property {(spaceId: string) => any} heldMeta
 * @property {() => any[]} heldEntries
 * @property {(name: string) => any} heldEntry
 * @property {() => void} reset
 * @property {() => void} close
 */
