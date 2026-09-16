/**
 * Schema Library page.
 *
 * Instance-level reusable TypeSchema definitions.  The editor UI mirrors the
 * per-type schema editor in settings/spaces.component.ts — same
 * TypeSchemaState model, same property table, same constraint fields.
 *
 * Route: /schema-library
 */

import { Component, inject, signal, computed, OnInit, ElementRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { finalize, forkJoin } from 'rxjs';
import {
  SchemaLibraryEntry, SchemaCatalog, ForeignCatalogEntry, KnowledgeType, PropertySchema, TypeSchema, Space,
  KNOWLEDGE_TYPES,
} from '../../core/api.types';
import { AuthApi } from '../../core/auth-api.service';
import { SchemaApi } from '../../core/schema-api.service';
import { SpacesApi } from '../../core/spaces-api.service';
import { TranslocoPipe } from '@jsverse/transloco';
import { TranslocoService } from '@jsverse/transloco';
import { ToastService } from '../../core/toast.service';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { PropSchemaTableComponent } from '../../shared/prop-schema-table.component';
import { ErrorStateComponent } from '../../shared/error-state.component';
import { httpErrorReason } from '../../core/http-error';
import { ModalDirective } from '../../shared/modal.directive';
import { CHIP_STYLES } from '../../shared/chip.styles';

// ── Local form state ────────────────────────────────────────────────────────

interface TypeSchemaState {
  namingPattern:   string;
  propertySchemas: { key: string; s: PropertySchema; _enumInput: string }[];
  _newPropInput:   string;
  _newTagInput:    string;
}

interface LibraryFormState {
  name:          string;
  description:   string;
  knowledgeType: KnowledgeType;
  typeName:      string;
  schemaGroup:   string;
  schemaState:   TypeSchemaState;
}

function emptySchemaState(): TypeSchemaState {
  return { namingPattern: '', propertySchemas: [], _newPropInput: '', _newTagInput: '' };
}

function entryToFormState(e: SchemaLibraryEntry): LibraryFormState {
  const s = e.schema;
  return {
    name:          e.name,
    description:   e.description ?? '',
    knowledgeType: e.knowledgeType,
    typeName:      e.typeName,
    schemaGroup:   e.schemaGroup ?? '',
    schemaState: {
      namingPattern:   s.namingPattern   ?? '',
      propertySchemas: Object.entries(s.propertySchemas ?? {}).map(([k, ps]) => ({ key: k, s: { ...ps }, _enumInput: '' })),
      _newPropInput:   '',
      _newTagInput:    '',
    },
  };
}

function formStateToSchema(f: LibraryFormState): Omit<TypeSchema, '$ref'> {
  const schema: Omit<TypeSchema, '$ref'> = {};
  if (f.knowledgeType === 'entity' && f.schemaState.namingPattern.trim()) {
    schema.namingPattern = f.schemaState.namingPattern.trim();
  }
  if (f.schemaState.propertySchemas.length) {
    const ps: Record<string, PropertySchema> = {};
    for (const { key, s } of f.schemaState.propertySchemas) {
      const entry: PropertySchema = {};
      if (s.type)            entry.type     = s.type;
      if (s.enum?.length)    entry.enum     = [...s.enum];
      if (s.minimum != null) entry.minimum  = s.minimum;
      if (s.maximum != null) entry.maximum  = s.maximum;
      if (s.pattern?.trim()) entry.pattern  = s.pattern.trim();
      if (s.mergeFn)         entry.mergeFn  = s.mergeFn;
      if (s.required)        entry.required = s.required;
      if (s.default != null) entry.default  = s.default;
      ps[key] = entry;
    }
    schema.propertySchemas = ps;
  }
  return schema;
}

// ── Component ───────────────────────────────────────────────────────────────

/** The four schema-bearing knowledge types, in the server's `export-space` iteration order. */
// The list is imported from `api.types`, which is the client's single source for it.

/**
 * If `raw` is a space-schema export (a `{ typeSchemas: {...} }` envelope OR a bare typeSchemas map
 * keyed by knowledge type), return the typeSchemas map; otherwise null (it's a library-entry file).
 * A library entry has `name`+`knowledgeType`+`schema` at the top level, so we key off `typeSchemas`
 * and the knowledge-type keys to disambiguate.
 */
export function extractTypeSchemas(raw: unknown): Record<string, Record<string, TypeSchema>> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const candidate = (obj['typeSchemas'] && typeof obj['typeSchemas'] === 'object' && !Array.isArray(obj['typeSchemas']))
    ? obj['typeSchemas'] as Record<string, unknown>
    // A bare typeSchemas map: only if it has NO library-entry marker and at least one KT key.
    : (!('name' in obj) && !('schema' in obj) && KNOWLEDGE_TYPES.some(kt => kt in obj) ? obj : null);
  if (!candidate) return null;
  return candidate as Record<string, Record<string, TypeSchema>>;
}

/**
 * Turn a space's `typeSchemas` into grouped library entries, mirroring the server `export-space`
 * naming (`<prefix>-<kt>-<typeName>`, sanitised) so a file import produces the same entries as
 * exporting the live space would. `$ref` types are skipped — they already point at a library entry.
 */
export function entriesFromTypeSchemas(
  typeSchemas: Record<string, Record<string, TypeSchema>>,
  group: string,
): { entries: Array<Pick<SchemaLibraryEntry, 'name' | 'knowledgeType' | 'typeName' | 'schema' | 'schemaGroup'>>; skippedRefs: number } {
  const prefix = group.toLowerCase().replace(/[^a-z0-9_.-]/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 100);
  const entries: Array<Pick<SchemaLibraryEntry, 'name' | 'knowledgeType' | 'typeName' | 'schema' | 'schemaGroup'>> = [];
  let skippedRefs = 0;
  for (const kt of KNOWLEDGE_TYPES) {
    const ktMap = typeSchemas[kt];
    if (!ktMap || typeof ktMap !== 'object') continue;
    for (const [typeName, schema] of Object.entries(ktMap)) {
      if (!schema || typeof schema !== 'object') continue;
      if ('$ref' in schema) { skippedRefs++; continue; }
      const safeName = typeName.toLowerCase().replace(/[^a-z0-9_.-]/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 80);
      const name = `${prefix}-${kt}-${safeName}`.slice(0, 200);
      entries.push({ name, knowledgeType: kt, typeName, schema, schemaGroup: group });
    }
  }
  return { entries, skippedRefs };
}

