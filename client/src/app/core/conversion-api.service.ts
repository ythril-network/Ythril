import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, forkJoin, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { filterCall } from './filter-call';
import { retryAfterSecondsOf } from './retry-after';
import type { RefusalSource } from './refusal-text';
import type { TypedKind } from './type-field';
import { blockCounts, blockRecordsFilter, rewrittenFilter, COLLECTION_OF_KIND, type BlockCounts, type ConvertBlock } from './conversion-counts';
import {
  CONVERSION_REFUSAL_KIND,
  type ConversionRefusal, type ConversionResult, type ConversionStep, type ConvertNoticeState, type ConvertRunNotice, type ConvertStartAnswer,
  type ConvertStatusAnswer, type ConvertTypeRef, type DismissOneAnswer, type DismissShownAnswer, type UnconvertedDismissRequest, type UnconvertedFilter,
  type UnconvertedListAnswer, type UnconvertedQuery,
} from './conversion.types';

/**
 * The record-conversion calls of the Schema tab and of Review (bundle-285, Q-747, plan section 6): start a run, read how it went, list and
 * dismiss the records it could not convert, and count a type's records before a run.
 *
 * ## What it prevents
 *
 * - **A refusal thrown as a string.** Every call that can be refused answers {@link ConversionResult}: the value, or a typed
 *   {@link ConversionRefusal} the page words (a bad step with its index, the rate limit with the seconds, a missing right, a conversion
 *   already running, a count that moved). {@link conversionRefusalOf} is the ONE reading of a refused request, the Save's PATCH included,
 *   so the dialog and the Convert act cannot word the same refusal two ways.
 * - **A count that is a failure.** {@link ConversionApi.countsFor} answers `{ ok: false }` when any read failed or carried no `total`; the
 *   dialog says it could not count and still offers both outcomes. A zero is only ever a real zero.
 * - **A wire shape guessed twice.** The types are `conversion.types.ts`, held to the server's source by `testing/conversion-contract.spec.ts`.
 *
 * The save itself is `SpacesApi.updateSpace` (it already carries If-Match); its answer's `convert` is read by {@link convertNoticeOf}.
 */

const base = (spaceId: string): string => `/api/spaces/${encodeURIComponent(spaceId)}/schema-convert`;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The longest server sentence a refusal carries along: a refusal quotes peer-chosen names, and a page shows it as text. */
const SENTENCE_MAX = 600;

/**
 * What a refused conversion request is, as a page words it. `err` is an `HttpErrorResponse` or anything thrown; a request that never
 * answered is `other` with status 0. A code the client has no kind for, and a kind whose numbers the body lacks (`step`, `current`, `max`),
 * is `other` with the server's own sentence and the code: the page shows what the server said, never a number made up.
 */
export function conversionRefusalOf(err: unknown): ConversionRefusal {
  const source: RefusalSource = isRecord(err) ? err as RefusalSource : {};
  const status = typeof source.status === 'number' ? source.status : 0;
  // What the body is at run time, not what the type says: a proxy's page is a string, and a network failure's is a ProgressEvent.
  const raw: unknown = source.error;
  const body = isRecord(raw) ? raw : null;
  const code = typeof body?.['code'] === 'string' ? body['code'] : undefined;
  const sentence = typeof body?.['error'] === 'string' ? body['error']
    : typeof raw === 'string' ? raw
      : typeof source.message === 'string' ? source.message : '';
  const error = sentence.length > SENTENCE_MAX ? `${sentence.slice(0, SENTENCE_MAX - 1)}…` : sentence;
  const other: ConversionRefusal = { kind: 'other', status, ...(code !== undefined ? { code } : {}), error };

  if (status === 412) return { kind: 'stale' };
  const kind = code !== undefined && Object.hasOwn(CONVERSION_REFUSAL_KIND, code) ? CONVERSION_REFUSAL_KIND[code] : undefined;
  const whole = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
  switch (kind) {
    case 'bad_step': {
      const step = body?.['step'];
      return whole(step) ? { kind: 'bad_step', step, error } : other;
    }
    case 'rate_limited':
      return { kind: 'rate_limited', retryAfterSeconds: retryAfterSecondsOf(err) };
    case 'no_right':
      return code === 'knowledge_rung' || code === 'space_admin_required' || code === 'unconverted_rung' ? { kind: 'no_right', code, error } : other;
    case 'running': return { kind: 'running' };
    case 'item_gone': return { kind: 'item_gone' };
    case 'needs_meta': return { kind: 'needs_meta' };
    case 'changed': {
      const current = body?.['current'];
      return whole(current) ? { kind: 'changed', current } : other;
    }
    case 'too_many': {
      const max = body?.['max'];
      return whole(max) ? { kind: 'too_many', max } : other;
    }
    default: return other;
  }
}

const NOTICE_STATES: readonly ConvertNoticeState[] = ['started', 'after_vote', 'nothing', 'not_started'];

/**
 * The `convert` a save's answer carries (200 applied, or 202 `vote_pending`): what became of the run the save asked for. `null` when the
 * answer carries none (the save carried no `convertRecords`) or carries one this client cannot read (a state it does not know, no types):
 * the page then says nothing about a run rather than guess one.
 */
export function convertNoticeOf(answer: unknown): ConvertRunNotice | null {
  const convert = isRecord(answer) ? answer['convert'] : undefined;
  if (!isRecord(convert) || !Array.isArray(convert['types'])) return null;
  const state = NOTICE_STATES.find(s => s === convert['state']);
  if (state === undefined) return null;
  const types = convert['types'].filter((t): t is ConvertTypeRef =>
    isRecord(t) && typeof t['kind'] === 'string' && Object.hasOwn(COLLECTION_OF_KIND, t['kind']) && typeof t['type'] === 'string');
  return {
    state,
    types,
    ...(typeof convert['toFp'] === 'string' ? { toFp: convert['toFp'] } : {}),
    ...(typeof convert['error'] === 'string' ? { error: convert['error'] } : {}),
  };
}

