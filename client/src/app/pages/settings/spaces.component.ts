import { ChangeDetectionStrategy, Component, HostListener, inject, signal, computed, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ProxySpaceBadgeComponent } from '../../shared/proxy-space-badge.component';
import { FormsModule } from '@angular/forms';
import {
  Space,
  SpaceActivity,
} from '../../core/api.types';
import { SpacesApi } from '../../core/spaces-api.service';
import { TranslocoPipe } from '@jsverse/transloco';
import { TranslocoService } from '@jsverse/transloco';
import { DragDropModule } from '@angular/cdk/drag-drop';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { SummaryStripComponent, type SummaryItem } from '../../shared/summary-strip.component';
import { SpaceSettingsState } from './space-settings-state.service';
import { SpacesStore } from './spaces-store.service';
import { SPACE_DIALOG_STYLES } from './space-dialog.styles';
import { SpaceSettingsPopupComponent } from './space-settings-popup.component';
import { ModalDirective } from '../../shared/modal.directive';
import { SpaceCreateDialogComponent } from './space-create-dialog.component';
import { HscrollTopDirective } from '../../shared/hscroll-top.directive';
import { StatusPillComponent } from '../../shared/status-pill.component';

@Component({
  selector: 'app-spaces',
  standalone: true,
  imports: [ProxySpaceBadgeComponent, CommonModule, FormsModule, TranslocoPipe, DragDropModule, PhIconComponent, SummaryStripComponent,
    SpaceSettingsPopupComponent,
    SpaceCreateDialogComponent, ModalDirective, HscrollTopDirective, StatusPillComponent],
  // Provided here (not root) so each mount gets its own settings state, with a lifetime tied to
  // this component rather than the app.
  providers: [SpacesStore, SpaceSettingsState],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [SPACE_DIALOG_STYLES],
  template: `
    <!-- CREATE DIALOG -->
    @if (showCreateDialog()) {
      <app-space-create-dialog (closed)="showCreateDialog.set(false)" />
    }

    <!-- The space settings pop-up: its own component, opened by setting state.settingsSpace().
         Deferred behind the same gate the Brain host uses. It is modal-only in both places, so neither page
         needs the schema editor, the duplicate rules and the danger zone until a cog is pressed — and while
         one host loaded it eagerly and the other did not, the shared code was hoisted out of this route's
         chunk, which cost spaces-component its name and took it off the bundle-budget list. A budget that
         names no chunk is evaluated against nothing, so the page could then grow unbounded while the build
         stayed green. -->
    @if (state.settingsSpace()) {
      @defer (on immediate) {
        <app-space-settings-popup />
      }
    }

    <!-- Import conflict dialog -->

    <!-- Library picker dialog -->

    <!-- SPACES TABLE -->
    @if (!store.loading() && !store.error()) {
      <app-summary-strip [items]="spacesSummary()" style="display:block;margin-bottom:16px;"/>
    }

    <div class="card">
      <div class="card-header">
        <div class="card-title">{{ 'spaces.table.title' | transloco }}</div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <input type="search" [value]="spaceSearch()" (input)="spaceSearch.set($any($event.target).value)"
            class="space-search-input"
            [placeholder]="'spaces.table.search.placeholder' | transloco" />
          <div class="sort-group" [attr.aria-label]="'spaces.table.sortLabel' | transloco">
            <button class="sort-btn" [class.active]="sortMode()==='custom'" [attr.aria-pressed]="sortMode()==='custom'" (click)="sortMode.set('custom')" [attr.title]="'spaces.table.sort.custom' | transloco">⠿</button>
            <button class="sort-btn" [class.active]="sortMode()==='az'" [attr.aria-pressed]="sortMode()==='az'" (click)="sortMode.set('az')" [attr.title]="'spaces.table.sort.az' | transloco">A→Z</button>
            <button class="sort-btn" [class.active]="sortMode()==='za'" [attr.aria-pressed]="sortMode()==='za'" (click)="sortMode.set('za')" [attr.title]="'spaces.table.sort.za' | transloco">Z→A</button>
            <button class="sort-btn" [class.active]="sortMode()==='usage-desc'" [attr.aria-pressed]="sortMode()==='usage-desc'" (click)="sortMode.set('usage-desc')" [attr.title]="'spaces.table.sort.usageDesc' | transloco">↓ GiB</button>
            <button class="sort-btn" [class.active]="sortMode()==='usage-asc'" [attr.aria-pressed]="sortMode()==='usage-asc'" (click)="sortMode.set('usage-asc')" [attr.title]="'spaces.table.sort.usageAsc' | transloco">↑ GiB</button>
            <!-- Two orderings, because "useful" has two halves. Busiest finds the load; worst-answered finds
                 the content gap — a space fielding questions and returning nothing, which is invisible in
                 every other column on this page. -->
            <button class="sort-btn" [class.active]="sortMode()==='calls-desc'" [attr.aria-pressed]="sortMode()==='calls-desc'" (click)="sortMode.set('calls-desc')" [attr.title]="'spaces.table.sort.callsDesc' | transloco">↓ {{ 'spaces.table.sort.callsShort' | transloco }}</button>
            <button class="sort-btn" [class.active]="sortMode()==='answers-asc'" [attr.aria-pressed]="sortMode()==='answers-asc'" (click)="sortMode.set('answers-asc')" [attr.title]="'spaces.table.sort.answersAsc' | transloco">↑ {{ 'spaces.table.sort.answersShort' | transloco }}</button>
          </div>
          <button class="btn-primary btn btn-sm" (click)="showCreateDialog.set(true)">{{ 'spaces.table.createButton' | transloco }}</button>
          <button class="btn-secondary btn btn-sm" (click)="store.load()">{{ 'spaces.table.refreshButton' | transloco }}</button>
        </div>
      </div>
      @if (store.loading()) {
        <div class="loading-overlay"><span class="spinner"></span></div>
      } @else if (store.error()) {
        <div class="alert alert-error" style="margin:16px;display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap;">
          <span>{{ 'spaces.table.loadError' | transloco }}</span>
          <button class="btn btn-secondary btn-sm" (click)="store.load()">{{ 'spaces.table.refreshButton' | transloco }}</button>
        </div>
      } @else {
        <div class="table-wrapper" hscrollTop>
          <table>
            <thead>
              <tr><th style="width:32px;"></th><th>{{ 'spaces.table.column.label' | transloco }}</th><th>{{ 'spaces.table.column.id' | transloco }}</th><th>{{ 'spaces.table.column.storage' | transloco }}</th><th>{{ 'spaces.table.column.usage' | transloco }}</th><th>{{ 'spaces.table.column.networks' | transloco }}</th><th>{{ 'spaces.table.column.proxy' | transloco }}</th><th></th></tr>
            </thead>
            <tbody cdkDropList (cdkDropListDropped)="store.reorder($event.previousIndex, $event.currentIndex)">
              @for (s of sortedSpaces(); track s.id) {
                @let bar = storageInfo(s);
                <tr cdkDrag cdkDragLockAxis="y" [cdkDragDisabled]="sortMode() !== 'custom'">
                  <td><span class="drag-handle" cdkDragHandle [class.drag-handle-disabled]="sortMode() !== 'custom'" [attr.title]="'spaces.table.dragHandleTitle' | transloco"><ph-icon name="dots-three-vertical" [size]="16"/></span></td>
                  <td style="font-weight:500;">{{ s.label }}
                    @if (s.indexStatus === 'building') {
                      <span class="badge badge-blue" style="margin-left:6px;font-weight:normal" [attr.title]="'spaces.indexBuildingTitle' | transloco"><span class="spinner" style="width:8px;height:8px;border-width:1.5px;display:inline-block;vertical-align:middle;margin-right:3px;"></span>{{ 'spaces.indexBuilding' | transloco }}</span>
                    } @else if (s.indexStatus === 'failed') {
                      <span class="badge badge-red" style="margin-left:6px;font-weight:normal" [attr.title]="'spaces.indexFailedTitle' | transloco">{{ 'spaces.indexFailed' | transloco }}</span>
                    }
                  </td>
                  <td><span class="badge badge-gray mono">{{ s.id }}</span></td>
                  <td style="min-width:140px;">
                    @if (bar.label !== '—') {
                      <div class="st-bar"><div [class]="'st-bar-fill '+bar.cls" [style.width.%]="bar.pct"></div></div>
                      <div style="font-size:11px;color:var(--text-muted);margin-top:2px;white-space:nowrap;">{{ bar.label }}</div>
                    } @else {
                      <span style="color:var(--text-muted)">—</span>
                    }
                  </td>
                  <!-- Usage: calls over the window, and how many recalls found something.
                       Both numbers, never one: a space asked 380 times that answered 41 is not the busiest
                       space in a useful sense, and a call count on its own says it is. -->
                  <td style="min-width:120px;white-space:nowrap;">
                    @let use = activityFor(s.id);
                    @if (use) {
                      <span class="mono" style="font-size:12px;">{{ use.calls }}</span>
                      @if (answerRate(use); as rate) {
                        <span class="badge" style="margin-left:6px"
                              [class.badge-green]="rate >= 50" [class.badge-yellow]="rate < 50 && rate >= 20"
                              [class.badge-red]="rate < 20"
                              [attr.title]="('spaces.table.usageAnsweredTitle' | transloco) + ' ' + use.answered + '/' + use.recall">{{ rate }}%</span>
                      } @else if (use.recall > 0) {
                        <span class="badge badge-red" style="margin-left:6px">0%</span>
                      }
                    } @else {
                      <span style="color:var(--text-muted)">—</span>
                    }
                  </td>
                  <td>
                    @let nets = store.networksForSpace(s.id);
                    @if (nets.length) {
                      @for (n of nets; track n.id) {
                        <span class="badge badge-gray" style="margin-right:4px;">{{ n.label }}</span>
                      }
                    } @else { <span style="color:var(--text-muted)">—</span> }
                  </td>
                  <td>
                    @if (s.proxyFor?.[0]==='*') {
                      <app-proxy-space-badge [proxyFor]="s.proxyFor" [size]="14" [showLabel]="true" />
                      <span class="badge badge-blue" style="font-style:italic;margin-left:4px;">{{ 'spaces.badge.allSpaces' | transloco }}</span>
                    } @else if (s.proxyFor?.length) {
                      <app-proxy-space-badge [proxyFor]="s.proxyFor" [size]="14" style="margin-right:4px" />
                      @for (pid of s.proxyFor; track pid) {
                        <span class="badge badge-blue" style="margin-right:4px">{{ pid }}</span>
                      }
                    } @else { <span style="color:var(--text-muted)">—</span> }
                  </td>
                  <td><button class="icon-btn" [attr.title]="'spaces.table.configureTitle' | transloco" (click)="state.openSettings(s)"><ph-icon name="gear" [size]="16"/></button></td>
                </tr>
              } @empty {
                <tr><td colspan="8"><div class="empty-state" style="padding:28px 24px;">
                  <div class="empty-state-icon"><ph-icon name="package" [size]="40"/></div>
                  <h3>{{ 'spaces.table.empty' | transloco }}</h3>
                  <p>{{ 'spaces.table.emptyBody' | transloco }}</p>
                  <button class="btn btn-primary btn-sm" style="margin-top:10px;" (click)="showCreateDialog.set(true)">{{ 'spaces.table.createButton' | transloco }}</button>
                </div></td></tr>
              }
            </tbody>
          </table>
        </div>
      }
    </div>
  `,
})
export class SpacesComponent implements OnInit {
  private spacesApi   = inject(SpacesApi);
  private transloco = inject(TranslocoService);
  /** Settings-dialog state, shared with the tabs. Public: the template binds to it. */
  readonly state = inject(SpaceSettingsState);
  /** Server data for the page (space list + networks). Public: the template binds to it. */
  readonly store = inject(SpacesStore);

