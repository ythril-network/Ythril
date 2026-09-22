import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { map, switchMap } from 'rxjs/operators';
import { filterCall } from './filter-call';
import { hydrateLinks, recordsLinkingTo } from './record-links';
import type {
  Fact, Entity, Edge, ChronoEntry, ChronoType, ChronoStatus,
  QueryCollection, QueryResult, RecallKnowledgeType, RecallResponse, TraverseResult, EmbeddingQueue,
  TokenAccessEntry, ErModel, ErModelMembers,
} from './api.types';

/**
 * A server-side sort request for a brain list endpoint. `field` must be one the server whitelists
 * for that collection (see the integration guide); an un-whitelisted field is a 400, so callers pass
 * only the columns the tab exposes a caret for.
 */
export interface ListSort {
  field: string;
  dir: 'asc' | 'desc';
}

/** Brain knowledge graph — facts, entities, edges, chrono, plus query/recall/traverse. */
/**
 * The body `POST /recall` takes — exported so ONE declaration serves both callers.
 *
 * It was inline on the method, which was fine while the only caller was the method. `U-1`'s JSON preview
 * needs the same type: it shows the request the panel would send, and a preview typed as a loose record
 * could contain a key the route refuses while still compiling. The route is `.strict()`, so that key would
 * be a 400 for whoever pasted the JSON — a preview being BELIEVED is the whole point of having one.
 */
