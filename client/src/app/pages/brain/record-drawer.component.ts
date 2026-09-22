import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslocoPipe } from '@jsverse/transloco';
import { ModalDirective } from '../../shared/modal.directive';
import { TagInputComponent } from '../../shared/tag-input.component';
import { PropertiesEditorComponent } from '../../shared/properties-editor.component';
import { EntityRefFieldComponent } from './entity-ref-field.component';
import { FactRefFieldComponent } from './fact-ref-field.component';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { BrainStore } from './brain-store.service';
import { EntityRefPicker } from './entity-ref-picker.service';
import { RecordDrawerState } from './record-drawer-state.service';
import { BRAIN_CHIP_STYLES, BRAIN_DRAWER_STYLES } from './brain-form.styles';

/**
 * The record detail drawer — edits one memory/entity/edge/chrono record, opened from every record tab.
 *
 * Extracted from BrainComponent (A17.9b-5). OnPush from birth: it renders `RecordDrawerState`'s plain
 * edit models via ngModel, which show only because `open()` writes the `drawerRecord` SIGNAL in the
 * same turn (marking this view dirty). That coupling is load-bearing and pinned by the spec.
 *
 * All three collaborators are provided by the parent shell (`RecordDrawerState`, `BrainStore`,
 * `EntityRefPicker`), so this component just injects and renders them.
 */
