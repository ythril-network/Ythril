import { Component, Input, Output, EventEmitter, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslocoPipe } from '@jsverse/transloco';
import { PropertySchema } from '../core/api.types';
import { PhIconComponent } from './ph-icon.component';
import { CHIP_STYLES } from './chip.styles';
import { PROP_TABLE_STYLES } from './prop-table.styles';
import { mergeFnsFor, mergeFnAfterTypeChange } from './merge-fns';

export interface PropSchemaRow {
  key: string;
  s: PropertySchema;
  _enumInput: string;
}

@Component({
  selector: 'app-prop-schema-table',
  standalone: true,
  imports: [FormsModule, TranslocoPipe, PhIconComponent],
  // The table, row, detail-card and Required rules were a character-identical SECOND copy of the ones in
  // `SPACE_DIALOG_STYLES`. Both are now PROP_TABLE_STYLES; only this component's own add-row is local.
  styles: [CHIP_STYLES, PROP_TABLE_STYLES, `
    .add-prop-row { display:flex; gap:8px; align-items:center; margin-top:10px; padding-top:10px; border-top:1px solid var(--border); }
  `],
  template: `
    @if (rows.length) {
      <table class="prop-table">
        <thead><tr>
          <th style="width:160px;">{{ 'spaces.schema.propTable.property' | transloco }}</th>
          <th style="width:80px;">{{ 'spaces.schema.propTable.type' | transloco }}</th>
          <th>{{ 'spaces.schema.propTable.constraints' | transloco }}</th>
          <th></th>
        </tr></thead>
        <tbody>
          @for (p of rows; track p.key) {
            <tr class="prop-row" [class.prow-open]="expandedKey() === p.key" (click)="toggleExpand(p.key)">
              <td>
                <div class="prop-name">
                  <span class="prop-name-key">{{ p.key }}</span>
                  <label class="req-toggle" [class.is-req]="p.s.required" (click)="$event.stopPropagation()">
                    <input type="checkbox" [checked]="p.s.required" (change)="p.s.required = !p.s.required; changed.emit()" />
                    {{ 'spaces.schema.propDetail.required' | transloco }}
                  </label>
                </div>
              </td>
              <td><span class="badge badge-gray">{{ p.s.type ?? 'any' }}</span></td>
              <td style="font-size:11px;color:var(--text-muted);">
                @if (p.s.enum?.length) { <span class="badge badge-gray" style="margin-inline-end:3px">{{ 'spaces.schema.summary.enum' | transloco: { count: p.s.enum!.length } }}</span> }
                @if (p.s.minimum !== undefined) { <span style="margin-inline-end:4px;">{{ 'spaces.schema.summary.min' | transloco: { value: p.s.minimum } }}</span> }
                @if (p.s.maximum !== undefined) { <span style="margin-inline-end:4px;">{{ 'spaces.schema.summary.max' | transloco: { value: p.s.maximum } }}</span> }
                @if (p.s.pattern) { <span style="margin-inline-end:4px;">{{ 'spaces.schema.summary.pattern' | transloco }}</span> }
                @if (p.s.default !== undefined) { <span style="margin-inline-end:4px;">{{ 'spaces.schema.summary.default' | transloco: { value: p.s.default } }}</span> }
                @if (p.s.mergeFn) { <span class="badge badge-blue">{{ p.s.mergeFn }}</span> }
              </td>
              <td>
                <div style="display:flex;gap:4px;justify-content:flex-end;">
                  <button class="icon-btn danger" type="button" (click)="removeRow(p.key); $event.stopPropagation()" [attr.title]="'common.remove' | transloco"><ph-icon name="x" [size]="14"/></button>
                </div>
              </td>
            </tr>
            @if (expandedKey() === p.key) {
              <tr class="prop-expand-row" (click)="$event.stopPropagation()">
                <td colspan="4" style="padding:0;">
                  <div class="pdet">
                    <div class="pdet-fields">
                      <div class="field" style="margin:0;">
                        <label>{{ 'spaces.schema.propDetail.type' | transloco }}</label>
                        <select [(ngModel)]="p.s.type" (ngModelChange)="onTypeChange(p)">
                          <option [ngValue]="undefined">{{ 'spaces.schema.summary.any' | transloco }}</option>
                          <option value="string">string</option>
                          <option value="number">number</option>
                          <option value="boolean">boolean</option>
                          <option value="date">date</option>
                        </select>
                      </div>
                      <div class="field" style="margin:0;">
                        <label>{{ 'spaces.schema.propDetail.default' | transloco }}</label>
                        <input type="text" [(ngModel)]="p.s.default" placeholder="—" (ngModelChange)="changed.emit()" />
                      </div>
                      <!-- Only what the API accepts for this type — see merge-fns.ts.
                           NO BACKTICKS in this template, comments included: one ends the string, and the
                           error points at @Component rather than at the line that caused it. -->
                      <div class="field" style="margin:0;">
                        <label>{{ 'spaces.schema.propDetail.mergeFn' | transloco }}</label>
                        <select [(ngModel)]="p.s.mergeFn" (ngModelChange)="changed.emit()"
                                [disabled]="!mergeFnsFor(p.s.type).length">
                          <option [ngValue]="undefined">—</option>
                          @for (fn of mergeFnsFor(p.s.type); track fn) { <option [value]="fn">{{ fn }}</option> }
                        </select>
                      </div>
                      @if (p.s.type === 'string' || p.s.type === undefined) {
                        <div class="field" style="margin:0;">
                          <label>{{ 'spaces.schema.propDetail.pattern' | transloco }} <span style="font-size:10px;font-weight:400;color:var(--text-muted);">{{ 'spaces.schema.propDetail.patternHint' | transloco }}</span></label>
                          <input type="text" [(ngModel)]="p.s.pattern" placeholder="^[A-Z].*" (ngModelChange)="changed.emit()" />
                        </div>
                      }
                      @if (p.s.type === 'number' || p.s.type === undefined) {
                        <div class="field" style="margin:0;">
                          <label>{{ 'spaces.schema.propDetail.min' | transloco }}</label>
                          <input type="number" [(ngModel)]="p.s.minimum" placeholder="—" (ngModelChange)="changed.emit()" />
                        </div>
                        <div class="field" style="margin:0;">
                          <label>{{ 'spaces.schema.propDetail.max' | transloco }}</label>
                          <input type="number" [(ngModel)]="p.s.maximum" placeholder="—" (ngModelChange)="changed.emit()" />
                        </div>
                      }
                    </div>
                    @if (p.s.type !== 'boolean') {
                      <div class="pdet-full">
                        <div class="field" style="margin:0;">
                          <label>{{ 'spaces.schema.propDetail.enumValues' | transloco }} <span style="font-size:11px;font-weight:normal;color:var(--text-muted);">{{ 'spaces.schema.propDetail.enumHint' | transloco }}</span></label>
                          <div class="chip-wrap">
                            @for (ev of (p.s.enum ?? []); track ev) {
                              <span class="chip">{{ ev }}<button type="button" class="chip-rm" (click)="removeEnumVal(p, ev)"><ph-icon name="x" [size]="12"/></button></span>
                            }
                            <input type="text" class="chip-field" [(ngModel)]="p._enumInput"
                              [placeholder]="'spaces.schema.propDetail.enumPlaceholder' | transloco"
                              (keydown)="onEnumKey($event, p)" />
                          </div>
                        </div>
                      </div>
                    }
                  </div>
                </td>
              </tr>
            }
          }
        </tbody>
      </table>
    } @else {
      <p style="font-size:12px;color:var(--text-muted);margin:4px 0 8px;">{{ 'spaces.schema.noProps' | transloco }}</p>
    }
    <div class="add-prop-row">
      <input type="text" [(ngModel)]="newPropInput"
        [placeholder]="'spaces.schema.newPropNamePlaceholder' | transloco"
        style="flex:1;max-width:220px;"
        (keydown.enter)="addRow(); $event.preventDefault()" />
      <button class="btn btn-secondary btn-sm" type="button"
        (click)="addRow()" [disabled]="!newPropInput.trim()">{{ 'spaces.schema.addPropertyButton' | transloco }}</button>
    </div>
  `,
})
export class PropSchemaTableComponent {
  @Input() rows: PropSchemaRow[] = [];
  @Output() changed = new EventEmitter<void>();