  /** Operator-first rollup atop the list: how many spaces, total storage in use, and how many need attention. */
  spacesSummary = computed<SummaryItem[]>(() => {
    const list = this.store.spaces();
    const totalUsed = list.reduce((n, s) => n + (s.usageGiB ?? 0), 0);
    const attention = list.filter(s => s.indexStatus === 'building' || s.indexStatus === 'failed').length;
    return [
      { label: this.transloco.translate('spaces.summary.count'), value: String(list.length) },
      { label: this.transloco.translate('spaces.summary.storage'), value: `${totalUsed.toFixed(totalUsed < 10 ? 2 : 1)} GiB` },
      { label: this.transloco.translate('spaces.summary.indexing'), value: String(attention), variant: attention ? 'warn' : 'ok' },
    ];
  });

  /**
   * Usage per space id, over the last 7 days, from ONE request.
   *
   * A week, not a day: usefulness is a question about a habit, and a space queried every Monday reads as dead
   * in a 24-hour window. Empty until it lands, and empty forever for a non-admin — the column then shows an em
   * dash rather than an error, because a missing comparison is not a broken page.
   */
  activity = signal<Map<string, SpaceActivity>>(new Map());

  activityFor(spaceId: string): SpaceActivity | undefined {
    return this.activity().get(spaceId);
  }