@Component({
  selector: 'app-schema-library',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslocoPipe, PhIconComponent, PropSchemaTableComponent, ErrorStateComponent, ModalDirective],
  styles: [CHIP_STYLES, `
    /* chip inputs — same as spaces.component.ts */
    /* create / edit dialog */
    .dialog-backdrop { position:fixed; inset:0; background:var(--bg-scrim); display:flex; align-items:center; justify-content:center; z-index:100; }
    .dialog { background:var(--bg-primary); border:1px solid var(--border); border-radius:var(--radius-lg); padding:24px; width:92vw; max-width:980px; max-height:90vh; overflow-y:auto; }
    .dialog-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:20px; }
    .dialog-header h3 { margin:0; font-size:17px; font-weight:700; }
    .dialog-footer { display:flex; align-items:center; justify-content:flex-end; gap:8px; margin-top:24px; padding-top:16px; border-top:1px solid var(--border); }
    /* schema sub-tabs — same pattern as spaces.component.ts */
    .sch-coll-tabs { display:flex; border-bottom:2px solid var(--border); margin-bottom:0; overflow-x:auto; gap:0; }
    .sch-coll-tab { background:none; border:none; border-bottom:2px solid transparent; margin-bottom:-2px; padding:10px 22px; cursor:pointer; font-size:13px; font-family:var(--font); color:var(--text-muted); display:inline-flex; align-items:center; gap:6px; transition:color .15s; white-space:nowrap; }
    .sch-coll-tab:hover { color:var(--text-primary); }
    .sch-coll-tab.active { color:var(--text-primary); border-bottom-color:var(--accent); font-weight:600; }
    .sch-sub { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.06em; color:var(--text-muted); margin-bottom:8px; padding-bottom:4px; border-bottom:1px solid var(--border); margin-top:20px; }
    /* entry list */
    .header-row { display:flex; align-items:center; justify-content:space-between; margin-bottom:16px; }
    .header-row h2 { margin:0; font-size:20px; font-weight:700; }
    /* Wraps. A non-wrapping button row is the same narrow-window bug as the tab strips (#534): with
       five buttons it ran 84px past the pane at 600px and 264px at 420px, sliding the whole page
       sideways. Found by testing/responsive-sweep.mjs, which #534 did not cover this route with. */
    .header-actions { display:flex; flex-wrap:wrap; gap:8px; }
    .search-row { margin-bottom:12px; }
    .search-row input { width:100%; max-width:400px; }
    .type-filters { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:16px; }
    .type-filter-btn { background:none; border:1px solid var(--border); border-radius:20px; padding:2px 12px; font-size:12px; cursor:pointer; color:var(--text-muted); transition:all .15s; font-family:var(--font); }
    .type-filter-btn:hover { color:var(--text-primary); border-color:var(--text-muted); }
    .type-filter-btn.active { background:var(--accent-dim); color:var(--accent); border-color:color-mix(in srgb,var(--accent) 60%,transparent); font-weight:600; }
    .entry-title-row { display:flex; align-items:center; gap:6px; margin-bottom:2px; }
    .entry-footer { display:flex; justify-content:flex-end; gap:8px; align-items:center; margin-top:6px; }
    .entry-grid { display:grid; gap:10px; }
    .entry-card { background:var(--bg-surface); border:1px solid var(--border); border-radius:var(--radius-md); padding:14px 16px; display:flex; align-items:flex-start; justify-content:space-between; gap:12px; transition:border-color .15s; cursor:pointer; }
    .entry-card:hover { border-color: var(--accent); }
    .entry-main { flex:1; min-width:0; }
    .entry-name { font-weight:600; font-size:14px; color:var(--text-primary); font-family:var(--font-mono); }
    .entry-meta { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:4px; }
    .entry-description { font-size:12px; color:var(--text-secondary); margin-top:4px; word-break:break-word; }
    .entry-actions { display:flex; gap:6px; flex-shrink:0; }
    .badge-kt { background:var(--accent-dim); color:var(--accent); border:1px solid color-mix(in srgb,var(--accent) 40%,transparent); border-radius:4px; padding:1px 7px; font-size:0.72rem; font-weight:600; letter-spacing:0.03em; text-transform:uppercase; }
    .badge-type { background:var(--bg-elevated); color:var(--text-secondary); border:1px solid var(--border); border-radius:4px; padding:1px 7px; font-size:0.72rem; font-weight:500; font-family:var(--font-mono); }
    .updated { font-size:11px; color:var(--text-muted); }
    .prop-badge { font-size:10px; color:var(--text-muted); background:var(--bg-elevated); border-radius:3px; padding:1px 5px; }
    .badge-published { font-size:10px; font-weight:600; color:#16a34a; background:rgba(22,163,74,.12); border-radius:3px; padding:1px 6px; }
    .badge-source { font-size:10px; color:var(--text-muted); background:var(--bg-elevated); border-radius:3px; padding:1px 5px; font-style:italic; }
    .badge-group { font-size:10px; font-weight:600; color:#7c3aed; background:rgba(124,58,237,.1); border-radius:3px; padding:1px 6px; cursor:pointer; }
    .badge-group:hover { background:rgba(124,58,237,.2); }
    .group-filter-btn { background:none; border:1px solid var(--border); border-radius:20px; padding:2px 12px; font-size:12px; cursor:pointer; color:#7c3aed; transition:all .15s; font-family:var(--font); }
    .group-filter-btn:hover { border-color:#7c3aed; }
    .group-filter-btn.active { background:rgba(124,58,237,.1); border-color:#7c3aed; font-weight:600; }
    /* page tabs */
    .page-tabs { display:flex; gap:0; margin-bottom:20px; border-bottom:2px solid var(--border); }
    .page-tab { background:none; border:none; border-bottom:2px solid transparent; margin-bottom:-2px; padding:10px 22px; cursor:pointer; font-size:13px; font-family:var(--font); color:var(--text-muted); display:inline-flex; align-items:center; gap:6px; transition:color .15s; white-space:nowrap; }
    .page-tab:hover { color:var(--text-primary); }
    .page-tab.active { color:var(--text-primary); border-bottom-color:var(--accent); font-weight:600; }
    /* catalog panel */
    .catalog-card { background:var(--bg-surface); border:1px solid var(--border); border-radius:var(--radius-md); padding:14px 16px; display:flex; align-items:flex-start; justify-content:space-between; gap:12px; }
    .catalog-entry-row { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:8px 12px; border-bottom:1px solid var(--border); font-size:13px; }
    .catalog-entry-row:last-child { border-bottom:none; }
    /* import/export banner */
    .ref-hint { font-size:12px; color:var(--text-secondary); background:var(--bg-elevated); border:1px solid var(--border); border-radius:var(--radius-sm); padding:8px 12px; margin-bottom:20px; font-family:var(--font-mono); }
    .ref-hint code { color:var(--accent); }
    .share-bar-url { font-size:12px; font-family:var(--font-mono); color:var(--accent); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .badge-auth { font-size:10px; font-weight:600; color:#0ea5e9; background:rgba(14,165,233,.12); border-radius:3px; padding:1px 6px; }
  `],
  template: `
    <div class="header-row">
      <h2>{{ 'schemaLib.title' | transloco }}</h2>
      <div class="header-actions">
        @if (pageTab() === 'library') {
          <button class="btn btn-secondary btn-sm" type="button" (click)="openExportSpace()" [attr.title]="'schemaLib.exportSpace.title' | transloco"><ph-icon name="export" [size]="13" style="margin-right:5px;vertical-align:-2px;"/>{{ 'schemaLib.exportSpace.button' | transloco }}</button>
          <button class="btn btn-secondary btn-sm" type="button" (click)="openApplyGroup()" [attr.title]="'schemaLib.applyGroup.title' | transloco"><ph-icon name="stack" [size]="13" style="margin-right:5px;vertical-align:-2px;"/>{{ 'schemaLib.applyGroup.button' | transloco }}</button>
          <button class="btn btn-secondary btn-sm" type="button" (click)="triggerImportFile()" [attr.title]="'schemaLib.import.fileTitle' | transloco"><ph-icon name="download-simple" [size]="13" style="margin-right:5px;vertical-align:-2px;"/>{{ 'schemaLib.import.fileButton' | transloco }}</button>
          <input #importFileInput type="file" accept=".json" style="display:none" (change)="onImportFile($event)" />
          <button class="btn btn-primary btn-sm" type="button" (click)="openCreate()">{{ 'schemaLib.createButton' | transloco }}</button>
        } @else {
          <button class="btn btn-primary btn-sm" type="button" (click)="openAddCatalog()">{{ 'schemaLib.catalog.addButton' | transloco }}</button>
        }
      </div>
    </div>

    <!-- page tabs: My Library / Foreign Catalogs -->
    <div class="page-tabs" role="tablist" [attr.aria-label]="'schemaLib.title' | transloco">
      <button class="page-tab" type="button" role="tab" [class.active]="pageTab()==='library'" [attr.aria-selected]="pageTab()==='library'" (click)="pageTab.set('library')">{{ 'schemaLib.tab.library' | transloco }}</button>
      <button class="page-tab" type="button" role="tab" [class.active]="pageTab()==='catalogs'" [attr.aria-selected]="pageTab()==='catalogs'" (click)="pageTab.set('catalogs');loadCatalogs()"><ph-icon name="globe" [size]="13" style="margin-right:4px;"/>{{ 'schemaLib.tab.catalogs' | transloco }}</button>
    </div>

    <div class="search-row" style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
      <input type="search" style="flex:1;min-width:0;" [ngModel]="searchQuery()" (ngModelChange)="searchQuery.set($event)" [placeholder]="'schemaLib.searchPlaceholder' | transloco" />
      @if (pageTab() === 'library') {
        <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
          <span class="share-bar-url" style="max-width:260px;">{{ libraryPublicUrl }}</span>
          <button class="btn btn-secondary btn-sm" type="button" (click)="copyLibraryUrl()" [attr.title]="'schemaLib.share.copyButton' | transloco">
            @if (urlCopied()) { <ph-icon name="check" [size]="13"/> } @else { <ph-icon name="copy" [size]="13"/> }
          </button>
          <button class="btn btn-secondary btn-sm" type="button" (click)="showCreateLibToken.set(true)" [attr.title]="'schemaLib.share.createTokenButton' | transloco">
            <ph-icon name="key" [size]="13"/>
          </button>
        </div>
      }
    </div>
    @if (pageTab() === 'library' && entries().length) {
      <div class="type-filters">
        @for (kt of knowledgeTypes; track kt) {
          <button class="type-filter-btn" [class.active]="typeFilter() === kt" [attr.aria-pressed]="typeFilter() === kt" type="button" (click)="typeFilter.set(typeFilter() === kt ? null : $any(kt))">{{ kt }}</button>
        }
        @for (g of availableGroups(); track g) {
          <button class="group-filter-btn" [class.active]="groupFilter() === g" [attr.aria-pressed]="groupFilter() === g" type="button" (click)="groupFilter.set(groupFilter() === g ? null : g)"><ph-icon name="tag" [size]="11" style="margin-right:3px;vertical-align:-1px;"/>{{ g }}</button>
        }
      </div>
    }

    <!-- ── MY LIBRARY TAB ─────────────────────────────────────────────────── -->
    @if (pageTab() === 'library') {
      @if (loading()) {
        <div class="empty-state"><span class="spinner"></span></div>
      } @else if (loadError() !== null) {
        <app-error-state [message]="'schemaLib.error.load' | transloco" [reason]="loadError() ?? ''" (retry)="load()" />
      } @else if (!entries().length) {
        <div class="empty-state">
          <div class="empty-state-icon"><ph-icon name="bookmarks" [size]="48"/></div>
          <h3>{{ 'schemaLib.empty.title' | transloco }}</h3>
          <p>{{ 'schemaLib.empty.subtitle' | transloco }}</p>
        </div>
      } @else if (!filteredEntries().length) {
        <div class="empty-state">
          <p style="color:var(--text-muted);">{{ 'schemaLib.noResults' | transloco }}</p>
        </div>
      } @else {
        <div class="entry-grid">
          @for (entry of filteredEntries(); track entry.name) {
            <div class="entry-card" (click)="openEdit(entry)">
              <div class="entry-main">
                <div class="entry-title-row">
                  <span class="badge-kt">{{ entry.knowledgeType }}</span>
                  <span class="entry-name">{{ entry.name }}</span>
                </div>
                <div class="entry-meta">
                  @if (propCount(entry) > 0) {
                    <span class="prop-badge">{{ propCount(entry) }} prop{{ propCount(entry) !== 1 ? 's' : '' }}</span>
                  }
                  @if (entry.schema.namingPattern) {
                    <span class="prop-badge" [title]="entry.schema.namingPattern">pattern</span>
                  }
                  @if ((usageCounts()[entry.name] || 0) > 0) {
                    <span class="prop-badge" style="color:var(--accent);background:var(--accent-dim);">{{ usageCounts()[entry.name] }} link{{ usageCounts()[entry.name] !== 1 ? 's' : '' }}</span>
                  }
                  @if (entry.schemaGroup) {
                    <span class="badge-group" [title]="'schemaLib.badge.groupTitle' | transloco" (click)="$event.stopPropagation(); groupFilter.set(groupFilter() === entry.schemaGroup ? null : entry.schemaGroup)"><ph-icon name="tag" [size]="10" style="margin-right:2px;vertical-align:-1px;"/>{{ entry.schemaGroup }}</span>
                  }
                  @if (entry.published) {
                    <span class="badge-published">{{ 'schemaLib.badge.published' | transloco }}</span>
                  }
                  @if (entry.sourceCatalog) {
                    <span class="badge-source" [title]="entry.sourceUrl || ''">{{ 'schemaLib.badge.from' | transloco }} {{ entry.sourceCatalog }}</span>
                  }
                </div>
                @if (entry.description) { <div class="entry-description">{{ entry.description }}</div> }
                <div class="entry-footer">
                  <span class="badge-type">{{ entry.typeName }}</span>
                  <span class="updated">{{ entry.updatedAt | date:'dd.MM.yyyy HH:mm' }}</span>
                </div>
              </div>
              <div class="entry-actions" (click)="$event.stopPropagation()">
                <button class="btn btn-ghost btn-sm" type="button" (click)="togglePublish(entry)" [attr.title]="(entry.published ? 'schemaLib.action.unpublish' : 'schemaLib.action.publish') | transloco" [style.color]="entry.published ? 'var(--accent)' : undefined"><ph-icon name="globe" [size]="13"/></button>
                <button class="btn btn-ghost btn-sm" type="button" (click)="exportEntry(entry)" [attr.title]="'schemaLib.export.title' | transloco"><ph-icon name="upload" [size]="13"/></button>
                <button class="btn btn-ghost btn-sm danger" type="button" (click)="initiateDelete(entry.name)" [attr.title]="'common.remove' | transloco"><ph-icon name="trash" [size]="13"/></button>
              </div>
            </div>
          }
        </div>
      }

    <!-- ── FOREIGN CATALOGS TAB ─────────────────────────────────────────────── -->
    } @else {
      @if (catalogsLoading()) {
        <div class="empty-state"><span class="spinner"></span></div>
      } @else if (catalogsLoadError() !== null) {
        <app-error-state [message]="'schemaLib.catalog.loadError' | transloco" [reason]="catalogsLoadError() ?? ''"
                         (retry)="loadCatalogs()" />
      } @else if (!catalogs().length) {
        <div class="empty-state">
          <p style="color:var(--text-muted);">{{ 'schemaLib.catalog.empty' | transloco }}</p>
        </div>
      } @else {
        <div style="display:grid;gap:10px;">
          @for (cat of catalogs(); track cat.name) {
            <div class="catalog-card">
              <div style="flex:1;min-width:0;">
                <div style="font-weight:600;font-size:14px;font-family:var(--font-mono);">{{ cat.name }}</div>
                <div style="font-size:12px;color:var(--text-muted);word-break:break-all;margin-top:2px;">{{ cat.url }}</div>
                @if (cat.description) { <div style="font-size:12px;color:var(--text-secondary);margin-top:3px;">{{ cat.description }}</div> }
                @if (cat.hasAccessToken) { <div style="margin-top:4px;"><span class="badge-auth">{{ 'schemaLib.catalog.hasToken' | transloco }}</span></div> }
              </div>
              <div style="display:flex;gap:6px;flex-shrink:0;">
                <button class="btn btn-secondary btn-sm" type="button" (click)="openBrowse(cat.name)">{{ 'schemaLib.catalog.browseButton' | transloco }}</button>
                <button class="btn btn-ghost btn-sm danger" type="button" (click)="removeCatalog(cat.name)" [attr.title]="'schemaLib.catalog.deleteTitle' | transloco"><ph-icon name="trash" [size]="13"/></button>
              </div>
            </div>
          }
        </div>
      }
    }

    <!-- Add Catalog dialog -->
    @if (showAddCatalog()) {
      <div style="position:fixed;inset:0;background:var(--bg-scrim);display:flex;align-items:center;justify-content:center;z-index:200;">
        <div style="background:var(--bg-primary);border:1px solid var(--border);border-radius:var(--radius-lg);padding:24px;width:92vw;max-width:480px;" [appModal]="'schemaLib.catalog.addTitle' | transloco" (dismiss)="showAddCatalog.set(false)" (click)="$event.stopPropagation()">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
            <h3 style="margin:0;font-size:15px;">{{ 'schemaLib.catalog.addTitle' | transloco }}</h3>
            <button class="icon-btn" type="button" [attr.aria-label]="'common.close' | transloco" (click)="showAddCatalog.set(false)"><ph-icon name="x" [size]="18"/></button>
          </div>
          <div class="field" style="margin-bottom:14px;">
            <label>{{ 'schemaLib.catalog.nameLabel' | transloco }}</label>
            <input type="text" [(ngModel)]="newCatalog.name" [placeholder]="'schemaLib.catalog.namePlaceholder' | transloco" />
          </div>
          <div class="field" style="margin-bottom:14px;">
            <label>{{ 'schemaLib.catalog.urlLabel' | transloco }}</label>
            <input type="url" [(ngModel)]="newCatalog.url" [placeholder]="'schemaLib.catalog.urlPlaceholder' | transloco" />
          </div>
          <div class="field" style="margin-bottom:14px;">
            <label>{{ 'schemaLib.catalog.descLabel' | transloco }}</label>
            <input type="text" [(ngModel)]="newCatalog.description" [placeholder]="'schemaLib.catalog.descPlaceholder' | transloco" />
          </div>
          <div class="field" style="margin-bottom:20px;">
            <label>{{ 'schemaLib.catalog.accessTokenLabel' | transloco }}</label>
            <input type="password" [(ngModel)]="newCatalog.accessToken" [placeholder]="'schemaLib.catalog.accessTokenPlaceholder' | transloco" autocomplete="off" />
            <span style="font-size:11px;color:var(--text-muted);">{{ 'schemaLib.catalog.accessTokenHint' | transloco }}</span>
          </div>
          @if (catalogError()) { <p style="font-size:12px;color:var(--danger);margin:0 0 12px;">{{ catalogError() }}</p> }
          <div style="display:flex;gap:8px;justify-content:flex-end;">
            <button class="btn btn-primary" type="button" (click)="addCatalog()" [disabled]="catalogSaving()">
              {{ catalogSaving() ? ('common.saving' | transloco) : ('schemaLib.catalog.addButton' | transloco) }}
            </button>
          </div>
        </div>
      </div>
    }

    <!-- Catalog browse dialog -->
    @if (browsing(); as b) {
      <div style="position:fixed;inset:0;background:var(--bg-scrim);display:flex;align-items:center;justify-content:center;z-index:200;">
        <div style="background:var(--bg-primary);border:1px solid var(--border);border-radius:var(--radius-lg);padding:24px;width:96vw;max-width:780px;max-height:85vh;display:flex;flex-direction:column;" [appModal]="'schemaLib.catalog.browseTitle' | transloco" appModalCloseOnBackdrop (dismiss)="browsing.set(null)" (click)="$event.stopPropagation()">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-shrink:0;">
            <h3 style="margin:0;font-size:15px;">{{ 'schemaLib.catalog.browseTitle' | transloco }}: <span style="font-family:var(--font-mono);">{{ b.catalogName }}</span></h3>
            <button class="icon-btn" type="button" [attr.aria-label]="'common.close' | transloco" (click)="browsing.set(null)"><ph-icon name="x" [size]="18"/></button>
          </div>
          @if (b.loading) {
            <div style="flex:1;display:flex;align-items:center;justify-content:center;"><span class="spinner"></span></div>
          } @else if (b.error) {
            <p style="color:var(--danger);font-size:13px;">{{ b.error }}</p>
          } @else if (!b.entries.length) {
            <p style="color:var(--text-muted);font-size:13px;">{{ 'schemaLib.catalog.browseEmpty' | transloco }}</p>
          } @else {
            <div style="overflow-y:auto;flex:1;border:1px solid var(--border);border-radius:var(--radius-sm);">
              @for (e of b.entries; track e.name) {
                <div class="catalog-entry-row">
                  <div style="flex:1;min-width:0;">
                    <span style="font-weight:600;font-size:13px;font-family:var(--font-mono);">{{ e.name }}</span>
                    <span class="badge-kt" style="margin-left:8px;">{{ e.knowledgeType }}</span>
                    <span class="badge-type" style="margin-left:4px;">{{ e.typeName }}</span>
                    @if (e.description) { <span style="font-size:12px;color:var(--text-muted);margin-left:8px;">{{ e.description }}</span> }
                  </div>
                  <button class="btn btn-secondary btn-sm" type="button" (click)="importFromCatalog(b.catalogName, e)" [disabled]="catalogImporting()">
                    {{ 'schemaLib.catalog.importButton' | transloco }}
                  </button>
                </div>
              }
            </div>
          }
        </div>
      </div>
    }
    <!-- Create library access token dialog -->
    @if (showCreateLibToken()) {
      <div style="position:fixed;inset:0;background:var(--bg-scrim);display:flex;align-items:center;justify-content:center;z-index:200;">
        <div style="background:var(--bg-primary);border:1px solid var(--border);border-radius:var(--radius-lg);padding:24px;width:92vw;max-width:420px;" [appModal]="'schemaLib.share.tokenDialogTitle' | transloco" (dismiss)="closeCreateLibToken()" (click)="$event.stopPropagation()">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
            <h3 style="margin:0;font-size:15px;">{{ 'schemaLib.share.tokenDialogTitle' | transloco }}</h3>
            <button class="icon-btn" type="button" [attr.aria-label]="'common.close' | transloco" (click)="closeCreateLibToken()"><ph-icon name="x" [size]="18"/></button>
          </div>
          <p style="font-size:13px;color:var(--text-secondary);margin:0 0 16px;">{{ 'schemaLib.share.tokenDialogHint' | transloco }}</p>
          <div class="field" style="margin-bottom:14px;">
            <label>{{ 'schemaLib.share.tokenNameLabel' | transloco }}</label>
            <input type="text" [ngModel]="libTokenName()" (ngModelChange)="libTokenName.set($event)" [placeholder]="'schemaLib.share.tokenNamePlaceholder' | transloco" (keydown.enter)="createLibraryToken()" />
          </div>
          @if (libTokenError()) { <p style="font-size:12px;color:var(--danger);margin:0 0 12px;">{{ libTokenError() }}</p> }
          <div style="display:flex;gap:8px;justify-content:flex-end;">
            <button class="btn btn-secondary btn-sm" type="button" (click)="closeCreateLibToken()">{{ 'common.cancel' | transloco }}</button>
            <button class="btn btn-primary" type="button" (click)="createLibraryToken()" [disabled]="libTokenCreating()">
              {{ libTokenCreating() ? ('common.saving' | transloco) : ('schemaLib.share.createTokenButton' | transloco) }}
            </button>
          </div>
        </div>
      </div>
    }

    <!-- Library access token one-time reveal -->
    @if (libTokenRevealed()) {
      <div style="position:fixed;inset:0;background:var(--bg-scrim);display:flex;align-items:center;justify-content:center;z-index:210;">
        <div style="background:var(--bg-primary);border:1px solid var(--border);border-radius:var(--radius-lg);padding:24px;width:92vw;max-width:480px;" [appModal]="'schemaLib.share.tokenCreatedTitle' | transloco" (dismiss)="libTokenRevealed.set(null)">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
            <h3 style="margin:0;font-size:15px;">{{ 'schemaLib.share.tokenCreatedTitle' | transloco }}</h3>
          </div>
          <p style="font-size:13px;color:var(--text-secondary);margin:0 0 12px;">{{ 'schemaLib.share.tokenCreatedHint' | transloco }}</p>
          <div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 12px;font-family:var(--font-mono);font-size:12px;word-break:break-all;color:var(--accent);margin-bottom:16px;">{{ libTokenRevealed() }}</div>
          <div style="display:flex;gap:8px;justify-content:flex-end;">
            <button class="btn btn-secondary btn-sm" type="button" (click)="copyRevealedToken()">
              <ph-icon name="copy" [size]="12" style="margin-right:4px;"/>{{ 'schemaLib.share.copyButton' | transloco }}
            </button>
            <button class="btn btn-primary" type="button" (click)="libTokenRevealed.set(null)">{{ 'common.close' | transloco }}</button>
          </div>
        </div>
      </div>
    }

    <!-- Export space schema dialog -->
    @if (exportSpaceDialog()) {
      <div style="position:fixed;inset:0;background:var(--bg-scrim);display:flex;align-items:center;justify-content:center;z-index:200;">
        <div style="background:var(--bg-primary);border:1px solid var(--border);border-radius:var(--radius-lg);padding:24px;width:92vw;max-width:500px;" [appModal]="'schemaLib.exportSpace.dialogTitle' | transloco" (dismiss)="exportSpaceDialog.set(null)" (click)="$event.stopPropagation()">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
            <h3 style="margin:0;font-size:15px;">{{ 'schemaLib.exportSpace.dialogTitle' | transloco }}</h3>
            <button class="icon-btn" type="button" [attr.aria-label]="'common.close' | transloco" (click)="exportSpaceDialog.set(null)"><ph-icon name="x" [size]="18"/></button>
          </div>
          <p style="font-size:13px;color:var(--text-secondary);margin:0 0 16px;">{{ 'schemaLib.exportSpace.dialogHint' | transloco }}</p>
          <div class="field" style="margin-bottom:14px;">
            <label>{{ 'schemaLib.exportSpace.spaceLabel' | transloco }}</label>
            <select [(ngModel)]="exportSpaceDialog()!.spaceId" style="width:100%;">
              <option value="">{{ 'schemaLib.exportSpace.selectSpace' | transloco }}</option>
              @for (s of spaces(); track s.id) {
                <option [value]="s.id">{{ s.label }}</option>
              }
            </select>
          </div>
          <div class="field" style="margin-bottom:14px;">
            <label>{{ 'schemaLib.exportSpace.groupNameLabel' | transloco }}</label>
            <input type="text" [(ngModel)]="exportSpaceDialog()!.groupName" [placeholder]="'schemaLib.exportSpace.groupNamePlaceholder' | transloco" maxlength="200" />
          </div>
          <div class="field" style="margin-bottom:20px;">
            <label>{{ 'schemaLib.exportSpace.namePrefixLabel' | transloco }}</label>
            <input type="text" [(ngModel)]="exportSpaceDialog()!.namePrefix" [placeholder]="exportSpaceDialog()!.groupName || ('schemaLib.exportSpace.namePrefixPlaceholder' | transloco)" maxlength="200" />
            <span style="font-size:11px;color:var(--text-muted);">{{ 'schemaLib.exportSpace.namePrefixHint' | transloco }}</span>
          </div>
          @if (exportSpaceDialog()!.result) {
            <p style="font-size:12px;color:var(--success, #16a34a);margin:0 0 12px;"><ph-icon name="check-circle" [size]="13" style="margin-right:4px;vertical-align:-2px;"/>{{ exportSpaceDialog()!.result }}</p>
          }
          @if (exportSpaceDialog()!.error) { <p style="font-size:12px;color:var(--danger);margin:0 0 12px;">{{ exportSpaceDialog()!.error }}</p> }
          <div style="display:flex;gap:8px;justify-content:flex-end;">
            <button class="btn btn-secondary btn-sm" type="button" (click)="exportSpaceDialog.set(null)">{{ 'common.cancel' | transloco }}</button>
            <button class="btn btn-primary" type="button" (click)="doExportSpace()" [disabled]="exportSpaceDialog()!.saving">
              {{ exportSpaceDialog()!.saving ? ('common.saving' | transloco) : ('schemaLib.exportSpace.confirmButton' | transloco) }}
            </button>
          </div>
        </div>
      </div>
    }

    <!-- Apply group to space dialog -->
    @if (applyGroupDialog()) {
      <div style="position:fixed;inset:0;background:var(--bg-scrim);display:flex;align-items:center;justify-content:center;z-index:200;">
        <div style="background:var(--bg-primary);border:1px solid var(--border);border-radius:var(--radius-lg);padding:24px;width:92vw;max-width:500px;" [appModal]="'schemaLib.applyGroup.dialogTitle' | transloco" (dismiss)="applyGroupDialog.set(null)" (click)="$event.stopPropagation()">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
            <h3 style="margin:0;font-size:15px;">{{ 'schemaLib.applyGroup.dialogTitle' | transloco }}</h3>
            <button class="icon-btn" type="button" [attr.aria-label]="'common.close' | transloco" (click)="applyGroupDialog.set(null)"><ph-icon name="x" [size]="18"/></button>
          </div>
          <p style="font-size:13px;color:var(--text-secondary);margin:0 0 16px;">{{ 'schemaLib.applyGroup.dialogHint' | transloco }}</p>
          <div class="field" style="margin-bottom:14px;">
            <label>{{ 'schemaLib.applyGroup.groupLabel' | transloco }}</label>
            <select [(ngModel)]="applyGroupDialog()!.group" style="width:100%;">
              <option value="">{{ 'schemaLib.applyGroup.selectGroup' | transloco }}</option>
              @for (g of availableGroups(); track g) {
                <option [value]="g">{{ g }}</option>
              }
            </select>
          </div>
          <div class="field" style="margin-bottom:20px;">
            <label>{{ 'schemaLib.applyGroup.spaceLabel' | transloco }}</label>
            <select [(ngModel)]="applyGroupDialog()!.spaceId" style="width:100%;">
              <option value="">{{ 'schemaLib.applyGroup.selectSpace' | transloco }}</option>
              @for (s of spaces(); track s.id) {
                <option [value]="s.id">{{ s.label }}</option>
              }
            </select>
          </div>
          @if (applyGroupDialog()!.result) {
            <p style="font-size:12px;color:var(--success, #16a34a);margin:0 0 12px;"><ph-icon name="check-circle" [size]="13" style="margin-right:4px;vertical-align:-2px;"/>{{ applyGroupDialog()!.result }}</p>
          }
          @if (applyGroupDialog()!.error) { <p style="font-size:12px;color:var(--danger);margin:0 0 12px;">{{ applyGroupDialog()!.error }}</p> }
          <div style="display:flex;gap:8px;justify-content:flex-end;">
            <button class="btn btn-secondary btn-sm" type="button" (click)="applyGroupDialog.set(null)">{{ 'common.cancel' | transloco }}</button>
            <button class="btn btn-primary" type="button" (click)="doApplyGroup()" [disabled]="applyGroupDialog()!.saving">
              {{ applyGroupDialog()!.saving ? ('common.saving' | transloco) : ('schemaLib.applyGroup.confirmButton' | transloco) }}
            </button>
          </div>
        </div>
      </div>
    }

    @if (showDialog()) {
      <div class="dialog-backdrop">
        <div class="dialog" [appModal]="editingName() ? ('schemaLib.dialog.editTitle' | transloco) : ('schemaLib.dialog.createTitle' | transloco)" (dismiss)="closeDialog()" (click)="$event.stopPropagation()">
          <div class="dialog-header">
            <h3>{{ editingName() ? ('schemaLib.dialog.editTitle' | transloco) : ('schemaLib.dialog.createTitle' | transloco) }}</h3>
            <button class="icon-btn" type="button" [attr.aria-label]="'common.close' | transloco" (click)="closeDialog()"><ph-icon name="x" [size]="18"/></button>
          </div>

          <!-- Entry metadata -->
          <div class="sch-grid" style="margin-bottom:16px;">
            <div class="field">
              <label>{{ 'schemaLib.field.typeName' | transloco }}</label>
              <input type="text" [ngModel]="form.typeName" (ngModelChange)="autoSlugFromTypeName($event)" [placeholder]="'schemaLib.field.typeNamePlaceholder' | transloco" />
              <span style="font-size:11px;color:var(--text-muted);">{{ 'schemaLib.field.nameAutoLabel' | transloco }} <span style="font-family:var(--font-mono);">{{ form.name || '—' }}</span></span>
            </div>
            <div class="field">
              <label>{{ 'schemaLib.field.knowledgeType' | transloco }}</label>
              <select [(ngModel)]="form.knowledgeType" style="width:100%;">
                <option value="entity">entity</option>
                <option value="edge">edge</option>
                <option value="fact">memory</option>
                <option value="chrono">chrono</option>
              </select>
            </div>
          </div>

          <div class="field" style="margin-bottom:16px;">
            <label>{{ 'schemaLib.field.description' | transloco }}</label>
            <input type="text" [(ngModel)]="form.description" [placeholder]="'schemaLib.field.descriptionPlaceholder' | transloco" />
          </div>

          <div class="field" style="margin-bottom:16px;">
            <label>{{ 'schemaLib.field.schemaGroup' | transloco }}</label>
            <input type="text" [(ngModel)]="form.schemaGroup" [placeholder]="'schemaLib.field.schemaGroupPlaceholder' | transloco" maxlength="200" list="schema-group-suggestions" />
            <datalist id="schema-group-suggestions">
              @for (g of availableGroups(); track g) { <option [value]="g"></option> }
            </datalist>
            <span style="font-size:11px;color:var(--text-muted);">{{ 'schemaLib.field.schemaGroupHint' | transloco }}</span>
          </div>

          <!-- Schema editor — matches spaces.component.ts per-type expand panel -->
          @if (form.knowledgeType === 'entity') {
            <div class="field" style="margin-bottom:16px;">
              <label>{{ 'spaces.schema.namingPattern' | transloco }} <span style="font-size:10px;font-weight:400;color:var(--text-muted);">{{ 'spaces.schema.namingPatternHint' | transloco }}</span></label>
              <input type="text" [(ngModel)]="form.schemaState.namingPattern" [placeholder]="'spaces.schema.namingPatternPlaceholder' | transloco" style="max-width:320px;" />
            </div>
          }

          <!-- The tag-suggestion editor was retired here for the same reason as on the space Schema
               tab: a library entry's suggestions are expanded into a type schema by a $ref, and that
               field reaches nothing — not the Brain record forms, not the MCP schema guidance. Stored
               values round-trip untouched. -->

          <!-- Property schemas -->
          <div>
            <div class="sch-sub">{{ 'spaces.schema.propertySchemas' | transloco }}</div>
            <app-prop-schema-table [rows]="form.schemaState.propertySchemas" />
          </div>

          <div class="dialog-footer">
            @if (dialogError()) { <span style="font-size:12px;color:var(--danger);flex:1;">{{ dialogError() }}</span> }
            <button class="btn btn-primary" type="button" (click)="saveEntry()" [disabled]="saving()">
              {{ saving() ? ('common.saving' | transloco) : ('common.save' | transloco) }}
            </button>
          </div>
        </div>
      </div>
    }

    <!-- Delete warning dialog -->
    @if (deleteDialog(); as dd) {
      <div style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:320;display:flex;align-items:center;justify-content:center;">
        <div style="background:var(--surface);border-radius:8px;padding:24px;max-width:480px;width:90%;display:flex;flex-direction:column;gap:16px;" [appModal]="'schemaLib.delete.title' | transloco" appModalCloseOnBackdrop (dismiss)="closeDeleteDialog()" (click)="$event.stopPropagation()">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
            <h3 style="margin:0;font-size:15px;">{{ 'schemaLib.delete.title' | transloco }}</h3>
            <button class="icon-btn" type="button" [attr.aria-label]="'common.close' | transloco" (click)="closeDeleteDialog()"><ph-icon name="x" [size]="18"/></button>
          </div>
          @if (dd.loading) {
            <div style="text-align:center;padding:16px 0;"><span class="spinner"></span></div>
          } @else {
            @if (dd.usages.length > 0) {
              <p style="margin:0;font-size:13px;color:var(--text-muted);">{{ 'schemaLib.delete.usagesWarning' | transloco: { count: dd.usages.length } }}</p>
              <ul style="margin:0;padding-left:20px;font-size:12px;color:var(--text-muted);">
                @for (u of dd.usages; track u.spaceId + u.knowledgeType + u.typeName) {
                  <li><strong>{{ u.spaceLabel }}</strong> — {{ u.knowledgeType }}: <code>{{ u.typeName }}</code></li>
                }
              </ul>
              <p style="margin:0;font-size:12px;color:var(--text-muted);">{{ 'schemaLib.delete.unlinkNote' | transloco }}</p>
            } @else {
              <p style="margin:0;font-size:13px;color:var(--text-muted);">{{ 'schemaLib.delete.noUsages' | transloco: { name: dd.entryName } }}</p>
            }
            @if (dd.error) { <p style="margin:0;font-size:12px;color:var(--danger);">{{ dd.error }}</p> }
            <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:4px;">
              <button class="btn btn-secondary btn-sm" type="button" (click)="closeDeleteDialog()" [disabled]="dd.unlinking">{{ 'common.cancel' | transloco }}</button>
              <button class="btn btn-danger btn-sm" type="button" (click)="confirmDelete()" [disabled]="dd.unlinking">
                {{ dd.unlinking ? ('schemaLib.delete.unlinking' | transloco) : (dd.usages.length > 0 ? ('schemaLib.delete.confirmUnlink' | transloco) : ('common.remove' | transloco)) }}
              </button>
            </div>
          }
        </div>
      </div>
    }
  `,
})
export class SchemaLibraryComponent implements OnInit {
  /**
   * The kinds, as a CLASS member because a template can only reach class members.
   *
   * An AOT build is what says so: the unit tests and `tsc` both pass with a module-scope const in the
   * template, and `ng build --configuration production` answers
   * `TS2339: Property KNOWLEDGE_TYPES does not exist on type SchemaLibraryComponent`. Which is the whole
   * reason preflight runs the production build.
   */
  readonly knowledgeTypes = KNOWLEDGE_TYPES;

