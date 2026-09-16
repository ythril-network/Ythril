import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslocoPipe } from '@jsverse/transloco';
import { catchError, of } from 'rxjs';
import { ChronoEntry, ChronoType, ChronoStatus } from '../../core/api.types';
import { BrainApi } from '../../core/brain-api.service';
import { httpErrorReason } from '../../core/http-error';
import { TagInputComponent } from '../../shared/tag-input.component';
import { EntityRefFieldComponent } from './entity-ref-field.component';
import { FactRefFieldComponent } from './fact-ref-field.component';
import { PropertiesEditorComponent } from '../../shared/properties-editor.component';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { ErrorStateComponent } from '../../shared/error-state.component';
import { RecordDrawerState } from './record-drawer-state.service';
import { RecordTabBase } from './record-tab-base';
import { SortableHeaderComponent } from './sortable-header.component';
import { RecordSearchBarComponent } from './record-search-bar.component';
import { fmtApiError, toLocalDatetime } from './brain-format';
import { BRAIN_CHIP_STYLES } from './brain-form.styles';
import { BRAIN_RECORD_TABLE_STYLES } from './brain-table.styles';
import { HscrollTopDirective } from '../../shared/hscroll-top.directive';
import { TimestampComponent } from '../../shared/timestamp.component';

/**
 * The Chrono record tab, extracted from BrainComponent (A17.9b-6g) following the memories/edges pattern.
 * Owns the chrono create form, the (drawer-superseded) inline edit, delete, and the tab's own search
 * (semantic-only top bar via `store.chronoSearch` + a docked Title column freetext filter, 2b-iii-c) +
 * type-tag filter + pagination + loader. Self-loads via a `spaceId` effect.
 *
 * Chrono deltas: every type select offers `store.chronoAllowedTypes()` — the client's mirror of the
 * server's per-space chrono allowlist. There is no free-text type any more; that path predated the
 * allowlist and could only ever return 400. It has NO `mutated` output: chrono
 * create AND delete never refreshed the space stats in the original shell (unlike memory/entity), so
 * there is nothing for the shell to re-fetch.
 */
