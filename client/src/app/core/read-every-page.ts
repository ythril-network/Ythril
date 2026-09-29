import { EMPTY, type Observable } from 'rxjs';
import { expand, map, reduce } from 'rxjs/operators';

/**
 * Every page of a paged answer, in order, by following `nextSkip` until the server stops sending one.
 *
 * One GET is one page, so a view that needs the whole list — to filter or sort it in the browser, or to save it
 * as a file — must read on, or it shows a part under a name that promises the whole. Written once here because it
 * was written three times (the read spill, the duplicate and the contradiction lists), and the line a hand-written
 * copy drops is the guard: **a `nextSkip` that does not move forward ends the walk**, or a server that repeats
 * itself turns one list into an endless loop of requests.
 *
 * A page that fails fails the whole read, so a partial list is never assembled and handed on as complete.
 */
export function readEveryPage<P extends { nextSkip?: number }>(
  page: (skip: number) => Observable<P>,
): Observable<P[]> {
  const at = (skip: number) => page(skip).pipe(map(p => ({ p, skip })));
  return at(0).pipe(
    expand(({ p, skip }) => (p.nextSkip !== undefined && p.nextSkip > skip ? at(p.nextSkip) : EMPTY)),
    reduce<{ p: P; skip: number }, P[]>((all, { p }) => { all.push(p); return all; }, []),
  );
}