export interface RecallRequestBody {
      /**
       * Which space to search. OMIT it and the search runs across every space the token may read — the
       * reason the route stopped carrying the space in its path at 5.0.
       */
      space?: string;
      query: string;
      topK?: number;
      types?: RecallKnowledgeType[];
      minScore?: number;
      /** Structured filter (same expression grammar as the query filter). */
      filter?: Record<string, unknown>;
      /** Restrict to records carrying these tags. */
      tags?: string[];
      /** Guarantee at least N hits per knowledge type, e.g. { entity: 2 }. */
      minPerType?: Partial<Record<RecallKnowledgeType, number>>;
      /** Cap hits per knowledge type, so one noisy type cannot fill the whole result set. */
      maxPerType?: number;
      /**
       * Also scan the newest records, for when the vector index has not caught up.
       *
       * A real boolean or absent — the route REJECTS a non-boolean rather than coercing, because `"false"` is truthy
       * and an opt-in that silently turns itself on is worse than one that errors.
       */
      /**
       * Whether file-chunk hits carry their passage body. `false` returns locations and metadata only.
       *
       * Defaults to `true` server-side, and a caller should leave it alone unless it means it: sending `false` makes
       * recall look as though it has stopped returning passages.
       */
      includeFileContent?: boolean;
      /**
       * Add back the fields a result carries for the SYSTEM: `matchedText`, `embeddingModel`, `seq` and the
       * per-stage scores. Recursive — a `traverse` answer's `_graph` follows it at every depth.
       *
       * Defaults to `false` server-side, on both doors. It exists for answering WHY something ranked where
       * it did; leaving it off is right for every ordinary search, because each of these is returned once
       * per result. The embedding vector is not among them and cannot be requested at all.
       */
      includeDiagnostics?: boolean;
      /**
       * Adds back the fields that say where a record SITS rather than what it says: `createdAt`,
       * `updatedAt` and the link-id arrays. Off by default — measured on a real corpus only 30% of an
       * answer was content. `createdAt` is when the RECORD was written, not when the remembered thing
       * happened; that date lives in the record’s own properties.
       */
      includeRecordMeta?: boolean;
      /**
       * Graph expansion depth, 0–5. Each match is expanded along edges and what the walk reached comes back
       * NESTED under it, as `_graph: [{edges, node, paths}]`, and a nested node carries its own `_graph` again.
       * It STAYS nested — see `relatedOf`, which reads a match's neighbourhood without moving anything into
       * the result list. This sentence used to point at a flattener that did move them, which is the bug the
       * owner reported: a neighbour arriving in rank order, counted in the total, looking like a match.
       *
       * The route has accepted this since recall existed; it was simply never declared here, so no UI could
       * ask for it.
       */
      traverse?: number | {
        /** How far to walk, 0–5. The object form's only required field. */
        depth: number;
        /**
         * Which way to follow an edge. Absent lets the route decide.
         *
         * This is the parameter the number form could not express, and the difference is not cosmetic:
         * outbound from a person reaches what they own, inbound reaches who named them. A walk that ignores
         * the distinction answers a different question and looks the same.
         */
        direction?: 'outbound' | 'inbound' | 'both';
        /** Only follow edges carrying these labels. Absent means every label. */
        edgeLabels?: string[];
        /**
         * Whether the walk also returns the chrono entries, facts and files it reached.
         *
         * All three arrived with A-2 INSIDE this object, which is why the mechanical five-places check did
         * not fire for them: it compares top-level request keys. They were reachable from an MCP call and
         * from nothing else for two releases.
         */
        includeChrono?: boolean;
        includeMemories?: boolean;
        includeFiles?: boolean;
      };
      /**
       * Which fields each result carries, as a Mongo-style projection.
       *
       * Declared as an object because the route takes one and it can EXCLUDE as well as include; a field
       * list would be a control that looks complete and cannot say half of what the parameter does. Getting
       * it wrong is invisible in a way a filter is not — a projection that omits the field somebody is
       * reading gives them a result that looks whole and is missing the answer.
       */
      projection?: Record<string, unknown>;
      /**
       * Deadline in ms. It can only LOWER the instance budget, and on expiry the answer is PARTIAL rather
       * than an error — whichever collections finished are returned, flagged as degraded.
       */
      maxTimeMS?: number;
      /**
       * Ceiling on the serialised response body, in bytes (operator default 100 000).
       *
       * The answer is the longest PREFIX of the ranked matches that fits, and every record in it is WHOLE.
       * Past the ceiling the response says `truncated` and carries `nextSkip`. A match is counted together
       * with its whole `_graph` subtree, so a deeper expansion means fewer matches fit.
       *
       * The other three units are declared below. This comment used to say `maxTokens` was deliberately
       * absent, because offering two overlapping numbers would make an operator work out which one won —
       * true of two numbers with no stated rule, and the wrong conclusion. **The server applies whichever
       * ceiling is SMALLEST**, so the honest answer is to say that once and offer all four.
       *
       * Characters and bytes are also not the same thing: treating them as interchangeable ran a German or
       * Polish space about a quarter over the limit it had been given, which was B-1.
       */
      maxBytes?: number;
      /** The same ceiling in CHARACTERS. Server floor 1000. */
      maxChars?: number;
      /** The same ceiling in TOKENS — the unit an agent's budget is written in. Server floor 1. */
      maxTokens?: number;
      /** Characters per token, for converting `maxTokens`. Means nothing without one. */
      /**
       * Skip this many ranked matches. Send back the response's `nextSkip` to continue a truncated answer.
       *
       * Absolute, not per-page: `nextSkip` already accounts for where the last answer started, so adding it
       * to the current skip would page twice and silently miss records.
       */
      skip?: number;
      /**
       * Also WRITE the matches that did not fit to the space, as a JSON file with a one-day download.
       *
       * The only parameter on this read route that writes anything, which is why it is opt-in and why the UI
       * says so on the control rather than in a tooltip.
       */
      remainderDump?: boolean;
}

@Injectable({ providedIn: 'root' })
export class BrainApi {
  private http = inject(HttpClient);

  /** Append `sort`/`dir` to a list request when a sort is active; a no-op otherwise. */
  /**
   * Read a page of one collection through the `filter` tool — the ONE shape, for every tab.
   *
   * ## Why the tabs move off their own routes
   *
   * `B-9`: one capability, one shape. Nine per-collection `GET` routes answered what `filter` answers,
   * and the client was the reason they stayed mounted. Four steps got them here — `filter` gained the
   * five list CONVENIENCES, then the two DECORATIONS those routes applied after the query, then
   * `limit` became a default instead of a silent clamp, then a chrono `status` started meaning the same
   * thing on both doors. Each of those was a gap that would have changed what a tab shows.
   *
   * ## The envelope is re-keyed here, deliberately
   *
   * `filter` answers `{ results }`; the tabs destructure `{ facts }`, `{ entities }`, `{ edges }`,
   * `{ chrono }`. Re-keying in the service means not one caller changes, which is what makes the route
   * deletion a server-only change afterwards — and what keeps THIS change reviewable as one thing.
   *
   * `total` and `truncated` are passed through untouched: a pager that lost them would page for ever.
   *
   * The collection is typed as `QueryCollection` — the route's OWN set, derived from the one tuple — and
   * not as the five the tabs happen to use. Four tabs is today's caller list, not this helper's question,
   * and writing the five out here would be a sixth copy of a list that gains a member for M-2.
   */
  private filterPage<T>(
    spaceId: string,
    collection: QueryCollection,
    key: string,
    body: Record<string, unknown>,
  ): Observable<Record<string, unknown>> {
    return filterCall<{ results: T[]; total: number; limit: number; skip: number; truncated: boolean }>(
      this.http, { space: spaceId, collection, ...body },
    ).pipe(map(r => ({ [key]: r.results, total: r.total, limit: r.limit, skip: r.skip, truncated: r.truncated })));
  }