/** What a count read of the `filter` tool answers when it was asked for one row: the exact `total` of everything the filter matches. */
interface FilterTotal { total?: unknown }

@Injectable({ providedIn: 'root' })
export class ConversionApi {
  private readonly http = inject(HttpClient);

  /** Run a request and answer its value, or its refusal: nothing a page needs to word is thrown. */
  private result<T>(request: Observable<T>): Observable<ConversionResult<T>> {
    return request.pipe(
      map((value): ConversionResult<T> => ({ ok: true, value })),
      catchError(err => of<ConversionResult<T>>({ ok: false, refusal: conversionRefusalOf(err) })),
    );
  }

  /**
   * Convert the records of `types` toward the schema the space has now, with optional steps (the Convert act: it changes no schema and is never
   * voted). `steps` is sent only when there are some: Convert again takes none.
   */
  start(spaceId: string, types: readonly ConvertTypeRef[], steps: readonly ConversionStep[] = []): Observable<ConversionResult<ConvertStartAnswer>> {
    return this.result(this.http.post<ConvertStartAnswer>(base(spaceId), { types, ...(steps.length > 0 ? { steps } : {}) }));
  }

  /** The run as it stands: a run, `{ state: 'none' }`, or one run per member for a personal view. */
  status(spaceId: string): Observable<ConversionResult<ConvertStatusAnswer>> {
    return this.result(this.http.get<ConvertStatusAnswer>(base(spaceId)));
  }

  /** One page of the records a conversion could not convert, newest first; `reasons` is the list form of the server's `reason` filter. */
  listUnconverted(spaceId: string, query: UnconvertedQuery = {}): Observable<ConversionResult<UnconvertedListAnswer>> {
    let params = new HttpParams();
    if (query.kind) params = params.set('kind', query.kind);
    if (query.type) params = params.set('type', query.type);
    if (query.reasons && query.reasons.length > 0) params = params.set('reason', query.reasons.join(','));
    if (query.status) params = params.set('status', query.status);
    if (query.skip) params = params.set('skip', String(query.skip));
    if (query.limit !== undefined) params = params.set('limit', String(query.limit));
    return this.result(this.http.get<UnconvertedListAnswer>(`${base(spaceId)}/items`, { params }));
  }

  /** How many records were left unchanged because this instance refused the steps they needed; `null` when it could not be read (nothing is shown). */
  refusedCount(spaceId: string): Observable<number | null> {
    return this.listUnconverted(spaceId, { reasons: ['step_refused'], limit: 1 }).pipe(
      map(r => (r.ok && Number.isInteger(r.value.total) ? r.value.total : null)),
    );
  }

  /** Dismiss one item: the record is not touched and the item is not opened again for the same record version and target. */
  dismissOne(spaceId: string, itemId: string): Observable<ConversionResult<DismissOneAnswer>> {
    return this.result(this.http.post<DismissOneAnswer>(`${base(spaceId)}/items/${encodeURIComponent(itemId)}/dismiss`, {}));
  }

  /** Dismiss every open item the filter lists, when the user was shown exactly `expect` of them (else the answer is `changed`, and nothing is dismissed). */
  dismissShown(spaceId: string, request: UnconvertedFilter & { expect: number }): Observable<ConversionResult<DismissShownAnswer>> {
    const body: UnconvertedDismissRequest = {
      ...(request.kind ? { kind: request.kind } : {}),
      ...(request.type ? { type: request.type } : {}),
      ...(request.reasons && request.reasons.length > 0 ? { reason: [...request.reasons] } : {}),
      expect: request.expect,
    };
    return this.result(this.http.post<DismissShownAnswer>(`${base(spaceId)}/items/dismiss`, body));
  }

  /** The exact number of records `filter` matches (one row asked for, nothing read of it); throws when the answer carries none. */
  private totalOf(spaceId: string, kind: TypedKind, filter: Record<string, unknown>, extra: Record<string, unknown> = {}): Observable<number> {
    return filterCall<FilterTotal>(this.http, {
      space: spaceId, collection: COLLECTION_OF_KIND[kind], filter, ...extra, limit: 1, projection: { _id: 1 },
    }).pipe(map(r => {
      if (typeof r.total !== 'number' || !Number.isFinite(r.total)) throw new Error('filter answered without a total');
      return r.total;
    }));
  }

  /**
   * What the steps of a block would do to the type's records, counted before the run: the type's records, and (only when a property step
   * decides it) the records it rewrites. `{ ok: false }` when a read failed: the dialog says it could not count and still offers both outcomes.
   */
  countsFor(spaceId: string, block: ConvertBlock): Observable<{ ok: true; counts: BlockCounts } | { ok: false }> {
    const rewritten = rewrittenFilter(block);
    return forkJoin([
      this.totalOf(spaceId, block.kind, blockRecordsFilter(block)),
      rewritten ? this.totalOf(spaceId, block.kind, rewritten) : of(null),
    ]).pipe(
      map(([total, changed]) => ({ ok: true as const, counts: blockCounts(block, { total, rewritten: changed }) })),
      catchError(() => of({ ok: false as const })),
    );
  }

  /** How many records of the type are on an older version of the schema than the current one (forks left out); `null` when it could not be read. */
  olderCount(spaceId: string, kind: TypedKind, type: string): Observable<number | null> {
    return this.totalOf(spaceId, kind, blockRecordsFilter({ kind, type, steps: [] }), { schemaVersion: 'older' }).pipe(catchError(() => of(null)));
  }
}
