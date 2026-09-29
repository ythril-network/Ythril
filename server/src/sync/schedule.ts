import { validate } from 'node-cron';

/**
 * How often a network syncs, in one place: what the scheduler will run, what a request may set, and what a
 * config written under the old rule becomes.
 *
 * ## One rule, three doors, and it used to have one implementation
 *
 * `resolveSyncCron` was the only thing that knew what a schedule meant. The routes took
 * `z.string().optional()` and validated nothing, so any string got a `200` — and if it did not resolve, the
 * scheduler logged *"Unrecognised sync schedule … using manual sync only"* and carried on. An operator could
 * set a schedule, be told it saved, and have that network never sync again, with the only evidence in a
 * server log they have no reason to open.
 *
 * So the three doors are named and share this module: `syncScheduleRefusal` for a request,
 * `migrateSyncScheduleShorthands` for what is already on disk, and `resolveSyncCron` for what actually runs.
 */

/** `1 ≤ N ≤ 59` for minutes, `1 ≤ N ≤ 23` for hours — cron's own ranges, and the reason some shorthands never worked. */
const SHORTHAND = /^(?:\*\/(\d+)\s*(min(?:ute)?s?|h(?:our)?s?)|every\s+(\d+)\s*(m(?:in(?:ute)?s?)?|h(?:(?:ou)?rs?)?))$/i;

/**
 * The cron expression a legacy shorthand always translated to, or `null` when it never translated to
 * anything.
 *
 * The shorthands were `N minutes` / `every Nm` and `N hours` / `every Nh`, in the slash-star and the `every`
 * spelling. `null` covers two different situations on purpose — not a shorthand at all, and a shorthand
 * outside cron's range, e.g. `every 90m`. A caller that needs to tell them apart looks at whether the string
 * matched, which only this module can answer.
 */
function shorthandToCron(schedule: string): string | null {
  const m = SHORTHAND.exec(schedule.trim());
  if (!m) return null;
  const n = parseInt(m[1] ?? m[3]!, 10);
  const unit = (m[2] ?? m[4]!).toLowerCase();
  if (unit.startsWith('h')) return n >= 1 && n <= 23 ? `0 */${n} * * *` : null;
  return n >= 1 && n <= 59 ? `*/${n} * * * *` : null;
}

/** Whether a string is a legacy shorthand, whatever it translates to. */
function looksLikeShorthand(schedule: string): boolean {
  return SHORTHAND.test(schedule.trim());
}

/**
 * Resolve a network's `syncSchedule` to a cron expression node-cron can run, or `null` for manual-sync only.
 *
 * **Cron only, since 4.0.** The two legacy shorthands were translated here for the whole of 2.x and 3.x;
 * they are now refused at input and rewritten on disk, so nothing reaches the scheduler that this function
 * has to translate. Keeping the arm as well would have been the third implementation of one rule.
 */
export function resolveSyncCron(schedule: string): string | null {
  const s = schedule.trim();
  if (!s) return null;
  return validate(s) ? s : null;
}

/**
 * Why this schedule cannot be saved, or `null` when it can.
 *
 * Same shape as `rateLimitRefusal`: one function both routes call, returning the sentence a caller is shown.
 * An empty or absent value is ALLOWED — clearing the field is how an operator turns scheduling off, and
 * refusing it would take away the only way back to manual sync.
 *
 * **A shorthand's refusal names the cron expression it used to mean.** An integrator has had `every 5m` in
 * their notes since 2.x, because the networks API documented it; being told "not valid" and left to work out
 * the replacement is barely better than being ignored. An out-of-range one gets no suggestion, because there
 * is no honest translation — rounding `every 90m` to two hours would be the server deciding when to sync.
 */
export function syncScheduleRefusal(schedule: unknown): string | null {
  if (schedule === undefined || schedule === null) return null;
  if (typeof schedule !== 'string') {
    return 'syncSchedule must be a cron expression string, e.g. "*/5 * * * *" — or empty for manual sync only.';
  }
  const s = schedule.trim();
  if (!s) return null;
  if (validate(s)) return null;

  if (looksLikeShorthand(s)) {
    const cron = shorthandToCron(s);
    return cron
      ? `syncSchedule no longer accepts the shorthand "${s}" (removed in 4.0). Send "${cron}" — it is the `
        + 'same schedule as a cron expression.'
      : `syncSchedule no longer accepts the shorthand "${s}" (removed in 4.0), and it never ran: the value is `
        + 'outside cron\'s range, so this network has been on manual sync. Send a cron expression that says '
        + 'when you actually want it, e.g. "*/30 * * * *".';
  }
  return `syncSchedule "${s}" is not a cron expression. Give five fields, e.g. "*/5 * * * *" for every five `
    + 'minutes or "0 * * * *" for hourly — or leave it empty for manual sync only.';
}

