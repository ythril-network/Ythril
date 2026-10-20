/**
 * The doors Q-531's personal-view tests drive (bundle-100, plan rev 3.2), opened once: the real application over a loopback
 * socket, real tokens, and MCP over `POST /mcp` with a bearer, so the owner a view belongs to is the one the real auth resolves.
 *
 * ## The contract it encodes, written before the implementation
 *
 * - `POST /api/views {name, members}` creates the caller's own view and answers it (as `view`, or as the body); its id is
 *   `@<name>`. `GET /api/views` lists the caller's views (`views`, or the body). `DELETE /api/views/:id`, and
 *   `POST /api/views/:id/copy {toTokenId}` gives a token a copy.
 * - MCP twins: `view_create {name, members}`, `view_list`, `view_delete {view}`, `view_copy {view, toTokenId}`.
 * - A read answer carries `viewMembers` (top level, or in the tool door's `data`, or in MCP `structuredContent`).
 *
 * A reader of an answer takes either placement on purpose: the plan fixes WHAT is answered, not the envelope, and a test that
 * pinned an envelope the plan never chose would go red for the wrong reason after a correct implementation.
 */
import http from 'node:http';
import { openPushDoor } from './_push-door.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';

for (const k of ['SKIP_GLOBAL_RATE_LIMIT', 'SKIP_AUTH_RATE_LIMIT', 'SKIP_SYNC_RATE_LIMIT']) process.env[k] = 'true';
process.env['YTHRIL_RATE_LIMIT_PER_MINUTE'] ??= '1000000';

export const META = Object.freeze({ suppressEmbeddings: true });

/** Rungs in every area; `rungs({ knowledge: 'read' }, 'none')` for one area only. */
export function rungsOf(SPACE_AREAS, over = {}, rest = 'none') {
  return Object.fromEntries(SPACE_AREAS.map(a => [a, over[a] ?? rest]));
}

/**
 * Open the doors over `spaces` (ids; each a real space with embeddings suppressed).
 * @returns the door: `rest(key, method, url, body?)`, `mcp(key, tool, args)`, `mint(name, perSpace | opts)`, and the server modules.
 */
export async function openViewDoors({ suite, spaces }) {
  const door = await openPushDoor({ suite, spaces: spaces.map(id => ({ id, label: id, folders: [], meta: META })) });
  const loader = await import('../../server/dist/config/loader.js');
  const tokens = await import('../../server/dist/auth/tokens.js');
  const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
  const { col } = await import('../../server/dist/db/mongo.js');
  const { spaceCollection } = await import('../../server/dist/db/space-collection.js');
  const { createApp } = await import('../../server/dist/app.js');
  const server = await listenOnLoopback(http.createServer(createApp()));

  async function rest(key, method, url, body, headers = {}) {
    const init = { method, headers: { Authorization: `Bearer ${key}`, ...headers }, signal: AbortSignal.timeout(60_000) };
    if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    const r = await fetch(`${server.url}${url}`, init);
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    const error = typeof json?.error === 'string' ? json.error : '';
    return { status: r.status, body: json, text, error };
  }

  async function mcp(key, name, args) {
    const r = await fetch(`${server.url}/mcp`, {
      method: 'POST', signal: AbortSignal.timeout(60_000),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const raw = await r.text();
    const data = /^(?:event|data):/m.test(raw) ? raw.split('\n').find(l => l.startsWith('data:'))?.slice(5) ?? '{}' : raw;
    let rpc = {}; try { rpc = JSON.parse(data); } catch { /* not JSON */ }
    const text = (rpc.result?.content ?? []).map(c => c.text ?? '').join('\n') || rpc.error?.message || '';
    return { status: r.status, isError: rpc.result?.isError === true || !!rpc.error, text, structured: rpc.result?.structuredContent ?? null };
  }

  /** A token: `perSpace` maps a space to its rungs; `opts` passes through to createToken (expiresAt, peerInstanceId, admin). */
  async function mint(name, perSpace = {}, opts = {}) {
    const rights = opts.admin ? undefined : { instanceAdmin: false, createSpaces: false, floor: null, perSpace };
    const { record, plaintext } = await tokens.createToken({ name, ...(rights ? { rights } : {}), ...opts });
    return { key: plaintext, id: record.id, record };
  }

  /** The rights of a stored token, changed in place (the next request reads them). */
  const setRights = (tokenId, apply) => loader.mutateConfig(cfg => { apply(cfg.tokens.find(t => t.id === tokenId).rights); });

  return {
    door, loader, tokens, SPACE_AREAS, col, spaceCollection, server, rest, mcp, mint, setRights,
    row: (over, rest_ = 'none') => rungsOf(SPACE_AREAS, over, rest_),
    async close() { await server?.close(); await door?.close(); },
  };
}

/** The view an answer carries, whichever envelope. */
export const viewOf = (a) => a.body?.view ?? a.structured?.view ?? (a.body?.id ? a.body : null) ?? a.structured;
/** The views a listing carries. */
export const viewsOf = (a) => a.body?.views ?? a.structured?.views ?? (Array.isArray(a.body) ? a.body : []);
/** The rows a read answers: REST tool door `data.results`, MCP `structuredContent.results`, or a top-level `results`. */
export const rowsOf = (a) => a.body?.data?.results ?? a.body?.results ?? a.structured?.results ?? [];
/** The members a view read says it read. */
export const viewMembersOf = (a) => a.body?.viewMembers ?? a.body?.data?.viewMembers ?? a.structured?.viewMembers;
