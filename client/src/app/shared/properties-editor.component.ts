import { Component, Input, Output, EventEmitter, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { PropertySchema } from '../core/api.service';

interface PropRow {
  key: string;
  val: string;
  removable: boolean;
}

@Component({
  selector: 'app-properties-editor',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="prop-editor">
      @for (row of rows; track $index; let i = $index) {
        <div class="prop-row">
          <input class="prop-key" type="text" placeholder="key"
            [(ngModel)]="row.key" [name]="'propKey' + i"
            [readOnly]="!row.removable && !!schema?.[row.key]"
            (ngModelChange)="emit()" />
          @if (schema?.[row.key]?.enum?.length) {
            <select class="prop-val" [(ngModel)]="row.val" [name]="'propVal' + i" (ngModelChange)="emit()">
              @for (opt of schema![row.key].enum!; track opt) {
                <option [value]="opt">{{ opt }}</option>
              }
            </select>
          } @else if (schema?.[row.key]?.type === 'boolean') {
            <select class="prop-val" [(ngModel)]="row.val" [name]="'propVal' + i" (ngModelChange)="emit()">
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          } @else if (schema?.[row.key]?.type === 'number') {
            <input class="prop-val" type="number" [(ngModel)]="row.val"
              [name]="'propVal' + i" (ngModelChange)="emit()" />
          } @else {
            <input class="prop-val" type="text" [(ngModel)]="row.val"
              placeholder="value" [name]="'propVal' + i" (ngModelChange)="emit()" />
          }
          @if (row.removable) {
            <button type="button" class="prop-remove" title="Remove" (click)="removeRow(i)">×</button>
          } @else {
            <span class="prop-req">req</span>
          }
        </div>
      }
      <button type="button" class="btn btn-sm btn-secondary prop-add" (click)="addRow()">+ Add</button>
    </div>
  `,
  styles: [`
    .prop-editor { display: flex; flex-direction: column; gap: 4px; min-width: 220px; }
    .prop-row { display: flex; gap: 4px; align-items: center; }
    .prop-key { width: 110px; font-size: 12px; padding: 3px 6px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg-secondary); color: var(--text); min-width: 0; }
    .prop-key[readonly] { opacity: 0.6; cursor: default; }
    .prop-val { flex: 1; font-size: 12px; padding: 3px 6px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg-secondary); color: var(--text); min-width: 0; }
    select.prop-val { background: var(--bg-secondary); }
    .prop-remove { width: 20px; height: 22px; padding: 0; border: none; background: none; color: var(--text-muted); cursor: pointer; font-size: 15px; line-height: 1; flex-shrink: 0; }
    .prop-remove:hover { color: var(--error, #e57373); }
    .prop-req { width: 28px; font-size: 10px; color: var(--text-muted); text-align: center; flex-shrink: 0; }
    .prop-add { align-self: flex-start; margin-top: 2px; font-size: 11px; padding: 2px 8px; }
  `]
})
export class PropertiesEditorComponent implements OnInit {
  @Input() schema?: Record<string, PropertySchema>;
  @Input() required?: string[];
  @Input() value: Record<string, string | number | boolean> = {};
  @Output() valueChange = new EventEmitter<Record<string, string | number | boolean>>();

  rows: PropRow[] = [];

  ngOnInit(): void {
    this.rows = Object.entries(this.value).map(([key, val]) => ({
      key,
      val: String(val),
      removable: !(this.required?.includes(key) ?? false),
    }));
  }

  addRow(): void {
    this.rows.push({ key: '', val: '', removable: true });
  }

  removeRow(i: number): void {
    this.rows.splice(i, 1);
    this.emit();
  }

  emit(): void {
    const result: Record<string, string | number | boolean> = {};
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
    this.valueChange.emit(result);
  }
}
