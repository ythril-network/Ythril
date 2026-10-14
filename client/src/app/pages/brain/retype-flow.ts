import { Observable, type Unsubscribable } from 'rxjs';
import { retypeKeys } from '../../core/refusal-text';
import type { RetypeConfirmService } from '../../core/retype-confirm.service';

/**
 * The ONE way a brain record update is sent (bundle-23, Q-93, R6-14).
 *
 * ## What it is for
 *
 * Under a strict schema a write is refused (HTTP 422) when it leaves a property the record's type does not declare and the old
 * type did: changing a record's type introduces those keys. The way out is to remove them WITH the change, and that deletes data,
 * so the person has to say yes. Eight places change a type (the four tabs' inline rows and the drawer's four kinds) and each used
 * to call `brainApi.update*` by itself, which is how a flow added to one is absent from the next. Every update goes through
 * `saveWithRetype`, and `retype-flow.spec.ts` derives the callers from the sources and holds each one to it.
 *
 * ## The flow
 *
 * - the update is sent as it is;
 * - a refusal whose introduced rows are ALL undeclared-key rows, of a write that CHANGES the record's type (`typeChanged`), asks once, through `RetypeConfirmService`, with the keys (no
 *   `properties.` prefix) and their values; any other row (a rule, a type mismatch) means removing keys would not fix the write,
 *   so it is an ordinary refusal and is passed on untouched, as is a refusal that lists only pre-existing rows;
 * - yes: the update is sent AGAIN with `deleteFields: ['properties.<key>', ...]` and a `properties` map without those keys; the
 *   server caps one write at {@link MAX_DELETE_FIELDS} deleted fields, so a larger set comes back as a second refusal and a second
 *   confirmation, and the newest keys come first in each resend;
 * - no: the observable fails with {@link RetypeCancelled}, which the caller answers by putting its type control back.
 *
 * A write that does not change the type is never offered the removal: its undeclared keys are the record's own, an ordinary refusal
 * the editor shows against the rows that hold them, for the person to remove or declare. (The removal is the answer to what a
 * retype INTRODUCED, which is why the caller says whether it retyped.)
 *
 * A write that simply succeeds (warn or off mode, or a type whose keys are all declared) never asks.
 *
 * `send` is the caller's own update observable; only its `subscribe` is used.
 */

/** The server's cap on `deleteFields` per write. */
export const MAX_DELETE_FIELDS = 100;

/** What the update body must carry for a resend: the property map and the delete list. */
export interface RetypeBody {
  properties?: Record<string, string | number | boolean>;
  deleteFields?: string[];
}

/** The person declined the removal: nothing more was sent and the caller restores the control they changed. */
export class RetypeCancelled {
  constructor(readonly refusal: unknown) {}
}

export const isRetypeCancelled = (e: unknown): e is RetypeCancelled => e instanceof RetypeCancelled;

/** The body of the resend: `keys` removed from `properties` and added to `deleteFields` (the newest first, capped), earlier ones kept while they fit. */
function resendBody<B extends RetypeBody>(body: B, keys: string[]): B {
  // Only the keys that fit in this write are removed from it: one that does not fit stays in `properties`, so the server refuses
  // it again and the person is asked about it, instead of the key being dropped from the write and left stored.
  const removed = new Set(keys.slice(0, MAX_DELETE_FIELDS));
  const properties = Object.fromEntries(Object.entries(body.properties ?? {}).filter(([k]) => !removed.has(k)));
  const earlier = (body.deleteFields ?? []).filter(f => !removed.has(f.replace(/^properties\./, '')));
  const deleteFields = [...[...removed].map(k => `properties.${k}`), ...earlier].slice(0, MAX_DELETE_FIELDS);
  return { ...body, properties, deleteFields };
}

export function saveWithRetype<R, B extends RetypeBody>(
  confirm: Pick<RetypeConfirmService, 'confirm'>,
  send: (body: B) => Observable<R>,
  body: B,
  typeChanged: boolean,
): Observable<R> {
  return new Observable<R>(subscriber => {
    let inner: Unsubscribable | undefined;
    let closed = false;

    const attempt = (b: B): void => {
      inner = send(b).subscribe({
        next: value => { if (!closed) { subscriber.next(value); subscriber.complete(); } },
        error: err => {
          if (closed) return;
          const keys = typeChanged ? retypeKeys(err) : null;
          if (!keys) { subscriber.error(err); return; }
          confirm.confirm(keys).then(
            yes => {
              if (closed) return;
              if (!yes) { subscriber.error(new RetypeCancelled(err)); return; }
              attempt(resendBody(b, keys.map(k => k.key)));
            },
            failure => { if (!closed) subscriber.error(failure); },
          );
        },
      });
    };
    attempt(body);
    return () => { closed = true; inner?.unsubscribe?.(); };
  });
}