@Component({
  selector: 'app-record-drawer',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, TranslocoPipe, TagInputComponent, PropertiesEditorComponent, EntityRefFieldComponent, FactRefFieldComponent, PhIconComponent, ModalDirective],
  styles: [BRAIN_CHIP_STYLES, BRAIN_DRAWER_STYLES],
  template: `
      @if (state.drawerRecord(); as dr) {
        <div class="drawer-overlay">
          <div class="drawer" [appModal]="'brain.drawer.recordDetailsAriaLabel' | transloco" (dismiss)="state.close()" (click)="$event.stopPropagation()">
            <div class="drawer-header">
              <div style="flex:1; min-width:0;">
                @if (dr.kind === 'fact') { <span class="badge badge-blue" style="margin-bottom:6px; display:inline-block;">{{ 'brain.drawer.badge.fact' | transloco }}</span> }
                @if (dr.kind === 'entity') { <span class="badge badge-purple" style="margin-bottom:6px; display:inline-block;">{{ 'brain.drawer.badge.entity' | transloco }}</span> }
                @if (dr.kind === 'edge') { <span class="badge badge-blue" style="margin-bottom:6px; display:inline-block;">{{ 'brain.drawer.badge.edge' | transloco }}</span> }
                @if (dr.kind === 'chrono') { <span class="badge" style="margin-bottom:6px; display:inline-block;">{{ 'brain.drawer.badge.chrono' | transloco }}</span> }
                <div class="drawer-title">
                  @if (dr.kind === 'fact') { {{ state.drawerEditMemory.fact.length > 80 ? (state.drawerEditMemory.fact | slice:0:80) + '\u2026' : state.drawerEditMemory.fact }} }
                  @if (dr.kind === 'entity') { {{ state.drawerEditEntity.name || dr.record.name }} }
                  @if (dr.kind === 'edge') { {{ (dr.record.fromName || dr.record.from) + ' \u2192 ' + (dr.record.toName || dr.record.to) }} }
                  @if (dr.kind === 'chrono') { {{ state.drawerEditChrono.title || dr.record.title }} }
                </div>
              </div>
              <div style="display:flex; gap:8px; flex-shrink:0; align-items:flex-start; padding-top:2px;">
                <button class="btn btn-sm btn-primary" [disabled]="state.drawerSaving()" (click)="state.save()">
                  @if (state.drawerSaving()) { <span class="spinner" style="width:11px;height:11px;border-width:2px;"></span> } {{ 'common.save' | transloco }}
                </button>
                <button class="icon-btn" [attr.title]="'common.close' | transloco" [attr.aria-label]="'brain.drawer.closeDetailsAriaLabel' | transloco" (click)="state.close()"><ph-icon name="x" [size]="16"/></button>
              </div>
            </div>
            @if (state.drawerError()) {
              <div class="alert alert-error" style="margin-bottom:16px; font-size:13px;">{{ state.drawerError() }}</div>
            }

            <form>
              <!-- ── MEMORY ── -->
              @if (dr.kind === 'fact') {
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.form.fact' | transloco }} <span style="color:var(--error)">*</span></div>
                  <textarea [(ngModel)]="state.drawerEditMemory.fact" name="drwMemFact" rows="4"></textarea>
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.form.description' | transloco }}</div>
                  <textarea [(ngModel)]="state.drawerEditMemory.description" name="drwMemDesc" rows="3" style="resize:vertical;"></textarea>
                </div>
                <div class="drawer-field">
                  <!-- Matches the create form exactly, and for the same reason: since P-24 a space declaring
                       typeSchemas.fact restricts memory types, so free text there would submit a value the
                       server refuses. A space declaring none is unrestricted and keeps the free-text input.
                       The two controls must agree — one door offering a type the other cannot write is the
                       shape this whole item was about. -->
                  <div class="drawer-label">{{ 'common.form.type' | transloco }}</div>
                  @if (store.memoryTypesAreRestricted()) {
                    <select [(ngModel)]="state.drawerEditMemory.type" name="drwMemType">
                      <option value=""></option>
                      @for (t of store.memoryAllowedTypes(); track t) { <option [value]="t">{{ t }}</option> }
                    </select>
                  } @else {
                    <input type="text" [(ngModel)]="state.drawerEditMemory.type" name="drwMemType" list="drwMemTypeOptions" />
                    <datalist id="drwMemTypeOptions">
                      @for (t of store.memoryTypeOptions(); track t) { <option [value]="t"></option> }
                    </datalist>
                  }
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.form.tags' | transloco }}</div>
                  <app-tag-input [(value)]="state.drawerEditMemory.tags" [suggestions]="store.memoryTagSuggestions()" inputName="drwMemTags" />
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.linkEntities' | transloco }}</div>
                  <app-entity-ref-field [target]="state.drawerEditMemory" [spaceId]="state.spaceId()" />
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.form.properties' | transloco }}</div>
                  <app-properties-editor [schema]="store.memorySchema()" [required]="store.requiredProps(store.memorySchema())" [(value)]="state.drawerEditMemory.properties" />
                </div>
                <hr class="drawer-hr">
                <div class="drawer-field">
                  <div class="drawer-label">_id</div>
                  <div class="drawer-readonly-value" style="font-family:var(--font-mono,monospace); font-size:11px;">{{ dr.record._id }}</div>
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.seq' | transloco }}</div>
                  <div class="drawer-readonly-value">{{ dr.record.seq }}</div>
                </div>
                @if (dr.record.author) {
                  <div class="drawer-field">
                    <div class="drawer-label">{{ 'common.authorInstanceId' | transloco }}</div>
                    <div class="drawer-readonly-value">{{ dr.record.author.instanceId }}</div>
                  </div>
                }
                <div class="drawer-field" style="margin-bottom:0;">
                  <div class="drawer-label">{{ 'common.createdAt' | transloco }}</div>
                  <div class="drawer-readonly-value">{{ dr.record.createdAt | date:'yyyy-MM-dd HH:mm:ss' }}</div>
                </div>
              }

              <!-- ── ENTITY ── -->
              @if (dr.kind === 'entity') {
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'brain.entities.table.name' | transloco }} <span style="color:var(--error)">*</span></div>
                  <input type="text" [(ngModel)]="state.drawerEditEntity.name" name="drwEntName" />
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.form.type' | transloco }} @if (store.entityTypeNames().length) { <span style="color:var(--error)">*</span> }</div>
                  @if (store.entityTypeNames().length) {
                    <select [(ngModel)]="state.drawerEditEntity.type" name="drwEntType" (ngModelChange)="state.onEntityTypeChange($event)">
                      @for (t of store.entityTypeNames(); track t) {
                        <option [value]="t">{{ t }}</option>
                      }
                    </select>
                  } @else {
                    <input type="text" [(ngModel)]="state.drawerEditEntity.type" name="drwEntType" />
                  }
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.form.description' | transloco }}</div>
                  <textarea [(ngModel)]="state.drawerEditEntity.description" name="drwEntDesc" rows="3" style="resize:vertical;"></textarea>
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.form.tags' | transloco }}</div>
                  <app-tag-input [(value)]="state.drawerEditEntity.tags" [suggestions]="store.entityTagSuggestions()" inputName="drwEntTags" />
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.form.properties' | transloco }}</div>
                  <app-properties-editor [schema]="store.entitySchema(state.drawerEditEntity.type)" [required]="store.requiredProps(store.entitySchema(state.drawerEditEntity.type))" [(value)]="state.drawerEditEntity.properties" />
                </div>
                <hr class="drawer-hr">
                <div class="drawer-field">
                  <div class="drawer-label">_id</div>
                  <div class="drawer-readonly-value" style="font-family:var(--font-mono,monospace); font-size:11px;">{{ dr.record._id }}</div>
                </div>
                <div class="drawer-field" style="margin-bottom:0;">
                  <div class="drawer-label">{{ 'common.createdAt' | transloco }}</div>
                  <div class="drawer-readonly-value">{{ dr.record.createdAt | date:'yyyy-MM-dd HH:mm:ss' }}</div>
                </div>
              }

              <!-- ── EDGE ── -->
              @if (dr.kind === 'edge') {
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.form.from' | transloco }} <span class="drawer-muted">{{ 'common.readOnly' | transloco }}</span></div>
                  <div class="drawer-readonly-value">{{ dr.record.fromName || dr.record.from }}<span style="font-size:11px;"> ({{ dr.record.from }})</span></div>
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'brain.edges.table.relation' | transloco }} <span style="color:var(--error)">*</span></div>
                  @if (store.edgeLabelNames().length) {
                    <select [(ngModel)]="state.drawerEditEdge.label" name="drwEdgeLabel">
                      @for (l of store.edgeLabelNames(); track l) {
                        <option [value]="l">{{ l }}</option>
                      }
                    </select>
                  } @else {
                    <input type="text" [(ngModel)]="state.drawerEditEdge.label" name="drwEdgeLabel" />
                  }
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.form.to' | transloco }} <span class="drawer-muted">{{ 'common.readOnly' | transloco }}</span></div>
                  <div class="drawer-readonly-value">{{ dr.record.toName || dr.record.to }}<span style="font-size:11px;"> ({{ dr.record.to }})</span></div>
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.form.type' | transloco }}</div>
                  <input type="text" [(ngModel)]="state.drawerEditEdge.type" name="drwEdgeType" />
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.form.weight' | transloco }}</div>
                  <input type="number" [(ngModel)]="state.drawerEditEdge.weight" name="drwEdgeWeight" step="0.1" />
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.form.description' | transloco }}</div>
                  <textarea [(ngModel)]="state.drawerEditEdge.description" name="drwEdgeDesc" rows="3" style="resize:vertical;"></textarea>
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.form.tags' | transloco }}</div>
                  <app-tag-input [(value)]="state.drawerEditEdge.tags" [suggestions]="store.edgeTagSuggestions()" inputName="drwEdgeTags" />
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.form.properties' | transloco }}</div>
                  <app-properties-editor [schema]="store.edgeSchema(state.drawerEditEdge.label)" [required]="store.requiredProps(store.edgeSchema(state.drawerEditEdge.label))" [(value)]="state.drawerEditEdge.properties" />
                </div>
                <hr class="drawer-hr">
                <div class="drawer-field">
                  <div class="drawer-label">_id</div>
                  <div class="drawer-readonly-value" style="font-family:var(--font-mono,monospace); font-size:11px;">{{ dr.record._id }}</div>
                </div>
                <div class="drawer-field" style="margin-bottom:0;">
                  <div class="drawer-label">{{ 'common.createdAt' | transloco }}</div>
                  <div class="drawer-readonly-value">{{ dr.record.createdAt | date:'yyyy-MM-dd HH:mm:ss' }}</div>
                </div>
              }

              <!-- ── CHRONO ── -->
              @if (dr.kind === 'chrono') {
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.form.title' | transloco }} <span style="color:var(--error)">*</span></div>
                  <input type="text" [(ngModel)]="state.drawerEditChrono.title" name="drwChronoTitle" />
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.form.type' | transloco }} <span style="color:var(--error)">*</span></div>
                  <select [(ngModel)]="state.drawerEditChrono.kind" name="drwChronoKind" (ngModelChange)="state.onDrawerChronoKindChange()">
                    @for (k of store.chronoTypeOptions(); track k) { <option [value]="k">{{ k }}</option> }
                  </select>
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'brain.chrono.table.status' | transloco }}</div>
                  <select [(ngModel)]="state.drawerEditChrono.status" name="drwChronoStatus">
                    @for (s of store.chronoStatusOptions; track s) { <option [value]="s">{{ s }}</option> }
                  </select>
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.form.startsAt' | transloco }} <span style="color:var(--error)">*</span></div>
                  <input type="datetime-local" [(ngModel)]="state.drawerEditChrono.startsAt" name="drwChronoStarts" />
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.form.endsAt' | transloco }}</div>
                  <input type="datetime-local" [(ngModel)]="state.drawerEditChrono.endsAt" name="drwChronoEnds" />
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.confidence' | transloco }} <span class="drawer-muted">(0-1)</span></div>
                  <input type="number" [(ngModel)]="state.drawerEditChrono.confidence" name="drwChronoConf" min="0" max="1" step="0.01" />
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.form.description' | transloco }}</div>
                  <textarea [(ngModel)]="state.drawerEditChrono.description" name="drwChronoDesc" rows="3"></textarea>
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.form.tags' | transloco }}</div>
                  <app-tag-input [(value)]="state.drawerEditChrono.tags" [suggestions]="store.chronoTagSuggestions()" inputName="drwChronoTags" />
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.linkEntities' | transloco }}</div>
                  <app-entity-ref-field [target]="state.drawerEditChrono" [spaceId]="state.spaceId()" />
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.linkFacts' | transloco }}</div>
                  <app-fact-ref-field [target]="state.drawerEditChrono" />
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'brain.chrono.table.properties' | transloco }}</div>
                  <app-properties-editor [schema]="store.chronoSchema(state.drawerChronoKind())" [required]="store.requiredProps(store.chronoSchema(state.drawerChronoKind()))" [(value)]="state.drawerEditChrono.properties" />
                </div>
                <hr class="drawer-hr">
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.spaceId' | transloco }}</div>
                  <div class="drawer-readonly-value">{{ dr.record.spaceId }}</div>
                </div>
                @if (dr.record.recurrence) {
                  <div class="drawer-field">
                    <div class="drawer-label">{{ 'common.recurrence' | transloco }}</div>
                    <div class="drawer-readonly-value" style="font-family:var(--font-mono,monospace); font-size:11px;">{{ dr.record.recurrence | json }}</div>
                  </div>
                }
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.author' | transloco }}</div>
                  <div class="drawer-readonly-value">{{ dr.record.author.instanceLabel }} ({{ dr.record.author.instanceId }})</div>
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.seq' | transloco }}</div>
                  <div class="drawer-readonly-value">{{ dr.record.seq }}</div>
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">_id</div>
                  <div class="drawer-readonly-value" style="font-family:var(--font-mono,monospace); font-size:11px;">{{ dr.record._id }}</div>
                </div>
                <div class="drawer-field">
                  <div class="drawer-label">{{ 'common.createdAt' | transloco }}</div>
                  <div class="drawer-readonly-value">{{ dr.record.createdAt | date:'yyyy-MM-dd HH:mm:ss' }}</div>
                </div>
                <div class="drawer-field" style="margin-bottom:0;">
                  <div class="drawer-label">{{ 'common.updatedAt' | transloco }}</div>
                  <div class="drawer-readonly-value">{{ dr.record.updatedAt | date:'yyyy-MM-dd HH:mm:ss' }}</div>
                </div>
              }
            </form>

          </div>
        </div>
      }
  `,
})
export class RecordDrawerComponent {
  readonly state = inject(RecordDrawerState);
  readonly store = inject(BrainStore);
  readonly picker = inject(EntityRefPicker);
}
