/**
 * A heavy run over a space's stored data: one at a time per space, priced on the heavy-call rail — the guard, in the order that makes it
 * one, for every door that starts such a run.
 *
 * ## What it prevents
 *
 * The file stamp report (`spaces/file-stamp-report-door.ts`) and the stored-data schema check (`spaces/schema-validate-door.ts`) each
 * wrote the same five lines: is the space busy, take a slot on the rail, claim the space, run, release it in a `finally`. The ORDER is the
 * part a copy drops: the busy check comes BEFORE the rail, so a call that finds the space busy costs the caller no slot, and there is no
 * `await` between the check, the rail and the claim, so two calls cannot both pass it. A release outside a `finally` leaves a space
 * "already running" for ever after the first run that throws.
 *
 * Each job keeps its own flight ({@link heavyRunner} per job): a schema check does not wait for a stamp report of the same space.
 */
import { consumeHeavyToolCall } from './heavy-tool.js';

/** What a run answered: its value, or the refusal a door sends as it is. */
export type HeavyRunOutcome<T> = { ok: true; value: T } | { ok: false; status: 409 | 429; error: string };

/** The two refusals in the job's own words: the space is busy with this job, and the caller is over the rail. */
export interface HeavyRunRefusals { busy: string; limited: string }

export interface HeavyRunner {
  /** Run `work` for `spaceId`, charged to `callerKey`, unless the space is already running this job or the caller is over the rail. */
  run<T>(spaceId: string, callerKey: string, refusals: HeavyRunRefusals, work: () => Promise<T>): Promise<HeavyRunOutcome<T>>;
}

/** One job's runner: its own set of running spaces, the rail shared with every heavy call (`consumeHeavyToolCall`). */
export function heavyRunner(): HeavyRunner {
  const running = new Set<string>();
  return {
    async run(spaceId, callerKey, refusals, work) {
      // Before the rail, so a call that finds the space busy costs the caller no slot. No `await` between this check, the rail and the
      // claim: two calls cannot both pass it.
      if (running.has(spaceId)) return { ok: false, status: 409, error: refusals.busy };
      if (!consumeHeavyToolCall(callerKey)) return { ok: false, status: 429, error: refusals.limited };
      running.add(spaceId);
      try {
        return { ok: true, value: await work() };
      } finally {
        running.delete(spaceId);
      }
    },
  };
}
