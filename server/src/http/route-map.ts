/**
 * Which registered route is this request — the question, answered once (Q-605, Q-700).
 *
 * ## The question
 *
 * "What is the FULL, REGISTERED pattern of the route that answered this request?" — `/api/brain/spaces/:spaceId/stats`, never the path
 * the caller typed (`/Api/Brain/Spaces/x/Stats`), never a router-relative `/stats`. Three callers asked it three ways, and each way
 * spelled the answer from the REQUEST:
 *
 * - the metrics label joined `req.baseUrl` and `req.route.path`, or fell back to a rewrite of the raw path, so a scanner's invented
 *   paths minted label values of their own and a router-relative `/` was several routes;
 * - the area guard rebuilt its inventory key from `req.baseUrl + req.route.path`. Express matches a mount's literal segments without
 *   regard to case and `req.baseUrl` echoes what the caller TYPED, so `/Api/Brain/...` found no row in `ROUTE_RIGHTS` and the route
 *   was taken for "unclassified", which falls through to the reach check alone. A token that reached a space but held no rung on an
 *   area read that area by changing the case of `api` (Q-700);
 * - the error handler named its failures `${req.method} ${req.baseUrl}${req.path}` — request text in a log line and in the audit
 *   record, with `baseUrl` empty by the time an error reaches it.
 *
 * ## How it is answered
 *
 * The map is keyed by the Route OBJECT, built once at boot by a RECURSIVE walk over the mounted routers (`indexRoutes(app)`, called as
 * `createApp` ends). A route's pattern is the join of the mount strings above it and its own path, so the answer is the registered
 * spelling whatever the request's casing, and it is the same when an error handler answers (the route is the one `req.route` still
 * names there). The mount strings are read from the router's own `use()` calls: a layer does not keep the string it was mounted with
 * (path-to-regexp compiles it away), so this module records it as the layer is created.
 *
 * The label set is FIXED by construction: a registered pattern, the one bucket `unmatched`, or — for a refusal a guard answered before
 * any route matched (a router-level `requireAuth`, a rate limit, the flood backstop, maintenance) — the label of the mount the request
 * path sits under, taken from the literal mount strings and matched case-insensitively. Nothing the caller sends can add a value.
 *
 * ## What it prevents
 *
 * A guard keyed by the caller's spelling of a path; a metrics series count chosen by whoever is sending requests; a route that is
 * silently unclassified because one of its mounts was nested.
 */
import express from 'express';
import type { Application, Request } from 'express';

/** The label of a request no mount or route claims. */
export const UNMATCHED = 'unmatched';

interface RouteLike { path?: unknown }
interface LayerLike { route?: RouteLike; handle?: { stack?: LayerLike[] } }
interface RouterLike { stack: LayerLike[]; use(...args: unknown[]): unknown }

/** The string each mount layer was registered with (`use('/api/tokens', r)` -> `/api/tokens`; `use(r)` -> `/`). */
const MOUNT_OF = new WeakMap<object, string>();
/** Route object -> its full registered pattern. Route objects are module singletons, so apps built one after another agree. */
const PATTERN_OF = new WeakMap<object, string>();
/** The literal full mounts (lowercase) the walk found, longest first once sorted: the labels of a refusal before any route matched. */
const MOUNT_LABELS = new Set<string>();
let mountLabelsByLength: string[] = [];
/** Every full pattern the walk found, for a test that holds the map to the routes the source mounts (`routePatterns`). */
const PATTERNS = new Set<string>();

const RECORDED = Symbol.for('ythril.route-map.use-recorded');

/**
 * Wrap `Router.prototype.use` once so each layer it creates remembers its mount string. The prototype is found by walking up from an
 * instance to the object that owns `use` (the router function inherits from an instance, which inherits from the prototype), and
 * a shape that is not what this expects throws at load: a map that silently recorded nothing would label every route `unmatched`.
 */
function recordMounts(): void {
  let proto: object | null = Object.getPrototypeOf(express.Router());
  while (proto && !Object.prototype.hasOwnProperty.call(proto, 'use')) proto = Object.getPrototypeOf(proto);
  if (!proto) throw new Error('route-map: express.Router() has no prototype that owns use(); the router implementation changed');
  const target = proto as { use: (...args: unknown[]) => unknown; [RECORDED]?: true };
  if (target[RECORDED]) return;
  const original = target.use;
  target.use = function use(this: RouterLike, ...args: unknown[]): unknown {
    const before = this.stack.length;
    const result = original.apply(this, args);
    const first = Array.isArray(args[0]) ? args[0].flat(Infinity)[0] : args[0];
    // `use(handler)` mounts at `/`; `use('/p', handler)` at `p`; a path given as an array or a pattern has no single string to keep.
    const mount = typeof first === 'string' && !Array.isArray(args[0]) ? first : typeof first === 'function' ? '/' : undefined;
    if (mount !== undefined) for (const layer of this.stack.slice(before)) MOUNT_OF.set(layer, mount);
    return result;
  };
  target[RECORDED] = true;
}
recordMounts();