  private authApi   = inject(AuthApi);
  private schemaApi = inject(SchemaApi);
  private spacesApi = inject(SpacesApi);
  private transloco = inject(TranslocoService);
  private toast = inject(ToastService);

  entries         = signal<SchemaLibraryEntry[]>([]);
  /** Failure reason for the library list load; null when it loaded (U3). */
  loadError       = signal<string | null>(null);
  usageCounts     = signal<Record<string, number>>({});
  loading         = signal(true);
  saving          = signal(false);
  showDialog      = signal(false);
  editingName     = signal<string | null>(null);
  dialogError     = signal('');
  confirmDeleteName = signal('');
  searchQuery     = signal('');
  typeFilter      = signal<KnowledgeType | null>(null);
  groupFilter     = signal<string | null>(null);

  /** Current page tab: 'library' | 'catalogs'. */
  pageTab = signal<'library' | 'catalogs'>('library');

  /** Foreign catalog signals. */
  catalogs        = signal<SchemaCatalog[]>([]);
  catalogsLoading = signal(false);
  /**
   * Null until the catalog list failed to load. Distinct from `catalogError`, which belongs to the
   * add-catalog dialog: the load used to clear `catalogs` on failure, so the page reported "no catalogs
   * configured" to an operator who had configured several.
   */
  catalogsLoadError = signal<string | null>(null);
  catalogSaving   = signal(false);
  catalogError    = signal('');
  showAddCatalog  = signal(false);
  catalogImporting = signal(false);
  newCatalog: { name: string; url: string; description: string; accessToken: string } = { name: '', url: '', description: '', accessToken: '' };