  /**
   * ONE record by id, through the same door as a page of them.
   *
   * ## Why this exists rather than four `filter` calls written out
   *
   * `B-9` step 3 deleted `GET .../<collection>/:id` on all four collections. Each was `findOne({_id})` and
   * a 404, which is this predicate with a collection — and four hand-written copies would have been four
   * chances to drop the guard below.
   *
   * ## The guard, which is the whole reason this is a module
   *
   * **A route answered `404` for a record that is not there; `filter` answers an empty page.** A caller
   * that merely reads `results[0]` therefore emits `undefined` down its SUCCESS path, and every one of
   * these callers is a component that draws a panel from what it receives. So the absent case ERRORS here,
   * which is what the routes did, and the `catchError(() => of(null))` the callers already carry keeps
   * working untouched.
   *
   * That is the forgettable half: the happy path is identical either way, so a copy that omitted it would
   * pass every test written about a record that exists.
   *
   * ## And the SECOND guard, which the integration suite found before a user did
   *
   * **A chrono status is derived on read, and `filter` returns the stored one unless asked.** The route
   * derived it: an entry past its due moment read `overdue` whatever it was stored as, unless its type
   * says a passed date means nothing. Without `deriveStatus` here, the graph panel and the reference
   * picker would start showing `active` for an overdue entry — identical for every entry whose moment has
   * not passed, and wrong for exactly the one somebody is looking at.
   */
  private filterOne<T>(spaceId: string, collection: QueryCollection, id: string): Observable<T> {
    return filterCall<{ results: T[] }>(this.http, {
      space: spaceId, collection, filter: { _id: id }, limit: 1,
      ...(collection === 'chrono' ? { deriveStatus: true } : {}),
    })
      .pipe(map(r => {
        const doc = r.results?.[0];
        if (!doc) throw new Error(`${collection} '${id}' not found`);
        return doc;
      }));
  }

  /**
   * The sort pair, as `filter` takes it. Same field names and the same allowlist the routes used — it
   * is the same parser on the server, which is why nothing here has to translate.
   */
  private sortBody(sort?: ListSort): Record<string, unknown> {
    return sort ? { sort: sort.field, dir: sort.dir } : {};
  }

  private withSort(params: HttpParams, sort?: ListSort): HttpParams {
    return sort ? params.set('sort', sort.field).set('dir', sort.dir) : params;
  }

  /** Mint a single-use ticket to open the live-change SSE stream. EventSource can't send an
   *  Authorization header and a raw token in the URL leaks into logs/history, so the stream is opened
   *  with `?ticket=` instead. The ticket is single-use, short-lived, and bound to this space's stream. */
  mintEventsTicket(spaceId: string): Observable<{ ticket: string; expiresInMs: number }> {
    return this.http.post<{ ticket: string; expiresInMs: number }>(`/api/brain/spaces/${spaceId}/events/ticket`, {});
  }

  queryBrain(
    spaceId: string,
    body: {
      collection: QueryCollection;
      filter?: Record<string, unknown>;
      projection?: Record<string, unknown>;
      limit?: number;
      maxTimeMS?: number;
    },
  ): Observable<QueryResult> {
    return filterCall<QueryResult>(this.http, { ...body, space: spaceId });
  }

  /** Embedding-job backlog for a space (F9 Overview embedding-queue panel). */
  getEmbeddingQueue(spaceId: string): Observable<EmbeddingQueue> {
    return this.http.get<EmbeddingQueue>(`/api/brain/spaces/${spaceId}/embedding-queue/media`);
  }

