import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, map, retry, throwError, timeout, timer } from 'rxjs';
import type { SchemaLibraryEntry, ForeignCatalogEntry, SchemaCatalog } from './api.types';
import { WAIT_GIVE_UP_MS } from './wait-give-up';
import { readEveryPage } from './read-every-page';
import type { TypedKind } from './type-field';
import { answerErrorField } from './refusal-text';

// ── A type's history: the type forms of the schema versions door (Q-744, design r4 §5) ─────────────────────────────────

/** Where a type of the list is defined: by the space (`own`), only by a network layer (`layer`), or by nothing current (`none`). */
export type TypeDeclared = 'own' | 'layer' | 'none';
/** How one version stands for a type against the current one; anything else the server answers is read as `unclassified`. */
export type TypeStanding = 'current' | 'older' | 'notHeld' | 'unclassified';

/** One row of a kind's type list. `older` is on own rows only, and only when the record facts are not withheld. */
export interface TypeRow { type: string; declared: TypeDeclared; networks?: string[]; older?: boolean }
/** `?kind=`: the kind's types. */
export interface TypeListAnswer {
  kind: TypedKind; current: string; recordFacts?: 'withheld'; types: TypeRow[];
  count: number; total: number; limit: number; skip: number; truncated: boolean; nextSkip?: number;
}
/** Where a definition is now: edited here (`null` when its own text is gone), the networks whose layer holds it, fetched from a member. */
export interface TypeDefinitionOrigin { edited: boolean | null; networks: string[]; fetched: boolean }
/** One definition of a type: a class of versions the same for it, named by its representative version. */
export interface TypeDefinition { rep: string; current: boolean; since?: string; until?: string; origin: TypeDefinitionOrigin }
/** `?kind=&type=`: the type's definitions, newest first; `cut` when earlier ones are not listed. */
export interface TypeHistoryAnswer {
  kind: TypedKind; type: string; current: string; declared: TypeDeclared; recordFacts?: 'withheld'; cut?: true;
  definitions: TypeDefinition[];
  count: number; total: number; limit: number; skip: number; truncated: boolean; nextSkip?: number;
}
/** One version's standing for a type, with the definition that holds it when it is current or older. */
export interface TypeStandingRow { fp: string; standing: TypeStanding; definition?: { rep: string; since?: string; until?: string } }
/** `?fps=&kind=&type=`: each asked version's standing. */
export interface TypeStandingsAnswer { kind: TypedKind; type: string; current: string; standings: TypeStandingRow[] }
/** One change at one place of a type, between the two versions. */
export interface TypeChange {
  place: string;
  from?: unknown;
  to?: unknown;
  class: string;
}
/** `?fp=&against=&kind=&type=`: the comparison narrowed to the type. */
export interface TypeComparisonAnswer {
  kind: TypedKind; type: string; from: string; to: string;
  types: { kind: string; type: string; changes: TypeChange[] }[];
  unread: string[];
}
/** A type read: `supported: false` when the server answered without the `kind`/`type` echo, i.e. it is older and ignored the asks. */
export type TypeRead<T> = { supported: false } | { supported: true; answer: T };

/**
 * Every page of a paged type read, in order, through `readEveryPage` (the one walk, with its guard: a `nextSkip` that does not move
 * forward ends it), as one read of all their answers. The two rules a caller would otherwise write again, and one of them forget, are
 * in here: one page the server does not support makes the whole read not supported (it has no `nextSkip`, so it also ends the walk), and
 * pages that disagree on the current version fail the read, because the schema changed between them and their parts do not belong to
 * one answer. So a part is never handed on as the whole. A read that answers always has a first page.
 */
export function everyTypePage<T extends { nextSkip?: number; current: string }>(
  page: (skip: number) => Observable<TypeRead<T>>,
): Observable<TypeRead<[T, ...T[]]>> {
  return readEveryPage((skip: number) => page(skip).pipe(
    map(read => ({ read, nextSkip: read.supported ? read.answer.nextSkip : undefined })),
  )).pipe(map((pages): TypeRead<[T, ...T[]]> => {
    const answers: T[] = [];
    for (const { read } of pages) {
      if (!read.supported) return { supported: false };
      answers.push(read.answer);
    }
    const [first, ...later] = answers;
    if (!first) throw new Error('a paged type read answered no page');
    if (later.some(a => a.current !== first.current)) throw new Error('the pages of a type read disagree on the current schema version');
    return { supported: true, answer: [first, ...later] };
  }));
}

