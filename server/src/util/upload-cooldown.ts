/**
 * The cooldown of a caller an import door refused for its upload's pace (bundle-270, Q-953, design revision 2, challenge finding F3).
 *
 * ## What it prevents
 *
 * **A looping sender holding the door.** A refusal for a stalled or trickling upload frees the door, but a caller that sends a byte, is
 * refused, and connects again took it back each time. After a pace refusal the same caller (its token, else its address) is answered `429`
 * with `Retry-After` on that door for one window of the upload pace (`uploadPace().windowMs`), before its body is read. Other callers are not
 * touched, and the door's own busy answer is unchanged.
 *
 * ## What it bounds
 *
 * Each door remembers at most {@link UPLOAD_COOLDOWN_CALLERS_MAX} callers, in memory: past it the oldest is forgotten, as is every entry
 * whose window has passed. A restart forgets them all, which costs a looping sender one more refusal.
 */
import type { Request } from 'express';
import { uploadPace } from './upload-reader.js';
import { requestAddress } from '../audit/request-address.js';

/** The most callers one door remembers as cooled down. */
export const UPLOAD_COOLDOWN_CALLERS_MAX = 10_000;
const MS_PER_SECOND = 1_000;

/** One door's cooldown. */
export interface UploadCooldown {
  /** `key` was refused for its pace now: cooled down for one window. */
  note(key: string): void;
  /** The whole seconds `key` must still wait (at least 1), or undefined when it is not cooled down. */
  retryAfterSeconds(key: string): number | undefined;
}

/** Every door's table, so a test can forget them all. */
const tables = new Set<Map<string, number>>();

/** A cooldown of its own for one door (made once, where the door is declared). */
export function uploadCooldown(): UploadCooldown {
  /** Each caller's end of cooldown, oldest first (a note moves its caller to the end). */
  const until = new Map<string, number>();
  tables.add(until);
  return {
    note(key) {
      const now = Date.now();
      for (const [k, t] of until) { if (t <= now) until.delete(k); else break; }
      until.delete(key);
      until.set(key, now + uploadPace().windowMs);
      for (const oldest of until.keys()) {
        if (until.size <= UPLOAD_COOLDOWN_CALLERS_MAX) break;
        until.delete(oldest);
      }
    },
    retryAfterSeconds(key) {
      const t = until.get(key);
      if (t === undefined) return undefined;
      const left = t - Date.now();
      if (left <= 0) { until.delete(key); return undefined; }
      return Math.max(1, Math.ceil(left / MS_PER_SECOND));
    },
  };
}

/** Who a cooldown is kept for: the request's token, else the address it came from. */
export function uploadCallerKey(req: Request): string {
  const id = (req.authToken as { id?: unknown } | undefined)?.id;
  if (typeof id === 'string' && id.length > 0) return `token:${id}`;
  return `address:${requestAddress(req)}`;
}

/** Forget every door's cooldowns (a test whose refusal must not reach the next case). */
export function forgetUploadCooldownsForTest(): void {
  for (const t of tables) t.clear();
}
