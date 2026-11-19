import { typeClauseOf, type TypedKind } from './type-field';
import type { ConversionStep } from './conversion.types';

/**
 * What the conversion dialog may say about a type's records BEFORE the run: how many it holds, how many the steps would rewrite, how many
 * would only be stamped, and what is not known until the run (bundle-285, Q-747, plan section 3.1 item 3).
 *
 * ## What it prevents
 *
 * - **A number the server cannot give, shown anyway.** No door counts a split's conditions over the records, so how many go to each type is
 *   not known before the run; {@link BlockCounts.casesCountedAsItRuns} says so and there is no per-case number to show. A type step moves
 *   EVERY record of its type, so its rewritten count is the total and needs no second read.
 * - **A count of the wrong records.** The records of a type are those of `was ?? type` (a renamed type's records still carry the old name),
 *   asked through `typeClauseOf` (never an array that merely holds the name; an edge by its label), and forks are left out
 *   (`forkOf: null`): a run leaves fork rows alone, so counting them would promise rewrites that never happen.
 * - **The wrong name in a clause.** A step that maps values of a property renamed in the same conversion reads the property by the name the
 *   STORED records still carry (the `from` of the rename), because the run reads each record before it renames it. A clause that named the
 *   new name would count none of them. (A record already stored under the new name is not counted by it either; the run would map that
 *   one too. The count is what the steps change in the records the rename moves, as the plan words it.)
 * - **A zero that is a failure.** {@link blockCounts} throws when a count the steps need is missing; it never answers zero for it.
 *
 * The counts say what the STEPS change. A record no step changes but that breaks the new schema is counted "only stamped" and ends
 * unconverted in the run (plan section 11, decision 2); the finished view reports the true numbers.
 */

/** The collection each knowledge kind lives in, as the `filter` tool names it. */
export const COLLECTION_OF_KIND: Readonly<Record<TypedKind, 'entities' | 'facts' | 'edges' | 'chrono'>> = {
  entity: 'entities', fact: 'facts', edge: 'edges', chrono: 'chrono',
};

/**
 * One type's block of a conversion: its records are those of `was` when the type was renamed, else of `type`; the steps are the ones that
 * belong to it. Steps that name another type or kind are not counted into it.
 */
export interface ConvertBlock { kind: TypedKind; type: string; was?: string; steps: readonly ConversionStep[] }

/** Which of the block's records the steps rewrite. */
export type RewriteScope =
  | { scope: 'none' }
  | { scope: 'all'; split: boolean }
  | { scope: 'some'; clause: { $or: Record<string, unknown>[] } };

/** What a block's records are named by before the conversion: the old name of a renamed type. */
const recordsType = (block: ConvertBlock): string => block.was ?? block.type;

/** Does the step belong to the block? A type step is the block's when it moves the block's records; a property step when it names the block's type. */
function belongs(block: ConvertBlock, step: ConversionStep): boolean {
  if (step.kind !== block.kind) return false;
  return step.op === 'renameType' || step.op === 'splitType' ? step.from === recordsType(block) : step.type === block.type;
}

/** The block's records: its type's, forks left out. The filter `limit: 1` reads the exact `total` of. */
export function blockRecordsFilter(block: ConvertBlock): Record<string, unknown> {
  return { ...typeClauseOf(block.kind, recordsType(block)), forkOf: null };
}

/**
 * Which records the steps rewrite: every record when a type step moves the type, none when no step belongs to the block, otherwise those a
 * property step changes: a rename's records are those that HAVE the old property, a map's those holding one of the mapped values, read by the
 * name the stored records carry.
 */
export function rewriteScopeOf(block: ConvertBlock): RewriteScope {
  const mine = block.steps.filter(s => belongs(block, s));
  const typeStep = mine.find(s => s.op === 'renameType' || s.op === 'splitType');
  if (typeStep) return { scope: 'all', split: typeStep.op === 'splitType' };
  const or: Record<string, unknown>[] = [];
  for (const step of mine) {
    if (step.op === 'renameProperty') or.push({ [`properties.${step.from}`]: { $exists: true } });
    else if (step.op === 'mapEnum') {
      const rename = mine.find((s): s is Extract<ConversionStep, { op: 'renameProperty' }> => s.op === 'renameProperty' && s.to === step.property);
      or.push({ [`properties.${rename?.from ?? step.property}`]: { $in: Object.keys(step.values) } });
    }
  }
  return or.length > 0 ? { scope: 'some', clause: { $or: or } } : { scope: 'none' };
}

/** The filter of the records the steps rewrite when only a property step does (the block's records narrowed by the clause); `null` for none or all. */
export function rewrittenFilter(block: ConvertBlock): Record<string, unknown> | null {
  const scope = rewriteScopeOf(block);
  return scope.scope === 'some' ? { ...blockRecordsFilter(block), ...scope.clause } : null;
}

/** What a block shows before the run. */
export interface BlockCounts {
  total: number;
  rewritten: number;
  stamped: number;
  /** A split sends records to several types and how many go where is counted as the run goes: there is no per-case number to show. */
  casesCountedAsItRuns: boolean;
  /** Two or more steps: the numbers are for the type as a whole, not for each step. */
  wholeType: boolean;
}

/**
 * The counts of a block from what the `filter` tool said: `total` the block's records, and `rewritten` the records the steps rewrite when
 * only a property step does (`null` when no such count was asked: none, or a type step). Throws when the steps need `rewritten` and it is
 * missing: a count that was not obtained is never zero. `rewritten` is held to `total` (the two reads are taken a moment apart).
 */
export function blockCounts(block: ConvertBlock, read: { total: number; rewritten: number | null }): BlockCounts {
  const scope = rewriteScopeOf(block);
  let rewritten: number;
  if (scope.scope === 'all') rewritten = read.total;
  else if (scope.scope === 'none') rewritten = 0;
  else if (read.rewritten === null) throw new Error('the steps rewrite some records and the count of rewritten records was not read');
  else rewritten = Math.min(read.rewritten, read.total);
  return {
    total: read.total,
    rewritten,
    stamped: read.total - rewritten,
    casesCountedAsItRuns: scope.scope === 'all' && scope.split,
    wholeType: block.steps.filter(s => belongs(block, s)).length >= 2,
  };
}
