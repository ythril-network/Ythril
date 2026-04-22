import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService, SchemaLibraryEntry, KnowledgeType } from '../../core/api.service';
import { TranslocoPipe } from '@jsverse/transloco';

@Component({
  selector: 'app-schema-library',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslocoPipe],
  styles: [`
    .header-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 20px;
    }
    .header-row h2 {
      margin: 0;
      font-size: 20px;
      font-weight: 700;
      color: var(--text-primary);
    }
    .header-actions {
      display: flex;
      gap: 8px;
    }
    .entry-grid {
      display: grid;
      gap: 10px;
    }
    .entry-card {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: 14px 16px;
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
    }
    .entry-main {
      flex: 1;
      min-width: 0;
    }
    .entry-name {
      font-weight: 600;
      font-size: 14px;
      color: var(--text-primary);
      font-family: var(--font-mono);
    }
    .entry-meta {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
      margin-top: 4px;
    }
    .entry-description {
      font-size: 12px;
      color: var(--text-secondary);
      margin-top: 4px;
      word-break: break-word;
    }
    .entry-actions {
      display: flex;
      gap: 6px;
      flex-shrink: 0;
    }
    .badge-kt {
      background: var(--accent-dim);
      color: var(--accent);
      border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
      border-radius: 4px;
      padding: 1px 7px;
      font-size: 0.72rem;
      font-weight: 600;
      letter-spacing: 0.03em;
      text-transform: uppercase;
    }
    .badge-type {
      background: var(--bg-elevated);
      color: var(--text-secondary);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 1px 7px;
      font-size: 0.72rem;
      font-family: var(--font-mono);
    }
    .ref-hint {
      margin-top: 8px;
      font-size: 11px;
      color: var(--text-muted);
      font-family: var(--font-mono);
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 4px 8px;
      display: inline-block;
      user-select: all;
    }
    .form-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    .form-row.three {
      grid-template-columns: 1fr 1fr 1fr;
    }
    .dialog-backdrop {
      position: fixed;
      inset: 0;
      background: var(--bg-scrim);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 100;
    }
    .dialog {
      background: var(--bg-primary);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 24px;
      width: 90%;
      max-width: 660px;
      max-height: 90vh;
      overflow-y: auto;
    }
    .dialog-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
    }
    .schema-field {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .schema-field label {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .schema-field textarea {
      font-family: var(--font-mono);
      font-size: 12px;
      resize: vertical;
    }
    .schema-field input, .schema-field textarea, .schema-field select {
      padding: 6px 10px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: var(--bg-surface);
      color: var(--text-primary);
      font-size: 13px;
      font-family: var(--font);
      width: 100%;
    }
    .schema-field input:focus, .schema-field textarea:focus, .schema-field select:focus {
      outline: none;
      border-color: var(--accent);
    }
    .empty-state-inner {
      padding: 48px 24px;
      text-align: center;
    }
    .empty-state-inner h3 {
      font-size: 16px;
      margin: 0 0 8px;
      color: var(--text-primary);
    }
    .empty-state-inner p {
      font-size: 13px;
      color: var(--text-secondary);
      margin: 0 0 16px;
    }
    .timestamp {
      font-size: 11px;
      color: var(--text-muted);
    }
  `],
  template: `
    <div class="header-row">
      <h2>{{ 'schemaLib.title' | transloco }}</h2>
      <div class="header-actions">
        <button class="btn-secondary btn btn-sm" (click)="load()">{{ 'common.refresh' | transloco }}</button>
        <button class="btn-primary btn btn-sm" (click)="openCreate()">{{ 'schemaLib.createButton' | transloco }}</button>
      </div>
    </div>

    @if (errorMsg()) {
      <div class="alert alert-error" style="margin-bottom:16px;">{{ errorMsg() }}</div>
    }

    <div class="card" style="margin-bottom:20px;">
      <p style="margin:0; font-size:13px; color:var(--text-secondary);">{{ 'schemaLib.description' | transloco }}</p>
    </div>

    <!-- Entry list -->
    <div class="card">
      @if (loading()) {
        <div class="loading-overlay"><span class="spinner"></span></div>
      } @else if (entries().length === 0) {
        <div class="empty-state-inner">
          <h3>{{ 'schemaLib.empty.title' | transloco }}</h3>
          <p>{{ 'schemaLib.empty.subtitle' | transloco }}</p>
          <button class="btn-primary btn btn-sm" (click)="openCreate()">{{ 'schemaLib.createButton' | transloco }}</button>
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
                  <span class="timestamp">{{ 'schemaLib.updated' | transloco }} {{ entry.updatedAt | date:'dd.MM.yyyy HH:mm' }}</span>
                </div>
                @if (entry.description) {
                  <div class="entry-description">{{ entry.description }}</div>
                }
                <div class="ref-hint">\$ref: "library:{{ entry.name }}"</div>
              </div>
              <div class="entry-actions">
                <button class="icon-btn" [title]="'common.rename' | transloco" (click)="openEdit(entry)">✎</button>
                <button class="icon-btn danger" [title]="'common.remove' | transloco" (click)="promptDelete(entry)">✕</button>
              </div>
            </div>
          }
        </div>
      }
    </div>

    <!-- Create / Edit dialog -->
    @if (showDialog()) {
      <div class="dialog-backdrop" (click)="closeDialog()">
        <div class="dialog" (click)="$event.stopPropagation()">
          <div class="dialog-header">
            <div class="card-title">
              {{ editingEntry() ? ('schemaLib.dialog.editTitle' | transloco) : ('schemaLib.dialog.createTitle' | transloco) }}
            </div>
            <button class="icon-btn" [attr.aria-label]="'common.close' | transloco" (click)="closeDialog()">✕</button>
          </div>

          @if (dialogError()) {
            <div class="alert alert-error" style="margin-bottom:14px;">{{ dialogError() }}</div>
          }

          <div class="form-row" style="margin-bottom:12px;">
            <div class="schema-field">
              <label>{{ 'schemaLib.field.name' | transloco }}</label>
              <input
                type="text"
                [(ngModel)]="form.name"
                [disabled]="!!editingEntry()"
                maxlength="200"
                placeholder="service-v1"
              />
            </div>
            <div class="schema-field">
              <label>{{ 'schemaLib.field.typeName' | transloco }}</label>
              <input type="text" [(ngModel)]="form.typeName" maxlength="200" placeholder="service" />
            </div>
          </div>

          <div class="schema-field" style="margin-bottom:12px;">
            <label>{{ 'schemaLib.field.knowledgeType' | transloco }}</label>
            <select [(ngModel)]="form.knowledgeType">
              <option value="entity">entity</option>
              <option value="memory">memory</option>
              <option value="edge">edge</option>
              <option value="chrono">chrono</option>
            </select>
          </div>

          <div class="schema-field" style="margin-bottom:12px;">
            <label>{{ 'schemaLib.field.description' | transloco }}</label>
            <input type="text" [(ngModel)]="form.description" maxlength="1000" [placeholder]="'schemaLib.field.descriptionPlaceholder' | transloco" />
          </div>

          <div class="schema-field" style="margin-bottom:16px;">
            <label>{{ 'schemaLib.field.schema' | transloco }}</label>
            <textarea
              [(ngModel)]="form.schemaJson"
              rows="10"
              [placeholder]="schemaPlaceholder"
            ></textarea>
            <div style="font-size:11px; color:var(--text-muted); margin-top:3px;">{{ 'schemaLib.field.schemaHint' | transloco }}</div>
          </div>

          <div style="display:flex; gap:8px; justify-content:flex-end;">
            <button class="btn-secondary btn" (click)="closeDialog()">{{ 'common.cancel' | transloco }}</button>
            <button class="btn-primary btn" (click)="submitDialog()" [disabled]="saving()">
              @if (saving()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }
              {{ 'common.save' | transloco }}
            </button>
          </div>
        </div>
      </div>
    }

    <!-- Delete confirmation dialog -->
    @if (deletingEntry()) {
      <div class="dialog-backdrop" (click)="deletingEntry.set(null)">
        <div class="dialog" style="max-width:400px;" (click)="$event.stopPropagation()">
          <div class="dialog-header">
            <div class="card-title">{{ 'schemaLib.delete.title' | transloco }}</div>
            <button class="icon-btn" [attr.aria-label]="'common.close' | transloco" (click)="deletingEntry.set(null)">✕</button>
          </div>
          <p style="font-size:13px; color:var(--text-secondary); margin:0 0 16px;">
            {{ 'schemaLib.delete.confirm' | transloco }} <strong>{{ deletingEntry()?.name }}</strong>?
          </p>
          @if (deleteError()) {
            <div class="alert alert-error" style="margin-bottom:12px;">{{ deleteError() }}</div>
          }
          <div style="display:flex; gap:8px; justify-content:flex-end;">
            <button class="btn-secondary btn" (click)="deletingEntry.set(null)">{{ 'common.cancel' | transloco }}</button>
            <button class="btn-danger btn" (click)="confirmDelete()" [disabled]="deleting()">
              @if (deleting()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }
              {{ 'common.remove' | transloco }}
            </button>
          </div>
        </div>
      </div>
    }
  `,
})
export class SchemaLibraryComponent implements OnInit {
  private api = inject(ApiService);