/** Why a type read failed, in the words the screens use (`common.reason.<reason>`); `refused` carries the server's own sentence. */
export type TypeReadFailure =
  | { reason: 'noAnswer' | 'busy' | 'indexBuilding' }
  | { reason: 'forbidden' | 'refused'; error: string };

const KNOWN_STANDINGS: ReadonlySet<string> = new Set<TypeStanding>(['current', 'older', 'notHeld', 'unclassified']);
const KNOWN_DECLARED: ReadonlySet<string> = new Set<TypeDeclared>(['own', 'layer', 'none']);

/** The waits before each further ask of a busy read (r4 §7.2): three more asks, then it fails as busy. */
const BUSY_RETRY_MS = [1000, 2000, 4000] as const;

const codeOf = (err: unknown): string | undefined => {
  const body = (err as { error?: unknown } | null)?.error;
  const code = (body as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
};
const statusOf = (err: unknown): number => {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : 0;
};

/**
 * Why a type read failed. A code this client does not know is `refused`, with the server's sentence: read cautiously, never guessed
 * at (r3 §10). A 5xx or a request that never got an answer is `noAnswer`; the two 503s with a code say what they are.
 */
export function typeHistoryFailure(err: unknown): TypeReadFailure {
  const status = statusOf(err), code = codeOf(err);
  if (code === 'schema_versions_busy') return { reason: 'busy' };
  if (code === 'schema_index_building') return { reason: 'indexBuilding' };
  if (status === 0 || status >= 500) return { reason: 'noAnswer' };
  return { reason: status === 403 ? 'forbidden' : 'refused', error: answerErrorField(err) || String(status) };
}

/** Whether the answer echoes what was asked; an older server answers the version list and echoes neither. */
const echoes = (body: unknown, kind: string, type?: string): body is Record<string, unknown> => {
  const b = body as Record<string, unknown> | null;
  return !!b && b['kind'] === kind && (type === undefined || b['type'] === type);
};

/** A space's network schema layers (F-39.3), as `GET /api/spaces/:id/schema-layers` answers. */
export interface SchemaLayersView {
  spaceId: string;
  own: Record<string, unknown>;
  layers: { networkId: string; networkLabel: string; meta: Record<string, unknown> }[];
  precedence: string[];
  clashes: { field?: string; kind?: string; type?: string; property?: string; typeField?: string; values: { networkId: string; value: unknown }[] }[];
  /**
   * Own values a higher-precedence layer is overriding (bundle-23, Q-67): an edit that was accepted and is NOT in effect. Derived on read, so
   * it follows a precedence reorder, a layer arriving or a rename for free. `networkId` is the layer whose value wins.
   */
  hidden?: { path: string; own: unknown; networkId: string }[];
  /** Rounds still open on this space, so closing the dialog does not lose them. */
  rounds?: { id: string; networkId: string; status: 'pending'; paths: string[] }[];
}

/** Instance-level schema library and external schema catalogs. */
@Injectable({ providedIn: 'root' })
export class SchemaApi {
  private http = inject(HttpClient);

  // ── Network schema layers (F-39.3) ─────────────────────────────────────────

  getSchemaLayers(spaceId: string): Observable<SchemaLayersView> {
    return this.http.get<SchemaLayersView>(`/api/spaces/${encodeURIComponent(spaceId)}/schema-layers`);
  }

  setNetworkPrecedence(spaceId: string, networks: string[]): Observable<SchemaLayersView> {
    return this.http.put<SchemaLayersView>(`/api/spaces/${encodeURIComponent(spaceId)}/network-precedence`, { networks });
  }

  /** Propose `meta` to ONE network as its definition (F-39.5): a vote there, landing in its layer once passed. */
  proposeToNetwork(spaceId: string, targetNetwork: string, meta: Record<string, unknown>): Observable<unknown> {
    return this.http.patch(`/api/spaces/${encodeURIComponent(spaceId)}`, { targetNetwork, meta });
  }

  // ── A type's history (Q-744): the type forms of GET /api/spaces/:id/schema-versions ─────────────────────────────────

  /** A kind's types: own, network-layer and record-only names, with `older` on own rows when the record facts are not withheld. */
  typeList(spaceId: string, kind: TypedKind, skip?: number): Observable<TypeRead<TypeListAnswer>> {
    return this.typeRead(spaceId, { kind, ...(skip ? { skip: String(skip) } : {}) }, body => {
      if (!echoes(body, kind) || !Array.isArray(body['types'])) return null;
      const types = (body['types'] as Record<string, unknown>[]).map(t => ({
        ...t, declared: KNOWN_DECLARED.has(String(t['declared'])) ? t['declared'] : 'none',
      }));
      return { ...body, types } as unknown as TypeListAnswer;
    });
  }

  /** A type's definitions, newest first. */
  typeHistory(spaceId: string, kind: TypedKind, type: string, skip?: number): Observable<TypeRead<TypeHistoryAnswer>> {
    return this.typeRead(spaceId, { kind, type, ...(skip ? { skip: String(skip) } : {}) }, body => {
      if (!echoes(body, kind, type) || !Array.isArray(body['definitions'])) return null;
      return { ...body, declared: KNOWN_DECLARED.has(String(body['declared'])) ? body['declared'] : 'none' } as unknown as TypeHistoryAnswer;
    });
  }

  /** How each of `fps` stands for the type: one call for a drawer's record, one for a Brain page's distinct stamps. */
  typeStandings(spaceId: string, kind: TypedKind, type: string, fps: readonly string[]): Observable<TypeRead<TypeStandingsAnswer>> {
    return this.typeRead(spaceId, { fps: fps.join(','), kind, type }, body => {
      if (!echoes(body, kind, type) || !Array.isArray(body['standings'])) return null;
      const standings = (body['standings'] as Record<string, unknown>[]).map(s => ({
        ...s, standing: KNOWN_STANDINGS.has(String(s['standing'])) ? s['standing'] : 'unclassified',
      }));
      return { ...body, standings } as unknown as TypeStandingsAnswer;
    });
  }

  /** What changed for the type from `fp` to `against`. */
  typeComparison(spaceId: string, kind: TypedKind, type: string, fp: string, against: string): Observable<TypeRead<TypeComparisonAnswer>> {
    return this.typeRead(spaceId, { fp, against, kind, type }, body => {
      if (!echoes(body, kind, type)) return null;
      return { ...body, types: Array.isArray(body['types']) ? body['types'] : [], unread: Array.isArray(body['unread']) ? body['unread'] : [] } as unknown as TypeComparisonAnswer;
    });
  }

  /**
   * One type read: the GET, given up on after `WAIT_GIVE_UP_MS` (a `TimeoutError` carries no status, so it reads as "no answer"), a
   * busy answer asked again three times (1 s, 2 s, 4 s) and nothing else retried, and the answer read by `read`, which returns null
   * for one without the echo (an older server) so the caller is told "not supported", never handed a version list as if it were a
   * type answer. The limit sits before the retry, so each ask has its own and a busy server cannot spend one limit across the asks.
   */
  private typeRead<T>(spaceId: string, params: Record<string, string>, read: (body: unknown) => T | null): Observable<TypeRead<T>> {
    return this.http.get<unknown>(`/api/spaces/${encodeURIComponent(spaceId)}/schema-versions`, { params: new HttpParams({ fromObject: params }) }).pipe(
      timeout(WAIT_GIVE_UP_MS),
      retry({
        count: BUSY_RETRY_MS.length,
        delay: (err: unknown, n: number) => codeOf(err) === 'schema_versions_busy' ? timer(BUSY_RETRY_MS[n - 1]!) : throwError(() => err),
      }),
      map(body => {
        const answer = read(body);
        return answer === null ? { supported: false as const } : { supported: true as const, answer };
      }),
    );
  }

  // ── Schema Library ─────────────────────────────────────────────────────────

  /** Every entry, and how many space types reference each (`usageCounts`, by entry name — Q-112). */
  listSchemaLibrary(): Observable<{ entries: SchemaLibraryEntry[]; usageCounts?: Record<string, number> }> {
    return this.http.get<{ entries: SchemaLibraryEntry[]; usageCounts?: Record<string, number> }>('/api/schema-library');
  }

  createSchemaLibraryEntry(body: Omit<SchemaLibraryEntry, 'createdAt' | 'updatedAt'>): Observable<{ entry: SchemaLibraryEntry }> {
    return this.http.post<{ entry: SchemaLibraryEntry }>('/api/schema-library', body);
  }

  upsertSchemaLibraryEntry(name: string, body: Omit<SchemaLibraryEntry, 'name' | 'createdAt' | 'updatedAt'>): Observable<{ entry: SchemaLibraryEntry }> {
    return this.http.put<{ entry: SchemaLibraryEntry }>(`/api/schema-library/${encodeURIComponent(name)}`, body);
  }

  deleteSchemaLibraryEntry(name: string): Observable<void> {
    return this.http.delete<void>(`/api/schema-library/${encodeURIComponent(name)}`);
  }

  getSchemaLibraryUsages(name: string): Observable<{ usages: { spaceId: string; spaceLabel: string; knowledgeType: string; typeName: string }[] }> {
    return this.http.get<{ usages: { spaceId: string; spaceLabel: string; knowledgeType: string; typeName: string }[] }>(`/api/schema-library/${encodeURIComponent(name)}/usages`);
  }

  publishSchemaLibraryEntry(name: string, published: boolean): Observable<{ entry: SchemaLibraryEntry }> {
    return this.http.patch<{ entry: SchemaLibraryEntry }>(`/api/schema-library/${encodeURIComponent(name)}/publish`, { published });
  }

  /** Export a space's full typeSchemas into the library as a named group. */
  exportSpaceSchemaToLibrary(body: { spaceId: string; groupName: string; namePrefix?: string }): Observable<{ created: number; updated: number; entries: SchemaLibraryEntry[] }> {
    return this.http.post<{ created: number; updated: number; entries: SchemaLibraryEntry[] }>('/api/schema-library/export-space', body);
  }

  /** Apply all library entries belonging to a group to a space as $ref links. */
  applyGroupToSpace(group: string, spaceId: string): Observable<{ applied: { knowledgeType: string; typeName: string; entryName: string }[]; count: number }> {
    return this.http.post<{ applied: { knowledgeType: string; typeName: string; entryName: string }[]; count: number }>(`/api/schema-library/groups/${encodeURIComponent(group)}/apply`, { spaceId });
  }

  // ── Schema catalogs ────────────────────────────────────────────────────────

  listSchemaCatalogs(): Observable<{ catalogs: SchemaCatalog[] }> {
    return this.http.get<{ catalogs: SchemaCatalog[] }>('/api/schema-library/catalogs');
  }

  addSchemaCatalog(body: { name: string; url: string; description?: string; accessToken?: string }): Observable<{ catalog: SchemaCatalog }> {
    return this.http.post<{ catalog: SchemaCatalog }>('/api/schema-library/catalogs', body);
  }

  deleteSchemaCatalog(name: string): Observable<void> {
    return this.http.delete<void>(`/api/schema-library/catalogs/${encodeURIComponent(name)}`);
  }

  browseCatalog(catalogName: string): Observable<{ catalog: string; entries: ForeignCatalogEntry[] }> {
    return this.http.get<{ catalog: string; entries: ForeignCatalogEntry[] }>(`/api/schema-library/catalogs/${encodeURIComponent(catalogName)}/entries`);
  }

  getCatalogEntry(catalogName: string, entryName: string): Observable<{ catalog: string; entry: ForeignCatalogEntry }> {
    return this.http.get<{ catalog: string; entry: ForeignCatalogEntry }>(`/api/schema-library/catalogs/${encodeURIComponent(catalogName)}/entries/${encodeURIComponent(entryName)}`);
  }
}
