/**
 * The scaffolding every per-space sweep of the files collection shares: when a pass of a space is owed, how long a tick may go on starting
 * pages, where a pass writes down how far it got, and how a pass learns that a restore wiped that record under it (bundle-70, duplicate-rule
 * pass: the absent-bytes sweep and the leaked-rows repair each wrote these, with the same numbers).
 *
 * ## The question it answers
 *
 * "May this tick start (or go on with) a pass of this space, and may the page that just ran write its cursor?" Each sweep keeps what a pass
 * IS (its state shape, its removal cap, what a restart clears besides the cursor); this module keeps the rules a pass is paced by.
 *
 * ## What it prevents
 *
 * - One sweep waiting a day and the other a day and a minute, or one stopping its tick at half a minute and the other at a minute: the pacing is
 *   one pair of constants ({@link SWEEP_RESCAN_AFTER_MS}, {@link SWEEP_STEP_BUDGET_MS}).
 * - A page that was already running when a restore or an import cleared the cursor writing its own cursor back over the cleared one: a
 *   {@link PassGenerations} is bumped by the restart, and a page compares the generation it began under with the one now.
 * - A cursor written to the live config entry with a save per page: {@link rememberPass} is always `save: 'soon'` (coalesced).
 */
import { changeSpaceEntries } from '../config/change-space-entries.js';
import type { SpaceConfig } from '../config/types.js';

/** How long a tick may go on STARTING pages, ms. A page already running is never interrupted. */
export const SWEEP_STEP_BUDGET_MS = 30_000;
/** A pass that completed is not started again before this much time has passed, ms. */
export const SWEEP_RESCAN_AFTER_MS = 24 * 3_600_000;

/** The instant after which a tick beginning at `from` (default now) starts no new page. */
export const sweepStepDeadline = (from: number = Date.now()): number => from + SWEEP_STEP_BUDGET_MS;

/**
 * Whether a pass of a space is owed at `now`: one is under way (`running`), none has completed yet (`completedAt` unset), or the last
 * completed `rescanAfterMs` ago or more. The caller says which of its state's fields are those two.
 */
export function passIsOwed(pass: { running: boolean; completedAt: string | undefined }, now: Date, rescanAfterMs: number = SWEEP_RESCAN_AFTER_MS): boolean {
  if (pass.running || pass.completedAt === undefined) return true;
  return now.getTime() - Date.parse(pass.completedAt) >= rescanAfterMs;
}

/** The generation of each space's pass, bumped by a restart so a page already running does not write state over the one a restart cleared. */
export class PassGenerations {
  private readonly byId = new Map<string, number>();

  of(spaceId: string): number { return this.byId.get(spaceId) ?? 0; }

  /** A restart of these spaces' passes: every page that began under an earlier generation is stale. */
  bump(spaceIds: readonly string[]): void {
    for (const id of spaceIds) this.byId.set(id, this.of(id) + 1);
  }
}

/**
 * Where a pass of a space is, set on its LIVE config entry (read at once by the next page) and written down SOON: coalesced with the next
 * ones (`saveConfigSoon`), so a tick of many pages is not a config write per page. A crash costs the progress since the last write, and the
 * pages are idempotent.
 */
export function rememberPass<K extends 'absentBytesScan' | 'leakedRowScan'>(spaceId: string, key: K, state: NonNullable<SpaceConfig[K]>): void {
  changeSpaceEntries([spaceId], entry => { entry[key] = state; return true; }, { save: 'soon' });
}