  entries = signal<SchemaLibraryEntry[]>([]);
  loading = signal(true);
  errorMsg = signal('');

  showDialog = signal(false);
  editingEntry = signal<SchemaLibraryEntry | null>(null);
  dialogError = signal('');
  saving = signal(false);

  deletingEntry = signal<SchemaLibraryEntry | null>(null);
  deleteError = signal('');
  deleting = signal(false);

  form: {
    name: string;
    knowledgeType: KnowledgeType;
    typeName: string;
    description: string;
    schemaJson: string;
  } = { name: '', knowledgeType: 'entity', typeName: '', description: '', schemaJson: '' };

  readonly schemaPlaceholder = JSON.stringify(
    { namingPattern: '^[a-z][a-z0-9-]{1,60}$', tagSuggestions: ['example'], propertySchemas: { status: { type: 'string', enum: ['active', 'deprecated'], required: true } } },
    null, 2,
  );

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.errorMsg.set('');
    this.api.listSchemaLibrary().subscribe({
      next: ({ entries }) => { this.entries.set(entries); this.loading.set(false); },
      error: (err) => {
        this.errorMsg.set(err?.error?.error ?? 'Failed to load schema library');
        this.loading.set(false);
      },
    });
  }

  openCreate(): void {
    this.editingEntry.set(null);
    this.form = { name: '', knowledgeType: 'entity', typeName: '', description: '', schemaJson: '{}' };
    this.dialogError.set('');
    this.showDialog.set(true);
  }

  openEdit(entry: SchemaLibraryEntry): void {
    this.editingEntry.set(entry);
    this.form = {
      name: entry.name,
      knowledgeType: entry.knowledgeType,
      typeName: entry.typeName,
      description: entry.description ?? '',
      schemaJson: JSON.stringify(entry.schema, null, 2),
    };
    this.dialogError.set('');
    this.showDialog.set(true);
  }

  closeDialog(): void {
    this.showDialog.set(false);
    this.editingEntry.set(null);
  }

  submitDialog(): void {
    const { name, knowledgeType, typeName, description, schemaJson } = this.form;
    if (!name.trim()) { this.dialogError.set('Name is required.'); return; }
    if (!typeName.trim()) { this.dialogError.set('Type name is required.'); return; }

    let schema: object;
    try {
      schema = JSON.parse(schemaJson || '{}');
    } catch {
      this.dialogError.set('Schema is not valid JSON.');
      return;
    }

    this.saving.set(true);
    this.dialogError.set('');

    const editing = this.editingEntry();

    if (editing) {
      // Update via PUT
      this.api.upsertSchemaLibraryEntry(editing.name, { knowledgeType, typeName, schema: schema as SchemaLibraryEntry['schema'], ...(description ? { description } : {}) }).subscribe({
        next: ({ entry }) => {
          this.entries.update(list => list.map(e => e.name === entry.name ? entry : e));
          this.saving.set(false);
          this.closeDialog();
        },
        error: (err) => { this.dialogError.set(err?.error?.error ?? 'Failed to save entry'); this.saving.set(false); },
      });
    } else {
      // Create via POST
      this.api.createSchemaLibraryEntry({ name, knowledgeType, typeName, schema: schema as SchemaLibraryEntry['schema'], ...(description ? { description } : {}) }).subscribe({
        next: ({ entry }) => {
          this.entries.update(list => [...list, entry]);
          this.saving.set(false);
          this.closeDialog();
        },
        error: (err) => { this.dialogError.set(err?.error?.error ?? 'Failed to create entry'); this.saving.set(false); },
      });
    }
  }

  promptDelete(entry: SchemaLibraryEntry): void {
    this.deletingEntry.set(entry);
    this.deleteError.set('');
  }

  confirmDelete(): void {
    const entry = this.deletingEntry();
    if (!entry) return;
    this.deleting.set(true);
    this.deleteError.set('');
    this.api.deleteSchemaLibraryEntry(entry.name).subscribe({
      next: () => {
        this.entries.update(list => list.filter(e => e.name !== entry.name));
        this.deleting.set(false);
        this.deletingEntry.set(null);
      },
      error: (err) => { this.deleteError.set(err?.error?.error ?? 'Failed to delete entry'); this.deleting.set(false); },
    });
  }
}