/**
 * What a network joined without a stated schedule syncs on when the inviter offers none it could use (`Q-137`).
 * Every fifteen minutes: the cadence the onboarding promised and the creating side runs. Not manual — a joined
 * network on manual never pulls, so a subscriber would depend on its publisher pushing everything.
 */
export const DEFAULT_JOIN_SYNC_SCHEDULE = '*/15 * * * *';

/**
 * The schedule a joined network syncs on — decided in ONE place for both join doors (`Q-137`).
 *
 * `stated` is the caller's, already refused at the door if unrunnable, and wins — including `''`, which is manual on
 * purpose. Otherwise the inviter's offer is adopted when it is a schedule this door would accept, and anything else
 * (absent, empty, not a string, not cron, a retired shorthand) gives the default: an offer is another instance's
 * value, so it is validated here rather than stored as it came.
 */
export function joinedSyncSchedule(stated: string | undefined, offered: unknown): string {
  if (stated !== undefined) return stated.trim();
  if (typeof offered === 'string' && offered.trim() && syncScheduleRefusal(offered) === null) return offered.trim();
  return DEFAULT_JOIN_SYNC_SCHEDULE;
}

/**
 * Give the join default to every joined network that never stated a schedule — the ones joined before it existed.
 *
 * `joinedSyncSchedule` only reached networks joined after it shipped, so an instance that joined before carries no
 * schedule, syncs only when its peer starts a cycle, and nothing says so. `''` is manual CHOSEN and is left alone;
 * `undefined` is never stated. A network this instance created is left alone too: the default is a joiner's rule.
 * An absent `origin` predates the field and is treated as joined, because a creator states a schedule at creation.
 *
 * Mutates in memory and returns the networks it scheduled; the caller persists and logs them. Settles: a second
 * call finds nothing.
 */
export function defaultUnstatedJoinedSchedules(
  config: { networks?: { id: string; origin?: 'created' | 'joined'; syncSchedule?: string }[] },
): string[] {
  const scheduled: string[] = [];
  for (const net of config.networks ?? []) {
    if (net.origin === 'created' || net.syncSchedule !== undefined) continue;
    net.syncSchedule = DEFAULT_JOIN_SYNC_SCHEDULE;
    scheduled.push(net.id);
  }
  return scheduled;
}

/** One network's stored schedule that cannot be translated and cannot be run. */
export interface UnrunnableSchedule {
  networkId: string;
  schedule: string;
}

/**
 * Rewrite any stored legacy shorthand to the cron expression it already translated to.
 *
 * A shorthand in `config.json` was written under the old rule, so refusing it at boot would stop an instance
 * for a value it accepted last week. It becomes the same schedule, spelled the way the parser still
 * understands — the sync rate does not change.
 *
 * **The out-of-range ones are reported rather than rewritten, and that report is worth more than the
 * removal.** `every 90m` never resolved to anything: 90 is outside cron's minute range, so the network has
 * been on manual sync since the day it was set, and nothing has ever said so except a startup line about a
 * value the operator no longer remembers typing. There is no honest translation, so the value stays where
 * they can see it and the caller is handed the network id to name in a warning.
 *
 * Mutates in memory and reports whether anything changed; the caller persists. Durable, and pinned by
 * `a-durable-config-migration-stays-wired.test.js` — the in-memory rewrite is what keeps an instance whose
 * `config.json` cannot be written syncing on the schedule it was given.
 *
 * @returns `changed` — whether the caller should save; `unrunnable` — the networks to warn about.
 */
export function migrateSyncScheduleShorthands(
  config: { networks?: { id: string; syncSchedule?: string }[] },
): { changed: boolean; unrunnable: UnrunnableSchedule[] } {
  let changed = false;
  const unrunnable: UnrunnableSchedule[] = [];

  for (const net of config.networks ?? []) {
    const stored = net.syncSchedule?.trim();
    if (!stored || validate(stored)) continue;

    const cron = shorthandToCron(stored);
    if (cron) {
      net.syncSchedule = cron;
      changed = true;
    } else {
      unrunnable.push({ networkId: net.id, schedule: stored });
    }
  }

  return { changed, unrunnable };
}
