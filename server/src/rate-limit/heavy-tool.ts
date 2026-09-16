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
  const recent = (calls.get(key) ?? []).filter(t => now - t < WINDOW_MS);
  if (recent.length >= MAX_CALLS) {
    calls.set(key, recent);
    return false;
  }
  recent.push(now);
  calls.set(key, recent);
  return true;
}

/** Drop every counter. For tests, which would otherwise carry one suite's calls into the next. */
export function resetHeavyToolCalls(): void {
  calls.clear();
}

/**
 * Prune keys whose window has passed.
 *
 * The map is keyed by token id, so it is bounded by the number of tokens in normal use — but the fallback
 * key is an IP, and an unauthenticated flood would otherwise grow it without limit.
 */
export function pruneHeavyToolCalls(): void {
  const now = Date.now();
  for (const [key, times] of calls) {
    if (times.every(t => now - t >= WINDOW_MS)) calls.delete(key);
  }
}