@Component({
  selector: 'app-chrono-tab',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, TranslocoPipe, TagInputComponent, EntityRefFieldComponent, FactRefFieldComponent, PropertiesEditorComponent, PhIconComponent, ErrorStateComponent, RecordSearchBarComponent, SortableHeaderComponent, HscrollTopDirective, TimestampComponent],
  styles: [BRAIN_CHIP_STYLES, BRAIN_RECORD_TABLE_STYLES],
  template: `

          <div class="content-header">
            <app-record-search-bar
              [value]="store.chronoSearch()" (valueChange)="onChronoSearch($event)"
              placeholder="brain.chrono.searchPlaceholder" />
            <button class="btn-primary btn btn-sm" (click)="openChronoForm()" [disabled]="showChronoForm()">{{ 'brain.chrono.addButton' | transloco }}</button>
          </div>

          @if (showChronoForm()) {
            <form class="create-form" (ngSubmit)="createChrono()">
              <!-- Order follows the feedback (Title, Description, tags, entities) while keeping chrono's
                   required kind/start/end. Single-line fields share one height; description grows. -->
              <div class="form-row">
                <div class="field" style="flex:2; min-width:200px;">
                  <label>{{ 'common.form.title' | transloco }}</label>
                  <input type="text" [(ngModel)]="chronoForm.title" name="title" required />
                </div>
                <div class="field" style="width:160px;">
                  <label>{{ 'common.form.type' | transloco }}</label>
                  <select [(ngModel)]="chronoForm.kind" name="kind" (ngModelChange)="onChronoFormKindChange()">
                    @for (k of store.chronoAllowedTypes(); track k) { <option [value]="k">{{ k }}</option> }
                  </select>
                </div>
                <div class="field" style="width:200px;">
                  <label>{{ 'brain.chrono.form.startsAt' | transloco }}</label>
                  <input type="datetime-local" [(ngModel)]="chronoForm.startsAt" name="startsAt" required />
                </div>
                <div class="field" style="width:200px;">
                  <label>{{ 'brain.chrono.form.endsAt' | transloco }}</label>
                  <input type="datetime-local" [(ngModel)]="chronoForm.endsAt" name="endsAt" />
                </div>
              </div>
              <div class="form-row rich">
                <div class="field">
                  <label>{{ 'brain.chrono.table.description' | transloco }}</label>
                  <textarea [(ngModel)]="chronoForm.description" name="description" rows="3"></textarea>
                </div>
              </div>
              <div class="form-row rich">
                <div class="field">
                  <label>{{ 'brain.chrono.table.tags' | transloco }}</label>
                  <app-tag-input [(value)]="chronoForm.tags" [suggestions]="store.chronoTagSuggestions()" inputName="chronoFormTags" />
                </div>
                <div class="field">
                  <label>{{ 'brain.chrono.table.entities' | transloco }}</label>
                  <app-entity-ref-field [target]="chronoForm" [spaceId]="spaceId()" />
                </div>
                <div class="field">
                  <label>{{ 'brain.chrono.form.facts' | transloco }}</label>
                  <app-memory-ref-field [target]="chronoForm" />
                </div>
              </div>
              <div class="form-row rich">
                <div class="field" style="flex:1;">
                  <label>{{ 'brain.chrono.table.properties' | transloco }}</label>
                  <app-properties-editor
                    [schema]="store.chronoSchema(chronoFormKind())"
                    [required]="store.requiredProps(store.chronoSchema(chronoFormKind()))"
                    [(value)]="chronoForm.properties"
                  />
                </div>
              </div>
              <div style="display:flex; gap:8px;">
                <button class="btn-primary btn btn-sm" type="submit" [disabled]="creatingChrono() || !chronoForm.title.trim() || !chronoForm.startsAt || !chronoForm.kind">
                  @if (creatingChrono()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }
                  {{ 'common.save' | transloco }}
                </button>
                <button class="btn-secondary btn btn-sm" type="button" (click)="showChronoForm.set(false)">{{ 'common.cancel' | transloco }}</button>
              </div>
            </form>
          }

          @if (createChronoError()) {
            <div class="alert alert-error" style="margin-bottom:12px;">{{ createChronoError() }}</div>
          }

          <div class="table-wrapper" hscrollTop>
            <table>
              <thead>
                <tr>
                  <th app-sort-th field="title" label="brain.chrono.table.title" [activeField]="sortField()" [dir]="sortDir()" (sort)="setSort($event)">
                    <input class="col-filter-input" type="text" [ngModel]="search()" (ngModelChange)="setSearchFilter($event)"
                      [placeholder]="'brain.filter.searchPlaceholder' | transloco" [attr.aria-label]="'brain.filter.searchPlaceholder' | transloco" />
                  </th><th app-sort-th label="brain.chrono.table.description">
                    <input class="col-filter-input" type="text" [ngModel]="recordFilter().description" (ngModelChange)="setDescriptionFilter($event)"
                      [placeholder]="'brain.filter.descriptionPlaceholder' | transloco" [attr.aria-label]="'brain.filter.descriptionPlaceholder' | transloco" />
                  </th><th app-sort-th field="type" label="brain.chrono.table.type" [activeField]="sortField()" [dir]="sortDir()" (sort)="setSort($event)">
                    <select class="col-filter-select" [ngModel]="recordFilter().type" (ngModelChange)="setTypeFilter($event)" [attr.aria-label]="'brain.filter.label' | transloco">
                      <option value="">{{ 'brain.filter.allTypes' | transloco }}</option>
                      @for (k of store.chronoTypeOptions(); track k) { <option [value]="k">{{ k }}</option> }
                    </select>
                  </th><th app-sort-th field="status" label="brain.chrono.table.status" [activeField]="sortField()" [dir]="sortDir()" (sort)="setSort($event)">
                    <select class="col-filter-select" [ngModel]="statusFilter()" (ngModelChange)="setStatusFilter($event)" [attr.aria-label]="'brain.filter.statusLabel' | transloco">
                      <option value="">{{ 'brain.filter.allStatuses' | transloco }}</option>
                      @for (st of store.chronoStatusOptions; track st) { <option [value]="st">{{ st }}</option> }
                    </select>
                  </th><th app-sort-th field="startsAt" label="brain.chrono.table.starts" [activeField]="sortField()" [dir]="sortDir()" (sort)="setSort($event)"></th><th app-sort-th field="endsAt" label="brain.chrono.table.ends" [activeField]="sortField()" [dir]="sortDir()" (sort)="setSort($event)"></th>
                  <th app-sort-th label="brain.chrono.table.tags">
                    <input class="col-filter-input" type="text" [ngModel]="recordFilter().tag" (ngModelChange)="setTagFilter($event)"
                      [attr.list]="tagListId" [placeholder]="'brain.filter.tagPlaceholder' | transloco" [attr.aria-label]="'brain.filter.tagPlaceholder' | transloco" />
                    <datalist [id]="tagListId">@for (s of store.chronoTagSuggestions(); track s) { <option [value]="s"></option> }</datalist>
                  </th><th app-sort-th label="brain.chrono.table.entities">
                    <input class="col-filter-input" type="text" [ngModel]="recordFilter().entityName" (ngModelChange)="setNameFilter('entityName', $event)"
                      [placeholder]="'brain.filter.entityNamePlaceholder' | transloco" [attr.aria-label]="'brain.filter.entityNamePlaceholder' | transloco" />
                  </th><th app-sort-th field="createdAt" label="brain.chrono.table.created" [activeField]="sortField()" [dir]="sortDir()" (sort)="setSort($event)"></th><th></th>
                </tr>
              </thead>
              <tbody>
                @for (entry of store.chrono(); track entry._id) {
                  @if (recordList.editingId() === entry._id) {
                    <tr>
                      <td colspan="9">
                        <div class="create-form" style="border:none; padding:8px 0;">
                          <div class="field" style="flex:2; min-width:180px; margin-bottom:0;">
                            <label>{{ 'common.form.title' | transloco }}</label>
                            <input type="text" [(ngModel)]="editChrono.title" name="editChronoTitle" />
                          </div>
                          <div class="field" style="width:130px; margin-bottom:0;">
                            <label>{{ 'common.form.type' | transloco }}</label>
                            <select [(ngModel)]="editChrono.kind" name="editChronoKind" (ngModelChange)="onEditChronoKindChange()">
                              @for (k of store.chronoAllowedTypes(); track k) { <option [value]="k">{{ k }}</option> }
                            </select>
                          </div>
                          <div class="field" style="width:130px; margin-bottom:0;">
                            <label>{{ 'brain.chrono.table.status' | transloco }}</label>
                            <select [(ngModel)]="editChrono.status" name="editChronoStatus">
                              @for (s of store.chronoStatusOptions; track s) { <option [value]="s">{{ s }}</option> }
                            </select>
                          </div>
                          <div class="field" style="width:190px; margin-bottom:0;">
                            <label>{{ 'brain.chrono.form.startsAt' | transloco }}</label>
                            <input type="datetime-local" [(ngModel)]="editChrono.startsAt" name="editChronoStarts" />
                          </div>
                          <div class="field" style="width:190px; margin-bottom:0;">
                            <label>{{ 'common.form.endsAt' | transloco }}</label>
                            <input type="datetime-local" [(ngModel)]="editChrono.endsAt" name="editChronoEnds" />
                          </div>
                          <div class="field" style="flex:1; min-width:180px; margin-bottom:0;">
                            <label>{{ 'brain.chrono.table.description' | transloco }}</label>
                            <textarea [(ngModel)]="editChrono.description" name="editChronoDesc" rows="2" style="resize:vertical;"></textarea>
                          </div>
                          <div class="field" style="flex:1; min-width:180px; margin-bottom:0;">
                            <label>{{ 'brain.chrono.table.tags' | transloco }}</label>
                            <app-tag-input [(value)]="editChrono.tags" [suggestions]="store.chronoTagSuggestions()" inputName="chronoEditTags" />
                          </div>
                          <div class="field" style="flex:1; min-width:140px; margin-bottom:0;">
                            <label>{{ 'brain.chrono.table.entities' | transloco }}</label>
                            <app-entity-ref-field [target]="editChrono" [spaceId]="spaceId()" />
                          </div>
                          <div class="field" style="flex:1; min-width:180px; margin-bottom:0;">
                            <label>{{ 'brain.chrono.table.properties' | transloco }}</label>
                            <app-properties-editor
                              [schema]="store.chronoSchema(editChrono.kind)"
                              [required]="store.requiredProps(store.chronoSchema(editChrono.kind))"
                              [(value)]="editChrono.properties"
                            />
                          </div>
                          <div style="display:flex; gap:6px; align-items:flex-end;">
                            <button class="btn btn-sm btn-primary" [disabled]="recordList.editSaving()" (click)="saveEditChrono(entry._id)">
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
                      <td>{{ entry.title }}</td>
                      <td class="desc-cell" style="max-width:160px;" [title]="entry.description ?? ''">
                        <div class="desc-clamp">{{ entry.description || '—' }}</div>
                      </td>
                      <td><span class="badge badge-blue">{{ entry.type }}</span></td>
                      <td><span class="badge" [class.badge-purple]="entry.status === 'upcoming'" [class.badge-blue]="entry.status === 'active'">{{ entry.status }}</span></td>
                      <td><app-timestamp [value]="entry.startsAt"/></td>
                      <td><app-timestamp [value]="entry.endsAt"/></td>
                      <td>
                        @for (tag of entry.tags; track tag) { <span class="tag">{{ tag }}</span> }
                      </td>
                      <td style="font-size:11px;">
                        @if (entry.entityIds.length) {
                          <div class="chip-list">
                            @for (id of entry.entityIds; track id) {
                              <span class="chip" [title]="id">{{ picker.entityNameCache()[id] || id.slice(0,8) + '…' }}</span>
                            }
                          </div>
                        } @else { <span style="color:var(--text-muted)">—</span> }
                      </td>
                      <td><app-timestamp [value]="entry.createdAt"/></td>
                      <td style="white-space:nowrap;">
                        <button class="icon-btn" [attr.title]="'common.viewDetails' | transloco" [attr.aria-label]="'common.viewDetails' | transloco" (click)="drawerState.open('chrono', entry)"><ph-icon name="eye" [size]="16"/></button>
                        @if (recordList.confirmDeleteId() === entry._id) {
                          <span class="inline-confirm">
                            {{ 'common.deleteConfirm' | transloco }}
                            <button class="btn btn-sm btn-danger" (click)="deleteChrono(entry._id)">{{ 'common.yes' | transloco }}</button>
                            <button class="btn btn-sm btn-secondary" (click)="cancelDelete()">{{ 'common.no' | transloco }}</button>
                          </span>
                        } @else {
                          <button class="icon-btn danger" [attr.aria-label]="'brain.chrono.deleteAriaLabel' | transloco" (click)="requestDelete(entry._id)"><ph-icon name="x" [size]="16"/></button>
                        }
                      </td>
                    </tr>
                  }
                } @empty {
                  <tr><td colspan="9">
                    @if (recordList.loadError() !== null) {
                      <app-error-state [message]="'brain.error.loadChrono' | transloco" [reason]="recordList.loadError() ?? ''" (retry)="retryCurrentTab()" />
                    } @else {
                    <div class="empty-state" style="padding:32px">
                      <div class="empty-state-icon"><ph-icon name="timer" [size]="48"/></div>
                      @if (store.chronoSearch()) {
                        <h3>{{ 'common.noMatches' | transloco }}</h3>
                        <p>{{ 'brain.chrono.empty.noMatchQuery' | transloco }}</p>
                      } @else {
                        <h3>{{ 'brain.chrono.empty.title' | transloco }}</h3>
                      }
                    </div>
                    }
                  </td></tr>
                }
              </tbody>
            </table>
          </div>
          @if (!store.chronoSearch().trim()) {
            <div class="pagination">
              <button class="btn btn-sm btn-secondary" [disabled]="skip() === 0" (click)="prevPage()"><ph-icon name="arrow-left" [size]="14" style="display:inline-flex;vertical-align:middle;"/> {{ 'common.prev' | transloco }}</button>
              <span class="pager-info">{{ store.chrono().length ? (skip() + 1) + '–' + (skip() + store.chrono().length) : '–' }}</span>
              <button class="btn btn-sm btn-secondary" [disabled]="store.chrono().length < pageSize" (click)="nextPage()">{{ 'common.next' | transloco }} <ph-icon name="arrow-right" [size]="14" style="display:inline-flex;vertical-align:middle;"/></button>
            </div>
          }
  `,
})
export class ChronoTabComponent extends RecordTabBase {
  readonly drawerState = inject(RecordDrawerState);
  private brainApi = inject(BrainApi);