  /** Library sharing signals. */
  readonly libraryPublicUrl = window.location.origin + '/api/schema-library';
  urlCopied           = signal(false);
  showCreateLibToken  = signal(false);
  libTokenName        = signal('');
  libTokenCreating    = signal(false);
  libTokenRevealed    = signal<string | null>(null);
  libTokenError       = signal('');

  /** Space list for export/apply dialogs. */
  spaces = signal<Space[]>([]);

  /** Export space schema dialog state. */
  exportSpaceDialog = signal<{
    spaceId: string;
    groupName: string;
    namePrefix: string;
    saving: boolean;
    error: string;
    result: string;
  } | null>(null);

  /** Apply group to space dialog state. */
  applyGroupDialog = signal<{
    group: string;
    spaceId: string;
    saving: boolean;
    error: string;
    result: string;
  } | null>(null);

  /** Catalog browse dialog state. */
  browsing = signal<{
    catalogName: string;
    entries: ForeignCatalogEntry[];
    loading: boolean;
    error: string;
  } | null>(null);

  /** State for the usage-aware delete warning dialog. */
  deleteDialog = signal<{
    entryName: string;
    usages: { spaceId: string; spaceLabel: string; knowledgeType: string; typeName: string }[];
    loading: boolean;
    unlinking: boolean;
    error: string;
  } | null>(null);

