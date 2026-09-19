import { ChangeDetectionStrategy, Component, inject, output, signal } from '@angular/core';
import { SupersededBadgeComponent } from '../../shared/superseded-badge.component';
import { CommonModule } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { TranslocoPipe } from '@jsverse/transloco';
import { Entity } from '../../core/api.types';
import { BrainApi } from '../../core/brain-api.service';
import { httpErrorReason } from '../../core/http-error';
import { TagInputComponent } from '../../shared/tag-input.component';
import { PropertiesViewComponent } from '../../shared/properties-view.component';
import { PropertiesEditorComponent } from '../../shared/properties-editor.component';
import { EntitySearchComponent } from '../../shared/entity-search.component';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { ErrorStateComponent } from '../../shared/error-state.component';
import { SortableHeaderComponent } from './sortable-header.component';
import { RecordDrawerState } from './record-drawer-state.service';
import { RecordTabBase } from './record-tab-base';
import { fmtApiError } from './brain-format';
import { BRAIN_CHIP_STYLES } from './brain-form.styles';
import { BRAIN_RECORD_TABLE_STYLES } from './brain-table.styles';
import { HscrollTopDirective } from '../../shared/hscroll-top.directive';
import { TimestampComponent } from '../../shared/timestamp.component';

/**
 * The Entities record tab, extracted from BrainComponent (A17.9b-6e) following the facts pattern.
 * Owns the entity create form, the (drawer-superseded) inline edit, delete, and the tab's own
 * entity-search / type-tag filter / pagination + loader. Self-loads via an effect on the `spaceId`
 * input; create/delete emit `mutated` so the shell refreshes tab-count stats.
 *
 * Entity delta from facts: both create AND inline-edit strip empty optional properties via the
 * entity schema. Search: the top bar is the semantic-only `<app-entity-search>` finder
 * (`[showModeToggle]="false"`, 2b-iii-d) — typing drives its own dropdown; picking a result feeds the
 * name into the docked Name column freetext filter (the list's plain-text `?search=` path), so there
 * is no separate exact-`?name=` list filter. Plain substring list filtering is the column header.
 */