  expandedKey = signal<string | null>(null);
  newPropInput = '';

  toggleExpand(key: string): void {
    this.expandedKey.set(this.expandedKey() === key ? null : key);
  }

  addRow(): void {
    const key = this.newPropInput.trim();
    if (!key || this.rows.some(r => r.key === key)) { this.newPropInput = ''; return; }
    this.rows.push({ key, s: {}, _enumInput: '' });
    this.newPropInput = '';
    this.expandedKey.set(key);
    this.changed.emit();
  }

  removeRow(key: string): void {
    const idx = this.rows.findIndex(r => r.key === key);
    if (idx !== -1) this.rows.splice(idx, 1);
    if (this.expandedKey() === key) this.expandedKey.set(null);
    this.changed.emit();
  }

  /** The API's own rule about which merge functions a type may hold. */
  mergeFnsFor = mergeFnsFor;

  /**
   * Changing the type clears a merge function the new type cannot hold.
   *
   * The two hand-written lists this replaced covered `boolean` and `number` and left `string` and `date`
   * alone — but the server accepts NO merge function on either, so switching `number` to `date` kept `min`
   * and the save was refused.
   */
  onTypeChange(p: PropSchemaRow): void {
    p.s.mergeFn = mergeFnAfterTypeChange(p.s.type, p.s.mergeFn);
    this.changed.emit();
  }

  onEnumKey(e: KeyboardEvent, p: PropSchemaRow): void {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); this.addEnumVal(p); }
  }

  addEnumVal(p: PropSchemaRow): void {
    const val = (p._enumInput ?? '').trim();
    if (!val) return;
    const curr = p.s.enum ?? [];
    if (!curr.some(v => String(v) === val)) p.s = { ...p.s, enum: [...curr, val] };
    p._enumInput = '';
    this.changed.emit();
  }

  removeEnumVal(p: PropSchemaRow, val: string | number | boolean): void {
    p.s = { ...p.s, enum: (p.s.enum ?? []).filter(v => v !== val) };
    this.changed.emit();
  }
}
