import type { HttpClient } from '@angular/common/http';
import { map, of, type Observable } from 'rxjs';
import { filterCall } from './filter-call';

/**
 * A page of records, with the ids each one links to — in ONE extra call, for the whole page.
 *
 * ## Why the client has to do this at all
 *
 * A record used to carry its connections: a fact had `entityIds`, a chrono entry had `entityIds` and
 * `memoryIds`, a file had three. 5.0 made a connection a LINK RECORD, so nothing comes back on the record
 * and every list that drew chips from those fields would draw none.
 *
 * ## Why per PAGE and never per record
 *
 * One query on the `{from, …}` index returns the whole page's links, and the classes are separated in
 * memory. Asking per record is a request per row — the same mistake the server made and measured at 3.8×
 * slower before it batched, on a list that can show two hundred rows.
 *
 * ## Why the fields are named as the WRITE doors name them
 *
 * `linkEntities`, `linkFacts`, `linkChronos` — what a caller sends. A view model that kept the 4.x names
 * would have every component reading a field the API neither accepts nor returns, which is how somebody
 * later "restores" it to the request body and gets a `400`.
 */

/** What one record links to, by class. Absent means the page was never hydrated; empty means no links. */
export interface RecordLinks {
  linkEntities?: string[];
  linkFacts?: string[];
  linkChronos?: string[];
}

/** The record kinds a link can start from. An entity is only ever the far end. */
export type LinkFromKind = 'fact' | 'chrono' | 'file';

const FIELD_FOR: Record<string, keyof RecordLinks> = {
  entity: 'linkEntities',
  fact: 'linkFacts',
  chrono: 'linkChronos',
};

interface LinkRow { from: string; to: string; toKind: string }

/**
 * Fill each row's link fields from the links collection.
 *
 * Returns the rows unchanged when there are none to ask about, so a caller can pipe this unconditionally
 * — an empty `$in` would be a request that can only answer nothing.
 */
export function hydrateLinks<T extends { _id: string }>(
  http: HttpClient,
  spaceId: string,
  fromKind: LinkFromKind,
  rows: T[],
): Observable<(T & RecordLinks)[]> {
  const ids = rows.map(r => r._id);
  if (ids.length === 0) return of(rows as (T & RecordLinks)[]);

  return filterCall<{ results: LinkRow[] }>(http, {
    space: spaceId,
    collection: 'links',
    filter: { from: { $in: ids }, fromKind },
    // One per row per class is the ceiling that matters; a page is 200 rows and a record's links are few.
    limit: 2000,
  }).pipe(map(r => {
    const byFrom = new Map<string, RecordLinks>();
    for (const row of r.results ?? []) {
      const field = FIELD_FOR[row.toKind];
      if (!field) continue;
      const bucket = byFrom.get(row.from) ?? {};
      (bucket[field] ??= []).push(row.to);
      byFrom.set(row.from, bucket);
    }
    /*
     * EVERY row gets the fields, including the ones with no links. Leaving them absent would make "not
     * hydrated" and "nothing linked" the same value, and a component cannot tell those apart — which is
     * the distinction that decides whether it draws an empty list or waits.
     */
    return rows.map(row => ({
      linkEntities: [], linkFacts: [], linkChronos: [],
      ...row,
      ...byFrom.get(row._id),
    }));
  }));
}

/** The ids of records of `fromKind` that link TO any of `toIds` — the other direction, for a filter. */
export function recordsLinkingTo(
  http: HttpClient,
  spaceId: string,
  fromKind: LinkFromKind,
  toIds: string[],
): Observable<string[]> {
  if (toIds.length === 0) return of([]);
  return filterCall<{ results: LinkRow[] }>(http, {
    space: spaceId,
    collection: 'links',
    filter: { to: { $in: toIds }, fromKind },
    limit: 2000,
  }).pipe(map(r => [...new Set((r.results ?? []).map(l => l.from))]));
}
