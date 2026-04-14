import {
  Component,
  EventEmitter,
  inject,
  Input,
  Output,
  signal,
  computed,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../core/api.service';

type RecordType = 'entity' | 'edge' | 'memory' | 'chrono';

interface FieldEntry {
  key: string;
  value: unknown;
  kind: 'scalar' | 'object' | 'array';
}

@Component({
  selector: 'app-entry-popup',
  standalone: true,
  imports: [CommonModule, FormsModule],
  styles: [
    `
      .popup-backdrop {
        position: fixed;
        inset: 0;
        background: var(--bg-overlay);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
      }

      .popup-modal {
        background: var(--bg-surface);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        width: 100%;
        max-width: 640px;
        max-height: 85vh;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
      }

      .popup-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 16px 20px;
        border-bottom: 1px solid var(--border);
      }

      .popup-header h2 {
        margin: 0;
        font-size: 1rem;
        font-weight: 600;
        color: var(--text-primary);
      }

      .popup-header .badge {
        font-size: 0.75rem;
      }

      .toggle-row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 20px;
        border-bottom: 1px solid var(--border);
      }

      .toggle-row label {
        font-size: 0.8rem;
        color: var(--text-secondary);
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 4px;
      }

      .popup-body {
        padding: 16px 20px;
        flex: 1;
        overflow-y: auto;
      }

      /* ── Field grid ── */
      .field-grid {
        display: grid;
        grid-template-columns: minmax(100px, auto) 1fr;
        gap: 8px 12px;
        align-items: start;
      }

      .field-label {
        text-align: right;
        color: var(--text-muted);
        font-size: 0.8rem;
        padding-top: 6px;
        font-family: var(--font-mono);
        word-break: break-all;
      }

      .field-value input,
      .field-value textarea {
        width: 100%;
        box-sizing: border-box;
      }

      .field-value textarea {
        min-height: 60px;
        resize: vertical;
      }

      /* ── Sub-tables ── */
      .sub-section {
        grid-column: 1 / -1;
        margin: 8px 0;
      }

      .sub-section-title {
        font-family: var(--font-mono);
        color: var(--text-muted);
        font-size: 0.8rem;
        margin-bottom: 4px;
      }

      .sub-table {
        width: 100%;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-elevated);
        border-collapse: collapse;
        font-size: 0.85rem;
      }

      .sub-table th,
      .sub-table td {
        padding: 4px 8px;
        border-bottom: 1px solid var(--border);
        text-align: left;
      }

      .sub-table th {
        color: var(--text-muted);
        font-weight: 500;
        font-size: 0.75rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }

      .sub-table td {
        color: var(--text-secondary);
        font-family: var(--font-mono);
        font-size: 0.8rem;
        word-break: break-all;
      }

      .sub-table tr:last-child td {
        border-bottom: none;
      }

      /* ── Raw JSON ── */
      .raw-json {
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        padding: 12px;
        font-family: var(--font-mono);
        font-size: 0.8rem;
        color: var(--text-secondary);
        white-space: pre-wrap;
        word-break: break-all;
        overflow-x: auto;
        max-height: 60vh;
      }

      /* ── Footer ── */
      .popup-footer {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 8px;
        padding: 12px 20px;
        border-top: 1px solid var(--border);
      }

      .popup-footer .spacer {
        flex: 1;
      }

      /* ── Status messages ── */
      .status-msg {
        font-size: 0.8rem;
        padding: 6px 12px;
        border-radius: var(--radius-sm);
        margin-bottom: 12px;
      }

      .status-msg.success {
        background: rgba(63, 185, 80, 0.12);
        color: var(--success);
      }

      .status-msg.error {
        background: var(--error-dim);
        color: var(--error);
      }
    `,
  ],
  template: `
    @if (record) {
      <div class="popup-backdrop" (click)="onBackdropClick($event)">
        <div class="popup-modal" (click)="$event.stopPropagation()">
          <!-- Header -->
          <div class="popup-header">
            <h2>
              {{ recordId() || 'Record' }}
            </h2>
            <span class="badge">{{ recordType }}</span>
          </div>

          <!-- Raw JSON toggle -->
          <div class="toggle-row">
            <label>
              <input
                type="checkbox"
                [checked]="showRaw()"
                (change)="showRaw.set(!showRaw())"
              />
              Raw JSON
            </label>
          </div>

          <!-- Body -->
          <div class="popup-body">
            @if (statusMsg()) {
              <div
                class="status-msg"
                [class.success]="statusType() === 'success'"
                [class.error]="statusType() === 'error'"
              >
                {{ statusMsg() }}
              </div>
            }

            @if (showRaw()) {
              @if (canEdit) {
                <textarea
                  class="raw-json"
                  style="width: 100%; min-height: 300px; resize: vertical"
                  [ngModel]="rawJson()"
                  (ngModelChange)="onRawJsonChange($event)"
                ></textarea>
              } @else {
                <pre class="raw-json">{{ rawJson() }}</pre>
              }
            } @else {
              <div class="field-grid">
                @for (field of fields(); track field.key) {
                  @if (field.kind === 'scalar') {
                    <div class="field-label">{{ field.key }}</div>
                    <div class="field-value">
                      @if (field.key === '_id') {
                        <input
                          type="text"
                          [ngModel]="stringify(field.value)"
                          disabled
                        />
                      } @else if (isBoolean(field.value)) {
                        <input
                          type="checkbox"
                          [ngModel]="!!field.value"
                          (ngModelChange)="onFieldChange(field.key, $event)"
                          [disabled]="!canEdit"
                        />
                      } @else if (isNumber(field.value)) {
                        <input
                          type="number"
                          [ngModel]="field.value"
                          (ngModelChange)="onFieldChange(field.key, $event)"
                          [disabled]="!canEdit"
                        />
                      } @else {
                        <input
                          type="text"
                          [ngModel]="stringify(field.value)"
                          (ngModelChange)="onFieldChange(field.key, $event)"
                          [disabled]="!canEdit"
                        />
                      }
                    </div>
                  } @else {
                    <div class="sub-section">
                      <div class="sub-section-title">{{ field.key }}</div>
                      @if (field.kind === 'object' && isObject(field.value)) {
                        <table class="sub-table">
                          <thead>
                            <tr>
                              <th>Key</th>
                              <th>Value</th>
                            </tr>
                          </thead>
                          <tbody>
                            @for (
                              entry of objectEntries(field.value);
                              track entry[0]
                            ) {
                              <tr>
                                <td>{{ entry[0] }}</td>
                                <td>{{ entry[1] }}</td>
                              </tr>
                            }
                          </tbody>
                        </table>
                      }
                      @if (field.kind === 'array' && isArray(field.value)) {
                        <table class="sub-table">
                          <thead>
                            <tr>
                              <th>#</th>
                              <th>Value</th>
                            </tr>
                          </thead>
                          <tbody>
                            @for (
                              item of asArray(field.value);
                              track $index
                            ) {
                              <tr>
                                <td>{{ $index }}</td>
                                <td>{{ stringify(item) }}</td>
                              </tr>
                            }
                          </tbody>
                        </table>
                      }
                    </div>
                  }
                }
              </div>
            }
          </div>

          <!-- Footer -->
          <div class="popup-footer">
            @if (saving()) {
              <span class="badge">Saving…</span>
            }
            <div class="spacer"></div>
            @if (canEdit) {
              <button class="btn btn-secondary btn-sm" (click)="validate()">
                Validate
              </button>
              <button class="btn btn-ghost btn-sm" (click)="undo()">
                Undo
              </button>
              <button class="btn btn-sm" (click)="cancel()">Cancel</button>
              <button
                class="btn btn-primary btn-sm"
                (click)="save()"
                [disabled]="saving()"
              >
                Save
              </button>
            } @else {
              <button class="btn btn-sm" (click)="cancel()">Close</button>
            }
          </div>
        </div>
      </div>
    }
  `,
})
export class EntryPopupComponent {
  private api = inject(ApiService);

  @Input() record: Record<string, unknown> | null = null;
  @Input() recordType: RecordType = 'entity';
  @Input() spaceId = '';
  @Input() canEdit = false;

  @Output() closed = new EventEmitter<void>();
  @Output() saved = new EventEmitter<Record<string, unknown>>();

  showRaw = signal(false);
  saving = signal(false);
  statusMsg = signal('');
  statusType = signal<'success' | 'error'>('success');

  /** Working copy that can be mutated by the user. */
  private draft = signal<Record<string, unknown>>({});

  /** Snapshot of the record when it was last received/saved. */
  private snapshot = signal<Record<string, unknown>>({});

  recordId = computed(() => {
    const id = this.draft()['_id'];
    return id != null ? String(id) : '';
  });

  rawJson = computed(() => JSON.stringify(this.draft(), null, 2));

  fields = computed<FieldEntry[]>(() => {
    const d = this.draft();
    const keys = Object.keys(d);

    // _id always first
    const sorted = keys.sort((a, b) => {
      if (a === '_id') return -1;
      if (b === '_id') return 1;
      return a.localeCompare(b);
    });

    return sorted.map((key) => {
      const value = d[key];
      let kind: FieldEntry['kind'] = 'scalar';
      if (Array.isArray(value)) {
        kind = 'array';
      } else if (value !== null && typeof value === 'object') {
        kind = 'object';
      }
      return { key, value, kind };
    });
  });

  /** React to input changes — reset draft + snapshot. */
  ngOnChanges(): void {
    if (this.record) {
      const copy = structuredClone(this.record);
      this.draft.set(copy);
      this.snapshot.set(structuredClone(this.record));
      this.clearStatus();
    }
  }

  // ── Template helpers ──────────────────────────────────────────────────────

  stringify(v: unknown): string {
    if (v === null) return 'null';
    if (v === undefined) return '';
    return String(v);
  }

  isBoolean(v: unknown): v is boolean {
    return typeof v === 'boolean';
  }

  isNumber(v: unknown): v is number {
    return typeof v === 'number';
  }

  isObject(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  isArray(v: unknown): v is unknown[] {
    return Array.isArray(v);
  }

  asArray(v: unknown): unknown[] {
    return Array.isArray(v) ? v : [];
  }

  objectEntries(v: unknown): [string, unknown][] {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      return Object.entries(v as Record<string, unknown>);
    }
    return [];
  }

  // ── Field editing ─────────────────────────────────────────────────────────

  onFieldChange(key: string, value: unknown): void {
    this.draft.update((d) => ({ ...d, [key]: value }));
  }

  onRawJsonChange(raw: string): void {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      this.draft.set(parsed);
      this.clearStatus();
    } catch {
      // allow partial edits; don't overwrite draft with invalid JSON
    }
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  validate(): void {
    try {
      JSON.parse(JSON.stringify(this.draft()));
      this.statusMsg.set('Valid ✓');
      this.statusType.set('success');
    } catch {
      this.statusMsg.set('Invalid JSON');
      this.statusType.set('error');
    }
  }

  undo(): void {
    this.draft.set(structuredClone(this.snapshot()));
    this.clearStatus();
  }

  cancel(): void {
    this.closed.emit();
  }

  save(): void {
    const id = this.recordId();
    if (!id) {
      this.statusMsg.set('Cannot save: no _id field');
      this.statusType.set('error');
      return;
    }

    this.saving.set(true);
    this.clearStatus();

    const body = this.buildPatchBody();
    const call = this.getUpdateCall(id, body);

    call.subscribe({
      next: (result) => {
        this.saving.set(false);
        this.snapshot.set(structuredClone(result as Record<string, unknown>));
        this.draft.set(structuredClone(result as Record<string, unknown>));
        this.statusMsg.set('Saved ✓');
        this.statusType.set('success');
        this.saved.emit(result as Record<string, unknown>);
      },
      error: (err: { message?: string }) => {
        this.saving.set(false);
        this.statusMsg.set(err.message ?? 'Save failed');
        this.statusType.set('error');
      },
    });
  }

  onBackdropClick(e: MouseEvent): void {
    if (e.target === e.currentTarget) {
      this.closed.emit();
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private buildPatchBody(): Record<string, unknown> {
    const d = { ...this.draft() };
    delete d['_id'];
    return d;
  }

  private getUpdateCall(
    id: string,
    body: Record<string, unknown>,
  ): import('rxjs').Observable<unknown> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b = body as any;
    switch (this.recordType) {
      case 'entity':
        return this.api.updateEntity(this.spaceId, id, b);
      case 'edge':
        return this.api.updateEdge(this.spaceId, id, b);
      case 'memory':
        return this.api.updateMemory(this.spaceId, id, b);
      case 'chrono':
        return this.api.updateChrono(this.spaceId, id, b);
    }
  }

  private clearStatus(): void {
    this.statusMsg.set('');
  }
}