/** A pattern as the inventory spells it: no trailing slash, `/` for the root. */
function normalise(p: string): string {
  return p.replace(/\/+$/, '') || '/';
}

function walk(stack: readonly LayerLike[], prefix: string, onPath: readonly object[]): void {
  for (const layer of stack) {
    if (layer.route) {
      const own = layer.route.path;
      // A route declared with an array or a pattern object has no single spelling; it falls to the fallbacks rather than to a made-up one.
      if (typeof own === 'string' && !PATTERN_OF.has(layer.route)) PATTERN_OF.set(layer.route, normalise(prefix + own));
      if (typeof own === 'string') PATTERNS.add(normalise(prefix + own));
      continue;
    }
    const child = layer.handle?.stack;
    if (!Array.isArray(child) || onPath.includes(layer.handle as object)) continue;
    const mount = MOUNT_OF.get(layer);
    // A router mounted before this module loaded, or by a router implementation it did not wrap, has no known prefix: its routes stay
    // unlabelled (`unmatched` for the metric, the lowercased request spelling for a guard) rather than labelled with a guess.
    if (mount === undefined) continue;
    const full = prefix + (mount === '/' ? '' : mount.replace(/\/+$/, ''));
    if (full && !/[:*(){}[\]?]/.test(full)) MOUNT_LABELS.add(full.toLowerCase());
    walk(child, full, [...onPath, layer.handle as object]);
  }
}

/**
 * Index every route the application serves. Called once as `createApp` ends, after every mount; calling it again for another app only
 * adds what that app has (a Route already indexed keeps its pattern).
 */
export function indexRoutes(app: Application): void {
  walk((app.router as unknown as RouterLike).stack, '', []);
  mountLabelsByLength = [...MOUNT_LABELS].sort((a, b) => b.length - a.length);
}

/** The full pattern of every route the walk indexed, and the literal mounts it found: what a test holds against the routes the source mounts. */
export function routeMapContents(): { patterns: string[]; mounts: string[] } {
  return { patterns: [...PATTERNS], mounts: [...MOUNT_LABELS] };
}

/** The path part of the request URL as the caller sent it (the mounted routers strip `req.url`, so this reads `originalUrl`). */
function requestedPath(req: Request): string {
  const url = req.originalUrl || req.url || '';
  const q = url.search(/[?#]/);
  return (q < 0 ? url : url.slice(0, q)).toLowerCase();
}

/** The label of the mount a request path sits under (longest literal mount, whole segments, either casing), or `unmatched`. */
function mountLabelOf(req: Request): string {
  const p = requestedPath(req);
  for (const mount of mountLabelsByLength) if (p === mount || p.startsWith(`${mount}/`)) return mount;
  return UNMATCHED;
}

/**
 * The `route` label of a finished request — a member of a fixed set.
 *
 * `statusCode` is read for one distinction. A request no route matched that was ANSWERED (401, 403, 429, 503: a router-level guard, the
 * flood backstop, maintenance) is labelled with the mount it sat under, so a dashboard sees which door refused. One answered `404` is
 * the miss itself — a path nothing serves — and is `unmatched`, however deep under a mount it is.
 */
export function routeLabel(req: Request, statusCode?: number): string {
  const route = req.route as RouteLike | undefined;
  if (route) return PATTERN_OF.get(route) ?? UNMATCHED;
  if (statusCode === undefined || statusCode === 404) return UNMATCHED;
  return mountLabelOf(req);
}

/**
 * The full registered path of the route that is answering this request, for the guards that look it up in an inventory
 * (`ROUTE_RIGHTS`, `NOT_AREA_SCOPED`). The registered spelling when the route was indexed; otherwise (a router a test mounted on an
 * app of its own) the mount as the request carried it, LOWERCASED, plus the route's own path, which keeps the lookup case-blind where
 * it cannot be exact.
 */
export function registeredPathOf(req: Request): string {
  const route = req.route as RouteLike | undefined;
  const mapped = route ? PATTERN_OF.get(route) : undefined;
  if (mapped !== undefined) return mapped;
  return `${(req.baseUrl ?? '').toLowerCase()}${typeof route?.path === 'string' ? route.path : ''}`;
}