  /** Distinct group names derived from the current entries list. */
  availableGroups = computed(() => {
    const seen = new Set<string>();
    const groups: string[] = [];
    for (const e of this.entries()) {
      if (e.schemaGroup && !seen.has(e.schemaGroup)) {
        seen.add(e.schemaGroup);
        groups.push(e.schemaGroup);
      }
    }
    return groups.sort();
  });

  filteredEntries = computed(() => {
    const q = this.searchQuery().trim().toLowerCase();
    const kt = this.typeFilter();
    const g = this.groupFilter();
    let result = this.entries();
    if (kt) result = result.filter(e => e.knowledgeType === kt);
    if (g) result = result.filter(e => e.schemaGroup === g);
    if (!q) return result;
    return result.filter(e =>
      e.name.toLowerCase().includes(q) ||
      e.typeName.toLowerCase().includes(q) ||
      (e.description ?? '').toLowerCase().includes(q) ||
      (e.schemaGroup ?? '').toLowerCase().includes(q),
    );
  });

  @ViewChild('importFileInput') importFileInputRef?: ElementRef<HTMLInputElement>;

  form: LibraryFormState = this.blankForm();

  private blankForm(): LibraryFormState {
    return {
      name:          '',
      description:   '',
      knowledgeType: 'entity',
      typeName:      '',
      schemaGroup:   '',
      schemaState:   emptySchemaState(),
    };
  }