@Component({
  selector: 'app-entities-tab',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, TranslocoPipe, TagInputComponent, PropertiesViewComponent, PropertiesEditorComponent, EntitySearchComponent, PhIconComponent, ErrorStateComponent, SortableHeaderComponent, HscrollTopDirective, TimestampComponent, SupersededBadgeComponent],
  styles: [BRAIN_CHIP_STYLES, BRAIN_RECORD_TABLE_STYLES],
  template: `

          <div class="content-header">
            <app-entity-search
              mode="bar"
              [spaceId]="spaceId()"
              placeholder="common.searchEntitiesPlaceholder"
              defaultMode="semantic"
              [showModeToggle]="false"
              (cleared)="onEntitySearchClear()"
              (selected)="onEntitySearchPick($event)"
            />
            <button class="btn-primary btn btn-sm" (click)="openEntityForm()" [disabled]="showEntityForm()">{{ 'brain.entities.addButton' | transloco }}</button>
          </div>

          @if (showEntityForm()) {
            <form class="create-form" (ngSubmit)="createEntity()">
              <!-- Row 1: single-line fields, one uniform height (name, type, tags). -->
              <div class="form-row">
                <div class="field" style="flex:2; min-width:140px;">
                  <label>{{ 'brain.entities.table.name' | transloco }}</label>
                  <input type="text" [(ngModel)]="entityForm.name" name="name" required />
                </div>
                <div class="field" style="width:150px;">
                  <label>{{ 'brain.entities.table.type' | transloco }} <span style="color:var(--error)">*</span></label>
                  @if (store.entityTypeNames().length) {
                    <select [(ngModel)]="entityForm.type" name="type" required (ngModelChange)="onEntityTypeChange($event, 'create')">
                      @for (t of store.entityTypeNames(); track t) {
                        <option [value]="t">{{ t }}</option>
                      }
                    </select>
                  } @else {
                    <!--
                      REQUIRED even with no declared types — owner's ruling P-31, option A. The server
                      refuses a typeless entity on every door now, and the type is what selects the property
                      schema. Free
                      TEXT rather than a picker here because a space that declares nothing has no vocabulary
                      to offer — the operator names the kind of thing this is.
                    -->
                    <input type="text" [(ngModel)]="entityForm.type" name="type" required [placeholder]="'brain.entities.form.typePlaceholder' | transloco" />
                  }
                </div>
                <div class="field" style="flex:2; min-width:180px;">
                  <label>{{ 'brain.entities.table.tags' | transloco }}</label>
                  <app-tag-input [(value)]="entityForm.tags" [suggestions]="store.entityTagSuggestions()" inputName="entFormTags" />
                </div>
              </div>
              <!-- Row 2: the tall fields, tops aligned, each grows (description | properties). -->
              <div class="form-row rich">
                <div class="field">
                  <label>{{ 'brain.entities.table.description' | transloco }}</label>
                  <textarea [(ngModel)]="entityForm.description" name="description" rows="3"></textarea>
                </div>
                <div class="field">
                  <label>{{ 'brain.entities.table.properties' | transloco }}</label>
                  <app-properties-editor
                    [schema]="store.entitySchema(entityForm.type)"
                    [required]="store.requiredProps(store.entitySchema(entityForm.type))"
                    [(value)]="entityForm.properties"
                  />
                </div>
              </div>
              <div style="display:flex; gap:8px;">
                <button class="btn-primary btn btn-sm" type="submit" [disabled]="creatingEntity() || !entityForm.name.trim() || !entityForm.type.trim()">
                  @if (creatingEntity()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }
                  {{ 'common.save' | transloco }}
                </button>
                <button class="btn-secondary btn btn-sm" type="button" (click)="showEntityForm.set(false)">{{ 'common.cancel' | transloco }}</button>
              </div>
            </form>
          }

          @if (createEntityError()) {
            <div class="alert alert-error" style="margin-bottom:12px;">{{ createEntityError() }}</div>
          }

          <div class="table-wrapper" hscrollTop>
            <table>
              <thead>
                <tr>
                  <th app-sort-th field="name" label="brain.entities.table.name" [activeField]="sortField()" [dir]="sortDir()" (sort)="setSort($event)">
                    <input class="col-filter-input" type="text" [ngModel]="search()" (ngModelChange)="setSearchFilter($event)"
                      [placeholder]="'brain.filter.searchPlaceholder' | transloco" [attr.aria-label]="'brain.filter.searchPlaceholder' | transloco" />
                  </th>
                  <th app-sort-th field="type" label="brain.entities.table.type" [activeField]="sortField()" [dir]="sortDir()" (sort)="setSort($event)">
                    <select class="col-filter-select" [ngModel]="recordFilter().type" (ngModelChange)="setTypeFilter($event)" [attr.aria-label]="'brain.filter.label' | transloco">
                      <option value="">{{ 'brain.filter.allTypes' | transloco }}</option>
                      @for (t of store.entityTypeOptions(); track t) { <option [value]="t">{{ t }}</option> }
                    </select>
                  </th>
                  <th app-sort-th label="brain.entities.table.description">
                    <input class="col-filter-input" type="text" [ngModel]="recordFilter().description" (ngModelChange)="setDescriptionFilter($event)"
                      [placeholder]="'brain.filter.descriptionPlaceholder' | transloco" [attr.aria-label]="'brain.filter.descriptionPlaceholder' | transloco" />
                  </th>
                  <th app-sort-th label="brain.entities.table.tags">
                    <input class="col-filter-input" type="text" [ngModel]="recordFilter().tag" (ngModelChange)="setTagFilter($event)"
                      [attr.list]="tagListId" [placeholder]="'brain.filter.tagPlaceholder' | transloco" [attr.aria-label]="'brain.filter.tagPlaceholder' | transloco" />
                    <datalist [id]="tagListId">@for (s of store.entityTagSuggestions(); track s) { <option [value]="s"></option> }</datalist>
                  </th>
                  <th app-sort-th label="brain.entities.table.properties">
                    <input class="col-filter-input" type="text" [ngModel]="recordFilter().properties" (ngModelChange)="setPropertiesFilter($event)"
                      [placeholder]="'brain.filter.propertiesPlaceholder' | transloco" [attr.aria-label]="'brain.filter.propertiesPlaceholder' | transloco" />
                  </th>
                  <th app-sort-th field="createdAt" label="brain.entities.table.created" [activeField]="sortField()" [dir]="sortDir()" (sort)="setSort($event)"></th><th></th>
                </tr>
              </thead>
              <tbody>
                @for (ent of store.entities(); track ent._id) {
                  @if (recordList.editingId() === ent._id) {
                    <tr>
                      <td colspan="7">
                        <div class="create-form" style="border:none; padding:8px 0;">
                          <div class="field" style="flex:1; min-width:120px; margin-bottom:0;">
                            <label>{{ 'brain.entities.table.name' | transloco }}</label>
                            <input type="text" [(ngModel)]="editEntity.name" name="editEntName" />
                          </div>
                          <div class="field" style="width:120px; margin-bottom:0;">
                            <label>Type @if (store.entityTypeNames().length) { <span style="color:var(--error)">*</span> }</label>
                            @if (store.entityTypeNames().length) {
                              <select [(ngModel)]="editEntity.type" name="editEntType" (ngModelChange)="onEntityTypeChange($event, 'inline')">
                                @for (t of store.entityTypeNames(); track t) {
                                  <option [value]="t">{{ t }}</option>
                                }
                              </select>
                            } @else {
                              <input type="text" [(ngModel)]="editEntity.type" name="editEntType" />
                            }
                          </div>
                          <div class="field" style="flex:1; min-width:160px; margin-bottom:0;">
                            <label>{{ 'brain.entities.table.description' | transloco }}</label>
                            <textarea [(ngModel)]="editEntity.description" name="editEntDesc" rows="2" style="resize:vertical;"></textarea>
                          </div>
                          <div class="field" style="flex:1; min-width:180px; margin-bottom:0;">
                            <label>{{ 'brain.entities.table.tags' | transloco }}</label>
                            <app-tag-input [(value)]="editEntity.tags" [suggestions]="store.entityTagSuggestions()" inputName="entEditTags" />
                          </div>
                          <div class="field" style="flex:1; min-width:220px; margin-bottom:0;">
                            <label>{{ 'brain.entities.table.properties' | transloco }}</label>
                            <app-properties-editor
                              [schema]="store.entitySchema(editEntity.type)"
                              [required]="store.requiredProps(store.entitySchema(editEntity.type))"
                              [(value)]="editEntity.properties"
                            />
                          </div>
                          <div style="display:flex; gap:6px; align-items:flex-end;">
                            <button class="btn btn-sm btn-primary" [disabled]="recordList.editSaving()" (click)="saveEditEntity(ent._id)">
                              @if (recordList.editSaving()) { <span class="spinner" style="width:11px;height:11px;border-width:2px;"></span> } Save
                            </button>
                            <button class="btn btn-sm btn-secondary" (click)="recordList.cancelEdit()">{{ 'common.cancel' | transloco }}</button>
                          </div>
                          @if (recordList.editError()) { <div style="font-size:12px; color:var(--error);">{{ recordList.editError() }}</div> }
                        </div>
                      </td>
                    </tr>
                  } @else {
                    <tr>
                      <td>{{ ent.name }} <app-superseded-badge [superseded]="ent.superseded" /></td>
                      <td>
                        @if (ent.type) { <span class="badge badge-purple">{{ ent.type }}</span> }
                      </td>
                      <td class="desc-cell" style="max-width:200px;" [title]="ent.description ?? ''">
                        <div class="desc-clamp">{{ ent.description || '—' }}</div>
                      </td>
                      <td style="font-size:11px;">
                        @for (tag of (ent.tags ?? []); track tag) { <span class="tag">{{ tag }}</span> }
                        @if (!(ent.tags?.length)) { <span style="color:var(--text-muted)">—</span> }
                      </td>
                      <td><app-properties-view [properties]="ent.properties" [schema]="store.entitySchema(ent.type)" /></td>
                      <td><app-timestamp [value]="ent.createdAt"/></td>
                      <td style="white-space:nowrap;">
                        <button class="icon-btn" [attr.title]="'common.viewDetails' | transloco" [attr.aria-label]="'common.viewDetails' | transloco" (click)="drawerState.open('entity', ent)"><ph-icon name="eye" [size]="16"/></button>
                        <button class="icon-btn" [attr.title]="'common.viewInGraph' | transloco" [attr.aria-label]="'common.viewInGraph' | transloco" (click)="viewInGraph.emit(ent._id)"><ph-icon name="graph" [size]="16"/></button>
                        @if (recordList.confirmDeleteId() === ent._id) {
                          <span class="inline-confirm">
                            Delete?
                            <button class="btn btn-sm btn-danger" (click)="deleteEntity(ent._id)">{{ 'common.yes' | transloco }}</button>
                            <button class="btn btn-sm btn-secondary" (click)="cancelDelete()">{{ 'common.no' | transloco }}</button>
                          </span>
                        } @else {
                          <button class="icon-btn danger" [attr.aria-label]="'brain.entities.deleteAriaLabel' | transloco" (click)="requestDelete(ent._id)"><ph-icon name="x" [size]="16"/></button>
                        }
                      </td>
                    </tr>
                  }
                } @empty {
                  <tr><td colspan="7">
                    @if (recordList.loadError() !== null) {
                      <app-error-state [message]="'brain.error.loadEntities' | transloco" [reason]="recordList.loadError() ?? ''" (retry)="retryCurrentTab()" />
                    } @else {
                    <div class="empty-state" style="padding:32px">
                      <div class="empty-state-icon"><ph-icon name="tag" [size]="48"/></div>
                      <h3>{{ 'brain.entities.empty.title' | transloco }}</h3>
                    </div>
                    }
                  </td></tr>
                }
              </tbody>
            </table>
          </div>
          <div class="pagination">
            <button class="btn btn-sm btn-secondary" [disabled]="skip() === 0" (click)="prevPage()"><ph-icon name="arrow-left" [size]="14" style="display:inline-flex;vertical-align:middle;"/> {{ 'common.prev' | transloco }}</button>
            <span class="pager-info">{{ store.entities().length ? (skip() + 1) + '–' + (skip() + store.entities().length) : '–' }}</span>
            <button class="btn btn-sm btn-secondary" [disabled]="store.entities().length < pageSize" (click)="nextPage()">{{ 'common.next' | transloco }} <ph-icon name="arrow-right" [size]="14" style="display:inline-flex;vertical-align:middle;"/></button>
          </div>
  `,
})
export class EntitiesTabComponent extends RecordTabBase {
  readonly drawerState = inject(RecordDrawerState);
  private brainApi = inject(BrainApi);
  private route = inject(ActivatedRoute);

