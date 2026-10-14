import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { PropertySchema } from '../core/api.types';
import { TranslocoPipe } from '@jsverse/transloco';
import { PhIconComponent } from './ph-icon.component';

interface PropRow {
  key: string;
  val: string;
  /** A row the person added by hand: always removable, whatever the schema requires. */
  added: boolean;
}

type Props = Record<string, string | number | boolean>;

/** Unique per editor on a page: the ids a refusal's message is wired to (`aria-describedby`) must not collide. */
let editorSeq = 0;

/**
 * The properties of one record, as rows of key and value.
 *
 * ## What a row says about the schema (bundle-23, Q-93)
 *
 * Under a strict schema a key the type does not declare is REFUSED, so a key that is stored but invisible is a record nobody can
 * fix. Every row whose key the `schema` does not declare is marked (`data-undeclared`, and the words "not declared") and keeps
 * its remove button, whether it was stored, seeded from another type or typed by hand a moment ago. An absent or empty `schema`
 * is an OPEN type: it declares nothing, so nothing is marked.
 *
 * ## Which rows it rebuilds
 *
 * `value` is read when it CHANGES to an object this editor did not just emit. A type change hands it a different object and the
 * rows follow; the echo of the editor's own emission (two-way binding hands every emitted object straight back) is not a change,
 * so a blank row the person just added is not thrown away mid-typing.
 *
 * ## What a refusal does to it
 *
 * `errors` maps a property key to the sentence the server's refusal said about it: that key's value input is `aria-invalid` and
 * `aria-describedby` points at the sentence, which is also shown under the row.
 */
@Component({
  selector: 'app-properties-editor',
  standalone: true,
  imports: [FormsModule, TranslocoPipe, PhIconComponent],
  template: `
    <div class="prop-editor">
      @for (row of rows; track $index; let i = $index) {
        <div class="prop-row" [attr.data-undeclared]="isUndeclared(row.key) ? '' : null">
          <input class="prop-key" type="text" [placeholder]="'propertiesEditor.keyPlaceholder' | transloco"
            [attr.aria-label]="'propertiesEditor.keyLabel' | transloco"
            [(ngModel)]="row.key" [name]="'propKey' + i"
            [readOnly]="!isRemovable(row) && !!schema?.[row.key]"
            (ngModelChange)="emit()" />
          @if (schema?.[row.key]?.enum?.length) {
            <select class="prop-val" [(ngModel)]="row.val" [name]="'propVal' + i" (ngModelChange)="emit()"
              [attr.aria-label]="valueLabel(row) | transloco: { key: row.key }"
              [attr.aria-invalid]="errorFor(row) ? 'true' : null" [attr.aria-describedby]="errorFor(row) ? errorId(i) : null">
              @for (opt of schema![row.key].enum!; track opt) {
                <option [value]="opt">{{ opt }}</option>
              }
            </select>
          } @else if (schema?.[row.key]?.type === 'boolean') {
            <select class="prop-val" [(ngModel)]="row.val" [name]="'propVal' + i" (ngModelChange)="emit()"
              [attr.aria-label]="valueLabel(row) | transloco: { key: row.key }"
              [attr.aria-invalid]="errorFor(row) ? 'true' : null" [attr.aria-describedby]="errorFor(row) ? errorId(i) : null">
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          } @else if (schema?.[row.key]?.type === 'number') {
            <input class="prop-val" type="number" [(ngModel)]="row.val"
              [attr.aria-label]="valueLabel(row) | transloco: { key: row.key }"
              [attr.aria-invalid]="errorFor(row) ? 'true' : null" [attr.aria-describedby]="errorFor(row) ? errorId(i) : null"
              [name]="'propVal' + i" (ngModelChange)="emit()" />
          } @else if (schema?.[row.key]?.type === 'date') {
            <input class="prop-val" type="date" [(ngModel)]="row.val"
              [attr.aria-label]="valueLabel(row) | transloco: { key: row.key }"
              [attr.aria-invalid]="errorFor(row) ? 'true' : null" [attr.aria-describedby]="errorFor(row) ? errorId(i) : null"
              [name]="'propVal' + i" (ngModelChange)="emit()" />
          } @else {
            <input class="prop-val" type="text" [(ngModel)]="row.val"
              [attr.aria-label]="valueLabel(row) | transloco: { key: row.key }"
              [attr.aria-invalid]="errorFor(row) ? 'true' : null" [attr.aria-describedby]="errorFor(row) ? errorId(i) : null"
              [placeholder]="'propertiesEditor.valuePlaceholder' | transloco" [name]="'propVal' + i" (ngModelChange)="emit()" />
          }
          @if (isUndeclared(row.key)) {
            <span class="prop-undeclared">{{ 'propertiesEditor.notDeclared' | transloco }}</span>
          }
          @if (isRemovable(row)) {
            <button type="button" class="prop-remove" [attr.title]="'propertiesEditor.removeTitle' | transloco"
              [attr.aria-label]="(row.key ? 'propertiesEditor.removeFor' : 'propertiesEditor.removeTitle') | transloco: { key: row.key }"
              (click)="removeRow(i)"><ph-icon name="x" [size]="14"/></button>
          } @else {
            <span class="prop-req">{{ 'propertiesEditor.requiredBadge' | transloco }}</span>
          }
          @if (errorFor(row)) {
            <span class="prop-err" [id]="errorId(i)">{{ errorFor(row) }}</span>
          }
        </div>
      }
      <button type="button" class="btn btn-sm btn-secondary prop-add" (click)="addRow()">{{ 'propertiesEditor.addButton' | transloco }}</button>
    </div>
  `,
  styles: [`
    .prop-editor { display: flex; flex-direction: column; gap: 4px; min-width: 220px; }
    .prop-row { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
    .prop-key { width: 110px; font-size: 12px; padding: 3px 6px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg-secondary); color: var(--text); min-width: 0; }
    .prop-key[readonly] { opacity: 0.6; cursor: default; }
    .prop-val { flex: 1; font-size: 12px; padding: 3px 6px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg-secondary); color: var(--text); min-width: 0; }
    select.prop-val { background: var(--bg-secondary); }
    .prop-val[aria-invalid="true"] { border-color: var(--error); }
    .prop-remove { min-width: 24px; height: 24px; padding: 0; border: none; background: none; color: var(--text-muted); cursor: pointer; font-size: 15px; line-height: 1; flex-shrink: 0; }
    .prop-remove:hover { color: var(--error); }
    .prop-req { width: 28px; font-size: 10px; color: var(--text-muted); text-align: center; flex-shrink: 0; }
    .prop-undeclared { font-size: 10px; color: var(--warning); border: 1px solid var(--warning); border-radius: 3px; padding: 0 4px; flex-shrink: 0; }
    .prop-err { flex-basis: 100%; font-size: 11px; color: var(--error); overflow-wrap: anywhere; }
    .prop-add { align-self: flex-start; margin-block-start: 2px; font-size: 11px; padding: 2px 8px; }
    @media (forced-colors: active) { .prop-undeclared { border-style: dashed; } .prop-val[aria-invalid="true"] { border-width: 2px; } }
  `]
})
export class PropertiesEditorComponent implements OnChanges {
  @Input() schema?: Record<string, PropertySchema>;
  @Input() required?: string[];
  @Input() value: Props = {};
  /** Property key -> the sentence a refusal said about it. */
  @Input() errors?: Record<string, string> | null;
  @Output() valueChange = new EventEmitter<Props>();