  /** Answered recalls as a percentage, or null when the space was never asked anything — see the sort. */
  answerRate(use: SpaceActivity | undefined): number | null {
    if (!use || use.recall === 0) return null;
    return Math.round((use.answered / use.recall) * 100);
  }

  spaceSearch = signal('');
  sortMode = signal<'custom' | 'az' | 'za' | 'usage-desc' | 'usage-asc' | 'calls-desc' | 'answers-asc'>('custom');
  sortedSpaces = computed(() => {
    const list = this.store.spaces();
    const sorted = (() => {
      switch (this.sortMode()) {
        case 'az':         return [...list].sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
        case 'za':         return [...list].sort((a, b) => b.label.localeCompare(a.label, undefined, { sensitivity: 'base' }));
        case 'usage-desc': return [...list].sort((a, b) => (b.usageGiB ?? 0) - (a.usageGiB ?? 0));
        case 'usage-asc':  return [...list].sort((a, b) => (a.usageGiB ?? 0) - (b.usageGiB ?? 0));
        // Busiest first — demand, which is only half the answer, so the column shows the rate beside it.
        case 'calls-desc': return [...list].sort((a, b) => (this.activityFor(b.id)?.calls ?? 0) - (this.activityFor(a.id)?.calls ?? 0));
        // WORST answer rate first, and only among spaces that were actually asked something. This is the
        // ordering that finds a content gap: a space fielding questions and returning nothing. A space nobody
        // queries has no rate at all and sorts last rather than looking like the worst offender.
        case 'answers-asc': return [...list].sort((a, b) => {
          const ra = this.answerRate(this.activityFor(a.id)); const rb = this.answerRate(this.activityFor(b.id));
          if (ra === null && rb === null) return 0;
          if (ra === null) return 1;
          if (rb === null) return -1;
          return ra - rb;
        });
        default:           return list;
      }
    })();
    const q = this.spaceSearch().trim().toLowerCase();
    if (!q) return sorted;
    // Purpose, not the deprecated `description` alias: it is the field the settings dialog edits, so
    // it is the text an operator remembers writing and would search for.
    return sorted.filter(s =>
      s.label.toLowerCase().includes(q) ||
      s.id.toLowerCase().includes(q) ||
      (s.meta?.purpose ?? '').toLowerCase().includes(q),
    );
  });

