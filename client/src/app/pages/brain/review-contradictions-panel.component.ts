import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import type { ContradictionRecord } from '../../core/api.types';
import { ErrorStateComponent } from '../../shared/error-state.component';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { RelativeTimeComponent } from '../../shared/relative-time.component';
import { StatusPillComponent } from '../../shared/status-pill.component';
import { SummaryStripComponent, type SummaryItem } from '../../shared/summary-strip.component';
import { ReviewContradictionsState } from './review-contradictions-state';
import { scorePct, scoreVariant } from './review-score';

/**
 * The Contradictions tab panel of Review: the intro, its own status and scan strip, and the list or its loading, failed and empty states
 * (moved out of the Review tab by Q-391, as the Forks panel was). The Review tab hosts it and owns the tab and what Duplicates shares with
 * it: the search box and the record-type filter reach it as inputs, and it hands a changed search back by `queryChange`. `rows` is the list
 * AFTER those shared filters, so the filter logic stays in one place; the list as loaded, the actions and the scan are the state's.
 *
 * Order matters in the states: a failed load is checked before the empty state, so a server that did not answer never reads as "no
 * contradictions", and the empty states go narrowest cause first.
 */
@Component({
  selector: 'app-review-contradictions-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, TranslocoPipe, PhIconComponent, StatusPillComponent, RelativeTimeComponent, ErrorStateComponent, SummaryStripComponent],
  styles: [`
    :host { display: block; }
    .intro { color: var(--text-muted); font-size: 13px; margin: 0 0 16px; }
    .strip-ctl { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .strip-ctl select { font-size: 13px; padding: 4px 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-primary); color: var(--text-primary); }
    .dup-search { display: inline-flex; align-items: center; gap: 6px; padding: 3px 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-primary); color: var(--text-muted); }
    .dup-search input { border: 0; background: transparent; color: var(--text-primary); font-size: 13px; outline: none; width: 150px; }

    .dup-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 12px; margin-top: 16px; }
    .dup-card { border: 1px solid var(--border); border-radius: 10px; background: var(--bg-surface); padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
    .dup-card-h { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; }
    .dup-type { color: var(--text-secondary); font-family: var(--font-mono); font-size: 11px; }
    .dup-when { color: var(--text-muted); font-size: 11px; margin-left: auto; }

    .conf { display: inline-flex; align-items: center; gap: 6px; }
    .conf-track { width: 54px; height: 6px; border-radius: 3px; background: var(--bg-elevated); overflow: hidden; }
    .conf-fill { height: 100%; border-radius: 3px; transition: width .3s ease; }
    .conf-fill.high { background: var(--accent); }
    .conf-fill.mid  { background: var(--info); }
    .conf-fill.low  { background: var(--text-muted); }
    .conf-pct { font-size: 11px; font-variant-numeric: tabular-nums; color: var(--text-secondary); }

    .dup-ab { display: grid; grid-template-columns: 1fr auto 1fr; gap: 8px; align-items: stretch; }
    .dup-rec { border: 1px solid var(--border-muted); border-radius: 8px; padding: 8px 9px; background: var(--bg-primary); min-width: 0; }
    .dup-rec-l { font-size: 10px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: .06em; margin-bottom: 3px; }
    .dup-rec-txt { font-size: 12px; white-space: pre-wrap; word-break: break-word; color: var(--text-primary); }
    .dup-rec.b .dup-rec-txt { color: var(--text-secondary); }
    .dup-vs { display: flex; align-items: center; color: var(--text-muted); font-size: 11px; font-style: italic; }

    .con-fields { list-style: none; margin: 0 0 8px; padding: 0; display: flex; flex-direction: column; gap: 4px; }
    .con-fields li { display: flex; align-items: baseline; gap: 7px; font-size: 12px; flex-wrap: wrap; }
    .con-key { font-family: var(--font-mono, monospace); font-size: 11px; color: var(--text-muted); }
    .con-a, .con-b { font-weight: 600; color: var(--text-primary); }
    .con-sep { color: var(--text-muted); font-style: italic; font-size: 11px; }

    .dup-actions { display: flex; gap: 8px; justify-content: flex-end; align-items: center; flex-wrap: wrap; }

    /* Keep A / Keep B. Deliberately NOT btn-danger: nothing is deleted — the loser stays, marked as
       overtaken — so a destructive colour would misdescribe the action. */
    .keep-group { display: flex; gap: 6px; margin-right: auto; }
    /* The full records, expanded on demand. Collapsed by default because the summary is enough to triage
       most pairs, and a wall of two full records per card is what stops a queue being read at all. */
    /* An expanded card takes the whole row. Two full records inside a 340px grid cell wrap into a column of
       three-word lines, which is technically "in full" and unreadable in practice. */
    .dup-card.expanded { grid-column: 1 / -1; }
    .rec-full { margin-top: 6px; border-top: 1px dashed var(--border-muted); padding-top: 6px; }
    .rec-full pre { margin: 0; font-size: 11px; line-height: 1.45; white-space: pre-wrap; word-break: break-word;
      color: var(--text-secondary); font-family: var(--font-mono, monospace); max-height: 260px; overflow: auto; }
    .rec-full .rec-err { font-size: 11px; color: var(--danger); }
    .superseded-note { font-size: 11px; color: var(--text-muted); }
    .resolve-note summary { cursor: pointer; }
    .kept-badge { font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
    .kept-badge.win { color: var(--success); }
    .kept-badge.lose { color: var(--text-muted); }
  `],
  template: `
    <section role="tabpanel" id="review-panel-contradictions" aria-labelledby="review-tab-contradictions">
      <p class="intro">{{ 'review.contradictions.intro' | transloco }}</p>

      <!-- Its own strip rather than one lifted above the tabs: the search box IS shared (same signal as
           Duplicates), but the status piles are not the same set — contradictions have a resolved pile
           and duplicates do not — so a single control would have to offer an option meaning nothing on
           one side. Sharing it would be a worse lie than repeating fifteen lines of markup. -->
      <app-summary-strip [items]="summaryItems()">
        <div class="strip-ctl">
          <label class="dup-search">
            <ph-icon name="magnifying-glass" [size]="14"/>
            <input type="search" [ngModel]="query()" (ngModelChange)="queryChange.emit($event)"
              [placeholder]="'duplicates.searchPlaceholder' | transloco"
              [attr.aria-label]="'duplicates.searchPlaceholder' | transloco" />
          </label>
          <select [(ngModel)]="state().statusFilter" (change)="state().load(spaceId())"
            [attr.aria-label]="'duplicates.statusFilterAria' | transloco">
            <option value="open">{{ 'duplicates.status.open' | transloco }}</option>
            <option value="dismissed">{{ 'duplicates.status.dismissed' | transloco }}</option>
            <option value="resolved">{{ 'duplicates.status.resolved' | transloco }}</option>
            <option value="all">{{ 'duplicates.status.all' | transloco }}</option>
          </select>
          <button class="btn btn-sm btn-secondary" (click)="state().scan(spaceId())" [disabled]="state().scanning()">
            @if (state().scanning()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }
            {{ 'duplicates.scanNow' | transloco }}
          </button>
        </div>
      </app-summary-strip>

      @if (state().loading()) {
        <div class="loading-overlay"><span class="spinner"></span></div>
      } @else if (state().error() !== null) {
        <app-error-state [message]="'review.contradictions.loadError' | transloco" [reason]="state().error() ?? ''"
                         (retry)="state().load(spaceId())" />
      } @else if (rows().length === 0) {
        <div class="empty-state">
          <div class="empty-state-icon"><ph-icon name="warning" [size]="48"/></div>
          <!-- Four different reasons for an empty list, and they used to share one message which
               asserted the most alarming of them. Narrowest cause first. -->
          @if (query().trim() && state().rows().length) {
            <h3>{{ 'duplicates.noMatches.title' | transloco }}</h3>
            <p>{{ 'duplicates.noMatches.body' | transloco }}</p>
          } @else if (typeFilter() !== 'all' && state().rows().length) {
            <!-- Distinct from "nothing to review": the queue is not empty, this filter is. -->
            <h3>{{ 'review.typeFilter.noneOfType' | transloco }}</h3>
            <p>{{ 'review.typeFilter.noneOfTypeBody' | transloco }}</p>
          } @else if (state().statusFilter !== 'open') {
            <!-- An empty dismissed or resolved pile is not a finding about the space at all. -->
            <h3>{{ 'review.contradictions.noneWithStatus' | transloco }}</h3>
            <p>{{ 'review.contradictions.noneWithStatusBody' | transloco }}</p>
          } @else if (state().nliConfigured() === false) {
            <!-- No judge configured — so say what that costs and what still runs, rather than "detection
                 is not running". The deterministic pass runs with no model at all. -->
            <h3>{{ 'review.contradictions.structuredOnlyTitle' | transloco }}</h3>
            <p>{{ 'review.contradictions.structuredOnlyBody' | transloco }}</p>
          } @else {
            <!-- Nothing found. The body states only that; the extra line claiming BOTH passes ran is
                 added only when the server actually said so, never on an unknown. -->
            <h3>{{ 'review.contradictions.cleanTitle' | transloco }}</h3>
            <p>{{ 'review.contradictions.cleanBody' | transloco }}</p>
            @if (state().nliConfigured() === true) {
              <p>{{ 'review.contradictions.judgeRan' | transloco }}</p>
            }
          }
        </div>
      } @else {
        <div class="dup-grid">
          @for (c of rows(); track c.id) {
            <div class="dup-card" [class.expanded]="state().expanded() === c.id">
              <div class="dup-card-h">
                <span class="dup-type">{{ c.type }}</span>
                <!-- The basis, never a bare number: a deterministic field conflict and a model's opinion
                     are different kinds of claim, and a reviewer needs to tell them apart at a glance. -->
                @if (c.basis === 'structured-field') {
                  <app-status-pill variant="warn">{{ 'review.contradictions.basis.structured' | transloco }}</app-status-pill>
                } @else {
                  <app-status-pill variant="off">{{ 'review.contradictions.basis.nli' | transloco }}</app-status-pill>
                  <span class="conf" [attr.title]="'review.contradictions.confidence' | transloco">
                    <span class="conf-track"><span class="conf-fill" [class]="scoreVariant(c.confidence)" [style.width.%]="scorePct(c.confidence)"></span></span>
                    <span class="conf-pct">{{ scorePct(c.confidence) }}%</span>
                  </span>
                }
                @if (c.status !== 'open') {
                  <app-status-pill [variant]="c.status === 'resolved' ? 'ok' : 'off'">{{ ('duplicates.status.' + c.status) | transloco }}</app-status-pill>
                }
                <span class="dup-when"><app-relative-time [value]="c.detectedAt"/></span>
              </div>

              <!-- A structured verdict can NAME the disagreement; say what it is rather than asserting one. -->
              @if (c.fields?.length) {
                <ul class="con-fields">
                  @for (f of c.fields; track f.key) {
                    <li><span class="con-key">{{ f.key }}</span>
                      <span class="con-a">{{ f.aValue }}</span>
                      <span class="con-sep">{{ 'review.contradictions.versus' | transloco }}</span>
                      <span class="con-b">{{ f.bValue }}</span></li>
                  }
                </ul>
              }

              <div class="dup-ab">
                <div class="dup-rec">
                  <div class="dup-rec-l">
                    {{ 'duplicates.table.recordA' | transloco }}
                    <!-- On a settled pair, say which side won where the reviewer is already looking. -->
                    @if (c.supersededId) {
                      <span class="kept-badge" [class.win]="c.supersededId !== c.aId" [class.lose]="c.supersededId === c.aId">
                        {{ (c.supersededId === c.aId ? 'review.contradictions.superseded' : 'review.contradictions.kept') | transloco }}
                      </span>
                    }
                  </div>
                  <div class="dup-rec-txt">{{ c.aSummary }}</div>
                  @if (state().expanded() === c.id) {
                    <div class="rec-full">
                      @if (state().fullA(); as full) { <pre>{{ full }}</pre> } @else { <span class="rec-err">{{ state().fullError() ?? ('common.loading' | transloco) }}</span> }
                    </div>
                  }
                </div>
                <div class="dup-vs">{{ 'review.contradictions.versus' | transloco }}</div>
                <div class="dup-rec b">
                  <div class="dup-rec-l">
                    {{ 'duplicates.table.recordB' | transloco }}
                    @if (c.supersededId) {
                      <span class="kept-badge" [class.win]="c.supersededId !== c.bId" [class.lose]="c.supersededId === c.bId">
                        {{ (c.supersededId === c.bId ? 'review.contradictions.superseded' : 'review.contradictions.kept') | transloco }}
                      </span>
                    }
                  </div>
                  <div class="dup-rec-txt">{{ c.bSummary }}</div>
                  @if (state().expanded() === c.id) {
                    <div class="rec-full">
                      @if (state().fullB(); as full) { <pre>{{ full }}</pre> } @else { <span class="rec-err">{{ state().fullError() ?? ('common.loading' | transloco) }}</span> }
                    </div>
                  }
                </div>
              </div>

              @if (c.resolution === 'superseded' && c.resolvedBy) {
                <!-- "kept and marked" only when a mark was set: a loser that was gone (loserGone) was not marked. -->
                <div class="superseded-note">{{ (state().loserWasGone(c) ? 'review.contradictions.decidedByOnly' : 'review.contradictions.decidedBy') | transloco: { who: c.resolvedBy } }}</div>
              }
              @if (c.resolving) {
                <div class="superseded-note">{{ state().resolvingText(c) }}</div>
              }
              <!-- What the resolve could not do as asked, in the reviewer's words; the server's sentence is the disclosure. -->
              @for (n of c.notes ?? []; track n.code) {
                <details class="superseded-note resolve-note">
                  <summary>{{ state().resolveNoteText(n) }}</summary>
                  {{ n.detail }}
                </details>
              }

              <div class="dup-actions">
                @if (c.status === 'dismissed') {
                  <button class="btn btn-sm btn-secondary" type="button" [disabled]="state().busy() === c.id" (click)="state().reopen(spaceId(), c)">
                    {{ 'duplicates.reRate' | transloco }}
                  </button>
                } @else if (c.status === 'open') {
                  <!-- Keep A / Keep B — the decision a reviewer actually makes about two disagreeing
                       records, which neither "resolved by edit" (nothing was corrected) nor "link as
                       contradiction" (they drew an edge by hand) could express. NOTHING is deleted: the
                       loser stays, marked as overtaken, which is why these are not destructive buttons.
                       NO BACKTICKS in this template — one kills the whole string and the error points at
                       the @Component decorator. -->
                  <div class="keep-group">
                    <button class="btn btn-sm btn-secondary" type="button" [disabled]="state().busy() === c.id" (click)="state().keepSide(spaceId(), c, 'a')">
                      {{ 'review.contradictions.action.keepA' | transloco }}
                    </button>
                    <button class="btn btn-sm btn-secondary" type="button" [disabled]="state().busy() === c.id" (click)="state().keepSide(spaceId(), c, 'b')">
                      {{ 'review.contradictions.action.keepB' | transloco }}
                    </button>
                    <button class="btn btn-sm btn-ghost" type="button" (click)="state().toggleFull(c)"
                            [attr.aria-expanded]="state().expanded() === c.id">
                      {{ (state().expanded() === c.id ? 'review.contradictions.action.hideFull' : 'review.contradictions.action.showFull') | transloco }}
                    </button>
                  </div>
                  <button class="btn btn-sm btn-secondary" type="button" [disabled]="state().busy() === c.id" (click)="state().dismiss(spaceId(), c)">
                    {{ 'duplicates.dismiss' | transloco }}
                  </button>
                  <!-- Contradictions are never merged: both records are real and which is wrong is a
                       judgement call, so the reviewer records HOW they settled it. -->
                  <button class="btn btn-sm btn-secondary" type="button" [disabled]="state().busy() === c.id" (click)="state().resolve(spaceId(), c, 'edited')">
                    {{ 'review.contradictions.action.edited' | transloco }}
                  </button>
                  <button class="btn btn-sm btn-secondary" type="button" [disabled]="state().busy() === c.id" (click)="state().resolve(spaceId(), c, 'linked')">
                    {{ 'review.contradictions.action.linked' | transloco }}
                  </button>
                }
              </div>
            </div>
          }
        </div>
      }
    </section>
  `,
})
export class ReviewContradictionsPanelComponent {
  private readonly transloco = inject(TranslocoService);

  readonly state = input.required<ReviewContradictionsState>();
  /** The contradictions AFTER the tab's shared search and record-type filter; the state's `rows` is the list as loaded. */
  readonly rows = input.required<ContradictionRecord[]>();
  readonly spaceId = input.required<string>();
  /** The tab's search box, shared with Duplicates; a change is handed back by `queryChange`. */
  readonly query = input.required<string>();
  readonly queryChange = output<string>();
  /** The tab's record-type filter, shared with Duplicates; read here only to say which empty this is. */
  readonly typeFilter = input.required<string>();

  protected readonly scorePct = scorePct;
  protected readonly scoreVariant = scoreVariant;

  /** The same rollup Duplicates gets: what still needs attention, and how much of it is on screen. */
  protected readonly summaryItems = computed<SummaryItem[]>(() => {
    const open = this.state().rows().filter(r => r.status === 'open').length;
    return [
      { label: this.transloco.translate('duplicates.summary.open'), value: String(open), variant: open ? 'warn' : 'ok' },
      { label: this.transloco.translate('duplicates.summary.shown'), value: String(this.rows().length) },
    ];
  });
}
