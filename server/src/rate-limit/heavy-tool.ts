/**
 * The throttle on destructive tool calls — transport-free, so BOTH doors get it.
 *
 * ## What it is fixing
 *
 * `bulkWipeRateLimit` is express middleware, so it sat in front of the five `DELETE .../<collection>` routes
 * and in front of nothing on the MCP door. Five wipes a minute from a browser; unlimited from an agent,
 * which is the caller most likely to be doing it in a loop. Nobody reported it because each door did exactly
 * what its own code said.
 *
 * A limiter that is middleware can only ever guard one of the two doors, so this one is a function
 * `callTool` calls. It cannot be skipped by a door, because there is no door left to skip it in.
 *
 * ## Why in-memory is the right amount of machinery
 *
 * This is a safety rail against a runaway loop, not a quota anyone is billed against. One process holds the
 * counter, a restart clears it, and a multi-process deployment gets the limit per process — all acceptable
 * for a rail whose job is to turn "emptied every space" into "emptied one and then got told no".
 */

/** Five a minute, matching the express limiter this replaces on the REST side. */
const MAX_CALLS = 5;
const WINDOW_MS = 60_000;

/** Call timestamps per key, newest last. Pruned on read, so an idle key costs nothing after its window. */
const calls = new Map<string, number[]>();

/**
 * Record a destructive call and say whether it is allowed.
 *
 * Returns `false` when the key has already made `MAX_CALLS` inside the window — and does NOT record the
 * refused call, so a caller hammering the limit does not push its own window forward for ever.
 *
 * @param key the calling token's id, or its IP when it has none. A token, not a space: the limit is on the
 *            caller, because "five spaces emptied in a minute" is the thing being prevented.
 */
export function consumeHeavyToolCall(key: string): boolean {
  const now = Date.now();

  /*
   * Prune every expired key on the way past, not just this one's.
   *
   * The first version exported a `pruneHeavyToolCalls` for a caller to run on a schedule, and nothing
   * called it — a bound that exists only in a function nobody invokes is not a bound. Doing it here costs
   * a walk of a map holding one entry per token that has wiped something in the last minute, which is
   * small by construction, and it cannot be forgotten.
   */
  for (const [k, times] of calls) {
    if (times.length === 0 || times[times.length - 1]! + WINDOW_MS <= now) calls.delete(k);
  }

  const recent = (calls.get(key) ?? []).filter(t => now - t < WINDOW_MS);
  if (recent.length >= MAX_CALLS) {
    // The refused call is NOT recorded: a caller hammering the limit would otherwise push its own window
    // forward for ever and never be let back in.
    calls.set(key, recent);
    return false;
  }
  recent.push(now);
  calls.set(key, recent);
  return true;
}
