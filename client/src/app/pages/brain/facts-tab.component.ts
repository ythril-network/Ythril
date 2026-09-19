import { ChangeDetectionStrategy, Component, inject, output, signal } from '@angular/core';
import { SupersededBadgeComponent } from '../../shared/superseded-badge.component';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslocoPipe } from '@jsverse/transloco';
import { catchError, of } from 'rxjs';
import { Fact } from '../../core/api.types';
import { BrainApi } from '../../core/brain-api.service';
import { httpErrorReason } from '../../core/http-error';
import { TagInputComponent } from '../../shared/tag-input.component';
import { PropertiesViewComponent } from '../../shared/properties-view.component';
import { PropertiesEditorComponent } from '../../shared/properties-editor.component';
import { EntityRefFieldComponent } from './entity-ref-field.component';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { ErrorStateComponent } from '../../shared/error-state.component';
import { RecordDrawerState } from './record-drawer-state.service';
import { RecordTabBase } from './record-tab-base';
import { SortableHeaderComponent } from './sortable-header.component';
import { RecordSearchBarComponent } from './record-search-bar.component';
import { fmtApiError } from './brain-format';
import { BRAIN_CHIP_STYLES } from './brain-form.styles';
import { BRAIN_RECORD_TABLE_STYLES } from './brain-table.styles';
import { HscrollTopDirective } from '../../shared/hscroll-top.directive';
import { TimestampComponent } from '../../shared/timestamp.component';

/**
 * The Memories record tab, extracted from BrainComponent (A17.9b-6d) — the first of the five record
 * tabs to become its own component. Owns the memory create form, the (drawer-superseded) inline edit,
 * delete, and the tab's own search / filter / pagination + loader. Reads records and derived views
 * from BrainStore; shares the singleton load/edit/delete interaction with the shell via
 * RecordListState; uses EntityRefPicker for entity chips and RecordDrawerState to open the detail
 * drawer.
 *
 * Self-loading: the shell renders this behind `@if (activeTab() === 'facts')`, so it is created on
 * activation and destroyed on switch. An effect on the `spaceId` input loads on creation and reloads
 * on a space switch while mounted. Create/delete emit `mutated` so the shell can refresh the tab-count
 * stats (the one legitimate output — tab counts are parent view-state).
 *
 * OnPush: every async path writes a signal; the plain ngModel form models render because a sibling
 * signal write (`showMemoryForm`/`recordList.editingId`) happens in the same turn.
 */
