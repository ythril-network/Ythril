/**
 * "The other edges at (from, label)" — the ONE definition of what a functional label counts, and the key the write guard
 * collides on (`Q-439`).
 *
 * ## What it prevents
 *
 * A functional label allows a subject at most one edge. Three places counted that, three ways: the planner's read set (a
 * NUL-joined key over distinct `to`), the stored-edge dry run (a length-prefixed key over every row) and the merge's
 * relink warning (a key with no length on the label, over distinct `to`). They agreed while one id lived in one kind and
 * disagreed on a second edge to the same `to` in another kind — and the planner and the store must agree on "another
 * edge", or the loser of a race is refused by the store, re-planned, allowed by a planner that counts zero and refused
 * again: a 409 for a write the rule says is a plain violation.
 *
 * ## The two answers
 *
 * - `functionalSubjectKey(from, label)` — the subject's key. Length-prefixed (`idPart`), so no pair of distinct inputs can
 *   share one, and free of a NUL (which makes git treat a source file as binary). It is the value `_functionalGuard` holds.
 * - `SubjectEdges` / `otherEdgesAtSubject` — how many of the edges held at an edge's subject differ from it IN IDENTITY
 *   (`to`, `fromKind`, `toKind`; an end stated `entity` and one left unstated are one identity, as `edgeIdFor` has them).
 *   The edge itself, however many times it is held, is not its own duplicate.
 *
 * ## The forgettable part, kept inside
 *
 * **A non-string input throws.** A key built from `undefined` is the string `"undefined"`, and every edge of a missing
 * subject would count as one subject — the silent answer this refuses to give.
 *
 * Callers that count over many subjects (`ReadSet`, the stored-edge dry run, the merge) hold one `SubjectEdges`; a caller
 * asking once uses `otherEdgesAtSubject`. Neither builds a key or compares a `to` by hand.
 */
import { idPart } from '../util/derived-id.js';
import { edgeIdFor } from './edge-id.js';
import { FUNCTIONAL_GUARD } from '../sync/local-only-fields.js';

/** An edge as this question reads it: the subject and the identity. The kinds are absent for an entity end. */
export interface SubjectEdge { from: string; label: string; to: string; fromKind?: string | undefined; toKind?: string | undefined }

function assertStrings(what: string, ...parts: unknown[]): void {
  for (const p of parts) {
    if (typeof p !== 'string') throw new TypeError(`${what}: expected a string, got ${p === null ? 'null' : typeof p}`);
  }
}

/** The key of the subject `(from, label)`: injective, so two subjects never share it. */
export function functionalSubjectKey(from: string, label: string): string {
  assertStrings('functionalSubjectKey', from, label);
  return `${idPart(from)}${idPart(label)}`;
}

/** What {@link guardNamesItsEdge} reads of a stored edge: its subject and its marker, each as stored (so possibly not strings). */
export interface GuardedEdge { from?: unknown; label?: unknown; [FUNCTIONAL_GUARD]?: unknown }

/**
 * Does the write guard an edge holds name the `(from, label)` it sits under? THE one answer to "is this marker a phantom".
 *
 * A marker is a pure function of its edge (`functionalSubjectKey(from, label)`); a marker that is not that function of the edge
 * carrying it holds a subject's unique slot for an edge that is not there. The heal (`heal-stale-marker.ts`), the index build's
 * thinning (`edge-guard-index.ts`) and the stored-edge dry run (`validate-stored-edges.ts`) each asked it, each spelling the
 * comparison — and each had to remember that a stored edge's `from` or `label` need not be a string, which makes the key's
 * own throw the wrong answer on a failure path. Here a marker or a subject that is not a string names nothing: `false`, never
 * a throw. An edge with NO marker is not asked about here — the callers decide what that means for them.
 */
export function guardNamesItsEdge(edge: GuardedEdge): boolean {
  const guard = edge[FUNCTIONAL_GUARD];
  return typeof guard === 'string' && typeof edge.from === 'string' && typeof edge.label === 'string'
    && functionalSubjectKey(edge.from, edge.label) === guard;
}

/** The identity of an edge among the edges at ONE subject — the same identity the store's unique index holds. */
function identityOf(e: SubjectEdge): string {
  assertStrings('an edge at a functional subject', e.from, e.label, e.to);
  return edgeIdFor(e.from, e.to, e.label, e.fromKind, e.toKind);
}

/** The edges held, grouped by subject and counted once each by identity. */
export class SubjectEdges {
  private readonly bySubject = new Map<string, Map<string, SubjectEdge>>();

  constructor(edges: Iterable<SubjectEdge> = []) {
    for (const e of edges) this.add(e);
  }

  /** Hold an edge. The same identity held twice (stored, then planned) is held once. */
  add(e: SubjectEdge): void {
    const key = functionalSubjectKey(e.from, e.label);
    let held = this.bySubject.get(key);
    if (!held) { held = new Map(); this.bySubject.set(key, held); }
    held.set(identityOf(e), e);
  }

  /**
   * How many of the edges held at `edge`'s subject differ from it in identity; `alsoHeld` are counted as held too,
   * without being kept (an edge of the same write that already passed).
   */
  others(edge: SubjectEdge, alsoHeld: Iterable<SubjectEdge> = []): number {
    const own = identityOf(edge);
    const key = functionalSubjectKey(edge.from, edge.label);
    const identities = new Set(this.bySubject.get(key)?.keys());
    for (const e of alsoHeld) {
      if (functionalSubjectKey(e.from, e.label) === key) identities.add(identityOf(e));
    }
    identities.delete(own);
    return identities.size;
  }
}

/** How many of `stored` — any edges, at any subject — are at `edge`'s subject and are not `edge`. */
export function otherEdgesAtSubject(stored: Iterable<SubjectEdge>, edge: SubjectEdge): number {
  return new SubjectEdges(stored).others(edge);
}
