import { Injectable, inject } from '@angular/core';
import type { ReembedResult, ReindexStatus } from './embed-ops.types';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import type {
  Space, SpaceMeta, SpacesResponse, SpaceMetaResponse, KnowledgeType, TypeSchema,
  DupeActionRule, SpaceStats, SpaceActivity, SpaceActivityResponse, WipeCollectionType, WipeResult, CompletenessReport,
  RecordTtlWindows,
} from './api.types';

/**
 * What `PATCH /api/spaces/:id` can answer.
 *
 * A meta change to a space that belongs to a network does NOT apply immediately — it opens a vote round
 * per network and comes back `202 { status: 'vote_pending', rounds }`, with **no `space`**. This was
 * typed as `{ space: Space }` unconditionally, so the settings dialog destructured `undefined` and threw
 * inside its own `next` handler: the save button did nothing, no error appeared, and the editor stayed
 * dirty — then prompted to discard changes that had in fact been submitted for a vote.
 */
export type UpdateSpaceResult =
  | { space: Space; status?: undefined; layers?: SchemaWriteLayer[] }
  | { status: 'vote_pending'; rounds: { networkId: string; networkLabel: string; roundId: string }[]; message: string; space?: undefined; layers?: SchemaWriteLayer[] };

/**
 * What a schema write did in ONE network the space sits in (bundle-23, Q-67, R5-1): `applied` (the network's rule let it through, or it
 * holds no vote on it) or `vote_pending` (a round is open). The later outcome - passed, vetoed, not carried - is derived on read by
 * `space_schema_layers`, never recorded here. A space in two networks can answer one of each, which is why the dialog cannot decide
 * "applied, close" or "pending, stay" from the answer as a whole.
 */
export interface SchemaWriteLayer {
  networkId: string;
  networkLabel: string;
  outcome: 'applied' | 'vote_pending';
}

/**
 * The answer of `POST /api/spaces/:id/validate-schema` - the live check of a schema against a sample record or against stored data.
 * Stored-data mode is PAGED: `complete` is false until the whole space has been read, and the cursor carries the next page. A check that
 * is not complete has found nothing yet, which is not the same as nothing being wrong.
 */
export interface ValidateSchemaResult {
  spaceId: string;
  /** Per collection: how many records were looked at of how many there are. */
  checked: Record<string, { checked: number; total: number }>;
  complete: boolean;
  totalViolations: number;
  violations: { collection: string; _id: string; violations: { field: string; reason?: string; value?: unknown; declared?: string[]; outcome?: string }[] }[];
  staleGuards?: unknown[];
  /** Where the next page starts (sent back as `after`); absent when the check is complete. The server's `_id`-keyset spelling. */
  nextAfter?: string;
}

/** Spaces, their per-type schemas, stats, reindex, and destructive wipe. */
@Injectable({ providedIn: 'root' })
export class SpacesApi {
  private http = inject(HttpClient);

  listSpaces(): Observable<SpacesResponse> {
    return this.http.get<SpacesResponse>('/api/spaces');
  }

  createSpace(body: { label: string; id?: string; maxGiB?: number; proxyFor?: string[]; meta?: Partial<SpaceMeta> }): Observable<{ space: Space }> {
    return this.http.post<{ space: Space }>('/api/spaces', body);
  }

  /**
   * `ifMatch` is the version of the space's meta the caller read: sent as `If-Match`, so a schema save made on top of somebody else's
   * change is refused with 412 instead of silently overwriting it. A bare integer in quotes, the entity-tag spelling the server accepts.
   */
  updateSpace(id: string, body: { label?: string; maxGiB?: number | null; meta?: Partial<SpaceMeta>; typeSchemasMode?: 'merge' | 'replace'; dupeRules?: DupeActionRule[]; dupeMergeSurvivor?: 'older' | 'newer'; dupeRulesOnInsert?: boolean; recordTtlDays?: number | RecordTtlWindows | null; documentExtraction?: 'off' | 'ocr' | 'vlm' | 'repair' | 'auto' | null; imageAnalysis?: 'off' | 'caption' | 'recognition' | 'auto' | null; audioAnalysis?: 'off' | 'on' | 'auto' | null; videoAnalysis?: 'off' | 'audio' | 'full' | 'auto' | null; textAnalysis?: 'off' | 'embed' | 'chunk' | 'auto' | null }, options: { ifMatch?: number } = {}): Observable<UpdateSpaceResult> {
    const headers = options.ifMatch === undefined ? undefined : { 'If-Match': `"${options.ifMatch}"` };
    return this.http.patch<UpdateSpaceResult>(`/api/spaces/${id}`, body, headers ? { headers } : undefined);
  }