@Component({
  selector: 'app-facts-tab',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, TranslocoPipe, TagInputComponent, PropertiesViewComponent, PropertiesEditorComponent, EntityRefFieldComponent, PhIconComponent, ErrorStateComponent, RecordSearchBarComponent, SortableHeaderComponent, HscrollTopDirective, TimestampComponent, SupersededBadgeComponent],
  styles: [BRAIN_CHIP_STYLES, BRAIN_RECORD_TABLE_STYLES],
  template: `

          <div class="content-header">
            <app-record-search-bar
              [value]="store.memorySearch()" (valueChange)="onMemorySearch($event)"
              placeholder="brain.facts.searchPlaceholder" />
            <button class="btn-primary btn btn-sm" (click)="openMemoryForm()" [disabled]="showMemoryForm()">{{ 'brain.facts.addButton' | transloco }}</button>
          </div>

          <!-- Add memory form -->
          @if (showMemoryForm()) {
            <form class="create-form" (ngSubmit)="createMemory()">
              <!-- Field order matches the table columns: Fact, Description, tags, entities, properties.
                   Fact and Description are the two multiline fields and share one size (feedback). -->
              <div class="form-row rich">
                <div class="field">
                  <label>{{ 'common.form.fact' | transloco }}</label>
                  <textarea [(ngModel)]="memoryForm.fact" name="fact" rows="3" required></textarea>
                </div>
                <div class="field">
                  <label>{{ 'common.form.description' | transloco }}</label>
                  <textarea [(ngModel)]="memoryForm.description" name="description" rows="3"></textarea>
                </div>
              </div>
              <div class="form-row rich">
                <div class="field">
                  <!-- TYPE follows the SERVER, and which control appears depends on the space.
                       This was free text with suggestions on the stated reasoning that "the server does not
                       restrict it ... a <select> would be stricter than the API". That reasoning was correct
                       and is now inverted: since P-24 (owner, 2026-08-30) declaring typeSchemas.fact makes
                       those names the allowed set, exactly as for entities, edges and chrono. Keeping free
                       text in such a space would let the form submit a value the server refuses, which is the
                       same defect the other way round. A space declaring NO memory types is unrestricted, and
                       there the free-text control is still the right one. -->
                  <label>{{ 'common.form.type' | transloco }}</label>
                  @if (store.memoryTypesAreRestricted()) {
                    <select [(ngModel)]="memoryForm.type" name="memFormType">
                      <option value="">{{ 'brain.facts.form.typePlaceholder' | transloco }}</option>
                      @for (t of store.memoryAllowedTypes(); track t) { <option [value]="t">{{ t }}</option> }
                    </select>
                  } @else {
                    <input type="text" [(ngModel)]="memoryForm.type" name="memFormType" list="memTypeOptions"
                           [placeholder]="'brain.facts.form.typePlaceholder' | transloco" />
                    <datalist id="memTypeOptions">
                      @for (t of store.memoryTypeOptions(); track t) { <option [value]="t"></option> }
                    </datalist>
                  }
                </div>
                <div class="field">
                  <label>{{ 'common.form.tags' | transloco }}</label>
                  <app-tag-input [(value)]="memoryForm.tags" [suggestions]="store.memoryTagSuggestions()" inputName="memFormTags" />
                </div>
                <div class="field">
                  <label>{{ 'common.form.entities' | transloco }}</label>
                  <app-entity-ref-field [target]="memoryForm" [spaceId]="spaceId()" />
                </div>
                <div class="field">
                  <label>{{ 'common.form.properties' | transloco }}</label>
                  <app-properties-editor [schema]="store.memorySchema()" [required]="store.requiredProps(store.memorySchema())" [(value)]="memoryForm.properties" />
                </div>
              </div>
              <div style="display:flex; gap:8px;">
                <button class="btn-primary btn btn-sm" type="submit" [disabled]="creatingMemory() || !memoryForm.fact.trim()">
                  @if (creatingMemory()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }
                  {{ 'common.save' | transloco }}
                </button>
                <button class="btn-secondary btn btn-sm" type="button" (click)="showMemoryForm.set(false)">{{ 'common.cancel' | transloco }}</button>
              </div>
            </form>
          }

          @if (createMemoryError()) {
            <div class="alert alert-error" style="margin-bottom:12px;">{{ createMemoryError() }}</div>
          }

          <!-- Tag/type filtering now docks in the column headers (2b-ii). The active ENTITY filter —
               set by clicking an entity chip in a row — stays as an indicator chip here since it has
               no column of its own. -->
          @if (filterEntity(); as ent) {
            <div class="list-filter-row">
              <span class="filter-chip">{{ 'brain.filter.entityPrefix' | transloco }} {{ ent }} <button [attr.aria-label]="'brain.filter.clearEntityAriaLabel' | transloco" (click)="clearFilter('entity')"><ph-icon name="x" [size]="12"/></button></span>
            </div>
          }

          <div class="table-wrapper" hscrollTop>
            <table>
              <thead>
                <tr>
                  <th app-sort-th label="brain.facts.table.fact">
                    <input class="col-filter-input" type="text" [ngModel]="search()" (ngModelChange)="setSearchFilter($event)"
                      [placeholder]="'brain.filter.searchPlaceholder' | transloco" [attr.aria-label]="'brain.filter.searchPlaceholder' | transloco" />
                  </th><th app-sort-th label="brain.facts.table.description">
                    <input class="col-filter-input" type="text" [ngModel]="recordFilter().description" (ngModelChange)="setDescriptionFilter($event)"
                      [placeholder]="'brain.filter.descriptionPlaceholder' | transloco" [attr.aria-label]="'brain.filter.descriptionPlaceholder' | transloco" />
                  </th><th app-sort-th field="type" label="brain.facts.table.type" [activeField]="sortField()" [dir]="sortDir()" (sort)="setSort($event)">
                    <select class="col-filter-select" [ngModel]="recordFilter().type" (ngModelChange)="setTypeFilter($event)" [attr.aria-label]="'brain.filter.label' | transloco">
                      <option value="">{{ 'brain.filter.allTypes' | transloco }}</option>
                      @for (t of store.memoryTypeOptions(); track t) { <option [value]="t">{{ t }}</option> }
                    </select>
                  </th><th app-sort-th label="brain.facts.table.tags">
                    <input class="col-filter-input" type="text" [ngModel]="recordFilter().tag" (ngModelChange)="setTagFilter($event)"
                      [attr.list]="tagListId" [placeholder]="'brain.filter.tagPlaceholder' | transloco" [attr.aria-label]="'brain.filter.tagPlaceholder' | transloco" />
                    <datalist [id]="tagListId">@for (s of store.memoryTagSuggestions(); track s) { <option [value]="s"></option> }</datalist>
                  </th>
                  <th app-sort-th label="brain.facts.table.entities">
                    <input class="col-filter-input" type="text" [ngModel]="recordFilter().entityName" (ngModelChange)="setNameFilter('entityName', $event)"
                      [placeholder]="'brain.filter.entityNamePlaceholder' | transloco" [attr.aria-label]="'brain.filter.entityNamePlaceholder' | transloco" />
                  </th><th app-sort-th label="brain.facts.table.properties">
                    <input class="col-filter-input" type="text" [ngModel]="recordFilter().properties" (ngModelChange)="setPropertiesFilter($event)"
                      [placeholder]="'brain.filter.propertiesPlaceholder' | transloco" [attr.aria-label]="'brain.filter.propertiesPlaceholder' | transloco" />
                  </th><th app-sort-th field="createdAt" label="brain.facts.table.created" [activeField]="sortField()" [dir]="sortDir()" (sort)="setSort($event)"></th><th></th>
                </tr>
              </thead>
              <tbody>
                @for (mem of store.facts(); track mem._id) {
                  @if (recordList.editingId() === mem._id) {
                    <tr>
                      <td colspan="8">
                        <div class="create-form" style="border:none; padding:8px 0;">
                          <div class="field" style="flex:2; min-width:200px; margin-bottom:0;">
                            <label>{{ 'common.form.fact' | transloco }}</label>
                            <textarea [(ngModel)]="editMemory.fact" name="editFact" rows="2" style="width:100%;"></textarea>
                          </div>
                          <div class="field" style="flex:1; min-width:160px; margin-bottom:0;">
                            <label>{{ 'common.form.description' | transloco }}</label>
                            <textarea [(ngModel)]="editMemory.description" name="editDesc" rows="2" style="resize:vertical;"></textarea>
                          </div>
                          <div class="field" style="flex:1; min-width:180px; margin-bottom:0;">
                            <label>{{ 'common.form.tags' | transloco }}</label>
                            <app-tag-input [(value)]="editMemory.tags" [suggestions]="store.memoryTagSuggestions()" inputName="memEditTags" />
                          </div>
                          <div class="field" style="flex:1; min-width:140px; margin-bottom:0;">
                            <label>{{ 'common.form.entities' | transloco }}</label>
                            <app-entity-ref-field [target]="editMemory" [spaceId]="spaceId()" />
                          </div>
                          <div class="field" style="flex:1; min-width:220px; margin-bottom:0;">
                            <label>{{ 'common.form.properties' | transloco }}</label>
                            <app-properties-editor
                              [schema]="store.memorySchema()"
                              [required]="store.requiredProps(store.memorySchema())"
                              [(value)]="editMemory.properties"
                            />
                          </div>
                          <div style="display:flex; gap:6px; align-items:flex-end;">
                            <button class="btn btn-sm btn-primary" [disabled]="recordList.editSaving()" (click)="saveEditMemory(mem._id)">
                              @if (recordList.editSaving()) { <span class="spinner" style="width:11px;height:11px;border-width:2px;"></span> } {{ 'common.save' | transloco }}
                            </button>
                            <button class="btn btn-sm btn-secondary" (click)="recordList.cancelEdit()">{{ 'common.cancel' | transloco }}</button>
                          </div>
                          @if (recordList.editError()) { <div style="font-size:12px; color:var(--error);">{{ recordList.editError() }}</div> }
                        </div>
                      </td>
                    </tr>
                  } @else {
                    <tr>
                      <td style="max-width:300px; white-space:pre-wrap; word-break:break-word;">{{ mem.fact }} <app-superseded-badge [superseded]="mem.superseded" /></td>
                      <td class="desc-cell" style="max-width:180px;" [title]="mem.description ?? ''">
                        <div class="desc-clamp">{{ mem.description || '—' }}</div>
                      </td>
                      <td style="font-size:11px; white-space:nowrap;">{{ mem.type || '—' }}</td>
                      <td style="font-size:11px;">
                        @for (tag of (mem.tags ?? []); track tag) { <span class="tag tag-clickable" (click)="applyFilter('tag', tag)">{{ tag }}</span> }
                        @if (!(mem.tags?.length)) { <span style="color:var(--text-muted)">—</span> }
                      </td>
                      <td style="font-size:11px;">
                        @if (mem.entityIds?.length) {
                          <div class="chip-list">
                            @for (id of mem.entityIds!; track id) {
                              <span class="chip" [title]="id">{{ picker.entityNameCache()[id] || id.slice(0,8) + '…' }}</span>
                            }
                          </div>
                        } @else { <span style="color:var(--text-muted)">—</span> }
                      </td>
                      <td><app-properties-view [properties]="mem.properties" [schema]="store.memorySchema()" /></td>
                      <td><app-timestamp [value]="mem.createdAt"/></td>
                      <td style="white-space:nowrap;">
                        <button class="icon-btn" [attr.title]="'common.viewDetails' | transloco" [attr.aria-label]="'common.viewDetails' | transloco" (click)="drawerState.open('fact', mem)"><ph-icon name="eye" [size]="16"/></button>
                        @if (recordList.confirmDeleteId() === mem._id) {
                          <span class="inline-confirm">
                            {{ 'common.deleteConfirm' | transloco }}
                            <button class="btn btn-sm btn-danger" (click)="deleteFact(mem._id)">{{ 'common.yes' | transloco }}</button>
                            <button class="btn btn-sm btn-secondary" (click)="cancelDelete()">{{ 'common.no' | transloco }}</button>
                          </span>
                        } @else {
                          <button class="icon-btn danger" [attr.title]="'brain.facts.deleteTitle' | transloco" [attr.aria-label]="'brain.facts.deleteAriaLabel' | transloco" (click)="requestDelete(mem._id)"><ph-icon name="x" [size]="16"/></button>
                        }
                      </td>
                    </tr>
                  }
                } @empty {
                  <tr><td colspan="8">
                    @if (recordList.loadError() !== null) {
                      <app-error-state [message]="'brain.error.loadFacts' | transloco" [reason]="recordList.loadError() ?? ''" (retry)="retryCurrentTab()" />
                    } @else {
                    <div class="empty-state" style="padding:32px">
                      <div class="empty-state-icon"><ph-icon name="brain" [size]="48"/></div>
                      @if (store.memorySearch()) {
                        <h3>{{ 'common.noMatches' | transloco }}</h3>
                        <p>{{ 'brain.facts.empty.noMatchQuery' | transloco: { query: store.memorySearch() } }}</p>
                      } @else {
                        <h3>{{ 'brain.facts.empty.title' | transloco }}</h3>
                        <p>{{ 'brain.facts.empty.body' | transloco }}</p>
                      }
                    </div>
                    }
                  </td></tr>
                }
              </tbody>
            </table>
          </div>
          @if (!store.memorySearch().trim()) {
            <div class="pagination">
              <button class="btn btn-sm btn-secondary" [disabled]="skip() === 0" (click)="prevPage()"><ph-icon name="arrow-left" [size]="14" style="display:inline-flex;vertical-align:middle;"/> {{ 'common.prev' | transloco }}</button>
              <span class="pager-info">{{ store.facts().length ? (skip() + 1) + '–' + (skip() + store.facts().length) : '–' }}</span>
              <button class="btn btn-sm btn-secondary" [disabled]="store.facts().length < pageSize" (click)="nextPage()">{{ 'common.next' | transloco }} <ph-icon name="arrow-right" [size]="14" style="display:inline-flex;vertical-align:middle;"/></button>
            </div>
          }
  `,
})
export class FactsTabComponent extends RecordTabBase {
  readonly drawerState = inject(RecordDrawerState);
  private brainApi = inject(BrainApi);