  /**
   * `?type=` seeds the type filter, so the Overview's data-model panel can link straight to "the entities
   * of this type" as a real URL.
   *
   * Read from the snapshot ONCE, not subscribed. A later navigation carrying a different `?type=` is not a
   * case worth serving: this tab unmounts when the user leaves it, so arriving here is always a fresh read.
   * Subscribing would additionally fight `resetOnSpaceChange`, which clears the filter deliberately — a
   * type filter must not survive a space change, because the same name can mean different things in two
   * spaces.
   */
  private deepLinkedType = this.route.snapshot.queryParamMap.get('type') ?? undefined;

  /** Emitted after a create/delete so the shell can refresh the space's tab-count stats. */
  readonly mutated = output<void>();

  /**
   * "View in graph" — emits the entity id for the shell to open on the Graph tab.
   *
   * An output rather than a direct tab switch because this component does not own the tab strip, and
   * an event is what the Overview tiles and the Review tab already use to move the shell.
   */
  readonly viewInGraph = output<string>();

  showEntityForm = signal(false);
  creatingEntity = signal(false);
  createEntityError = signal('');
  entityForm = { name: '', type: '', tags: [] as string[], description: '', properties: {} as Record<string, string | number | boolean> };
  editEntity = { name: '', type: '', tags: [] as string[], description: '', properties: {} as Record<string, string | number | boolean> };

