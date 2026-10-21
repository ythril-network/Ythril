/**
 * The operator's way out of an instance-wide act set that cannot finish: abandon the standing restore or migrate, and the answer its
 * door gives (`POST /api/admin/data/restore/abandon`, `POST /api/admin/data/migrate/abandon`).
 *
 * ## What it prevents (Q-564 F5)
 *
 * A migrate's copy treats a store outage or a timeout of the target as retryable, so a target that never answers left the set owed for
 * ever: every space held, the instance in maintenance, and no door to end it - only the restore had an abandon, written for the restore
 * alone. The abandon itself was already generic (`abandonSpaceActSet`); what was restore-only was the wrapper and the door. This is that
 * wrapper for every instance-wide kind, so a third kind gets its abandon by being one, not by a copy.
 *
 * ## What an abandon does, and does not
 *
 * Every entry of the set not done leaves in ONE write, lifting its hold (and the maintenance an instance-wide set holds); the members are
 * marked `<kind>_abandoned`; the set's end hook runs (a restore's caches and its `data.restore.abandoned` row; a migrate's
 * `data.migrate.failed` row). Nothing a completion would write is written: a migrate's URI is not saved, the old database stays in use.
 * Refused while a member's body runs - an abandon never cuts a body.
 */
import { abandonSpaceActSet } from './space-act-runner.js';
import type { ReportedActSetKind } from './act-set-report.js';

/** The answer of an abandon door: its status and body, the same shape for every instance-wide kind. */
export interface ActSetAbandonAnswer { status: 200 | 404 | 409; body: Record<string, unknown> }

/**
 * Abandon the standing set of `kind` and answer as its door does:
 * - `200` `{ abandoned: true, <kind>Id, backupId?, released, completed }`: `released` are the spaces whose acts had not completed (a
 *   restore's may be half restored, and its answer also names them `halfRestored`, the word its door has always used);
 * - `404` `no_<kind>_standing` when none stands; `409` `<kind>_act_running` while a member's body runs.
 */
export async function abandonActSet(kind: ReportedActSetKind): Promise<ActSetAbandonAnswer> {
  const r = await abandonSpaceActSet(kind);
  if (!r.abandoned && r.reason === 'none_standing') {
    return { status: 404, body: { error: `No ${kind} is standing.`, code: `no_${kind}_standing` } };
  }
  if (!r.abandoned) {
    return {
      status: 409,
      body: {
        error: `A ${kind} act is running for ${(r.running ?? []).map(s => `'${s}'`).join(', ')}; abandon once it has ended.`,
        code: `${kind}_act_running`,
      },
    };
  }
  const released = [...r.left].sort();
  const completed = Object.entries(r.set.members).filter(([, m]) => m.state === 'done').map(([id]) => id).sort();
  return {
    status: 200,
    body: {
      abandoned: true, [`${kind}Id`]: r.set.id, ...(r.set.backupId ? { backupId: r.set.backupId } : {}), released, completed,
      ...(kind === 'restore' ? { halfRestored: released } : {}),
    },
  };
}