  /** Emitted after a create/delete so the shell can refresh the space's tab-count stats. */
  readonly mutated = output<void>();

  filterEntity = signal('');

  showMemoryForm = signal(false);
  creatingMemory = signal(false);
  createMemoryError = signal('');
  memoryForm = { fact: '', type: '', tags: [] as string[], entityIds: '', description: '', properties: {} as Record<string, string | number | boolean> };
  editMemory = { fact: '', tags: [] as string[], entityIds: '', description: '', properties: {} as Record<string, string | number | boolean> };

  private _memSemTimer: ReturnType<typeof setTimeout> | null = null;

  protected override resetOnSpaceChange(): void {
    this.recordFilter.set({ type: '', tag: '', description: '', properties: '', fromName: '', toName: '', entityName: '' });
    this.filterEntity.set('');
  }

  protected override load(): void {
    const spaceId = this.spaceId();
    if (!spaceId) return;
    this.recordList.loading.set(true);
    this.recordList.loadError.set(null);
    const filters: { tag?: string; entity?: string; type?: string; description?: string; properties?: string; entityName?: string } = {};
    if (this.recordFilter().tag) filters.tag = this.recordFilter().tag;
    if (this.filterEntity()) filters.entity = this.filterEntity();
    if (this.recordFilter().type) filters.type = this.recordFilter().type;
    if (this.recordFilter().description) filters.description = this.recordFilter().description;
    if (this.recordFilter().entityName) filters.entityName = this.recordFilter().entityName;
    if (this.recordFilter().properties) filters.properties = this.recordFilter().properties;
    this.brainApi.listFacts(spaceId, this.pageSize, this.skip(), filters, this.sortParam(), this.searchParam()).subscribe({
      next: ({ facts }) => {
        this.store.facts.set(facts);
        const ids = [...new Set(facts.flatMap(m => m.entityIds ?? []))];
        if (ids.length) this.picker.resolveEntityNames(ids);
        this.recordList.loading.set(false);
      },
      error: (e) => { this.recordList.loadError.set(httpErrorReason(e)); this.recordList.loading.set(false); },
    });
  }

