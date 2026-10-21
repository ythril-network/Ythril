# 13 — A restore is a set of space acts, and it forgets only what it received

**Status:** accepted, 2026-10-21 · **Scope:** `POST /api/admin/data/restore` and `POST /api/admin/data/migrate`, their reports and abandon, the space acts they register, maintenance while they stand, and the per-member sync marks a restore touches

## Context

A restore replaced the database inside the request. It turned maintenance on and dropped and reloaded every collection, and
maintenance stops HTTP callers that are not administrators and nothing else. So:

- **Writers kept writing.** An exchange this instance started, a timer, an administrator's own write all landed while
  collections were dropped and reloaded; a collection the backup held empty kept what arrived after it, and a space created
  after the backup kept its records.
- **The numbering went backwards.** The sequence counter came back below seqs already handed out, so a new write could take
  a seq a peer had already read past, and that peer would never ask for it.
- **The marks still described the old database.** Each peer's receive mark said "read up to" a seq this database no longer
  held, so what had arrived after the backup was never asked for again.
- **A crash half-way left nothing on disk** saying a restore was owed.

A migrate saved the new URI and exited, leaving the copy to a boot step that did not exist, so the instance came back on an
empty database.

## Decision

1. **A restore is a set of space acts, one per served space, registered in one config write.** The space-act machinery that
   finishes a deletion or wipe (decision 12) finishes a restore: from that write every space takes no writes (`409
   space_being_restored`) and its exchanges are held, the instance is in maintenance for as long as an act stands (derived
   from the acts, so a restart resumes both), and a crash resumes the act. A migrate is the same set with one body for the
   whole database, and it saves the new URI in the write that lifts the holds.
2. **A restore makes each space equal to the backup.** Its collections are dropped and created again with every index before
   the backup is loaded; a space created after the backup is emptied; a space the backup holds that this instance no longer
   serves is refused unless the operator leaves it out. The backup is checked whole before anything is registered and again
   by each space's act.
3. **The counter never goes backwards.** Each space's counter is raised to at least every seq this instance handed out before
   the restore, whatever the backup's counter says.
4. **A restore forgets only the marks of what this instance received**, so each peer sends again what
   arrived after the backup. The marks of what it sent, and of what the peers acknowledged, stay, each with its reason: the
   restore does not change what the peers hold, and the raised counter keeps those marks true. A migrate forgets nothing,
   because the data is the same.
5. **What a restore does not restore is stated, not implied.** The audit log, which records what happened, the restore
   included; `space_activity`, the webhook subscriptions and queues and the other instance collections; `config.json`; and the
   files' bytes on disk.

## Consequences

- An integrator learns the outcome from `GET /api/admin/data/restore` (or `/migrate`), not from the answer, which is `202`.
- A restore whose backup cannot be read stays owed and held until an operator abandons it; an abandoned space may be half
  restored, and the report says so.
- An instance administrator passes maintenance on every path, so the operator can watch and abandon a restore while it holds.
- **Residuals, owned by the limit "a peer's numbering starts over" (`D-48`), not by this decision:** a restore onto an empty
  database cannot raise the counter past seqs peers have already read; a peer this instance never pulls from (its subscribers,
  when it publishes) does not send again what it sent; and a record deleted here after the backup whose tombstone the peers
  have since pruned comes back here and is not pushed again. File bytes and their records going out of step is a separate
  defect of its own.
- Records erased after the backup come back, while the kept audit log still records the erasure.

## The reversal to prevent

Reversing this decision means replacing the database in the request again, or forgetting every mark on a restore. The first
brings back writes landing in a half-restored space and a counter below seqs peers have seen, which loses those writes on the
peers silently. The second makes each peer push again restored records whose deletions it has already pruned, and they come
back on every member.

## Where the detail lives

- The routes, the report, abandon and what is not restored: `docs/integration-guide/12-admin-api.md`.
- The marks and what a restore does to each: `docs/sync-protocol.md` (The per-space marks, and what a restore does to them).
- The upgrade and rollback notes: `docs/integration-guide/02b-upgrading.md`.
- The code: `server/src/db/restore-act.ts` and `server/src/db/migrate-act.ts`; the one list of act kinds in
  `server/src/config/types-space-acts.ts`; the receive marks and the kept marks, each with its reason, in
  `server/src/config/types-networks.ts`.