  /**
   * Check a schema against one pasted record (`sample`: nothing is scanned) or against the space's stored data, a page at a time
   * (`after`: the previous answer's `nextAfter`). `meta` is the STAGED schema to check, so the dialog can ask before it saves; without
   * it the stored schema is checked.
   */
  validateSchema(spaceId: string, body: { sample?: unknown; after?: string; meta?: Partial<SpaceMeta> }): Observable<ValidateSchemaResult> {
    return this.http.post<ValidateSchemaResult>(`/api/spaces/${encodeURIComponent(spaceId)}/validate-schema`, body);
  }

  reorderSpaces(ids: string[]): Observable<{ spaces: Space[] }> {
    return this.http.post<{ spaces: Space[] }>('/api/spaces/reorder', { ids });
  }

  getSpaceMeta(id: string): Observable<SpaceMetaResponse> {
    // `resolve=1`: expand library `$ref` types so the brain entry forms can pre-fill a selected type's
    // properties (a bare `{ $ref }` carries no propertySchemas). Edit/round-trip views use the raw meta.
    return this.http.get<SpaceMetaResponse>(`/api/spaces/${id}/meta?resolve=1`);
  }

  /** Completeness checks + their roll-up (Brain → Overview panel). Separate from `/meta` on purpose:
   *  that endpoint is read on every schema edit and must stay cheap; this one walks the collections. */
  getCompleteness(id: string): Observable<CompletenessReport> {
    return this.http.get<CompletenessReport>(`/api/spaces/${id}/completeness`);
  }

  /** GET a single type definition from the space's typeSchemas. */
  getTypeSchema(spaceId: string, knowledgeType: KnowledgeType, typeName: string): Observable<{ knowledgeType: KnowledgeType; typeName: string; schema: TypeSchema }> {
    return this.http.get<{ knowledgeType: KnowledgeType; typeName: string; schema: TypeSchema }>(
      `/api/spaces/${spaceId}/meta/typeSchemas/${knowledgeType}/${typeName}`,
    );
  }

  /** PUT (upsert) a single type definition into the space's typeSchemas. */
  upsertTypeSchema(spaceId: string, knowledgeType: KnowledgeType, typeName: string, schema: TypeSchema): Observable<{ knowledgeType: KnowledgeType; typeName: string; schema: TypeSchema }> {
    return this.http.put<{ knowledgeType: KnowledgeType; typeName: string; schema: TypeSchema }>(
      `/api/spaces/${spaceId}/meta/typeSchemas/${knowledgeType}/${typeName}`,
      schema,
    );
  }

  /** DELETE a single type definition from the space's typeSchemas. */
  deleteTypeSchema(spaceId: string, knowledgeType: KnowledgeType, typeName: string): Observable<void> {
    return this.http.delete<void>(`/api/spaces/${spaceId}/meta/typeSchemas/${knowledgeType}/${typeName}`);
  }

  deleteSpace(id: string): Observable<void> {
    return this.http.delete<void>(`/api/spaces/${id}`, { body: { confirm: true } });
  }

  renameSpace(oldId: string, newId: string): Observable<{ space: Space }> {
    return this.http.patch<{ space: Space }>(`/api/spaces/${oldId}/rename`, { newId });
  }

