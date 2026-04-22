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
import { finalize } from 'rxjs';
import {
  ApiService, SchemaLibraryEntry, KnowledgeType, PropertySchema, TypeSchema,
} from '../../core/api.service';
import { TranslocoPipe } from '@jsverse/transloco';
import { TranslocoService } from '@jsverse/transloco';
import { PhIconComponent } from '../../shared/ph-icon.component';

// ── Local form state ────────────────────────────────────────────────────────

interface TypeSchemaState {
  namingPattern:   string;
  tagSuggestions:  string[];
  propertySchemas: { key: string; s: PropertySchema; _enumInput: string }[];
  _newPropInput:   string;
  _newTagInput:    string;
}

interface LibraryFormState {
  name:          string;
  description:   string;
  knowledgeType: KnowledgeType;
  typeName:      string;
  schemaState:   TypeSchemaState;
}

function emptySchemaState(): TypeSchemaState {
  return { namingPattern: '', tagSuggestions: [], propertySchemas: [], _newPropInput: '', _newTagInput: '' };
}

function entryToFormState(e: SchemaLibraryEntry): LibraryFormState {
  const s = e.schema;
  return {
    name:          e.name,
    description:   e.description ?? '',
    knowledgeType: e.knowledgeType,
    typeName:      e.typeName,
    schemaState: {
      namingPattern:   s.namingPattern   ?? '',
      tagSuggestions:  [...(s.tagSuggestions ?? [])],
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
  if (f.schemaState.tagSuggestions.length) {
    schema.tagSuggestions = [...f.schemaState.tagSuggestions];
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

@Component({
  selector: 'app-schema-library',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslocoPipe, PhIconComponent],
  styles: [`
    /* chip inputs — same as spaces.component.ts */
    .chip-wrap {
      display:flex; flex-wrap:wrap; gap:4px; align-items:center;
      border:1px solid var(--border); border-radius:var(--radius-sm);
      padding:4px 8px; min-height:34px; background:var(--bg-surface); cursor:text;
    }
    .chip {
      display:inline-flex; align-items:center; gap:3px;
      background:color-mix(in srgb,var(--accent) 15%,transparent);
      color:var(--accent); border-radius:3px; padding:1px 6px; font-size:12px;
    }
    .chip-rm { background:none; border:none; color:var(--text-muted); cursor:pointer; padding:0 2px; font-size:14px; line-height:1; }
    .chip-rm:hover { color:var(--danger); }
    .chip-field { border:none; background:none; outline:none; font-size:12px; min-width:100px; flex:1; color:var(--text-primary); font-family:var(--font); padding:1px 0; }
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
    /* property table */
    .prop-table { width:100%; border-collapse:collapse; font-size:13px; }
    .prop-table th { text-align:left; font-size:11px; font-weight:600; color:var(--text-muted); padding:5px 8px; border-bottom:1px solid var(--border); }
    .prop-table td { padding:6px 8px; border-bottom:1px solid var(--border); vertical-align:middle; }
    .prop-expand-row td { background:var(--bg-elevated); padding:0; }
    .prop-expand-inner { padding:12px 16px; }
    .sch-grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
    .sch-grid-3 { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; }
    .sch-sub { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.06em; color:var(--text-muted); margin-bottom:8px; padding-bottom:4px; border-bottom:1px solid var(--border); margin-top:20px; }
    /* entry list */
    .header-row { display:flex; align-items:center; justify-content:space-between; margin-bottom:20px; }
    .header-row h2 { margin:0; font-size:20px; font-weight:700; }
    .header-actions { display:flex; gap:8px; }
    .entry-grid { display:grid; gap:10px; }
    .entry-card { background:var(--bg-surface); border:1px solid var(--border); border-radius:var(--radius-md); padding:14px 16px; display:flex; align-items:flex-start; justify-content:space-between; gap:12px; transition:border-color .15s; }
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
    /* import/export banner */
    .ref-hint { font-size:12px; color:var(--text-secondary); background:var(--bg-elevated); border:1px solid var(--border); border-radius:var(--radius-sm); padding:8px 12px; margin-bottom:20px; font-family:var(--font-mono); }
    .ref-hint code { color:var(--accent); }
  `],
  template: `
    <div class="header-row">
      <h2>{{ 'schemaLib.title' | transloco }}</h2>
      <div class="header-actions">
        <button class="btn btn-secondary btn-sm" type="button" (click)="triggerImportFile()" [attr.title]="'schemaLib.import.fileTitle' | transloco">{{ 'schemaLib.import.fileButton' | transloco }}</button>
        <input #importFileInput type="file" accept=".json" style="display:none" (change)="onImportFile($event)" />
        <button class="btn btn-primary btn-sm" type="button" (click)="openCreate()">{{ 'schemaLib.createButton' | transloco }}</button>
      </div>
    </div>

    <p class="ref-hint">{{ 'schemaLib.refHint.prefix' | transloco }} <code>&#123; "$ref": "library:&lt;name&gt;" &#125;</code> {{ 'schemaLib.refHint.suffix' | transloco }}</p>

    @if (loading()) {
      <div class="empty-state"><span class="spinner"></span></div>
    } @else if (!entries().length) {
      <div class="empty-state">
        <div class="empty-state-icon"><ph-icon name="bookmarks" [size]="48"/></div>
        <h3>{{ 'schemaLib.empty.title' | transloco }}</h3>
        <p>{{ 'schemaLib.empty.subtitle' | transloco }}</p>
      </div>
    } @else {
      <div class="entry-grid">
        @for (entry of entries(); track entry.name) {
          <div class="entry-card">
            <div class="entry-main">
              <div class="entry-name">{{ entry.name }}</div>
              <div class="entry-meta">
                <span class="badge-kt">{{ entry.knowledgeType }}</span>
                <span class="badge-type">{{ entry.typeName }}</span>
                @if (propCount(entry) > 0) {
                  <span class="prop-badge">{{ propCount(entry) }} prop{{ propCount(entry) !== 1 ? 's' : '' }}</span>
                }
                @if (entry.schema.namingPattern) {
                  <span class="prop-badge" [title]="entry.schema.namingPattern">pattern</span>
                }
                <span class="updated">{{ 'schemaLib.updated' | transloco }}: {{ entry.updatedAt | date:'dd.MM.yyyy HH:mm' }}</span>
              </div>
              @if (entry.description) { <div class="entry-description">{{ entry.description }}</div> }
            </div>
            <div class="entry-actions">
              <button class="btn btn-ghost btn-sm" type="button" (click)="exportEntry(entry)" [attr.title]="'schemaLib.export.title' | transloco">↓</button>
              <button class="btn btn-secondary btn-sm" type="button" (click)="openEdit(entry)">{{ 'common.edit' | transloco }}</button>
              @if (confirmDeleteName() === entry.name) {
                <span class="inline-confirm">
                  <button class="btn btn-danger btn-sm" (click)="deleteEntry(entry.name)">{{ 'common.yes' | transloco }}</button>
                  <button class="btn btn-secondary btn-sm" (click)="confirmDeleteName.set('')">{{ 'common.no' | transloco }}</button>
                </span>
              } @else {
                <button class="btn btn-ghost btn-sm danger" type="button" (click)="confirmDeleteName.set(entry.name)">{{ 'common.delete' | transloco }}</button>
              }
            </div>
          </div>
        }
      </div>
    }

    <!-- Create / Edit dialog -->
    @if (showDialog()) {
      <div class="dialog-backdrop" (click)="closeDialog()">
        <div class="dialog" (click)="$event.stopPropagation()">
          <div class="dialog-header">
            <h3>{{ editingName() ? ('schemaLib.dialog.editTitle' | transloco) : ('schemaLib.dialog.createTitle' | transloco) }}</h3>
            <button class="icon-btn" type="button" (click)="closeDialog()"><ph-icon name="x" [size]="18"/></button>
          </div>

          <!-- Entry metadata -->
          <div class="sch-grid" style="margin-bottom:16px;">
            <div class="field">
              <label>{{ 'schemaLib.field.name' | transloco }}</label>
              <input type="text" [(ngModel)]="form.name" [disabled]="!!editingName()" [placeholder]="'schemaLib.field.namePlaceholder' | transloco" (input)="slugifyName()" />
              <span style="font-size:11px;color:var(--text-muted);">{{ 'schemaLib.field.nameHint' | transloco }}</span>
            </div>
            <div class="field">
              <label>{{ 'schemaLib.field.typeName' | transloco }}</label>
              <input type="text" [(ngModel)]="form.typeName" [placeholder]="'schemaLib.field.typeNamePlaceholder' | transloco" />
            </div>
          </div>

          <div class="sch-grid" style="margin-bottom:16px;">
            <div class="field">
              <label>{{ 'schemaLib.field.knowledgeType' | transloco }}</label>
              <select [(ngModel)]="form.knowledgeType" style="width:100%;">
                <option value="entity">entity</option>
                <option value="edge">edge</option>
                <option value="memory">memory</option>
                <option value="chrono">chrono</option>
              </select>
            </div>
            <div class="field">
              <label>{{ 'schemaLib.field.description' | transloco }}</label>
              <input type="text" [(ngModel)]="form.description" [placeholder]="'schemaLib.field.descriptionPlaceholder' | transloco" />
            </div>
          </div>

          <!-- Schema editor — matches spaces.component.ts per-type expand panel -->
          @if (form.knowledgeType === 'entity') {
            <div class="field" style="margin-bottom:16px;">
              <label>{{ 'spaces.schema.namingPattern' | transloco }} <span style="font-size:10px;font-weight:400;color:var(--text-muted);">{{ 'spaces.schema.namingPatternHint' | transloco }}</span></label>
              <input type="text" [(ngModel)]="form.schemaState.namingPattern" [placeholder]="'spaces.schema.namingPatternPlaceholder' | transloco" style="max-width:320px;" />
            </div>
          }

          <div style="margin-bottom:16px;">
            <div class="sch-sub">{{ 'spaces.schema.tagSuggestions' | transloco }} <span style="font-size:10px;font-weight:400;text-transform:none;letter-spacing:0;color:var(--text-muted);">{{ 'spaces.schema.tagSuggestionsHint' | transloco }}</span></div>
            <div class="chip-wrap" (click)="tagChipInput?.focus()">
              @for (tag of form.schemaState.tagSuggestions; track tag) {
                <span class="chip">{{ tag }} <button class="chip-rm" type="button" (mousedown)="removeTag(tag)">×</button></span>
              }
              <input #tagChipInput class="chip-field" [(ngModel)]="form.schemaState._newTagInput"
                     [placeholder]="form.schemaState.tagSuggestions.length ? '' : ('spaces.schema.addTagPlaceholder' | transloco)"
                     (keydown.enter)="addTag(); $event.preventDefault()"
                     (keydown.comma)="addTag(); $event.preventDefault()" />
            </div>
          </div>

          <!-- Property schemas — same table as spaces.component.ts -->
          <div>
            <div class="sch-sub">{{ 'spaces.schema.propertySchemas' | transloco }}</div>
            @if (form.schemaState.propertySchemas.length) {
              <table class="prop-table" style="margin-bottom:8px;">
                <thead><tr>
                  <th style="width:160px;">{{ 'spaces.schema.propTable.property' | transloco }}</th>
                  <th style="width:80px;">{{ 'spaces.schema.propTable.type' | transloco }}</th>
                  <th>{{ 'spaces.schema.propTable.constraints' | transloco }}</th>
                  <th></th>
                </tr></thead>
                <tbody>
                  @for (p of form.schemaState.propertySchemas; track p.key) {
                    <tr>
                      <td style="font-family:var(--font-mono);font-size:12px;">{{ p.key }}</td>
                      <td>
                        @if (p.s.type) { <span class="badge badge-gray" style="font-size:11px;">{{ p.s.type }}</span> }
                        @if (p.s.required) { <span class="badge badge-blue" style="font-size:10px;margin-left:3px;">req</span> }
                      </td>
                      <td style="font-size:11px;color:var(--text-muted);">
                        @if (p.s.enum?.length) { <span>enum({{ p.s.enum!.length }})</span> }
                        @if (p.s.minimum != null) { <span>min={{ p.s.minimum }}</span> }
                        @if (p.s.maximum != null) { <span>max={{ p.s.maximum }}</span> }
                        @if (p.s.pattern) { <span>pattern</span> }
                        @if (p.s.mergeFn) { <span>{{ p.s.mergeFn }}</span> }
                      </td>
                      <td style="white-space:nowrap;">
                        <button class="btn btn-ghost btn-sm" type="button" (click)="togglePropExpand(p.key)" style="font-size:11px;padding:2px 6px;">{{ isPropExpanded(p.key) ? '▲' : '▼' }}</button>
                        <button class="icon-btn danger" type="button" (click)="removeProp(p.key)" style="margin-left:4px;">✕</button>
                      </td>
                    </tr>
                    @if (isPropExpanded(p.key)) {
                      <tr class="prop-expand-row"><td colspan="4"><div class="prop-expand-inner">
                        <div class="sch-grid-3">
                          <div class="field" style="margin-bottom:0">
                            <label>{{ 'spaces.schema.propDetail.type' | transloco }}</label>
                            <select [(ngModel)]="p.s.type" (ngModelChange)="onPropTypeChange(p)">
                              <option value="">—</option>
                              <option value="string">string</option>
                              <option value="number">number</option>
                              <option value="boolean">boolean</option>
                              <option value="date">date</option>
                            </select>
                          </div>
                          <div class="field" style="margin-bottom:0">
                            <label>{{ 'spaces.schema.propDetail.default' | transloco }}</label>
                            <input type="text" [(ngModel)]="p.s.default" />
                          </div>
                          <div class="field" style="margin-bottom:0">
                            <label>{{ 'spaces.schema.propDetail.mergeFn' | transloco }}</label>
                            <select [(ngModel)]="p.s.mergeFn">
                              <option value="">—</option>
                              @if (p.s.type === 'number' || !p.s.type) {
                                <option value="avg">avg</option>
                                <option value="min">min</option>
                                <option value="max">max</option>
                                <option value="sum">sum</option>
                              }
                              @if (p.s.type === 'boolean' || !p.s.type) {
                                <option value="and">and</option>
                                <option value="or">or</option>
                                <option value="xor">xor</option>
                              }
                            </select>
                          </div>
                        </div>
                        <div class="sch-grid" style="margin-top:12px;">
                          @if (p.s.type !== 'boolean') {
                            <div class="field" style="margin-bottom:0">
                              <label>{{ 'spaces.schema.propDetail.pattern' | transloco }} <span style="font-size:10px;font-weight:400;color:var(--text-muted);">{{ 'spaces.schema.propDetail.patternHint' | transloco }}</span></label>
                              <input type="text" [(ngModel)]="p.s.pattern" />
                            </div>
                          }
                          @if (p.s.type === 'number') {
                            <div class="sch-grid-3">
                              <div class="field" style="margin-bottom:0"><label>{{ 'spaces.schema.propDetail.min' | transloco }}</label><input type="number" [(ngModel)]="p.s.minimum" /></div>
                              <div class="field" style="margin-bottom:0"><label>{{ 'spaces.schema.propDetail.max' | transloco }}</label><input type="number" [(ngModel)]="p.s.maximum" /></div>
                            </div>
                          }
                        </div>
                        @if (p.s.type !== 'boolean' && p.s.type !== 'number') {
                          <div class="field" style="margin-top:12px;margin-bottom:0">
                            <label>{{ 'spaces.schema.propDetail.enumValues' | transloco }} <span style="font-size:11px;font-weight:normal;color:var(--text-muted);">{{ 'spaces.schema.propDetail.enumHint' | transloco }}</span></label>
                            <div class="chip-wrap">
                              @for (v of (p.s.enum ?? []); track v) {
                                <span class="chip">{{ v }} <button class="chip-rm" type="button" (mousedown)="removeEnumVal(p.key, v)">×</button></span>
                              }
                              <input class="chip-field" [(ngModel)]="p._enumInput"
                                     [placeholder]="'spaces.schema.propDetail.enumPlaceholder' | transloco"
                                     (keydown)="onEnumKey($event, p.key)" />
                            </div>
                          </div>
                        }
                        <label style="display:inline-flex;align-items:center;gap:6px;margin-top:12px;font-size:13px;">
                          <input type="checkbox" [(ngModel)]="p.s.required" style="margin:0;" />
                          {{ 'spaces.schema.propDetail.required' | transloco }}
                        </label>
                      </div></td></tr>
                    }
                  }
                </tbody>
              </table>
            } @else {
              <p style="font-size:12px;color:var(--text-muted);margin:4px 0 8px;">{{ 'spaces.schema.noProps' | transloco }}</p>
            }
            <div style="display:flex;gap:8px;align-items:center;margin-top:4px;">
              <input type="text" [(ngModel)]="form.schemaState._newPropInput"
                     [placeholder]="'spaces.schema.newPropNamePlaceholder' | transloco"
                     style="width:180px;"
                     (keydown.enter)="addProp(); $event.preventDefault()" />
              <button class="btn btn-secondary btn-sm" type="button"
                      (click)="addProp()" [disabled]="!form.schemaState._newPropInput.trim()">{{ 'spaces.schema.addPropertyButton' | transloco }}</button>
            </div>
          </div>

          <div class="dialog-footer">
            @if (dialogError()) { <span style="font-size:12px;color:var(--danger);flex:1;">{{ dialogError() }}</span> }
            <button class="btn btn-secondary" type="button" (click)="closeDialog()">{{ 'common.cancel' | transloco }}</button>
            <button class="btn btn-primary" type="button" (click)="saveEntry()" [disabled]="saving()">
              {{ saving() ? ('common.saving' | transloco) : ('common.save' | transloco) }}
            </button>
          </div>
        </div>
      </div>
    }
  `,
})
export class SchemaLibraryComponent implements OnInit {
  private api      = inject(ApiService);
  private transloco = inject(TranslocoService);

  entries         = signal<SchemaLibraryEntry[]>([]);
  loading         = signal(true);
  saving          = signal(false);
  showDialog      = signal(false);
  editingName     = signal<string | null>(null);
  dialogError     = signal('');
  confirmDeleteName = signal('');

  expandedPropKey = signal<string | null>(null);

  @ViewChild('importFileInput') importFileInputRef?: ElementRef<HTMLInputElement>;

  form: LibraryFormState = this.blankForm();

  private blankForm(): LibraryFormState {
    return {
      name:          '',
      description:   '',
      knowledgeType: 'entity',
      typeName:      '',
      schemaState:   emptySchemaState(),
    };
  }

  ngOnInit(): void { this.load(); }

  load(): void {
    this.loading.set(true);
    this.api.listSchemaLibrary().pipe(
      finalize(() => this.loading.set(false)),
    ).subscribe({
      next: ({ entries }) => this.entries.set(entries),
      error: () => this.entries.set([]),
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
    this.expandedPropKey.set(null);
    this.showDialog.set(true);
  }

  openEdit(entry: SchemaLibraryEntry): void {
    this.form = entryToFormState(entry);
    this.editingName.set(entry.name);
    this.dialogError.set('');
    this.expandedPropKey.set(null);
    this.showDialog.set(true);
  }

  closeDialog(): void {
    this.showDialog.set(false);
    this.editingName.set(null);
    this.dialogError.set('');
    this.confirmDeleteName.set('');
  }

  // ── Name slugify ───────────────────────────────────────────────────────────

  slugifyName(): void {
    if (!this.editingName()) {
      this.form.name = this.form.name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 200);
    }
  }

  // ── Tag suggestions ────────────────────────────────────────────────────────

  addTag(): void {
    const raw = (this.form.schemaState._newTagInput ?? '').trim();
    if (!raw || this.form.schemaState.tagSuggestions.includes(raw)) {
      this.form.schemaState._newTagInput = '';
      return;
    }
    this.form.schemaState.tagSuggestions = [...this.form.schemaState.tagSuggestions, raw];
    this.form.schemaState._newTagInput = '';
  }

  removeTag(tag: string): void {
    this.form.schemaState.tagSuggestions = this.form.schemaState.tagSuggestions.filter(t => t !== tag);
  }

  // ── Property schemas ──────────────────────────────────────────────────────

  isPropExpanded(key: string): boolean { return this.expandedPropKey() === key; }

  togglePropExpand(key: string): void {
    this.expandedPropKey.set(this.isPropExpanded(key) ? null : key);
  }

  addProp(): void {
    const key = (this.form.schemaState._newPropInput ?? '').trim();
    if (!key || this.form.schemaState.propertySchemas.some(e => e.key === key)) {
      this.form.schemaState._newPropInput = '';
      return;
    }
    this.form.schemaState.propertySchemas = [...this.form.schemaState.propertySchemas, { key, s: {}, _enumInput: '' }];
    this.form.schemaState._newPropInput   = '';
    this.expandedPropKey.set(key);
  }

  removeProp(key: string): void {
    this.form.schemaState.propertySchemas = this.form.schemaState.propertySchemas.filter(e => e.key !== key);
    if (this.isPropExpanded(key)) this.expandedPropKey.set(null);
  }

  onPropTypeChange(p: { key: string; s: PropertySchema; _enumInput: string }): void {
    // Clear incompatible mergeFn when type changes
    if (p.s.type === 'boolean' && p.s.mergeFn && ['avg', 'min', 'max', 'sum'].includes(p.s.mergeFn)) p.s.mergeFn = undefined;
    if (p.s.type === 'number'  && p.s.mergeFn && ['and', 'or', 'xor'].includes(p.s.mergeFn))         p.s.mergeFn = undefined;
  }

  onEnumKey(e: KeyboardEvent, key: string): void {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); this.addEnumVal(key); }
  }

  addEnumVal(key: string): void {
    const entry = this.form.schemaState.propertySchemas.find(e => e.key === key);
    if (!entry) return;
    const val = (entry._enumInput ?? '').trim();
    if (!val) return;
    const curr = entry.s.enum ?? [];
    if (!curr.some(v => String(v) === val)) entry.s = { ...entry.s, enum: [...curr, val] };
    entry._enumInput = '';
  }

  removeEnumVal(key: string, val: string | number | boolean): void {
    const entry = this.form.schemaState.propertySchemas.find(e => e.key === key);
    if (!entry) return;
    entry.s = { ...entry.s, enum: (entry.s.enum ?? []).filter(v => v !== val) };
  }

  // ── Save ───────────────────────────────────────────────────────────────────

  saveEntry(): void {
    this.dialogError.set('');
    const name    = this.editingName() ?? this.form.name.trim();
    const payload = {
      knowledgeType: this.form.knowledgeType,
      typeName:      this.form.typeName.trim() || name,
      schema:        formStateToSchema(this.form),
      description:   this.form.description.trim() || undefined,
    };

    if (!name) {
      this.dialogError.set(this.transloco.translate('schemaLib.error.nameRequired'));
      return;
    }

    this.saving.set(true);

    const req$ = this.editingName()
      ? this.api.upsertSchemaLibraryEntry(name, payload)
      : this.api.createSchemaLibraryEntry({ ...payload, name });

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
    this.api.deleteSchemaLibraryEntry(name).subscribe({
      next: () => {
        this.entries.update(list => list.filter(e => e.name !== name));
        this.confirmDeleteName.set('');
      },
      error: (err) => {
        alert(err?.error?.error ?? this.transloco.translate('schemaLib.error.deleteFailed'));
        this.confirmDeleteName.set('');
      },
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
        // Accept a single entry or an array of entries
        const items: unknown[] = Array.isArray(raw) ? raw : [raw];
        let imported = 0;
        for (const item of items) {
          const e = item as SchemaLibraryEntry;
          if (!e?.name || !e?.knowledgeType || !e?.schema) continue;
          try {
            const r = await this.api.upsertSchemaLibraryEntry(e.name, {
              knowledgeType: e.knowledgeType,
              typeName: e.typeName ?? e.name,
              schema: e.schema,
              description: e.description,
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
        if (imported === 0) alert(this.transloco.translate('schemaLib.import.noneImported'));
      } catch {
        alert(this.transloco.translate('schemaLib.import.parseFailed'));
      } finally {
        if (this.importFileInputRef) this.importFileInputRef.nativeElement.value = '';
      }
    };
    reader.readAsText(file);
  }
}
