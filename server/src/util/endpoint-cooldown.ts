/**
 * Pass over a model endpoint that just failed, for a while, instead of paying its timeout on every call (`Q-157`).
 *
 * Owner, 2026-09-29: *"duration is insane for simple semantic search queries, work on performance"*. Measured on a
 * 5.6.0 instance: every recall took 20 s — the reranker's slot timeout — and then answered in fused order anyway;
 * the same recall with the reranker skipped took 90 ms. Nothing remembered that the last pass had failed.
 *
 * The assist model already had the rule, written into its own module (`config/assist-backend.ts`, a fixed minute).
 * The reranker was the second endpoint needing it, so the rule lives here and both use it.
 *
 * **The window doubles on each failure in a row, up to a ceiling, and a success resets it.** A fixed window keeps
 * charging one caller the full timeout every window for an endpoint that stays down; doubling makes a long outage
 * cost a handful of timeouts, and the ceiling bounds how long a recovered endpoint goes unused.
 *
 * **What counts as unavailable is `endpointUnavailable`, and a caller must use it.** A request the endpoint refused
 * on its own terms (400, 413, 422) says nothing about whether it is up, and cooling down on it would switch off a
 * working endpoint for a caller's mistake.
 */
import { log } from './log.js';

export interface EndpointCooldown {
  /** Whether a call now should skip the endpoint. */
  coolingDown(now?: number): boolean;
  /** When the current window ends, or undefined when the endpoint is not cooling down. */
  until(): number | undefined;
  /** A call failed for a reason `endpointUnavailable` accepts: start or extend the window. */
  failed(now?: number): void;
  /** A call succeeded: end the window and reset the doubling. */
  succeeded(): void;
}

/** A failure that means the endpoint cannot answer NOW, as opposed to a request it will never accept. */
export function endpointUnavailable(status: number | undefined): boolean {
  return status === undefined || status === 429 || status === 529 || status === 402 || status >= 500;
}

export function endpointCooldown(name: string, opts: { baseMs: number; maxMs: number }): EndpointCooldown {
  let downUntil: number | undefined;
  let streak = 0;
  return {
    coolingDown: (now = Date.now()) => downUntil !== undefined && now < downUntil,
    until: () => downUntil,
    failed(now = Date.now()) {
      const ms = Math.min(opts.baseMs * 2 ** streak, opts.maxMs);
      streak++;
      downUntil = now + ms;
      log.warn(`${name}: unavailable — passed over for ${Math.round(ms / 1000)} s`);
    },
    succeeded() {
      if (downUntil !== undefined) log.info(`${name}: answering again`);
      downUntil = undefined;
      streak = 0;
    },
  };
}