  /** Re-queue every failed media job in a space (F9 Overview "retry all failed"). Returns the count reset. */
  retryFailedEmbeddings(spaceId: string): Observable<{ retried: number }> {
    return this.http.post<{ retried: number }>(`/api/brain/spaces/${spaceId}/embedding-queue/media/retry-failed`, {});
  }

  /** Which tokens can reach a space and at what level (F9 Overview matrix). ADMIN-only — 403 for others. */
  getTokenAccess(spaceId: string): Observable<{ tokens: TokenAccessEntry[] }> {
    return this.http.get<{ tokens: TokenAccessEntry[] }>(`/api/brain/spaces/${spaceId}/token-access`);
  }

  /**
   * Meaning-ranked search. The space rides in the BODY since 5.0, because the route has to be able to
   * express “search every space I can read” and a path segment cannot be omitted.
   *
   * The panel always names one — it is opened ON a space and rendering another space’s results under this
   * one’s name is the fabricated-context defect — so `spaceId` stays a required argument here even though
   * the API allows it to be omitted.
   */
  recallBrain(
    spaceId: string,
    body: RecallRequestBody,
  ): Observable<RecallResponse> {
    return this.http.post<RecallResponse>('/api/brain/recall', { ...body, space: spaceId });
  }

  // ── Brain — facts ──────────────────────────────────────────────────────

  /**
   * A page of facts, with the links each one has.
   *
   * **`entity` costs a first call now.** It was a predicate over the fact's own `linkEntities`; a connection
   * is a link record since 5.0, so the ids of the facts linked to that entity are read first and narrow
   * `_id`. The intersection with the other filters stays the SERVER's — they travel in the same
   * predicate — which is what keeps paging and `total` honest.
   */
  listFacts(spaceId: string, limit = 20, skip = 0, filters?: { tag?: string; entity?: string; type?: string; description?: string; properties?: string; entityName?: string }, sort?: ListSort, search?: string): Observable<{ facts: Fact[]; limit: number; skip: number }> {
    const linked$: Observable<string[] | null> = filters?.entity
      ? recordsLinkingTo(this.http, spaceId, 'fact', [filters.entity])
      : of(null);
    return linked$.pipe(switchMap(linkedIds => this.filterPage<Fact>(spaceId, 'facts', 'facts', {
      limit, skip, ...this.sortBody(sort),
      ...(linkedIds ? { filter: { _id: { $in: linkedIds } } } : {}),
      ...(filters?.tag ? { tag: filters.tag } : {}),
      ...(filters?.type ? { type: filters.type } : {}),
      ...(filters?.description ? { description: filters.description } : {}),
      ...(filters?.properties ? { properties: filters.properties } : {}),
      ...(filters?.entityName ? { entityName: filters.entityName } : {}),
      ...(search ? { search } : {}),
    }) as unknown as Observable<{ facts: Fact[]; limit: number; skip: number }>),
      switchMap(page => hydrateLinks(this.http, spaceId, 'fact', page.facts)
        .pipe(map(facts => ({ ...page, facts: facts as Fact[] })))));
  }

  deleteFact(spaceId: string, id: string): Observable<void> {
    return this.http.delete<void>(`/api/brain/spaces/${spaceId}/facts/${id}`);
  }

  createMemory(spaceId: string, body: { fact: string; type?: string; tags?: string[]; linkEntities?: string[]; description?: string; properties?: Record<string, string | number | boolean> }): Observable<Fact> {
    return this.http.post<Fact>(`/api/brain/spaces/${spaceId}/facts`, body);
  }

  updateFact(spaceId: string, id: string, body: Partial<{ fact: string; type: string; tags: string[]; linkEntities: string[]; description: string; properties: Record<string, string | number | boolean>; deleteFields: string[] }>): Observable<Fact> {
    return this.http.patch<Fact>(`/api/brain/spaces/${spaceId}/facts/${id}`, body);
  }

  // ── Brain — entities ──────────────────────────────────────────────────────

  listEntities(spaceId: string, limit = 50, skip = 0, filters?: { search?: string; type?: string; tag?: string; description?: string; properties?: string }, sort?: ListSort, search?: string): Observable<{ entities: Entity[] }> {
    // `filters.search` is the entity-search bar's EXACT `name` lookup, so it is a predicate; `search`
    // is the docked column freetext, which is the substring convenience. Two different questions that
    // have always shared a spelling here — the distinction is why this one cannot be folded.
    return this.filterPage<Entity>(spaceId, 'entities', 'entities', {
      limit, skip, ...this.sortBody(sort),
      ...(filters?.search ? { filter: { name: filters.search } } : {}),
      ...(filters?.type ? { type: filters.type } : {}),
      ...(filters?.tag ? { tag: filters.tag } : {}),
      ...(filters?.description ? { description: filters.description } : {}),
      ...(filters?.properties ? { properties: filters.properties } : {}),
      ...(search ? { search } : {}),
    }) as Observable<{ entities: Entity[] }>;
  }