  showChronoForm = signal(false);
  creatingChrono = signal(false);
  createChronoError = signal('');
  chronoForm = { title: '', kind: 'event' as string, startsAt: '', endsAt: '', description: '', tags: [] as string[], entityIds: '', memoryIds: [] as string[], properties: {} as Record<string, string | number | boolean> };
  editChrono = { title: '', kind: '' as string, status: '' as string, startsAt: '', endsAt: '', description: '', tags: [] as string[], entityIds: '', memoryIds: [] as string[], properties: {} as Record<string, string | number | boolean> };

  private _chronoSemTimer: ReturnType<typeof setTimeout> | null = null;

  /** Docked Status header filter. Its own signal: `status` is chrono-only, not part of RecordFilter. */
  statusFilter = signal('');
  setStatusFilter(value: string): void {
    this.statusFilter.set(value);
    this.skip.set(0);
    this.load();
  }

  protected override resetOnSpaceChange(): void {
    this.recordFilter.set({ type: '', tag: '', description: '', properties: '', fromName: '', toName: '', entityName: '' });
    this.statusFilter.set('');
  }

  protected override load(): void {
    const spaceId = this.spaceId();
    if (!spaceId) return;
    this.recordList.loading.set(true);
    this.recordList.loadError.set(null);
    const cf: { search?: string; type?: string; tag?: string; description?: string; status?: string; entityName?: string } = {};
    // Docked Title column freetext filter → server-side substring (2b-iii-c), matching memories/edges.
    // The top bar is semantic-only now and never feeds this.
    if (this.searchParam()) cf.search = this.searchParam();
    if (this.recordFilter().type) cf.type = this.recordFilter().type;
    if (this.recordFilter().tag) cf.tag = this.recordFilter().tag;
    if (this.recordFilter().description) cf.description = this.recordFilter().description;
    if (this.recordFilter().entityName) cf.entityName = this.recordFilter().entityName;
    if (this.statusFilter()) cf.status = this.statusFilter();
    this.brainApi.listChrono(spaceId, this.pageSize, this.skip(), cf, this.sortParam()).subscribe({
      next: ({ chrono }) => {
        this.store.chrono.set(chrono);
        const ids = [...new Set(chrono.flatMap(e => e.entityIds ?? []))];
        if (ids.length) this.picker.resolveEntityNames(ids);
        this.recordList.loading.set(false);
      },
      error: (e) => { this.recordList.loadError.set(httpErrorReason(e)); this.recordList.loading.set(false); },
    });
  }

