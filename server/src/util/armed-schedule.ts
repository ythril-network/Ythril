/**
 * Remembering which cron expression a scheduler currently has armed.
 *
 * ## Why this is a module and not four fields
 *
 * Re-arming a `node-cron` task with the SAME expression is not free: it stops the running task and schedules a
 * fresh one, which **resets the phase**. A network on a quarter-hour cron that was ninety seconds from its next
 * sync goes back to a full fifteen minutes. The config-reload path re-arms three schedulers on every external
 * change, and the backup route re-arms a fourth on every save — so an edit to an unrelated setting used to push
 * every one of them out, repeatedly for somebody adjusting several fields in a row.
 *
 * The fix is one rule: *arm only when the expression differs from the one already armed.* Written four times it
 * would be four chances to get the clear-on-stop half wrong, which is the half that fails CLOSED — leave the
 * fact set after a stop and the next `start` returns early, so the scheduler never runs again. `CLAUDE.md`
 * names that shape as the defect this repo produces most, so the rule lives here and each scheduler holds one
 * of these instead of its own bookkeeping.
 *
 * ## What it deliberately does not do
 *
 * It does not own the task. A scheduler still stops and starts its own `ScheduledTask`, because the library type
 * does not carry the expression it was built from and wrapping it would put this module in the path of every
 * fire. This holds one string per key and answers one question.
 *
 * The INTERVAL-driven sweeps have no business here: they read their config on every run, so nothing needs
 * re-arming and restarting them would reset the phase of a six-hour timer for no gain.
 */

/** One scheduler's fact of what it armed. Keyed, so a per-network scheduler uses one instance for all of them. */
export interface ArmedSchedules {
  /** True when `key` is already armed on exactly `cron` — the caller should return without touching the task. */
  isArmed(key: string, cron: string): boolean;
  /** Record that `key` is now armed on `cron`. Call AFTER the task is actually scheduled. */
  note(key: string, cron: string): void;
  /** Forget `key`, or every key when called with no argument. Call whenever a task is stopped. */
  forget(key?: string): void;
}

/**
 * A fresh fact, empty.
 *
 * The single-task schedulers pass a constant key; `sync` passes the network id. There is no default key on
 * purpose — a scheduler that forgot to pass one would silently share a slot with another.
 */
export function armedSchedules(): ArmedSchedules {
  const armed = new Map<string, string>();
  return {
    isArmed(key, cron) {
      return armed.get(key) === cron;
    },
    note(key, cron) {
      armed.set(key, cron);
    },
    forget(key) {
      if (key === undefined) armed.clear();
      else armed.delete(key);
    },
  };
}