  protected override resetOnSpaceChange(): void {
    // The deep-linked type is applied HERE rather than in the constructor, because this is where the
    // filter's shape is defined — setting it earlier reads a signal the base class has not populated yet.
    //
    // Consumed once. It must not survive a space change: the same type name can mean different things in
    // two spaces, so carrying the filter across would silently show a filtered-empty list and look like the
    // space is empty. The tab unmounts when the user leaves it, so arriving here is always a fresh read of
    // the URL anyway.
    const type = this.deepLinkedType ?? '';
    this.deepLinkedType = undefined;
    this.recordFilter.set({ type, tag: '', description: '', properties: '', fromName: '', toName: '', entityName: '' });
  }

  protected override load(): void {
    const spaceId = this.spaceId();
    if (!spaceId) return;
    this.recordList.loading.set(true);
    this.recordList.loadError.set(null);
    const ef: { type?: string; tag?: string; description?: string; properties?: string } = {};
    if (this.recordFilter().type) ef.type = this.recordFilter().type;
    if (this.recordFilter().tag) ef.tag = this.recordFilter().tag;
    if (this.recordFilter().description) ef.description = this.recordFilter().description;
    if (this.recordFilter().properties) ef.properties = this.recordFilter().properties;
    this.brainApi.listEntities(spaceId, this.pageSize, this.skip(), ef, this.sortParam(), this.searchParam()).subscribe({
      next: ({ entities }) => { this.store.entities.set(entities); this.recordList.loading.set(false); },
      error: (e) => { this.recordList.loadError.set(httpErrorReason(e)); this.recordList.loading.set(false); },
    });
  }

