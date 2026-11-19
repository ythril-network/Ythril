import { FORK_KINDS } from './forks.types';
import type { UnconvertedOpenGroup } from './conversion.types';

/**
 * The reasons a record is listed as unconverted, the three classes Review groups them into, and the counts the class switch and the type
 * choice are made of (bundle-285, Q-747).
 *
 * ## Why classes
 *
 * The server lists a record for one of ten reasons; the green-lit Review section shows three the user can act on. "Does not fit the new
 * schema" covers seven reasons (the advice is the same for all: give the record what the schema needs, or dismiss it), "The relationship
 * already exists" covers two (delete one of the two edges), "The steps were refused here" covers one (correct the steps on the type).
 *
 * ## What it prevents
 *
 * - **A server reason with no class.** `UNCONVERTED_REASON_CLASS` is a `Record` over the reason tuple, so a reason added here without a class
 *   does not compile, and `testing/conversion-contract.spec.ts` compares the tuple with the server's own `UNCONVERTED_REASONS`, so a reason
 *   added on the server fails there with its name. A reason an OLDER client meets anyway (a newer server) is "does not fit": the one class
 *   whose advice is true of any record a run could not convert. It never throws, and it is never read off the prototype: the table is asked
 *   by own key, so `constructor` is not a reason.
 * - **A count made up by the page.** The class counts and the type choices are sums of the groups the server counted
 *   (`counts.openBy`), nothing else.
 */

/** Why a record was not converted: the server's `UNCONVERTED_REASONS`, in its order. */
export const UNCONVERTED_REASONS = [
  'not_conforming', 'no_case_matched', 'both_set', 'could_not_evaluate',
  'relationship_exists', 'functional_taken', 'version_ceiling', 'fork', 'step_refused', 'conversion_failed',
] as const;
export type UnconvertedReason = typeof UNCONVERTED_REASONS[number];

/** What the user can do about a record: the three classes of the reason switch, in the order it lists them. */
export const UNCONVERTED_CLASSES = ['fit', 'exists', 'refused'] as const;
export type UnconvertedClass = typeof UNCONVERTED_CLASSES[number];

/** The class of each reason the server lists a record for. */
export const UNCONVERTED_REASON_CLASS: Readonly<Record<UnconvertedReason, UnconvertedClass>> = {
  not_conforming: 'fit',
  no_case_matched: 'fit',
  both_set: 'fit',
  could_not_evaluate: 'fit',
  relationship_exists: 'exists',
  functional_taken: 'exists',
  version_ceiling: 'fit',
  fork: 'fit',
  step_refused: 'refused',
  conversion_failed: 'fit',
};

/** The class of a reason; a reason this client does not know (a newer server's) is `fit`. */
export function reasonClassOf(reason: string): UnconvertedClass {
  return Object.hasOwn(UNCONVERTED_REASON_CLASS, reason) ? UNCONVERTED_REASON_CLASS[reason as UnconvertedReason] : 'fit';
}

/**
 * The reasons a class stands for, in the server's order: what a class pill sends as the list's `reason` filter. A reason this client does
 * not know is under no pill (the server refuses an unknown reason in a filter); it is listed under "All".
 */
export function reasonsOfClass(cls: UnconvertedClass): readonly UnconvertedReason[] {
  return UNCONVERTED_REASONS.filter(r => UNCONVERTED_REASON_CLASS[r] === cls);
}

/** One record type of the open items: its kind and name (an edge's name is its label). */
export interface OpenTypeRef { kind: UnconvertedOpenGroup['kind']; type: string }

/**
 * The number on each pill of the reason switch: the open items of each class, from the server's groups, for one type when `only` names it or
 * for every type. All three classes are always present, a class with nothing open as zero. A type is a kind and a name.
 */
export function openCountsByClass(groups: readonly UnconvertedOpenGroup[], only?: OpenTypeRef): Record<UnconvertedClass, number> {
  const out: Record<UnconvertedClass, number> = { fit: 0, exists: 0, refused: 0 };
  for (const g of groups) {
    if (only && (g.kind !== only.kind || g.type !== only.type)) continue;
    out[reasonClassOf(g.reason)] += g.n;
  }
  return out;
}

/**
 * The record types with something open, each once with its open count: what the type choice lists. Kinds in the Brain's tab order, names in
 * the order of their letters. A group with nothing open names no type.
 */
export function openTypesOf(groups: readonly UnconvertedOpenGroup[]): (OpenTypeRef & { open: number })[] {
  const byType = new Map<string, OpenTypeRef & { open: number }>();
  for (const g of groups) {
    if (g.n <= 0) continue;
    const key = JSON.stringify([g.kind, g.type]);
    const seen = byType.get(key);
    if (seen) seen.open += g.n;
    else byType.set(key, { kind: g.kind, type: g.type, open: g.n });
  }
  const order = (kind: string): number => FORK_KINDS.indexOf(kind as (typeof FORK_KINDS)[number]);
  return [...byType.values()].sort((a, b) => order(a.kind) - order(b.kind) || a.type.localeCompare(b.type));
}

/** The one type when exactly one has open items (Review preselects it), else `null`. */
export function soleOpenType(groups: readonly UnconvertedOpenGroup[]): OpenTypeRef | null {
  const types = openTypesOf(groups);
  return types.length === 1 ? { kind: types[0]!.kind, type: types[0]!.type } : null;
}