  /**
   * The top-bar search is SEMANTIC-only (2b-iii-c): typing issues a debounced `recallBrain`. Plain
   * substring search moved to the docked Title column freetext filter (server-side, via `load()`).
   * Clearing the box restores the normal paginated list.
   */
  onChronoSearch(q: string): void {
    this.store.chronoSearch.set(q);
    if (this._chronoSemTimer) clearTimeout(this._chronoSemTimer);
    if (!q.trim()) { this.skip.set(0); this.load(); return; }
    this._chronoSemTimer = setTimeout(() => this.runSemanticChronoSearch(), 300);
  }

  runSemanticChronoSearch(): void {
    const q = this.store.chronoSearch().trim();
    const spaceId = this.spaceId();
    if (!q || !spaceId) { this.store.chrono.set([]); return; }
    this.brainApi.recallBrain(spaceId, { query: q, types: ['chrono'], topK: 20 }).pipe(
      catchError(() => of({ results: [], count: 0 })),
    ).subscribe(res => {
      this.store.chrono.set(res.results.filter(r => r.type === 'chrono').map(r => ({
        _id: r['_id'] as string,
        spaceId: (r['spaceId'] as string) ?? spaceId,
        title: (r['title'] as string) ?? '',
        description: r['description'] as string | undefined,
        type: ((r['type'] as string) ?? 'event') as ChronoType,
        startsAt: (r['startsAt'] as string) ?? '',
        endsAt: r['endsAt'] as string | undefined,
        status: 'upcoming' as ChronoStatus,
        confidence: r['confidence'] as number | undefined,
        tags: (r['tags'] as string[]) ?? [],
        entityIds: (r['entityIds'] as string[]) ?? [],
        memoryIds: [],
        author: (r['author'] as { instanceId: string; instanceLabel: string }) ?? { instanceId: '', instanceLabel: '' },
        createdAt: (r['createdAt'] as string) ?? '',
        updatedAt: (r['createdAt'] as string) ?? '',
        seq: (r['seq'] as number) ?? 0,
      } as ChronoEntry)));
    });
  }