  /**
   * The top-bar search is SEMANTIC-only (2b-iii-c): typing issues a debounced `recallBrain`. Plain
   * substring search moved to the docked Fact column freetext filter (server-side, via `load()`).
   * Clearing the box restores the normal paginated list.
   */
  onMemorySearch(q: string): void {
    this.store.memorySearch.set(q);
    if (this._memSemTimer) clearTimeout(this._memSemTimer);
    if (!q.trim()) { this.skip.set(0); this.load(); return; }
    this._memSemTimer = setTimeout(() => this.runSemanticMemorySearch(), 300);
  }

  runSemanticMemorySearch(): void {
    const q = this.store.memorySearch().trim();
    const spaceId = this.spaceId();
    if (!q || !spaceId) { this.store.facts.set([]); return; }
    this.brainApi.recallBrain(spaceId, { query: q, types: ['fact'], topK: 20 }).pipe(
      catchError(() => of({ results: [], count: 0 })),
    ).subscribe(res => {
      this.store.facts.set(res.results.filter(r => r.type === 'fact').map(r => ({
        _id: r['_id'] as string,
        fact: (r['fact'] as string) ?? '',
        tags: (r['tags'] as string[]) ?? [],
        entityIds: (r['entityIds'] as string[]) ?? [],
        description: r['description'] as string | undefined,
        properties: (r['properties'] as Record<string, string | number | boolean>) ?? {},
        createdAt: (r['createdAt'] as string) ?? '',
        seq: (r['seq'] as number) ?? 0,
        author: r['author'] as { instanceId: string } | undefined,
      } as Fact)));
    });
  }