  ngOnInit(): void {
    this.load();
    // Pre-load space list for export/apply dialogs
    this.spacesApi.listSpaces().subscribe({
      next: ({ spaces }) => this.spaces.set(spaces),
      error: () => {},
    });
  }

  load(): void {
    this.loading.set(true);
    this.loadError.set(null);
    this.schemaApi.listSchemaLibrary().pipe(
      finalize(() => this.loading.set(false)),
    ).subscribe({
      next: ({ entries }) => {
        this.entries.set(entries);
        if (entries.length === 0) return;
        // Fetch usage counts for all entries (non-critical; errors silently ignored)
        forkJoin(
          entries.map(e => this.schemaApi.getSchemaLibraryUsages(e.name)),
        ).subscribe({
          next: (results) => {
            const counts: Record<string, number> = {};
            entries.forEach((e, i) => { counts[e.name] = results[i]?.usages?.length ?? 0; });
            this.usageCounts.set(counts);
          },
          error: () => {}, // usage counts are non-critical
        });
      },
      // Distinguish a failed load from a genuinely empty library (U3).
      error: (e) => { this.entries.set([]); this.loadError.set(httpErrorReason(e)); },
    });
  }

  propCount(entry: SchemaLibraryEntry): number {
    return Object.keys(entry.schema.propertySchemas ?? {}).length;
  }

