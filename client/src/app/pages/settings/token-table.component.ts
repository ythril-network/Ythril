import { ChangeDetectionStrategy, Component, input, model, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslocoPipe } from '@jsverse/transloco';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { HscrollTopDirective } from '../../shared/hscroll-top.directive';
import { BRAIN_RECORD_TABLE_STYLES } from '../brain/brain-table.styles';
import { StatusPillComponent } from '../../shared/status-pill.component';
import { SortableHeaderComponent } from '../brain/sortable-header.component';
import { RightsGlyphComponent } from './rights-glyph.component';
import { TokenQuotaCellComponent } from './token-quota-cell.component';
import { TimestampComponent } from '../../shared/timestamp.component';
import { isExpired, isExpiringSoon } from './token-table';
import type { TokenSortField, SortDir } from './token-table';
import type { TokenRecord } from '../../core/api.types';

/**
 * The Tokens list table — headers, sorting, the two search boxes, and the rows.
 *
 * ## Why the table left the page
 *
 * Owner, 2026-09-01: *"token matrix must be sortable on any column except the button one and label/spaces have
 * to be searchable (see brain-ui datatables for reference)."*
 *
 * `tokens.component.ts` was at its frozen size ceiling, so the feature could not be added to it — and the
 * gate's own message is the reason rather than the rule: *"every change lands in the same place because that is
 * where the code already is."* The table is the natural seam: it is the whole of what the new behaviour touches,
 * and what stays behind is the page's requests, its create dialog and its rights editor.
 *
 * ## It renders rows and emits intentions — it decides nothing
 *
 * Every action is an output. The page owns the requests, as it must: a component that owned one would cancel it
 * on destroy, and this table unmounts whenever the list reloads into an error state.
 *
 * It also does not sort or filter. `[rows]` arrives already ordered and narrowed, from the page's computed over
 * `token-table.ts`. Keeping the comparator out of here is what lets every judgement in it — where blanks land,
 * what "spaces" means as an order — be a named case in `token-table.spec.ts` rather than something reachable
 * only by rendering a table.
 *
 * ## The sort headers are client-side, which the shared primitive did not previously allow for
 *
 * `th[app-sort-th]` comes from Brain, where sorting is a server round trip. Its docblock used to say that only
 * a server-whitelisted field may pass a `field`, so a header could never ask for an ordering the server would
 * reject. That is still true of Brain and is not true here: this list arrives whole and sorts in the browser.
 * The primitive was already agnostic — it emits a field name and draws a caret — so the sentence was amended
 * rather than the code, because a stale sentence in an authoritative place is the defect, and the next reader of
 * that component is the one who believes it.
 */