  deleteEntity(spaceId: string, id: string): Observable<void> {
    return this.http.delete<void>(`/api/brain/spaces/${spaceId}/entities/${id}`);
  }

  /**
   * `type` is REQUIRED — owner's ruling `P-31`, 2026-09-04.
   *
   * Optional here mirrored a REST create that defaulted it to the empty string while the other three
   * entity doors demanded it. It is what selects the per-type property schema, so a typeless entity is one
   * nothing can validate. Required in the TYPE as well as on the form, so a second caller cannot omit it
   * and find out from a 400.
   */
  createEntity(spaceId: string, body: { name: string; type: string; tags?: string[]; description?: string; properties?: Record<string, string | number | boolean> }): Observable<Entity> {
    return this.http.post<Entity>(`/api/brain/spaces/${spaceId}/entities`, body);
  }

  updateEntity(spaceId: string, id: string, body: Partial<{ name: string; type: string; description: string; tags: string[]; properties: Record<string, string | number | boolean>; deleteFields: string[] }>): Observable<Entity> {
    return this.http.patch<Entity>(`/api/brain/spaces/${spaceId}/entities/${id}`, body);
  }

  // ── Brain — edges ─────────────────────────────────────────────────────────

  listEdges(spaceId: string, limit = 50, skip = 0, filters?: { type?: string; tag?: string; description?: string; properties?: string; fromName?: string; toName?: string }, sort?: ListSort, search?: string): Observable<{ edges: Edge[] }> {
    // `fromName`/`toName` are per-member JOINs `filter` resolves server-side — a client holding ids
    // could not, which is why they are arguments rather than something built here.
    return this.filterPage<Edge>(spaceId, 'edges', 'edges', {
      limit, skip, ...this.sortBody(sort),
      ...(filters?.type ? { type: filters.type } : {}),
      ...(filters?.tag ? { tag: filters.tag } : {}),
      ...(filters?.description ? { description: filters.description } : {}),
      ...(filters?.properties ? { properties: filters.properties } : {}),
      ...(filters?.fromName ? { fromName: filters.fromName } : {}),
      ...(filters?.toName ? { toName: filters.toName } : {}),
      ...(search ? { search } : {}),
    }) as Observable<{ edges: Edge[] }>;
  }

  deleteEdge(spaceId: string, id: string): Observable<void> {
    return this.http.delete<void>(`/api/brain/spaces/${spaceId}/edges/${id}`);
  }

  createEdge(spaceId: string, body: { from: string; to: string; label: string; weight?: number; type?: string; tags?: string[]; description?: string; properties?: Record<string, string | number | boolean> }): Observable<Edge> {
    return this.http.post<Edge>(`/api/brain/spaces/${spaceId}/edges`, body);
  }

  updateEdge(spaceId: string, id: string, body: Partial<{ label: string; description: string; tags: string[]; properties: Record<string, string | number | boolean>; weight: number; type: string; deleteFields: string[] }>): Observable<Edge> {
    return this.http.patch<Edge>(`/api/brain/spaces/${spaceId}/edges/${id}`, body);
  }

  // ── Brain — lookups & graph traverse ──────────────────────────────────────

  /**
   * Entities with this exact name.
   *
   * Through `filter` since 5.0. The dedicated `entities/by-name` route was removed with its
   * MCP tool: it ran `find({spaceId, name})` and nothing else, which is that filter with a collection — and
   * a second route for one predicate is the kind of duplicate that drifts from the thing it duplicates.
   *
   * The `{ entities }` shape is kept for callers rather than leaked outward as `{ results }`: the component
   * asking this question wants entities, and making every caller learn the generic envelope buys nothing.
   */
  searchEntitiesByName(spaceId: string, name: string): Observable<{ entities: Entity[] }> {
    return filterCall<{ results: Entity[] }>(this.http, {
      space: spaceId, collection: 'entities', filter: { name },
    })
      .pipe(map(r => ({ entities: r.results ?? [] })));
  }