  // ── Dialog open/close ──────────────────────────────────────────────────────

  openCreate(): void {
    this.form = this.blankForm();
    this.editingName.set(null);
    this.dialogError.set('');
    this.showDialog.set(true);
  }

  openEdit(entry: SchemaLibraryEntry): void {
    this.form = entryToFormState(entry);
    this.editingName.set(entry.name);
    this.dialogError.set('');
    this.showDialog.set(true);
  }

  closeDialog(): void {
    this.showDialog.set(false);
    this.editingName.set(null);
    this.dialogError.set('');
    this.confirmDeleteName.set('');
  }

  // ── Usage-aware delete flow ────────────────────────────────────────────────

  initiateDelete(name: string): void {
    this.deleteDialog.set({ entryName: name, usages: [], loading: true, unlinking: false, error: '' });
    this.schemaApi.getSchemaLibraryUsages(name).subscribe({
      next: ({ usages }) => {
        this.deleteDialog.update(d => d ? { ...d, usages, loading: false } : d);
      },
      error: () => {
        // If we can't check usages, still allow delete (fail open — usages non-critical)
        this.deleteDialog.update(d => d ? { ...d, usages: [], loading: false } : d);
      },
    });
  }

  closeDeleteDialog(): void { this.deleteDialog.set(null); }

  confirmDelete(): void {
    const d = this.deleteDialog();
    if (!d) return;
    if (d.usages.length === 0) {
      this._doDelete(d.entryName);
      return;
    }
    // Unlink all linked types (replace $ref with inline schema from library entry),
    // then delete the library entry.
    const entry = this.entries().find(e => e.name === d.entryName);
    this.deleteDialog.update(s => s ? { ...s, unlinking: true, error: '' } : s);
    const unlinks$ = d.usages.map(u =>
      this.spacesApi.upsertTypeSchema(
        u.spaceId,
        u.knowledgeType as KnowledgeType,
        u.typeName,
        entry ? { ...entry.schema } : {},
      ),
    );
    forkJoin(unlinks$.length ? unlinks$ : [Promise.resolve()]).subscribe({
      next: () => this._doDelete(d.entryName),
      error: (err) => {
        this.deleteDialog.update(s => s ? { ...s, unlinking: false, error: err?.error?.error ?? 'Failed to unlink one or more spaces.' } : s);
      },
    });
  }

  private _doDelete(name: string): void {
    this.schemaApi.deleteSchemaLibraryEntry(name).subscribe({
      next: () => {
        this.entries.update(list => list.filter(e => e.name !== name));
        this.usageCounts.update(c => { const n = { ...c }; delete n[name]; return n; });
        this.deleteDialog.set(null);
      },
      error: (err) => {
        this.deleteDialog.update(s => s ? { ...s, unlinking: false, error: err?.error?.error ?? this.transloco.translate('schemaLib.error.deleteFailed') } : s);
      },
    });
  }

  // ── Name slugify ───────────────────────────────────────────────────────────

