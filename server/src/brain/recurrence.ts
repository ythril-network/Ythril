/**
 * What a chrono entry's `recurrence` block may say, in one place (moved out of `brain/chrono.ts`, bundle-270 review F2).
 *
 * ## What it prevents
 *
 * The REST door, the MCP tool and the bulk import each read a `recurrence` block through {@link parseRecurrence}, and the RDF import's dry plan
 * asks it of a chrono built from a document (`record-checks.ts`): a block no door would store ({freq} missing, an interval of zero) must be
 * refused by every writer in the same words. It is its own leaf module (it imports nothing of the server) so the shared record checks, which
 * the write planners reach, can ask it without joining the server's largest import cycle.
 */
import type { ChronoEntry } from '../config/types.js';

/**
 * The recurrence frequencies a chrono entry may repeat on. EXPORTED so a test can exercise all of them
 * rather than naming four -- a fifth would otherwise be accepted by this validator and tried by nothing.
 */
export const RECURRENCE_FREQ = ['daily', 'weekly', 'monthly', 'yearly'] as const;

/**
 * Validate and normalise a `recurrence` block.
 *
 * Shared by REST and MCP. REST previously destructured `recurrence` straight out of the request body and handed it to createChrono with NO
 * shape check — unlike every sibling field — so an arbitrary object could be persisted and later fed to date logic. MCP did not expose it at
 * all, so recurring entries were unreachable for agents.
 *
 * Returns `{ ok: true, value }` (value `undefined` when absent), or `{ ok: false, error }`.
 */
export function parseRecurrence(
  raw: unknown,
): { ok: true; value: ChronoEntry['recurrence'] } | { ok: false; error: string } {
  if (raw == null) return { ok: true, value: undefined };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'recurrence must be an object' };
  }
  const r = raw as Record<string, unknown>;

  const freq = r['freq'];
  if (typeof freq !== 'string' || !(RECURRENCE_FREQ as readonly string[]).includes(freq)) {
    return { ok: false, error: `recurrence.freq must be one of: ${RECURRENCE_FREQ.join(', ')}` };
  }

  // `interval` is required by the type. Default it rather than persisting a half-formed
  // block that would later read as NaN.
  let interval = 1;
  if (r['interval'] !== undefined) {
    if (typeof r['interval'] !== 'number' || !Number.isInteger(r['interval']) || r['interval'] < 1) {
      return { ok: false, error: 'recurrence.interval must be a positive integer' };
    }
    interval = r['interval'];
  }

  let until: string | undefined;
  if (r['until'] !== undefined) {
    if (typeof r['until'] !== 'string' || Number.isNaN(Date.parse(r['until']))) {
      return { ok: false, error: 'recurrence.until must be an ISO 8601 date string' };
    }
    until = r['until'];
  }

  return {
    ok: true,
    value: { freq: freq as 'daily' | 'weekly' | 'monthly' | 'yearly', interval, ...(until ? { until } : {}) },
  };
}
