import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import type { SchemaLibraryEntry, ForeignCatalogEntry, SchemaCatalog } from './api.types';

/** A space's network schema layers (F-39.3), as `GET /api/spaces/:id/schema-layers` answers. */
export interface SchemaLayersView {
  spaceId: string;
  own: Record<string, unknown>;
  layers: { networkId: string; networkLabel: string; meta: Record<string, unknown> }[];
  precedence: string[];
  clashes: { field?: string; kind?: string; type?: string; property?: string; typeField?: string; values: { networkId: string; value: unknown }[] }[];
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

  // ── Schema Library ─────────────────────────────────────────────────────────

  listSchemaLibrary(): Observable<{ entries: SchemaLibraryEntry[] }> {
    return this.http.get<{ entries: SchemaLibraryEntry[] }>('/api/schema-library');
  }

  getSchemaLibraryEntry(name: string): Observable<{ entry: SchemaLibraryEntry }> {
    return this.http.get<{ entry: SchemaLibraryEntry }>(`/api/schema-library/${encodeURIComponent(name)}`);
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

  getPublicSchemaLibrary(): Observable<{ entries: ForeignCatalogEntry[] }> {
    return this.http.get<{ entries: ForeignCatalogEntry[] }>('/api/schema-library/public');
  }

  /** List all distinct schema group names and their entry counts. */
  listSchemaLibraryGroups(): Observable<{ groups: { name: string; count: number }[] }> {
    return this.http.get<{ groups: { name: string; count: number }[] }>('/api/schema-library/groups');
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
