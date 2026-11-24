/**
 * The cooldown of a caller an import door refused for its upload's pace (bundle-270, Q-953, design revision 2, challenge finding F3).
 *
 * ## What it prevents
 *
 * **A looping sender holding the door.** A refusal for a stalled or trickling upload frees the door, but a caller that sends a byte, is
 * refused, and connects again took it back each time. After a pace refusal the same caller (its token, else its address) is answered `429`
 * with `Retry-After` on that door for one window of the upload pace (`uploadPace().windowMs`), before its body is read. Other callers are not
 * touched, and the door's own busy answer is unchanged. The sequence is this module's, not each door's (lens finding D2): a door names its pace
 * codes once, asks `waitOf` before it reads and tells `noteRefusal` what it answered, and the caller's key is never the door's to spell.
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

/**
 * One door's cooldown. A door asks it before it reads a body ({@link UploadCooldown.waitOf}) and tells it every refusal it answers
 * ({@link UploadCooldown.noteRefusal}); the caller's key, the pace codes and the table are inside, so a door cannot ask without them or note a
 * refusal that is not a pace's.
 */
export interface UploadCooldown {
  /** The whole seconds the caller of `req` must still wait (at least 1), or undefined when it is not cooled down. */
  waitOf(req: Request): number | undefined;
  /** `req`'s upload was refused with `code` (none, for a refusal that has no code): the caller is cooled down for one window when it is a pace code of this door, and nothing happens otherwise. */
  noteRefusal(req: Request, code: string | undefined): void;
}

/** Every door's table, so a test can forget them all. */
const tables = new Set<Map<string, number>>();

/** A cooldown of its own for one door (made once, where the door is declared), started by the refusals with `paceCodes`. */
export function uploadCooldown(paceCodes: ReadonlySet<string>): UploadCooldown {
  /** Each caller's end of cooldown, oldest first (a note moves its caller to the end). */
  const until = new Map<string, number>();
  tables.add(until);
  return {
    noteRefusal(req, code) {
      if (code === undefined || !paceCodes.has(code)) return;
      const key = uploadCallerKey(req);
      const now = Date.now();
      for (const [k, t] of until) { if (t <= now) until.delete(k); else break; }
      until.delete(key);
      until.set(key, now + uploadPace().windowMs);
      for (const oldest of until.keys()) {
        if (until.size <= UPLOAD_COOLDOWN_CALLERS_MAX) break;
        until.delete(oldest);
      }
    },
    waitOf(req) {
      const key = uploadCallerKey(req);
      const t = until.get(key);
      if (t === undefined) return undefined;
      const left = t - Date.now();
      if (left <= 0) { until.delete(key); return undefined; }
      return Math.max(1, Math.ceil(left / MS_PER_SECOND));
    },
  };
}

/** Who a cooldown is kept for: the request's token, else the address it came from. */
function uploadCallerKey(req: Request): string {
  const id = (req.authToken as { id?: unknown } | undefined)?.id;
  if (typeof id === 'string' && id.length > 0) return `token:${id}`;
  return `address:${requestAddress(req)}`;
}

/** Forget every door's cooldowns (a test whose refusal must not reach the next case). */
export function forgetUploadCooldownsForTest(): void {
  for (const t of tables) t.clear();
}