  applyFilter(type: 'tag' | 'entity', value: string): void {
    if (type === 'tag') this.recordFilter.set({ ...this.recordFilter(), tag: value });
    else this.filterEntity.set(value);
    this.skip.set(0);
    this.load();
  }

  clearFilter(which: 'tag' | 'entity' | 'all'): void {
    if (which === 'tag' || which === 'all') this.recordFilter.set({ ...this.recordFilter(), tag: '' });
    if (which === 'entity' || which === 'all') this.filterEntity.set('');
    this.skip.set(0);
    this.load();
  }

  openMemoryForm(): void {
    this.memoryForm = { fact: '', type: '', tags: [], entityIds: '', description: '', properties: this.store.buildPropertiesObject('fact') };
    this.showMemoryForm.set(true);
  }

  createMemory(): void {
    if (!this.memoryForm.fact.trim()) return;
    this.creatingMemory.set(true);
    this.createMemoryError.set('');
    const entityIds = this.memoryForm.entityIds.split(',').map(s => s.trim()).filter(Boolean);
    const body: Parameters<BrainApi['createMemory']>[1] = { fact: this.memoryForm.fact.trim() };
    // Sent only when non-empty: an empty `type` must stay ABSENT rather than become the string "", which would
    // select typeSchemas.fact[""], find nothing, and store a type nobody can filter for.
    if (this.memoryForm.type.trim()) body.type = this.memoryForm.type.trim();
    if (this.memoryForm.tags.length) body.tags = this.memoryForm.tags;
    if (entityIds.length) body.entityIds = entityIds;
    if (this.memoryForm.description.trim()) body.description = this.memoryForm.description.trim();
    if (Object.keys(this.memoryForm.properties).length) body.properties = this.memoryForm.properties;
    this.brainApi.createMemory(this.spaceId(), body).subscribe({
      next: () => {
        this.creatingMemory.set(false);
        this.showMemoryForm.set(false);
        this.memoryForm = { fact: '', type: '', tags: [], entityIds: '', description: '', properties: {} as Record<string, string | number | boolean> };
        this.mutated.emit();
        this.load();
      },
      error: (err) => { this.creatingMemory.set(false); this.createMemoryError.set(fmtApiError(err, 'Failed to create memory')); },
    });
  }

