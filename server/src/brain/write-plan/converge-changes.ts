/**
 * What a converge would change on a stored record, computed from its plan without writing (bundle-270, slice S4; amendment A4).
 *
 * ## What it prevents
 *
 * A converge does not only add. An entity's sets `name` and `type` whatever the stored ones were, and a fact's and a chrono entry's rewrite
 * their whole link set from the write's `link*` fields, so a write that states less than the record holds takes the rest away. A caller that
 * must take nothing away (an import: RDF states what is, and absence is not a statement) fills every field it does not state from the stored
 * record and passes the union of the stored and its own links; this function is how it, and its test, see what a plan would still change or
 * remove before anything is written.
 *
 * ## What it compares
 *
 * The fields a write can state, per kind ({@link STATED_FIELDS}); server-owned fields (`updatedAt`, the vector and its text, the schema stamp,
 * retention, `seq`) are the write's own and not a change of what the record says. A field is CHANGED when its stored value and the value the
 * converge leaves differ, and REMOVED when the stored record has it and the converge leaves none; a tag the converge no longer carries is
 * removed as `tags:<tag>`, a property key as `properties.<key>`. Link rows are compared when the caller hands the stored ones
 * (`ReadSet.storedLinks`): a stored link the plan's desired set leaves out of a class it names is taken away.
 */
import type { KnowledgeType, RefKind } from '../../config/types-knowledge.js';
import { canonicalJson } from '../../util/canonical-json.js';

/** The record kinds a plan can be for (`write-plan/types.ts`, `PlanKind`). */
export type PlanKind = KnowledgeType;
/** A link set by the kind it points at (`brain/links.ts`, `DesiredLinks`). Declared here so this module is a leaf: it imports nothing of the planners' graph. */
export type DesiredLinks = Partial<Record<RefKind, readonly string[]>>;
/** What of a `WritePlan` this module reads: a plan of the planners is one (structurally). */
export interface PlanLike {
  readonly kind: PlanKind;
  readonly op: 'insert' | 'converge';
  readonly result: Readonly<Record<string, unknown>>;
  readonly links?: { readonly desired: DesiredLinks };
}

/** The fields a write can state, per kind, in the order a change is reported. */
export const STATED_FIELDS: Readonly<Record<PlanKind, readonly string[]>> = {
  entity: ['name', 'type', 'description', 'tags', 'properties'],
  fact: ['fact', 'type', 'description', 'tags', 'properties'],
  chrono: ['title', 'type', 'startsAt', 'endsAt', 'status', 'confidence', 'description', 'tags', 'properties', 'recurrence'],
  edge: ['weight', 'type', 'description', 'tags', 'properties'],
};

export interface ConvergeChanges {
  /** Stated fields whose value the converge changes. */
  readonly changed: readonly string[];
  /** What the stored record says and the converge leaves out: a field, `tags:<tag>`, or `properties.<key>`. */
  readonly removed: readonly string[];
  /** Per class the plan names, the stored link ends its desired set leaves out (only when the stored links were handed in). */
  readonly linksTakenAway: DesiredLinks;
}

/**
 * Structural equality of two stored values (strings, numbers, booleans, arrays, plain objects): an array is compared in its order (a tag list is an
 * ordered list), an object by its keys and values whatever order they were written in (a property bag, a recurrence), so the order a planner builds a
 * bag in is never a change.
 */
const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);

const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * What `plan` (a converge of `stored`) would change and take away. An insert changes no stored record, so it answers nothing.
 * `storedLinks`: the record's stored link rows (`ReadSet.storedLinks`), to judge what its link reconcile would take away.
 */
export function convergeChanges(stored: Readonly<Record<string, unknown>>, plan: PlanLike, storedLinks?: DesiredLinks): ConvergeChanges {
  if (plan.op !== 'converge') return { changed: [], removed: [], linksTakenAway: {} };
  const after = plan.result;
  const changed: string[] = [];
  const removed: string[] = [];
  for (const field of STATED_FIELDS[plan.kind]) {
    const was = stored[field];
    const now = after[field];
    if (was === undefined) {
      if (now !== undefined) changed.push(field);
      continue;
    }
    if (now === undefined) { removed.push(field); continue; }
    if (!same(was, now)) changed.push(field);
    if (field === 'tags' && Array.isArray(was) && Array.isArray(now)) {
      for (const tag of was) if (!now.includes(tag)) removed.push(`tags:${String(tag)}`);
    }
    if (field === 'properties' && isPlainObject(was) && isPlainObject(now)) {
      for (const key of Object.keys(was)) if (!(key in now)) removed.push(`properties.${key}`);
    }
  }
  const linksTakenAway: Partial<Record<RefKind, string[]>> = {};
  if (storedLinks && plan.links) {
    for (const [kind, wanted] of Object.entries(plan.links.desired) as Array<[RefKind, readonly string[] | undefined]>) {
      const keep = new Set(wanted ?? []);
      const lost = (storedLinks[kind] ?? []).filter(id => !keep.has(id));
      if (lost.length > 0) linksTakenAway[kind] = lost;
    }
  }
  return { changed, removed, linksTakenAway: linksTakenAway as DesiredLinks };
}
