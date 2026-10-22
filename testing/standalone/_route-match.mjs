/**
 * Does a path a caller writes resolve to a route this server mounts — the question, answered once.
 *
 * ## Why a module
 *
 * The matcher lived inside `every-path-the-client-calls-resolves.test.js`. A second gate asked the same question
 * about a path in a source COMMENT (`every-route-a-rights-comment-names-is-mounted`), and a third
 * (`route-path-docs-coverage`) derives its own route list. A matcher written per gate is a rule written twice,
 * and the weaker copy wins silently: the first one let every two-segment `/api/<x>` resolve, because
 * `POST /api/:tool` is a mounted route and its parameter matches any one segment.
 *
 * ## What it decides
 *
 * **Matching is by SHAPE.** A route declares `/api/files/:spaceId`; a client writes `` `/api/files/${spaceId}` `` and
 * a comment writes `/api/files/work`. A parameter on either side is a hole matching one segment, and the segment
 * count still has to agree. The query string is not part of the route.
 *
 * **The generic tool door is the exception, and it is narrowed rather than dropped.** `POST /api/:tool` serves
 * only what is in the tool registry, so `POST /api/<x>` resolves through it ONLY when `<x>` is a registry tool
 * (or a hole, which is a name the caller fills in). Without that, a mistyped tool name resolves and the gate
 * cannot tell a real tool from a typo. A call that names no verb still resolves by its path against every other
 * route; against the tool door it is held to the same rule, because the door is the one route whose parameter
 * is NOT free.
 *
 * ## The floor
 *
 * `mountedRoutes` throws below its own floor and the registry is asserted to be real, so a scan that stopped
 * matching cannot make every call resolve or none.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from './_sources.mjs';
import { mountedRoutes } from './_routes.mjs';
import { THE_TOOL_DOOR } from './_capability-map.mjs';

const { ALL_TOOLS } = await import(pathToFileURL(join(REPO_ROOT, 'server/dist/mcp/tools/index.js')).href);
export const TOOL_NAMES = new Set(ALL_TOOLS.map(t => t.name));
if (TOOL_NAMES.size < 30) {
  throw new Error('the tool registry read too few tools; the tool door would reject a real tool name or accept every one');
}

/** A parameter, on either side, is a hole that matches exactly one segment. */
export const HOLE = '\u0001';

/** A path reduced to comparable segments: the query string off, parameters and template holes as one hole. */
export const shape = p => p
  // The QUERY STRING is not part of the route. `GET /api/spaces/${id}/meta?resolve=1` is the meta route
  // with an argument on it, and six such calls read as unmatched until this line existed.
  .split('?')[0]
  .replace(/\$\{[^}]*\}/g, HOLE)
  .replace(/:[A-Za-z0-9_]+/g, HOLE)
  .replace(/\/+$/, '');

const [DOOR_METHOD, DOOR_PATH] = THE_TOOL_DOOR.split(' ');
const DOOR_SEGMENTS = shape(DOOR_PATH).split('/');

/** Every mounted route as `{ method, segs, door }`; `door` marks the generic tool route. */
export const ROUTES = mountedRoutes().map(r => {
  const segs = shape(r.path).split('/');
  return {
    method: r.method,
    segs,
    door: r.method === DOOR_METHOD && segs.length === DOOR_SEGMENTS.length && segs.every((s, i) => s === DOOR_SEGMENTS[i]),
  };
});

if (!ROUTES.some(r => r.door)) {
  throw new Error(`the generic tool route ${THE_TOOL_DOOR} was not found among the mounted routes; the narrowing below would apply to nothing`);
}

/**
 * Does `route` serve the last `segs.length` segments given? With `anchored` the count has to be the route's
 * own; without it `segs` is a TAIL and the route may have more in front.
 *
 * The door's parameter is the route's last segment, wherever the tail starts: it must be a registry tool, or a
 * hole the caller fills in.
 *
 * **A route parameter accepts a literal only when the whole path is given.** `/api/files/work` is a caller filling
 * `:spaceId` in. A TAIL such as `/facts` is a name written in a comment, and letting it match `/facts/:id`'s
 * parameter is how a route that was deleted (`DELETE /facts`, the collection wipe) kept resolving against the
 * route beside it.
 */
function serves(route, method, segs, anchored) {
  if (method !== undefined && route.method !== method) return false;
  if (anchored ? route.segs.length !== segs.length : route.segs.length < segs.length) return false;
  const tail = route.segs.slice(route.segs.length - segs.length);
  return tail.every((s, i) => {
    const given = segs[i];
    if (route.door && i === tail.length - 1) return given === HOLE || TOOL_NAMES.has(given);
    if (s === HOLE) return anchored || given === HOLE;
    return given === HOLE || given === s;
  });
}

/**
 * Does `path` resolve to a mounted route? `method` narrows it when the caller gave one; without it, any verb
 * will do — except that the tool door only ever answers a name the registry has.
 */
export function resolves(path, method) {
  const segs = shape(path).split('/');
  return ROUTES.some(r => serves(r, method, segs, true));
}

/**
 * Does a RELATIVE path — `/facts/:id`, or `.../validate-schema` — name the end of a mounted route?
 *
 * A comment that says `DELETE /facts/:id` is naming a route under whatever base the sentence was about, and the
 * comment does not say which. So the question it can be held to is the weaker one this answers: some mounted
 * route, under the given verb, ends in these segments. The weakness is real (a common tail matches an unrelated
 * route) and it is the right size for a comment; a call site, which writes the whole path, uses `resolves`.
 */
export function resolvesBySuffix(tail, method) {
  const segs = shape(tail.replace(/^\.\.\./, '')).split('/').filter(Boolean);
  if (segs.length === 0) return false;
  return ROUTES.some(r => serves(r, method, segs, false));
}