  rows: PropRow[] = [];

  private readonly uid = `prop-editor-${editorSeq++}`;
  /** The object last emitted: when the parent hands it straight back it is an echo, not a new value. */
  private lastEmitted: Props | null = null;

  ngOnChanges(changes: SimpleChanges): void {
    const change = changes['value'];
    if (change && this.value !== this.lastEmitted) this.rebuild();
  }

  private rebuild(): void {
    this.rows = Object.entries(this.value ?? {}).map(([key, val]) => ({ key, val: String(val), added: false }));
  }

  /** A key is "not declared" only against a type that declares something; blank keys are not keys yet. */
  isUndeclared(key: string): boolean {
    const k = key.trim();
    if (!k || !this.schema || Object.keys(this.schema).length === 0) return false;
    return !Object.hasOwn(this.schema, k);
  }

  isRemovable(row: PropRow): boolean {
    return row.added || !(this.required?.includes(row.key) ?? false);
  }

  errorFor(row: PropRow): string {
    return this.errors?.[row.key.trim()] ?? '';
  }

  errorId(i: number): string {
    return `${this.uid}-err-${i}`;
  }

  /** The key of the translation that names a value control: with the key when the row has one. */
  valueLabel(row: PropRow): string {
    return row.key.trim() ? 'propertiesEditor.valueFor' : 'propertiesEditor.valueLabel';
  }

  addRow(): void {
    this.rows.push({ key: '', val: '', added: true });
  }

  removeRow(i: number): void {
    this.rows.splice(i, 1);
    this.emit();
  }

  emit(): void {
    const result: Props = {};
    for (const row of this.rows) {
      const k = row.key.trim();
      if (!k) continue;
      const s = this.schema?.[k];
      if (s?.type === 'number') {
        const n = parseFloat(row.val);
        result[k] = isNaN(n) ? row.val : n;
      } else if (s?.type === 'boolean') {
        result[k] = row.val === 'true';
      } else {
        result[k] = row.val;
      }
    }
    this.lastEmitted = result;
    this.valueChange.emit(result);
  }
}
