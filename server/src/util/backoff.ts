/**
 * Jitter for retry backoff — the part that stops a recovering dependency being knocked straight back
 * over by the clients that were waiting for it.
 *
 * ## The failure this prevents
 *
 * Both retry queues here already back off exponentially, which is the half everyone remembers. But the
 * delay was *exactly* the same for every job, so failures that happen together retry together. Upload
 * twenty files while the document sidecar is restarting and all twenty fail within the same second, all
 * wait exactly 30 000 ms, and all hit the sidecar again on the same tick — a synchronised herd, aimed at
 * something that has just come back up and is at its most fragile. If that knocks it over, the twenty
 * fail together again and re-synchronise on the next step of the schedule.
 *
 * Backoff spaces retries out *over time*. Jitter spaces them out *across clients*. Neither substitutes
 * for the other, and the second one is the one that was missing.
 *
 * ## Equal jitter, not full jitter
 *
 * Full jitter (`random(0, delay)`) spreads best but throws away the floor: a job can retry almost
 * immediately after failing, which defeats the point of having chosen 30 s. Equal jitter keeps half the
 * delay as a guaranteed minimum and randomises the rest, so the schedule still means what it says while
 * the herd still breaks up. For a queue measured in tens of jobs rather than thousands, that is the
 * better trade.
 */

/**
 * `delayMs` scattered to somewhere in `[delayMs/2, delayMs)`.
 *
 * Returns 0 for a non-positive delay, so "retry immediately" stays immediate rather than becoming a
 * random tiny wait.
 */
export function withJitter(delayMs: number, random: () => number = Math.random): number {
  if (!Number.isFinite(delayMs) || delayMs <= 0) return 0;
  const half = delayMs / 2;
  return Math.round(half + random() * half);
}

/**
 * The wait before retry number `attempt` (0-based): `baseMs` doubling per attempt up to `capMs`, then equal-jittered.
 *
 * ## Why this is a function and not a loop variable
 *
 * Three sites wanted "exponential, capped, half of it random": the connect loop in `db/mongo.ts`, the embedding
 * endpoint's retry, and the search-readiness watcher (`spaces/search-readiness.ts`, which retries for as long
 * as the process lives). Written three times, one of them ends up with full jitter, or with no cap, or with an
 * exponent that overflows — and the last of those is silent: a watcher at attempt 1 100 has `2 ** attempt ===
 * Infinity`, and `Infinity * 0` is NaN, and a NaN timer fires at once. So the exponent is clamped HERE, and the
 * cap is what a caller gets for any attempt however large.
 *
 * Attempt 0 is the base itself, so a caller that never retries twice (`backoffDelayMs(0, base, base)`) is a
 * single jitter of `base`. A NaN, negative or non-positive input never yields NaN or a negative wait: an
 * unusable base stays "immediate" exactly as {@link withJitter} does, and an unusable cap is ignored.
 */
export function backoffDelayMs(
  attempt: number, baseMs: number, capMs: number, random: () => number = Math.random,
): number {
  if (!Number.isFinite(baseMs) || baseMs <= 0) return 0;
  // 2 ** 50 times any base a caller would pass is past every cap, and stays a finite number.
  const exponent = Number.isFinite(attempt) && attempt > 0 ? Math.min(attempt, 50) : (attempt === Infinity ? 50 : 0);
  const nominal = baseMs * 2 ** exponent;
  return withJitter(Number.isFinite(capMs) && capMs > 0 ? Math.min(nominal, capMs) : nominal, random);
}