  /**
   * Rebuild the space's vector search indexes — the repair for "search returns nothing".
   *
   * Recall goes through a `$vectorSearch` index that is separate from the stored vectors, so it can be
   * missing while every record still has a perfectly good embedding: recall then returns empty with no
   * error anywhere. Reindexing does NOT fix that — it re-embeds documents and never touches the index.
   * This is the only operation that rebuilds it.
   *
   * Returns immediately; the build continues in the background and recall stays empty until it finishes.
   */
  rebuildSpaceIndexes(spaceId: string): Observable<{ ok: boolean; spaceId: string; status: string }> {
    return this.http.post<{ ok: boolean; spaceId: string; status: string }>(
      `/api/spaces/${spaceId}/rebuild-indexes`, {},
    );
  }

  /**
   * Queue embeddings for records in the space that have none — the way back from `suppressEmbeddings`.
   *
   * Unlike `rebuildSpaceIndexes` this is AWAITED for its counts rather than fire-and-forget: it only enqueues, so
   * it returns in the time it takes to scan, and `enqueued` / `remaining` are the answer the operator wants. A
   * record still suppressed at any tier is skipped by the server and reported under `skippedSuppressed`.
   */
  reembedSpace(spaceId: string, body: { kinds?: string[]; limit?: number } = {}): Observable<ReembedResult> {
    return this.http.post<ReembedResult>(`/api/spaces/${spaceId}/reembed`, body);
  }

  wipeSpace(spaceId: string, types?: WipeCollectionType[]): Observable<{ deleted: WipeResult }> {
    const body: { types?: WipeCollectionType[] } = types && types.length > 0 ? { types } : {};
    return this.http.post<{ deleted: WipeResult }>(`/api/admin/spaces/${spaceId}/wipe`, body);
  }

  getSpaceStats(spaceId: string): Observable<SpaceStats> {
    return this.http.get<SpaceStats>(`/api/brain/spaces/${spaceId}/stats`);
  }

  /**
   * Usage over a window, defaulting to a day.
   *
   * Separate call from `getSpaceStats` on purpose: stats is counts of stored records and answers instantly,
   * while this aggregates hourly buckets. Folding them together would make the whole Overview wait on the
   * slower half, and the panel is designed to render its tiles before this arrives.
   */
  /**
   * Clear a space's recorded usage.
   *
   * Note the path: the READ is under /api/brain, the reset is under /api/spaces. They are not siblings, and that
   * is deliberate rather than sloppy — reading usage is a brain query, clearing it is an administrative act on
   * the space, and it lives with rebuild-indexes and wipe behind the same admin guard.
   *
   * Returns how many hourly buckets were removed, because afterwards the panel reads zero either way and
   * nothing on screen tells a reset apart from a space that was genuinely idle.
   */
  resetSpaceActivity(spaceId: string): Observable<{ ok: boolean; spaceId: string; cleared: number }> {
    return this.http.post<{ ok: boolean; spaceId: string; cleared: number }>(
      `/api/spaces/${spaceId}/activity/reset`, {},
    );
  }

  getSpaceActivity(spaceId: string, hours = 24): Observable<SpaceActivityResponse> {
    return this.http.get<SpaceActivityResponse>(
      `/api/brain/spaces/${spaceId}/activity?hours=${hours}`,
    );
  }

  /**
   * Every space's usage in ONE request, for the Spaces list.
   *
   * Not the per-space endpoint called once per row — that is a front-end N+1, and on a sixty-five-space
   * instance it is sixty-five requests to draw one table. Admin-only, because it is inherently cross-space.
   */
  listSpaceActivity(hours = 7 * 24): Observable<{ hours: number; retentionDays: number; spaces: SpaceActivity[] }> {
    return this.http.get<{ hours: number; retentionDays: number; spaces: SpaceActivity[] }>(
      `/api/admin/space-activity?hours=${hours}`,
    );
  }

  getReindexStatus(spaceId: string): Observable<ReindexStatus> {
    return this.http.get<ReindexStatus>(`/api/brain/spaces/${spaceId}/reindex-status`);
  }

  reindex(spaceId: string): Observable<Record<string, number>> {
    return this.http.post<Record<string, number>>(`/api/brain/spaces/${spaceId}/reindex`, {});
  }
}
