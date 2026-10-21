/**
 * The report of an instance-wide act set - a restore or a migrate - standing or last ended: what `GET /api/admin/data/restore` and
 * `GET /api/admin/data/migrate` answer (bundle-157, R4.2, R5.1, slice I4a).
 *
 * ## What it prevents
 *
 * Once a restore or a migrate answers 202 its work happens in acts, so the answer can no longer carry the outcome. The restore had a
 * report and the migrate had none: a failed migrate left its reason on the set record in the config file and in the log, where no
 * operator asks. Written a second time for the migrate, the two reports would drift the way two copies of one rule do in this codebase
 * (one would gain the set's `lastError`, the other would not), so there is ONE report and the kind is its parameter.
 *
 * ## The shape
 *
 * `{ <kind>Id, backupId?, state: running | completed | abandoned, startedAt, endedAt?, lastError?, done, total, spaces, emptied, leftOut }`,
 * and per space `{ id, state: owed | running | done | <kind>_abandoned, attempts, lastError?, retryAt?, needsAbandon?, completedAt?, ...the
 * body's report }`. `lastError` at the top is the sentence a whole-set failure ended the set with; it is ours, never the driver's. A
 * migrate's target URI is never read here: `spaceActSetOf` does not hand it out.
 */
import { spaceActSetOf, entriesOfSet } from './space-act-runner.js';
import type { SpaceActKind } from '../config/types.js';

/** The kinds that run as an instance-wide set and are reported by {@link actSetReport}. */
export type ReportedActSetKind = Extract<SpaceActKind, 'restore' | 'migrate'>;

/** One space of the report: where its act stands and what its body reported. */
export interface ActSetSpaceReport {
  id: string;
  state: 'owed' | 'running' | 'done' | `${ReportedActSetKind}_abandoned`;
  attempts: number;
  lastError?: string;
  retryAt?: string;
  needsAbandon?: true;
  completedAt?: string;
  [reported: string]: unknown;
}

/** The set standing, or the last one, under its kind's id key (`restoreId`, `migrateId`). */
export type ActSetReport = {
  backupId?: string;
  state: 'running' | 'completed' | 'abandoned';
  startedAt: string;
  endedAt?: string;
  lastError?: string;
  done: number;
  total: number;
  spaces: ActSetSpaceReport[];
  emptied: string[];
  leftOut: string[];
} & { [idKey in `${ReportedActSetKind}Id`]?: string };

/**
 * The set states (`ActSetReport['state']`) after which a set no longer changes. A reader that paints a set by its state (the client's
 * status pill) keeps no list of its own: it asks this one, and the client never paints any of these as pending, whatever the set's
 * rows say.
 */
export const TERMINAL_ACT_SET_STATES = ['completed', 'abandoned'] as const satisfies readonly ActSetReport['state'][];

/** The report of the `kind` set standing or last ended; `{ [kind]: null }` when none ever ran on this instance. */
export function actSetReport(kind: ReportedActSetKind): ActSetReport | { [k in ReportedActSetKind]?: null } {
  const set = spaceActSetOf(kind);
  if (!set) return { [kind]: null };
  const entries = new Map(entriesOfSet(set.id).map(e => [e.localId, e]));
  const spaces = Object.entries(set.members).map(([id, m]): ActSetSpaceReport => {
    if (m.state === 'done') return { id, state: 'done', attempts: 0, ...(m.completedAt ? { completedAt: m.completedAt } : {}), ...(m.report ?? {}) };
    const e = entries.get(id);
    if (m.state === 'abandoned') return { id, state: `${kind}_abandoned`, attempts: e?.attempts ?? 0 };
    return {
      id, state: e?.state === 'running' ? 'running' : 'owed', attempts: e?.attempts ?? 0,
      ...(e?.lastError ? { lastError: e.lastError } : {}),
      ...(e?.retryAt ? { retryAt: e.retryAt } : {}),
      ...(e?.needsAbandon ? { needsAbandon: true as const } : {}),
    };
  });
  return {
    [`${kind}Id`]: set.id, ...(set.backupId ? { backupId: set.backupId } : {}),
    state: set.endedAt ? (set.outcome ?? 'completed') : 'running',
    startedAt: set.startedAt, ...(set.endedAt ? { endedAt: set.endedAt } : {}),
    ...(set.lastError ? { lastError: set.lastError } : {}),
    done: spaces.filter(s => s.state === 'done').length, total: spaces.length,
    spaces, emptied: set.emptied ?? [], leftOut: set.leftOut ?? [],
  };
}