  showCreateDialog = signal(false);

  /** Tracks the kt/typeName target for per-type import. */

  ngOnInit(): void {
    this.store.load();
    this.loadActivity();
  }

  /**
   * One request for every space's usage. Admin-only server-side, so a non-admin simply gets nothing and the
   * column shows an em dash — a missing comparison is not a broken page, and an error toast for a panel nobody
   * asked to see would be worse than silence.
   */
  private loadActivity(): void {
    this.spacesApi.listSpaceActivity(7 * 24).subscribe({
      next: r => this.activity.set(new Map((r.spaces ?? []).map(a => [a.space, a]))),
      error: () => this.activity.set(new Map()),
    });
  }

  storageInfo(s: Space): { pct: number; label: string; cls: string } {
    const used = s.usageGiB ?? 0;
    const max  = s.maxGiB;
    if (!max && !used) return { pct: 0, label: '—', cls: 'ok' };
    if (!max)          return { pct: 0, label: this.fmtGiB(used), cls: 'ok' };
    const pct = Math.min(100, Math.round(used / max * 100));
    return { pct, label: `${this.fmtGiB(used)} / ${max} GiB`, cls: pct > 90 ? 'danger' : pct > 70 ? 'warn' : 'ok' };
  }

  fmtGiB(gib: number): string {
    if (gib < 0.001) return `${Math.round(gib * 1024)} MB`;
    return `${gib.toFixed(2)} GiB`;
  }

  // ── Unsaved-changes guard (U4) ─────────────────────────────────────────────

  /** CanDeactivate hook: block leaving the Spaces route while the editor has unsaved edits. */
  canLeave(): boolean | Promise<boolean> {
    // The prompt lives on the service now: the pop-up's (X) needs the identical question, and two
    // copies of "are you sure you want to lose these edits" is two places for the answer to drift.
    // This hook stays here — a modal openable from two pages must not own either page's guard.
    return this.state.confirmDiscardIfDirty();
  }

  /** Native prompt on reload/tab-close while dirty — EventSource-style dialogs aren't allowed here. */
  @HostListener('window:beforeunload', ['$event'])
  onBeforeUnload(e: BeforeUnloadEvent): void {
    if (this.state.isDirty()) { e.preventDefault(); e.returnValue = ''; }
  }

  // ── Schema export / import ─────────────────────────────────────────────────

  // ── Per-type export / import ───────────────────────────────────────────────

  // ── Library: save a type to library ───────────────────────────────────────

  // ── Library: import from library ──────────────────────────────────────────

  /** kt/typeName context for the open library picker */

}
