import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import type {
  Memory, Entity, Edge, ChronoEntry, ChronoType, ChronoStatus,
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

/** Brain knowledge graph — memories, entities, edges, chrono, plus query/recall/traverse. */
/**
 * The body `POST /recall` takes — exported so ONE declaration serves both callers.
 *
 * It was inline on the method, which was fine while the only caller was the method. `U-1`'s JSON preview
 * needs the same type: it shows the request the panel would send, and a preview typed as a loose record
 * could contain a key the route refuses while still compiling. The route is `.strict()`, so that key would
 * be a 400 for whoever pasted the JSON — a preview being BELIEVED is the whole point of having one.
 */
export interface RecallRequestBody {      query: string;
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
      includeFreshWrites?: boolean;
      /**
       * Whether file-chunk hits carry their passage body. `false` returns locations and metadata only.
       *
       * Defaults to `true` server-side, and a caller should leave it alone unless it means it: sending `false` makes
       * recall look as though it has stopped returning passages.
       */
      includeContent?: boolean;
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
       * NESTED under it, as `_graph: [{edge, node, paths}]`, and a nested node carries its own `_graph` again.
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
         * Whether the walk also returns the chrono entries, memories and files it reached.
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
      charsPerToken?: number;
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
    return this.http.post<QueryResult>(`/api/brain/spaces/${spaceId}/query`, body);
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

  recallBrain(
    spaceId: string,
    body: RecallRequestBody,
  ): Observable<RecallResponse> {
    return this.http.post<RecallResponse>(`/api/brain/spaces/${spaceId}/recall`, body);
  }

  // ── Brain — memories ──────────────────────────────────────────────────────

  listMemories(spaceId: string, limit = 20, skip = 0, filters?: { tag?: string; entity?: string; type?: string; description?: string; properties?: string; entityName?: string }, sort?: ListSort, search?: string): Observable<{ memories: Memory[]; limit: number; skip: number }> {
    let params = new HttpParams().set('limit', limit).set('skip', skip);
    if (filters?.tag) params = params.set('tag', filters.tag);
    if (filters?.entity) params = params.set('entity', filters.entity);
    if (filters?.type) params = params.set('type', filters.type);
    if (filters?.description) params = params.set('description', filters.description);
    if (filters?.entityName) params = params.set('entityName', filters.entityName);
    if (filters?.properties) params = params.set('properties', filters.properties);
    if (search) params = params.set('search', search);
    params = this.withSort(params, sort);
    return this.http.get<any>(`/api/brain/spaces/${spaceId}/memories`, { params });
  }

  deleteMemory(spaceId: string, id: string): Observable<void> {
    return this.http.delete<void>(`/api/brain/spaces/${spaceId}/memories/${id}`);
  }

  createMemory(spaceId: string, body: { fact: string; type?: string; tags?: string[]; entityIds?: string[]; description?: string; properties?: Record<string, string | number | boolean> }): Observable<Memory> {
    return this.http.post<Memory>(`/api/brain/spaces/${spaceId}/memories`, body);
  }

  updateMemory(spaceId: string, id: string, body: Partial<{ fact: string; type: string; tags: string[]; entityIds: string[]; description: string; properties: Record<string, string | number | boolean>; deleteFields: string[] }>): Observable<Memory> {
    return this.http.patch<Memory>(`/api/brain/spaces/${spaceId}/memories/${id}`, body);
  }

  wipeMemories(spaceId: string): Observable<{ deleted: number }> {
    return this.http.delete<{ deleted: number }>(`/api/brain/spaces/${spaceId}/memories`, {
      body: { confirm: true },
    });
  }

  // ── Brain — entities ──────────────────────────────────────────────────────

  listEntities(spaceId: string, limit = 50, skip = 0, filters?: { search?: string; type?: string; tag?: string; description?: string; properties?: string }, sort?: ListSort, search?: string): Observable<{ entities: Entity[] }> {
    let params = new HttpParams().set('limit', limit).set('skip', skip);
    // `filters.search` is the entity-search bar's exact `name` lookup; `search` is the docked column
    // freetext filter → the server's substring `?search=` (2b-iii). They are distinct params.
    if (filters?.search) params = params.set('name', filters.search);
    if (filters?.type) params = params.set('type', filters.type);
    if (filters?.tag) params = params.set('tag', filters.tag);
    if (filters?.description) params = params.set('description', filters.description);
    if (filters?.properties) params = params.set('properties', filters.properties);
    if (search) params = params.set('search', search);
    params = this.withSort(params, sort);
    return this.http.get<any>(`/api/brain/spaces/${spaceId}/entities`, { params });
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
    let params = new HttpParams().set('limit', limit).set('skip', skip);
    if (filters?.type) params = params.set('type', filters.type);
    if (filters?.tag) params = params.set('tag', filters.tag);
    if (filters?.description) params = params.set('description', filters.description);
    if (filters?.fromName) params = params.set('fromName', filters.fromName);
    if (filters?.toName) params = params.set('toName', filters.toName);
    if (filters?.properties) params = params.set('properties', filters.properties);
    if (search) params = params.set('search', search);
    params = this.withSort(params, sort);
    return this.http.get<any>(`/api/brain/spaces/${spaceId}/edges`, { params });
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

  searchEntitiesByName(spaceId: string, name: string): Observable<{ entities: Entity[] }> {
    const params = new HttpParams().set('name', name);
    return this.http.get<{ entities: Entity[] }>(`/api/brain/spaces/${spaceId}/entities/by-name`, { params });
  }

  getEntitiesByIds(spaceId: string, ids: string[]): Observable<{ entities: Entity[] }> {
    if (!ids.length) return new Observable(o => { o.next({ entities: [] }); o.complete(); });
    const params = new HttpParams().set('ids', ids.join(','));
    return this.http.get<{ entities: Entity[] }>(`/api/brain/spaces/${spaceId}/entities/by-ids`, { params });
  }

  getEntity(spaceId: string, id: string): Observable<Entity> {
    return this.http.get<Entity>(`/api/brain/spaces/${spaceId}/entities/${id}`);
  }

  getEdge(spaceId: string, id: string): Observable<Edge> {
    return this.http.get<Edge>(`/api/brain/spaces/${spaceId}/edges/${id}`);
  }

  getMemory(spaceId: string, id: string): Observable<Memory> {
    return this.http.get<Memory>(`/api/brain/spaces/${spaceId}/memories/${id}`);
  }

  getChrono(spaceId: string, id: string): Observable<ChronoEntry> {
    return this.http.get<ChronoEntry>(`/api/brain/spaces/${spaceId}/chrono/${id}`);
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
  getRecord(spaceId: string, type: string, id: string): Observable<Entity | Memory | ChronoEntry | Edge> {
    switch (type) {
      case 'entity': return this.getEntity(spaceId, id);
      case 'memory': return this.getMemory(spaceId, id);
      case 'chrono': return this.getChrono(spaceId, id);
      case 'edge':   return this.getEdge(spaceId, id);
      default: throw new Error(`getRecord: unknown record type '${type}'`);
    }
  }

  /**
   * Walk the graph from an entity. The three `include*` flags decide what the answer CONTAINS, not what is
   * walked: edges are always followed, and `includeEdges: false` only drops the edge list from the response.
   * `includeMemories` is opt-in because memories are usually the most numerous record type and every node
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
    let params = new HttpParams().set('limit', limit).set('skip', skip);
    if (filters?.tags) params = params.set('tags', filters.tags);
    if (filters?.tagsAny) params = params.set('tagsAny', filters.tagsAny);
    if (filters?.tag) params = params.set('tag', filters.tag);
    if (filters?.description) params = params.set('description', filters.description);
    if (filters?.entityName) params = params.set('entityName', filters.entityName);
    // The chrono record "kind" (event/deadline/…) is filtered via the `type` query
    // param server-side; the old `kind` param was silently ignored.
    if (filters?.type) params = params.set('type', filters.type);
    if (filters?.status) params = params.set('status', filters.status);
    if (filters?.after) params = params.set('after', filters.after);
    if (filters?.before) params = params.set('before', filters.before);
    if (filters?.search) params = params.set('search', filters.search);
    params = this.withSort(params, sort);
    return this.http.get<any>(`/api/brain/spaces/${spaceId}/chrono`, { params });
  }

  createChrono(spaceId: string, body: { title: string; type: ChronoType; startsAt: string; endsAt?: string; status?: ChronoStatus; confidence?: number; tags?: string[]; entityIds?: string[]; memoryIds?: string[]; description?: string; properties?: Record<string, string | number | boolean> }): Observable<ChronoEntry> {
    return this.http.post<ChronoEntry>(`/api/brain/spaces/${spaceId}/chrono`, body);
  }

  // PATCH, like the other three record types — this was the ONE update in the client still on the legacy
  // POST-to-an-id form, which our own integration guide tells integrators not to build on. Both verbs reach
  // the same writer, so the record comes out identical; what the legacy verb skips is the two things a
  // multi-client operator cannot do without. It runs NO property validation (so the UI could write a record
  // the same space would reject on the create form next to it), and it stores NO audit snapshot (so every
  // chrono edit made in this app was absent from the before/after trail that entities, memories and edges
  // all leave). An integrator found nine of their own flows on this route before we found one of ours.
  updateChrono(spaceId: string, id: string, body: Partial<{ title: string; type: ChronoType; startsAt: string; endsAt: string; status: ChronoStatus; confidence: number; tags: string[]; entityIds: string[]; memoryIds: string[]; description: string; properties: Record<string, string | number | boolean>; suppressEmbeddings: boolean }>): Observable<ChronoEntry> {
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
    return this.http.get<ErModel | ErModelMembers>(`/api/brain/spaces/${spaceId}/er-model`);
  }
}