  // The top bar is a SEMANTIC finder now (2b-iii-d): its A–Z half was removed since the docked Name
  // column freetext filter already does plain-text (substring `?search=`). Typing drives the bar's own
  // semantic dropdown; PICKING an entity feeds that name into the Name column filter so the list
  // narrows via the same server `?search=` as typing in the column would — no separate exact-`?name=`
  // list path (that was a redundant second name filter). Clearing the bar clears the column filter.
  onEntitySearchClear(): void {
    this.setSearchFilter('');
  }
  onEntitySearchPick(ent: Entity): void {
    this.setSearchFilter(ent.name);
  }

  openEntityForm(): void {
    const firstType = Object.keys(this.store.spaceMeta()?.typeSchemas?.entity ?? {})[0] ?? '';
    this.entityForm = { name: '', type: firstType, tags: [], description: '', properties: this.store.buildPropertiesObject('entity', {}, firstType) };
    this.showEntityForm.set(true);
  }

  /** Called when the entity type dropdown changes. Rebuilds properties: keeps existing values, adds defaults for any new schema-required fields. */
  onEntityTypeChange(type: string, target: 'create' | 'inline'): void {
    if (target === 'create') {
      this.entityForm.properties = this.store.buildPropertiesObject('entity', this.entityForm.properties, type);
    } else {
      this.editEntity.properties = this.store.buildPropertiesObject('entity', this.editEntity.properties, type);
    }
  }

  createEntity(): void {
    if (!this.entityForm.name.trim()) return;
    this.creatingEntity.set(true);
    this.createEntityError.set('');
    // `type` in the initialiser rather than assigned after: it is required in the signature now, which is
    // what makes a second caller unable to omit it and find out from a 400. Owner's ruling `P-31`.
    const body: Parameters<BrainApi['createEntity']>[1] = {
      name: this.entityForm.name.trim(),
      type: this.entityForm.type.trim(),
    };
    if (this.entityForm.tags.length) body.tags = this.entityForm.tags;
    if (this.entityForm.description.trim()) body.description = this.entityForm.description.trim();
    const props = this.store.stripEmptyOptionalProps(this.entityForm.properties, this.store.entitySchema(this.entityForm.type));
    if (Object.keys(props).length) body.properties = props;
    this.brainApi.createEntity(this.spaceId(), body).subscribe({
      next: () => {
        this.creatingEntity.set(false);
        this.showEntityForm.set(false);
        this.entityForm = { name: '', type: '', tags: [], description: '', properties: {} as Record<string, string | number | boolean> };
        this.mutated.emit();
        this.load();
      },
      error: (err) => { this.creatingEntity.set(false); this.createEntityError.set(fmtApiError(err, 'Failed to create entity')); },
    });
  }

  startEditEntity(ent: Entity): void {
    this.recordList.editingId.set(ent._id);
    this.recordList.editError.set('');
    this.editEntity = {
      name: ent.name,
      type: ent.type ?? '',
      tags: ent.tags ?? [],
      description: ent.description ?? '',
      properties: this.store.buildPropertiesObject('entity', ent.properties ?? {}, ent.type),
    };
  }

  saveEditEntity(id: string): void {
    this.recordList.editSaving.set(true);
    this.recordList.editError.set('');
    const entProps = this.store.stripEmptyOptionalProps(this.editEntity.properties, this.store.entitySchema(this.editEntity.type));
    this.brainApi.updateEntity(this.spaceId(), id, {
      name: this.editEntity.name.trim(),
      type: this.editEntity.type.trim(),
      tags: this.editEntity.tags,
      description: this.editEntity.description.trim(),
      ...(Object.keys(entProps).length ? { properties: entProps } : {}),
    }).subscribe({
      next: (updated) => {
        this.recordList.editSaving.set(false);
        this.recordList.editingId.set('');
        this.store.entities.update(list => list.map(e => e._id === id ? updated : e));
      },
      error: (err) => { this.recordList.editSaving.set(false); this.recordList.editError.set(fmtApiError(err, 'Failed to save')); },
    });
  }

  deleteEntity(id: string): void {
    this.recordList.confirmDeleteId.set('');
    this.brainApi.deleteEntity(this.spaceId(), id).subscribe({
      next: () => { this.store.entities.update(list => list.filter(e => e._id !== id)); this.mutated.emit(); },
      error: () => {},
    });
  }
}