  slugifyName(): void {
    if (!this.editingName()) {
      this.form.name = this.form.name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 200);
    }
  }

  autoSlugFromTypeName(val: string): void {
    this.form.typeName = val;
    if (!this.editingName()) {
      this.form.name = val.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 200);
    }
  }

  // ── Tag suggestions ────────────────────────────────────────────────────────
  // `addTag`/`removeTag` went with the editor. `schemaState.tagSuggestions` deliberately stays: it is
  // loaded from the stored entry and written back on save, so retiring the control does not delete an
  // operator's list. Same trade as the space-wide list in #365 — an unused field is a smaller cost
  // than silently destroying data on the next save.

  // ── Save ───────────────────────────────────────────────────────────────────

  saveEntry(): void {
    this.dialogError.set('');
    const name    = this.editingName() ?? this.form.name.trim();
    const payload = {
      knowledgeType: this.form.knowledgeType,
      typeName:      this.form.typeName.trim() || name,
      schema:        formStateToSchema(this.form),
      description:   this.form.description.trim() || undefined,
      schemaGroup:   this.form.schemaGroup.trim() || undefined,
    };

    if (!name) {
      this.dialogError.set(this.transloco.translate('schemaLib.error.nameRequired'));
      return;
    }

    this.saving.set(true);

    const req$ = this.editingName()
      ? this.schemaApi.upsertSchemaLibraryEntry(name, payload)
      : this.schemaApi.createSchemaLibraryEntry({ ...payload, name });

    req$.pipe(finalize(() => this.saving.set(false))).subscribe({
      next: ({ entry }) => {
        this.entries.update(list => {
          const idx = list.findIndex(e => e.name === entry.name);
          if (idx === -1) return [...list, entry];
          const updated = [...list];
          updated[idx] = entry;
          return updated;
        });
        this.closeDialog();
      },
      error: (err) => {
        this.dialogError.set(err?.error?.error ?? this.transloco.translate('schemaLib.error.saveFailed'));
      },
    });
  }

  deleteEntry(name: string): void {
    // Legacy inline confirm path — now superseded by initiateDelete().
    // Kept for safety; should not be reachable from current template.
    this._doDelete(name);
  }

  // ── Publish toggle ────────────────────────────────────────────────────────

  togglePublish(entry: SchemaLibraryEntry): void {
    const next = !entry.published;
    this.schemaApi.publishSchemaLibraryEntry(entry.name, next).subscribe({
      next: ({ entry: updated }) => {
        this.entries.update(list => {
          const idx = list.findIndex(e => e.name === updated.name);
          if (idx === -1) return list;
          const copy = [...list];
          copy[idx] = updated;
          return copy;
        });
      },
      error: () => { /* non-critical — show nothing */ },
    });
  }

  // ── Foreign catalogs ──────────────────────────────────────────────────────

  loadCatalogs(): void {
    if (this.catalogsLoading()) return;
    this.catalogsLoading.set(true);
    this.catalogsLoadError.set(null);
    this.schemaApi.listSchemaCatalogs().pipe(
      finalize(() => this.catalogsLoading.set(false)),
    ).subscribe({
      next: ({ catalogs }) => this.catalogs.set(catalogs),
      error: (err) => { this.catalogs.set([]); this.catalogsLoadError.set(httpErrorReason(err)); },
    });
  }

  openAddCatalog(): void {
    this.newCatalog = { name: '', url: '', description: '', accessToken: '' };
    this.catalogError.set('');
    this.showAddCatalog.set(true);
  }

  addCatalog(): void {
    this.catalogError.set('');
    const { name, url, description, accessToken } = this.newCatalog;
    if (!name.trim() || !url.trim()) {
      this.catalogError.set(this.transloco.translate('schemaLib.catalog.errorRequired'));
      return;
    }
    this.catalogSaving.set(true);
    const baseUrl = url.trim().replace(/\/+$/, '');
    const catalogUrl = baseUrl.endsWith('/api/schema-library') ? baseUrl : `${baseUrl}/api/schema-library`;
    this.schemaApi.addSchemaCatalog({ name: name.trim(), url: catalogUrl, description: description.trim() || undefined, accessToken: accessToken.trim() || undefined }).pipe(
      finalize(() => this.catalogSaving.set(false)),
    ).subscribe({
      next: ({ catalog }) => {
        this.catalogs.update(list => [...list, catalog]);
        this.showAddCatalog.set(false);
      },
      error: (err) => {
        this.catalogError.set(err?.error?.error ?? this.transloco.translate('schemaLib.catalog.saveError'));
      },
    });
  }

  // ── Library sharing ──────────────────────────────────────────────────────

  copyLibraryUrl(): void {
    navigator.clipboard.writeText(this.libraryPublicUrl).then(() => {
      this.urlCopied.set(true);
      setTimeout(() => this.urlCopied.set(false), 2000);
    }).catch(() => {});
  }

  closeCreateLibToken(): void {
    this.showCreateLibToken.set(false);
    this.libTokenName.set('');
    this.libTokenError.set('');
  }

  createLibraryToken(): void {
    const name = this.libTokenName().trim();
    if (!name) {
      this.libTokenError.set(this.transloco.translate('tokens.error.nameRequired'));
      return;
    }
    this.libTokenCreating.set(true);
    this.libTokenError.set('');
    this.authApi.createToken({ name, schemaLibrary: true }).pipe(
      finalize(() => this.libTokenCreating.set(false)),
    ).subscribe({
      next: ({ plaintext }) => {
        this.closeCreateLibToken();
        this.libTokenRevealed.set(plaintext);
      },
      error: (err) => {
        this.libTokenError.set(err?.error?.error ?? this.transloco.translate('tokens.error.createFailed'));
      },
    });
  }

  copyRevealedToken(): void {
    const t = this.libTokenRevealed();
    if (t) navigator.clipboard.writeText(t).catch(() => {});
  }

  removeCatalog(name: string): void {
    this.schemaApi.deleteSchemaCatalog(name).subscribe({
      next: () => this.catalogs.update(list => list.filter(c => c.name !== name)),
      error: () => { /* non-critical */ },
    });
  }

  openBrowse(catalogName: string): void {
    this.browsing.set({ catalogName, entries: [], loading: true, error: '' });
    this.schemaApi.browseCatalog(catalogName).subscribe({
      next: ({ entries }) => this.browsing.update(b => b ? { ...b, entries, loading: false } : b),
      error: (err) => {
        const msg = err?.error?.error ?? this.transloco.translate('schemaLib.catalog.fetchFailed');
        this.browsing.update(b => b ? { ...b, loading: false, error: msg } : b);
      },
    });
  }

  importFromCatalog(catalogName: string, entry: ForeignCatalogEntry): void {
    if (this.catalogImporting()) return;
    // Fetch full schema for this entry, then upsert locally
    this.catalogImporting.set(true);
    this.schemaApi.getCatalogEntry(catalogName, entry.name).pipe(
      finalize(() => this.catalogImporting.set(false)),
    ).subscribe({
      next: ({ entry: full }) => {
        if (!full.schema) return;
        this.schemaApi.upsertSchemaLibraryEntry(full.name, {
          knowledgeType: full.knowledgeType,
          typeName: full.typeName,
          schema: full.schema,
          description: full.description,
          sourceCatalog: catalogName,
        }).subscribe({
          next: ({ entry: upserted }) => {
            this.entries.update(list => {
              const idx = list.findIndex(e => e.name === upserted.name);
              if (idx === -1) return [...list, upserted];
              const copy = [...list]; copy[idx] = upserted; return copy;
            });
          },
          error: () => { /* non-critical */ },
        });
      },
      error: () => { /* non-critical */ },
    });
  }

  // ── Export single entry to file ────────────────────────────────────────────

  exportEntry(entry: SchemaLibraryEntry): void {
    const blob = new Blob([JSON.stringify(entry, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `schema-library_${entry.name}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Import entries from file ───────────────────────────────────────────────

  triggerImportFile(): void {
    this.importFileInputRef?.nativeElement.click();
  }

  onImportFile(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const raw = JSON.parse(reader.result as string);
        // Two accepted shapes:
        //  (a) a space-schema export envelope `{ spaceId?, spaceLabel?, typeSchemas: {...} }` (or a bare
        //      typeSchemas object) — auto-grouped into one library entry per inline type, and
        //  (b) a single library entry or an array of them (the per-entry export shape).
        const ts = extractTypeSchemas(raw);
        let items: unknown[];
        let group: string | undefined;
        let skipped = 0;
        if (ts) {
          const g = (raw?.spaceLabel || raw?.spaceId || file.name.replace(/\.json$/i, '') || 'imported').toString();
          group = g;
          const built = entriesFromTypeSchemas(ts, g);
          items = built.entries;
          skipped = built.skippedRefs;
        } else {
          items = Array.isArray(raw) ? raw : [raw];
        }
        let imported = 0;
        for (const item of items) {
          const e = item as SchemaLibraryEntry;
          if (!e?.name || !e?.knowledgeType || !e?.schema) continue;
          try {
            const r = await this.schemaApi.upsertSchemaLibraryEntry(e.name, {
              knowledgeType: e.knowledgeType,
              typeName: e.typeName ?? e.name,
              schema: e.schema,
              description: e.description,
              schemaGroup: e.schemaGroup,
            }).toPromise();
            if (r?.entry) {
              this.entries.update(list => {
                const idx = list.findIndex(x => x.name === r.entry.name);
                if (idx === -1) return [...list, r.entry];
                const u = [...list]; u[idx] = r.entry; return u;
              });
              imported++;
            }
          } catch { /* skip invalid entries */ }
        }
        if (imported === 0) {
          this.toast.info(this.transloco.translate('schemaLib.import.noneImported'));
        } else if (group !== undefined) {
          const key = skipped > 0 ? 'schemaLib.import.spaceGroupedSkipped' : 'schemaLib.import.spaceGrouped';
          this.toast.success(this.transloco.translate(key, { count: imported, group, skipped }));
        }
      } catch {
        this.toast.error(this.transloco.translate('schemaLib.import.parseFailed'));
      } finally {
        if (this.importFileInputRef) this.importFileInputRef.nativeElement.value = '';
      }
    };
    reader.readAsText(file);
  }

  // ── Export space schema to library ────────────────────────────────────────

  openExportSpace(): void {
    this.exportSpaceDialog.set({ spaceId: '', groupName: '', namePrefix: '', saving: false, error: '', result: '' });
  }

  doExportSpace(): void {
    const d = this.exportSpaceDialog();
    if (!d) return;
    if (!d.spaceId) {
      this.exportSpaceDialog.update(s => s ? { ...s, error: this.transloco.translate('schemaLib.exportSpace.errorNoSpace') } : s);
      return;
    }
    if (!d.groupName.trim()) {
      this.exportSpaceDialog.update(s => s ? { ...s, error: this.transloco.translate('schemaLib.exportSpace.errorNoGroup') } : s);
      return;
    }
    this.exportSpaceDialog.update(s => s ? { ...s, saving: true, error: '', result: '' } : s);
    this.schemaApi.exportSpaceSchemaToLibrary({
      spaceId: d.spaceId,
      groupName: d.groupName.trim(),
      namePrefix: d.namePrefix.trim() || undefined,
    }).pipe(finalize(() => this.exportSpaceDialog.update(s => s ? { ...s, saving: false } : s))).subscribe({
      next: ({ created, updated, entries: newEntries }) => {
        // Merge new/updated entries into local list
        this.entries.update(list => {
          let result = [...list];
          for (const entry of newEntries) {
            const idx = result.findIndex(e => e.name === entry.name);
            if (idx === -1) result = [...result, entry];
            else { result = [...result]; result[idx] = entry; }
          }
          return result;
        });
        const msg = this.transloco.translate('schemaLib.exportSpace.success', { created, updated });
        this.exportSpaceDialog.update(s => s ? { ...s, result: msg } : s);
      },
      error: (err) => {
        this.exportSpaceDialog.update(s => s ? { ...s, error: err?.error?.error ?? this.transloco.translate('schemaLib.exportSpace.errorFailed') } : s);
      },
    });
  }

  // ── Apply group to space ──────────────────────────────────────────────────

  openApplyGroup(): void {
    this.applyGroupDialog.set({ group: this.groupFilter() ?? '', spaceId: '', saving: false, error: '', result: '' });
  }

  doApplyGroup(): void {
    const d = this.applyGroupDialog();
    if (!d) return;
    if (!d.group) {
      this.applyGroupDialog.update(s => s ? { ...s, error: this.transloco.translate('schemaLib.applyGroup.errorNoGroup') } : s);
      return;
    }
    if (!d.spaceId) {
      this.applyGroupDialog.update(s => s ? { ...s, error: this.transloco.translate('schemaLib.applyGroup.errorNoSpace') } : s);
      return;
    }
    this.applyGroupDialog.update(s => s ? { ...s, saving: true, error: '', result: '' } : s);
    this.schemaApi.applyGroupToSpace(d.group, d.spaceId).pipe(
      finalize(() => this.applyGroupDialog.update(s => s ? { ...s, saving: false } : s)),
    ).subscribe({
      next: ({ count }) => {
        const msg = this.transloco.translate('schemaLib.applyGroup.success', { count });
        this.applyGroupDialog.update(s => s ? { ...s, result: msg } : s);
      },
      error: (err) => {
        this.applyGroupDialog.update(s => s ? { ...s, error: err?.error?.error ?? this.transloco.translate('schemaLib.applyGroup.errorFailed') } : s);
      },
    });
  }
}