  /** Effective chrono type for schema lookup. */
  chronoFormKind(): string {
    return this.chronoForm.kind;
  }

  openChronoForm(): void {
    // Seed from the space's OWN allowlist, not from 'event': a space that declares `typeSchemas.chrono`
    // does not allow the built-ins, so opening on 'event' there armed the form with a value the server 400s on.
    const kind = this.store.chronoAllowedTypes()[0] ?? 'event';
    this.chronoForm = { title: '', kind, startsAt: '', endsAt: '', description: '', tags: [], entityIds: '', memoryIds: [], properties: this.store.buildPropertiesObject('chrono', {}, kind) };
    this.showChronoForm.set(true);
  }

  /** Reseed the create form's properties from the newly selected kind's schema (preserving values). */
  onChronoFormKindChange(): void {
    this.chronoForm.properties = this.store.buildPropertiesObject('chrono', this.chronoForm.properties, this.chronoFormKind());
  }

  /** Reseed the inline-edit form's properties from the newly selected kind's schema. */
  onEditChronoKindChange(): void {
    this.editChrono.properties = this.store.buildPropertiesObject('chrono', this.editChrono.properties, this.editChrono.kind);
  }

  createChrono(): void {
    if (!this.chronoForm.title.trim() || !this.chronoForm.startsAt) return;
    // No free-text branch any more: every chrono write is gated on the space's allowlist, so a typed
    // value that is not already a declared type could only ever come back 400.
    const resolvedKind = this.chronoForm.kind as ChronoType;
    if (!resolvedKind) return;
    this.creatingChrono.set(true);
    this.createChronoError.set('');
    const entityIds = this.chronoForm.entityIds.split(',').map(s => s.trim()).filter(Boolean);
    const body: Parameters<BrainApi['createChrono']>[1] = {
      title: this.chronoForm.title.trim(),
      type: resolvedKind,
      startsAt: new Date(this.chronoForm.startsAt).toISOString(),
    };
    if (this.chronoForm.endsAt) body.endsAt = new Date(this.chronoForm.endsAt).toISOString();
    if (this.chronoForm.description.trim()) body.description = this.chronoForm.description.trim();
    if (this.chronoForm.tags.length) body.tags = this.chronoForm.tags;
    if (entityIds.length) body.entityIds = entityIds;
    if (this.chronoForm.memoryIds.length) body.memoryIds = this.chronoForm.memoryIds;
    const props = this.store.stripEmptyOptionalProps(this.chronoForm.properties, this.store.chronoSchema(resolvedKind));
    if (Object.keys(props).length) body.properties = props;
    this.brainApi.createChrono(this.spaceId(), body).subscribe({
      next: () => {
        this.creatingChrono.set(false);
        this.showChronoForm.set(false);
        this.chronoForm = { title: '', kind: resolvedKind, startsAt: '', endsAt: '', description: '', tags: [], entityIds: '', memoryIds: [], properties: this.store.buildPropertiesObject('chrono', {}, resolvedKind) };
        this.load();
      },
      error: (err) => { this.creatingChrono.set(false); this.createChronoError.set(fmtApiError(err, 'Failed to create chrono entry')); },
    });
  }

