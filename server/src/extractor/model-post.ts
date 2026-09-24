/**
 * One POST to a hosted model, with the waiting done right — shared by the extractors' decision client
 * (`decide.ts`) and their generation client (`generate.ts`).
 *
 * What a hand-written copy drops is the part that looks like boilerplate: the retry set and its END. 429, 503
 * and 529 mean *not now*, so they are waited out, honouring `Retry-After` when the backend says how long; a
 * 4xx means *not this* and is never retried, because asking again cannot fix it; and the retries STOP, so an
 * outage is an error rather than a hang. A caller that forgot the stop would spin on an overloaded provider for
 * as long as the process lives.
 *
 * The error type is the caller's, because each caller's failure means something different to ITS caller.
 */
import { boundedErrorText } from '../util/bounded-read.js';

/** How a request travels. Handed in by tests; in production an SSRF-guarded fetch with the slot's policy. */
export interface ModelTransport {
  post?: (url: string, init: RequestInit & { headers: Record<string, string>; body: string }) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
}

/** Statuses that mean "not now" rather than "not this": rate-limited, overloaded, unavailable. */
const RETRYABLE = new Set([429, 503, 529]);
/** Waits before each retry. Four attempts in all: a backend overloaded for longer than this is an outage. */
const BACKOFF_MS = [1_000, 4_000, 15_000];

export async function postWithBackoff(
  transport: Required<ModelTransport>,
  url: string,
  init: RequestInit & { headers: Record<string, string>; body: string },
  fail: (message: string, status?: number) => Error,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try { res = await transport.post(url, init); }
    catch (e) { throw fail(`unreachable (${url}): ${e instanceof Error ? e.message : String(e)}`); }
    if (res.ok) return res;
    if (!RETRYABLE.has(res.status) || attempt >= BACKOFF_MS.length) {
      throw fail(`HTTP ${res.status}: ${await boundedErrorText(res)}`, res.status);
    }
    // A Retry-After in seconds is the backend telling us exactly how long; otherwise the schedule.
    const after = Number(res.headers.get('retry-after'));
    await transport.sleep(Number.isFinite(after) && after > 0 ? Math.min(after * 1_000, 60_000) : BACKOFF_MS[attempt]!);
  }
}