@Component({
  selector: 'app-token-table',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule, TranslocoPipe, PhIconComponent, StatusPillComponent,
    SortableHeaderComponent, RightsGlyphComponent, TokenQuotaCellComponent, HscrollTopDirective, TimestampComponent,
  ],
  /*
   * `BRAIN_RECORD_TABLE_STYLES` carries `.col-filter-input`, which is what makes the two docked search boxes look
   * like the ones on the Brain tabs — the reference the owner asked for. It has to be listed HERE and not on
   * the page: a parent's styles cannot reach a child's template under emulated encapsulation, so the rules for
   * markup that lives in this file have to travel with this file. That is the exact failure the file-manager
   * split shipped twice.
   *
   * The two rules below moved out of `tokens.styles.ts` for the same reason. Both were checked for a second
   * consumer first — the page's own copy of this markup is what this component replaces, and nothing else
   * renders either class.
   */
  styles: [BRAIN_RECORD_TABLE_STYLES, `
    /* The active/expired dot beside a token's label. */
    .token-status-dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin-right: 5px;
      flex-shrink: 0;
    }
    .dot-active { background: var(--success); }
    .dot-expired { background: var(--error); }

    /* A token with no rights matrix. Muted and small: it is an absence, not a level — the pen beside it is
       the thing to act on. Before 3.0.1 this row showed nothing at all and no pen, so a rightless token could
       be seen and not fixed. */
    .no-rights { margin-left: 8px; font-size: 11px; color: var(--text-muted); font-style: italic;
                 vertical-align: middle; }
  `],
  template: `
    <div class="table-wrapper" hscrollTop>
      <table>
        <thead>
          <tr>
            <th app-sort-th field="label" label="tokens.table.label"
                [activeField]="sortField()" [dir]="sortDir()" (sort)="sort.emit($event)">
              <input class="col-filter-input" type="text" [ngModel]="labelFilter()"
                     (ngModelChange)="labelFilterChange.emit($event)"
                     [attr.placeholder]="'tokens.filter.labelPlaceholder' | transloco"
                     [attr.aria-label]="'tokens.filter.labelPlaceholder' | transloco" />
            </th>
            <th app-sort-th field="permission" label="tokens.table.permission"
                [activeField]="sortField()" [dir]="sortDir()" (sort)="sort.emit($event)"></th>
            <th app-sort-th field="created" label="tokens.table.created"
                [activeField]="sortField()" [dir]="sortDir()" (sort)="sort.emit($event)"></th>
            <th app-sort-th field="lastUsed" label="tokens.table.lastUsed"
                [activeField]="sortField()" [dir]="sortDir()" (sort)="sort.emit($event)"></th>
            <th app-sort-th field="expires" label="tokens.table.expires"
                [activeField]="sortField()" [dir]="sortDir()" (sort)="sort.emit($event)"></th>
            <th app-sort-th field="spaces" label="tokens.table.spaces"
                [activeField]="sortField()" [dir]="sortDir()" (sort)="sort.emit($event)"
                [attr.title]="'tokens.filter.spacesSortHint' | transloco">
              <input class="col-filter-input" type="text" [ngModel]="spacesFilter()"
                     (ngModelChange)="spacesFilterChange.emit($event)"
                     [attr.placeholder]="'tokens.filter.spacesPlaceholder' | transloco"
                     [attr.aria-label]="'tokens.filter.spacesPlaceholder' | transloco" />
            </th>
            <th app-sort-th field="quota" label="tokens.table.quota"
                [activeField]="sortField()" [dir]="sortDir()" (sort)="sort.emit($event)"></th>
            <!-- The actions column does not sort, which is the owner's one exception. The shared header
                 renders plain text when no sort field is passed, so the exception needs no special case. -->
            <th></th>
          </tr>
        </thead>
        <tbody>
          @for (t of rows(); track t.id) {
            <tr>
              <td style="font-weight:500;">
                @if (editingId() === t.id) {
                  <span style="display:inline-flex;align-items:center;gap:6px;">
                    <input type="text" [(ngModel)]="editLabelValue" maxlength="200" style="width:190px;"
                      [attr.aria-label]="'tokens.action.editLabelAriaLabel' | transloco"
                      (keydown.enter)="editLabelSave.emit(t)" (keydown.escape)="editLabelCancel.emit()" />
                    <button class="icon-btn" [attr.title]="'common.save' | transloco" [attr.aria-label]="'common.save' | transloco"
                      (click)="editLabelSave.emit(t)" [disabled]="!editLabelValue().trim()"><ph-icon name="check" [size]="14"/></button>
                    <button class="icon-btn" [attr.title]="'common.cancel' | transloco" [attr.aria-label]="'common.cancel' | transloco"
                      (click)="editLabelCancel.emit()"><ph-icon name="x" [size]="14"/></button>
                  </span>
                } @else {
                  <span class="token-status-dot" [class.dot-active]="!expired(t)" [class.dot-expired]="expired(t)"></span>
                  {{ t.name }}
                  <button class="icon-btn" style="margin-left:4px;" [attr.title]="'tokens.action.editLabelTitle' | transloco"
                    [attr.aria-label]="'tokens.action.editLabelAriaLabel' | transloco" (click)="editLabelStart.emit(t)"><ph-icon name="pencil-simple" [size]="13"/></button>
                  @if (t.id === selfTokenId()) { <span style="margin-left:6px;font-size:0.75rem;color:var(--text-muted);">{{ 'tokens.table.currentSession' | transloco }}</span> }
                }
              </td>
              <td>
                @if (t.rights) {
                  <app-rights-glyph [rights]="t.rights" style="margin-left:8px;vertical-align:middle;"/>
                } @else {
                  <span class="no-rights" [attr.title]="'tokens.rights.none' | transloco">{{ 'tokens.rights.none' | transloco }}</span>
                }
                <button class="icon-btn" type="button" style="margin-left:4px;vertical-align:middle;"
                        [attr.aria-label]="'tokens.rights.edit' | transloco"
                        [attr.title]="'tokens.rights.edit' | transloco"
                        (click)="editRights.emit(t)">
                  <ph-icon name="pencil-simple" [size]="13"/>
                </button>
              </td>
              <td><app-timestamp [value]="t.createdAt"/></td>
              <td>
                @if (t.lastUsed) {
                  <app-timestamp [value]="t.lastUsed"/>
                } @else {
                  <span style="font-style:italic;color:var(--text-muted);">{{ 'tokens.table.neverUsed' | transloco }}</span>
                }
              </td>
              <td>
                @if (t.expiresAt) {
                  <span style="display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;">
                    @if (expired(t)) { <app-status-pill variant="error">{{ 'tokens.table.expired' | transloco }}</app-status-pill> }
                    @else if (expiringSoon(t)) { <app-status-pill variant="warn" [dot]="true">{{ 'tokens.table.expiringSoon' | transloco }}</app-status-pill> }
                    <app-timestamp [value]="t.expiresAt"/>
                  </span>
                } @else {
                  <app-status-pill variant="ok">{{ 'tokens.table.noExpiry' | transloco }}</app-status-pill>
                }
              </td>
              <td>
                @if (t.schemaLibrary) {
                  <span class="badge badge-gray" style="font-style:italic;">{{ 'tokens.badge.schemaLibraryOnly' | transloco }}</span>
                } @else if (!t.spaces || t.spaces.length === 0) {
                  <span class="badge badge-green">{{ 'tokens.badge.allSpaces' | transloco }}</span>
                } @else {
                  <span class="badge badge-gray">{{ t.spaces.join(', ') }}</span>
                }
              </td>
              <td>
                <app-token-quota-cell [perToken]="t.rateLimitPerMinute" [effective]="t.rateLimitEffective" />
              </td>
              <td style="white-space:nowrap; display:flex; gap:6px; align-items:center;">
                <button class="icon-btn" [attr.title]="'tokens.action.rotateTitle' | transloco" [attr.aria-label]="'tokens.action.rotateAriaLabel' | transloco" (click)="rotate.emit(t)"><ph-icon name="arrows-clockwise" [size]="14"/></button>
                <button class="icon-btn danger" [attr.title]="'tokens.action.revokeTitle' | transloco" [attr.aria-label]="'tokens.action.revokeAriaLabel' | transloco" (click)="revoke.emit(t)"><ph-icon name="x" [size]="14"/></button>
              </td>
            </tr>
          } @empty {
            <!-- Eight columns, and it used to say seven — so the empty state stopped one cell short of the
                 table's width and the panel had a notch cut out of its right edge. -->
            <tr><td colspan="8">
              @if (filtered()) {
                <div class="empty-state" style="padding:24px;">
                  <h3>{{ 'tokens.empty.filteredTitle' | transloco }}</h3>
                  <p style="color:var(--text-secondary);font-size:13px;margin:6px 0 14px;">{{ 'tokens.empty.filteredBody' | transloco }}</p>
                  <button class="btn btn-sm" (click)="clearFilters.emit()">{{ 'tokens.empty.clearFilters' | transloco }}</button>
                </div>
              } @else {
                <div class="empty-state" style="padding:24px;">
                  <h3>{{ 'tokens.empty.title' | transloco }}</h3>
                  <p style="color:var(--text-secondary);font-size:13px;margin:6px 0 14px;">{{ 'tokens.empty.body' | transloco }}</p>
                  <button class="btn-primary btn btn-sm" (click)="create.emit()">{{ 'tokens.list.createButton' | transloco }}</button>
                </div>
              }
            </td></tr>
          }
        </tbody>
      </table>
    </div>
  `,
})
export class TokenTableComponent {
  /** Already sorted and narrowed by the page. This component orders nothing. */
  rows = input.required<TokenRecord[]>();
  /**
   * `''` is a real state, not a missing input: it means no column has been chosen and the rows are in the order
   * the server sent. The shared header draws no active caret for a field nobody matches, so the union is what
   * lets "unsorted" render correctly rather than being faked with a column that happens to be the default.
   */
  sortField = input.required<TokenSortField | ''>();
  sortDir = input.required<SortDir>();
  labelFilter = input('');
  spacesFilter = input('');
  editingId = input<string>('');
  selfTokenId = input<string>('');
  /**
   * True when a filter is narrowing the list, so an empty table can say WHICH kind of empty it is.
   *
   * Passed in rather than derived from the two filter strings, because "the boxes are non-empty" and "rows were
   * removed" are different questions and only the page can answer the second. An operator who filters to
   * nothing and is shown "you have no tokens yet, create one" would reasonably believe their tokens were gone.
   */
  filtered = input(false);

  /** Two-way, so the page keeps owning the value it will send. */
  editLabelValue = model('');

  sort = output<string>();
  labelFilterChange = output<string>();
  spacesFilterChange = output<string>();
  clearFilters = output<void>();
  editLabelStart = output<TokenRecord>();
  editLabelSave = output<TokenRecord>();
  editLabelCancel = output<void>();
  editRights = output<TokenRecord>();
  rotate = output<TokenRecord>();
  revoke = output<TokenRecord>();
  create = output<void>();

  /** Shared with the page's rollup — see `token-table.ts`, where both read one definition. */
  expired = isExpired;
  expiringSoon = isExpiringSoon;
}