  /**
   * Entities for a set of ids, in one request.
   *
   * The `$in` is why this is not a loop over `filterOne`: a picker resolving twenty references would
   * otherwise make twenty round trips, and the route it replaces made one. The 100-id ceiling was the
   * route's and is kept here — an unbounded `$in` is a page with no limit on it.
   */
  getEntitiesByIds(spaceId: string, ids: string[]): Observable<{ entities: Entity[] }> {
    if (!ids.length) return new Observable(o => { o.next({ entities: [] }); o.complete(); });
    const unique = [...new Set(ids)].slice(0, 100);
    return filterCall<{ results: Entity[] }>(this.http, {
      space: spaceId, collection: 'entities', filter: { _id: { $in: unique } }, limit: unique.length,
    })
      .pipe(map(r => ({ entities: r.results ?? [] })));
  }

  getEntity(spaceId: string, id: string): Observable<Entity> {
    return this.filterOne<Entity>(spaceId, 'entities', id);
  }

  getEdge(spaceId: string, id: string): Observable<Edge> {
    return this.filterOne<Edge>(spaceId, 'edges', id);
  }

  getMemory(spaceId: string, id: string): Observable<Fact> {
    return this.filterOne<Fact>(spaceId, 'facts', id);
  }

  getChrono(spaceId: string, id: string): Observable<ChronoEntry> {
    return this.filterOne<ChronoEntry>(spaceId, 'chrono', id);
  }

  /**
   * Fetch one record when the TYPE is data rather than a compile-time choice.
   *
   * Review findings carry `type` as a string, so a caller showing "the two records this finding is about"
   * cannot pick a getter by hand. The switch lives here, next to the four getters it dispatches to, rather
   * than being re-derived by every view that meets a typed id — and an unknown type throws instead of
   * quietly requesting `/api/brain/spaces/x/undefined/y`, which 404s in a way that reads like a missing
   * record rather than a missing case.
   */
  getRecord(spaceId: string, type: string, id: string): Observable<Entity | Fact | ChronoEntry | Edge> {
    switch (type) {
      case 'entity': return this.getEntity(spaceId, id);
      case 'fact': return this.getMemory(spaceId, id);
      case 'chrono': return this.getChrono(spaceId, id);
      case 'edge':   return this.getEdge(spaceId, id);
      default: throw new Error(`getRecord: unknown record type '${type}'`);
    }
  }

  /**
   * Walk the graph from an entity. The three `include*` flags decide what the answer CONTAINS, not what is
   * walked: edges are always followed, and `includeEdges: false` only drops the edge list from the response.
   * `includeMemories` is opt-in because facts are usually the most numerous record type and every node
   * counts against `limit`.
   */
  traverseGraph(spaceId: string, body: {
    startId: string;
    direction?: 'outbound' | 'inbound' | 'both';
    edgeLabels?: string[];
    maxDepth?: number;
    limit?: number;
    includeChrono?: boolean;
    includeMemories?: boolean;
    includeFiles?: boolean;
    includeEdges?: boolean;
  }): Observable<TraverseResult> {
    return this.http.post<TraverseResult>(`/api/brain/spaces/${spaceId}/traverse`, body);
  }

  // ── Brain — chrono ──────────────────────────────────────────────────────