  startEditChrono(entry: ChronoEntry): void {
    this.recordList.editingId.set(entry._id);
    this.recordList.editError.set('');
    this.editChrono = {
      title: entry.title,
      kind: entry.type,
      status: entry.status,
      startsAt: entry.startsAt ? toLocalDatetime(entry.startsAt) : '',
      endsAt: entry.endsAt ? toLocalDatetime(entry.endsAt) : '',
      description: entry.description ?? '',
      tags: entry.tags ?? [],
      entityIds: (entry.entityIds ?? []).join(', '),
      memoryIds: [...(entry.memoryIds ?? [])],
      properties: this.store.buildPropertiesObject('chrono', entry.properties ?? {}, entry.type),
    };
    this.picker.resolveMemoryTitles(entry.memoryIds ?? []);
  }

  saveEditChrono(id: string): void {
    this.recordList.editSaving.set(true);
    this.recordList.editError.set('');
    this.brainApi.updateChrono(this.spaceId(), id, {
      title: this.editChrono.title.trim(),
      type: this.editChrono.kind as ChronoType,
      status: this.editChrono.status as ChronoStatus,
      ...(this.editChrono.startsAt ? { startsAt: new Date(this.editChrono.startsAt).toISOString() } : {}),
      ...(this.editChrono.endsAt ? { endsAt: new Date(this.editChrono.endsAt).toISOString() } : {}),
      description: this.editChrono.description.trim(),
      tags: this.editChrono.tags,
      entityIds: this.editChrono.entityIds.split(',').map(s => s.trim()).filter(Boolean),
      memoryIds: this.editChrono.memoryIds,
      properties: this.store.stripEmptyOptionalProps(this.editChrono.properties, this.store.chronoSchema(this.editChrono.kind)),
    }).subscribe({
      next: (updated) => {
        this.recordList.editSaving.set(false);
        this.recordList.editingId.set('');
        this.store.chrono.update(list => list.map(c => c._id === id ? updated : c));
      },
      error: (err) => { this.recordList.editSaving.set(false); this.recordList.editError.set(fmtApiError(err, 'Failed to save')); },
    });
  }

  deleteChrono(id: string): void {
    this.recordList.confirmDeleteId.set('');
    this.brainApi.deleteChrono(this.spaceId(), id).subscribe({
      next: () => this.store.chrono.update(list => list.filter(c => c._id !== id)),
      error: () => {},
    });
  }
}