  startEditMemory(mem: Fact): void {
    this.recordList.editingId.set(mem._id);
    this.recordList.editError.set('');
    this.editMemory = {
      fact: mem.fact,
      tags: mem.tags ?? [],
      entityIds: (mem.entityIds ?? []).join(', '),
      description: mem.description ?? '',
      properties: this.store.buildPropertiesObject('fact', mem.properties ?? {}),
    };
  }

  saveEditMemory(id: string): void {
    this.recordList.editSaving.set(true);
    this.recordList.editError.set('');
    const memProps = this.editMemory.properties;
    this.brainApi.updateFact(this.spaceId(), id, {
      fact: this.editMemory.fact.trim(),
      tags: this.editMemory.tags,
      entityIds: this.editMemory.entityIds.split(',').map(s => s.trim()).filter(Boolean),
      description: this.editMemory.description.trim(),
      ...(Object.keys(memProps).length ? { properties: memProps } : {}),
    }).subscribe({
      next: (updated) => {
        this.recordList.editSaving.set(false);
        this.recordList.editingId.set('');
        this.store.facts.update(list => list.map(m => m._id === id ? updated : m));
      },
      error: (err) => { this.recordList.editSaving.set(false); this.recordList.editError.set(fmtApiError(err, 'Failed to save')); },
    });
  }

  deleteFact(id: string): void {
    this.recordList.confirmDeleteId.set('');
    this.brainApi.deleteFact(this.spaceId(), id).subscribe({
      next: () => { this.store.facts.update(list => list.filter(m => m._id !== id)); this.mutated.emit(); },
      error: () => {},
    });
  }
}