  listChrono(spaceId: string, limit = 50, skip = 0, filters?: { tags?: string; tagsAny?: string; tag?: string; type?: string; status?: string; after?: string; before?: string; search?: string; description?: string; entityName?: string }, sort?: ListSort): Observable<{ chrono: ChronoEntry[] }> {
    /*
     * `deriveStatus: true` IS THE WHOLE REASON THIS TAB COULD NOT MOVE UNTIL NOW.
     *
     * A chrono status is derived on read — an entry past its due moment reads `overdue` whatever it
     * was stored as, unless its type says a passed date means nothing. The list route did that to
     * both the rows AND its status query; `filter` did neither until `B-8` and `B-19`. Without the
     * flag this tab would quietly stop showing `overdue`, and its status filter would start
     * returning entries the old one excluded.
     */
    const tagList = (v?: string) => v?.split(',').map(t => t.trim()).filter(Boolean) ?? [];
    const all = tagList(filters?.tags);
    const any = tagList(filters?.tagsAny);
    /*
     * These four are chrono's OWN filters and are plain predicates — an exact tag set, a tag
     * intersection, a status and a date range. They are not the substring/scan RULES the
     * conveniences carry, which is the line: a rule written twice drifts, an equality does not.
     */
    const predicate: Record<string, unknown> = {
      ...(all.length && any.length ? { $and: [{ tags: { $all: all } }, { tags: { $in: any } }] }
        : all.length ? { tags: { $all: all } }
          : any.length ? { tags: { $in: any } } : {}),
      ...(filters?.status ? { status: filters.status } : {}),
      ...(filters?.after || filters?.before
        ? { createdAt: { ...(filters.after ? { $gt: filters.after } : {}), ...(filters.before ? { $lt: filters.before } : {}) } }
        : {}),
    };
    return this.filterPage<ChronoEntry>(spaceId, 'chrono', 'chrono', {
      limit, skip, ...this.sortBody(sort), deriveStatus: true,
      ...(Object.keys(predicate).length ? { filter: predicate } : {}),
      ...(filters?.tag ? { tag: filters.tag } : {}),
      ...(filters?.type ? { type: filters.type } : {}),
      ...(filters?.description ? { description: filters.description } : {}),
      ...(filters?.entityName ? { entityName: filters.entityName } : {}),
      ...(filters?.search ? { search: filters.search } : {}),
    }).pipe(switchMap(page => {
      // The chips this tab draws are LINKS since 5.0, so the page is hydrated from the links collection
      // in one call — see `record-links.ts` for why it is per page and never per row.
      const rows = (page as { chrono: ChronoEntry[] }).chrono;
      return hydrateLinks(this.http, spaceId, 'chrono', rows)
        .pipe(map(chrono => ({ ...page, chrono: chrono as ChronoEntry[] })));
    })) as unknown as Observable<{ chrono: ChronoEntry[] }>;
  }

  createChrono(spaceId: string, body: { title: string; type: ChronoType; startsAt: string; endsAt?: string; status?: ChronoStatus; confidence?: number; tags?: string[]; linkEntities?: string[]; linkFacts?: string[]; description?: string; properties?: Record<string, string | number | boolean> }): Observable<ChronoEntry> {
    return this.http.post<ChronoEntry>(`/api/brain/spaces/${spaceId}/chrono`, body);
  }

  // PATCH, like the other three record types — this was the ONE update in the client still on the legacy
  // POST-to-an-id form, which our own integration guide tells integrators not to build on. Both verbs reach
  // the same writer, so the record comes out identical; what the legacy verb skips is the two things a
  // multi-client operator cannot do without. It runs NO property validation (so the UI could write a record
  // the same space would reject on the create form next to it), and it stores NO audit snapshot (so every
  // chrono edit made in this app was absent from the before/after trail that entities, facts and edges
  // all leave). An integrator found nine of their own flows on this route before we found one of ours.
  updateChrono(spaceId: string, id: string, body: Partial<{ title: string; type: ChronoType; startsAt: string; endsAt: string; status: ChronoStatus; confidence: number; tags: string[]; linkEntities: string[]; linkFacts: string[]; description: string; properties: Record<string, string | number | boolean>; suppressEmbeddings: boolean }>): Observable<ChronoEntry> {
    return this.http.patch<ChronoEntry>(`/api/brain/spaces/${spaceId}/chrono/${id}`, body);
  }

  deleteChrono(spaceId: string, id: string): Observable<void> {
    return this.http.delete<void>(`/api/brain/spaces/${spaceId}/chrono/${id}`);
  }

  /**
   * The space’s inferred entity-relationship model.
   *
   * A proxy space answers with `{ spaceId, members: [...] }` instead of a single model, so a caller must
   * narrow before reading `entityTypes`. Kept as a union rather than flattened here: merging members would
   * sum two types that share a name across spaces and show relationships that can never be joined.
   */
  getErModel(spaceId: string): Observable<ErModel | ErModelMembers> {
    /*
     * From the space's meta since 5.0. `GET /er-model` was folded into it with its MCP tool, because the
     * declared and the actual shape are two halves of one question and a caller needed both.
     */
    return this.http
      .get<{ actualSchema: ErModel | ErModelMembers }>(`/api/spaces/${spaceId}/meta`)
      .pipe(map(m => m.actualSchema));
  }
}
