/**
 * What rung a request needs, from the route inventory.
 *
 * ## Why a lookup and not a decorator on each route
 *
 * The inventory in `space-rights.ts` is the single list a gate can check against the real route surface.
 * Scattering the requirement across the handlers would put it back where the gate cannot see it, and the
 * gate is the only reason an unclassified route fails the build rather than quietly ungoverned.
 *
 * ## THREE answers, not two, and conflating two of them was a real defect
 *
 * A route can be in one of three states, and the previous shape of this function could express only two:
 *
 *  - **`requires`** — classified in `ROUTE_RIGHTS`. Enforce it.
 *  - **`not-area-scoped`** — on the `NOT_AREA_SCOPED` list, with a written reason. Somebody DECIDED this
 *    route is not a view of the space's data. There is nothing to enforce and nothing to report.
 *  - **`unclassified`** — nobody decided. That is the state this whole feature exists to make impossible.
 *
 * Returning `null` for the last two made them one event. `enforceAreaRung` then logged every request to a
 * deliberately-exempt route as an oversight, advising the operator to add it to `ROUTE_RIGHTS` — advice that
 * would have undone the recorded decision. Worse, the message's own plan (*"misses become refusals once the
 * log is clean"*) could never fire, because four routes were guaranteed to keep warning forever. Reported
 * from a live pod's stdout by the canary operator, 2026-08-20; see the long note on `NOT_AREA_SCOPED`.
 *
 * ## Matching, and the one thing that must never happen
 *
 * Express gives the registered pattern (`/spaces/:spaceId/entities/:id`), not the concrete URL, so matching
 * is on the pattern and is exact. **`unclassified` must be treated by the caller as REFUSE, never as allow.**
 * That is the whole safety property: an unclassified route is one nobody decided about, and defaulting it to
 * permissive reproduces the situation this feature exists to end — access that works because nothing said
 * otherwise. `not-area-scoped` is the opposite: an explicit allow, and safe precisely because it is written
 * down with a reason a reader can disagree with.
 *
 * The build-time gate makes `unclassified` unreachable in practice. This function assumes it will happen
 * anyway, because "unreachable in practice" is how the last three silent failures in this codebase described
 * themselves.
 *
 * ## Method on one list, path on the other
 *
 * `ROUTE_RIGHTS` keys on method + path: `GET` and `DELETE` on one path need different rungs. `NOT_AREA_SCOPED`
 * keys on path alone, because an exemption is a claim about what the route IS rather than about one verb of
 * it. That asymmetry is deliberate and matches what the gate has always done; `every-space-route-has-an-area`
 * asserts the two readers agree instead of assuming it.
 */
import type { ScopeShape } from './space-rights.js';
import { ROUTE_RIGHTS, NOT_AREA_SCOPED_PATHS, type SpaceArea } from './space-rights.js';
import type { Rung } from '../config/rights-shape.js';

export interface RungRequirement {
  area: SpaceArea;
  needs: Rung;
  /** The SAME vocabulary as `ROUTE_RIGHTS`, referenced rather than respelled — two copies of one list is
   *  how a third scope becomes valid in one file and a type error in the other. */
  scope: ScopeShape;
}

/** The three states a route can be in. Discriminated so a caller cannot read one as another. */
export type RungVerdict =
  | ({ kind: 'requires' } & RungRequirement)
  | { kind: 'not-area-scoped' }
  | { kind: 'unclassified' };

/** Normalise a mount + route pair into the key the inventory stores. */
function key(method: string, routePath: string): string {
  return `${method.toUpperCase()} ${routePath.replace(/\/+$/, '') || '/'}`;
}

/** Trailing slashes normalised the same way, so the two lists cannot disagree on `/x` versus `/x/`. */
function path(routePath: string): string {
  return routePath.replace(/\/+$/, '') || '/';
}

const BY_KEY: ReadonlyMap<string, RungRequirement> = new Map(
  ROUTE_RIGHTS.map(r => [key(r.method, r.route), { area: r.area, needs: r.needs, scope: r.scope }]),
);

/**
 * Which of the three states this route is in.
 *
 * `ROUTE_RIGHTS` is consulted FIRST. If a path ever appears on both lists the classification wins, which is
 * the safe direction — but a gate refuses that overlap outright, because a route that is both governed and
 * exempt is a contradiction somebody needs to resolve rather than a precedence rule to rely on.
 */
export function rungFor(method: string, fullPath: string): RungVerdict {
  const found = BY_KEY.get(key(method, fullPath));
  if (found) return { kind: 'requires', ...found };
  if (NOT_AREA_SCOPED_PATHS.has(path(fullPath))) return { kind: 'not-area-scoped' };
  return { kind: 'unclassified' };
}

/** Does a held rung satisfy a required one? Rungs contain the ones below them. */
export function satisfies(held: Rung, needs: Rung): boolean {
  const order: Rung[] = ['none', 'read', 'write', 'admin'];
  return order.indexOf(held) >= order.indexOf(needs);
}
