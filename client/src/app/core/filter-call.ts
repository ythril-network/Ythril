import type { HttpClient } from '@angular/common/http';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

/**
 * Call the `filter` tool and hand back what it answered — the ONE place this client unwraps a tool envelope.
 *
 * ## Why there is an envelope to unwrap at all
 *
 * `POST /api/<tool-name>` is the REST door onto the tools, and it answers one shape for every tool so a
 * caller writes the response handling once: `{ok: true, text, data}` on success, `{ok: false, error, data}`
 * on refusal. `text` is the prose an agent would read and `data` is the structured result — both carry the
 * whole answer, neither is a summary of the other.
 *
 * `POST /api/brain/filter` used to answer `{results, total, …}` directly, and it was deleted in `B-9` step
 * 3c because it was not a thin route over the tool: it was four hundred lines re-implementing what
 * `callTool` already does. Two implementations of one capability, and the weaker one winning silently is
 * the defect this codebase produces most.
 *
 * ## Why one function rather than an unwrap at each call site
 *
 * There are five: the four Brain tabs' pager, the by-id read, the exact-name lookup, the id-set lookup and
 * the file-metadata read — and the last lives in a different service. Five unwraps is five places to get
 * the failure branch wrong, and the failure branch is the one nobody exercises.
 *
 * ## The guard, which is what a hand-written copy drops
 *
 * **A refusal arrives as a non-2xx, so `HttpClient` errors and the caller's `catchError` sees it.** What it
 * does NOT do is protect against a `200` whose `data` is missing — a shape that should not happen and would
 * otherwise reach a component as `undefined` and be drawn as an empty page. That reads exactly like "the
 * collection is empty", which is the one wrong answer nobody reports. So it throws instead.
 */
export function filterCall<T = Record<string, unknown>>(
  http: HttpClient,
  body: Record<string, unknown>,
): Observable<T> {
  return http
    .post<{ ok: boolean; text?: string; error?: string; data: T | null }>('/api/filter', body)
    .pipe(map(r => {
      if (!r.ok || r.data == null) {
        throw new Error(r.error ?? 'filter answered without a result');
      }
      return r.data;
    }));
}
