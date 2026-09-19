import { Component, inject, signal, computed, OnInit, OnChanges, SimpleChanges, Input, Output, EventEmitter } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DuplicateRecord, ContradictionRecord, CompletenessCheck } from '../../core/api.types';
import { DuplicatesApi } from '../../core/duplicates-api.service';
import { ContradictionsApi } from '../../core/contradictions-api.service';
import { SpacesApi } from '../../core/spaces-api.service';
import { BrainApi } from '../../core/brain-api.service';
import type { CollectionTab } from './brain-tabs';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { SummaryStripComponent, type SummaryItem } from '../../shared/summary-strip.component';
import { StatusPillComponent } from '../../shared/status-pill.component';
import { RelativeTimeComponent } from '../../shared/relative-time.component';
import { ErrorStateComponent } from '../../shared/error-state.component';
import { httpErrorReason } from '../../core/http-error';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { ToastService } from '../../core/toast.service';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';

@Component({
  selector: 'app-review-tab',
  standalone: true,
  imports: [FormsModule, PhIconComponent, TranslocoPipe, SummaryStripComponent, StatusPillComponent, RelativeTimeComponent, ErrorStateComponent],
  styles: [`
    .page-title { margin: 0 0 4px; font-size: 18px; }
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
    .dup-resolved { font-size: 12px; color: var(--success); text-align: right; }

    /* Keep A / Keep B. Deliberately NOT btn-danger: nothing is deleted — the loser stays, marked as
       overtaken — so a destructive colour would misdescribe the action. */
    .keep-group { display: flex; gap: 6px; margin-right: auto; }
    .keep-hint { font-size: 11px; color: var(--text-muted); font-style: italic; }
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
    .kept-badge { font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
    .kept-badge.win { color: var(--success); }
    .kept-badge.lose { color: var(--text-muted); }

    /* Record-type filter — sits under the sub-tabs because it applies to whichever one is open. */
    .type-filter { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 12px 0 0; font-size: 13px; }
    .type-filter label { color: var(--text-muted); font-size: 12px; }
    /* width/flex are explicit: a global full-width rule on select otherwise stretches this across the
       whole page and pushes the label onto its own line. */
    .type-filter select { font-size: 13px; padding: 4px 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-primary); color: var(--text-primary); width: auto; min-width: 140px; flex: 0 0 auto; }
    .cap-note { font-size: 11px; color: var(--warning); }

    /* Suggestions. Reuses .dup-card wholesale — a finding is a finding, and a second card language
       would make the same queue look like two products. */
    .sug-score { display: flex; align-items: baseline; gap: 10px; margin: 16px 0 4px; }
    .sug-score-v { font-size: 26px; font-weight: 700; font-family: var(--font-mono, monospace);
      font-variant-numeric: tabular-nums; line-height: 1; }
    .sug-score-v.good { color: var(--success); } .sug-score-v.mid { color: var(--warning); } .sug-score-v.bad { color: var(--error); }
    .sug-score-l { font-size: 12.5px; color: var(--text-secondary); }
    .sug-body { display: flex; flex-direction: column; gap: 7px; }
    .sug-title { font-size: 13.5px; font-weight: 600; color: var(--text-primary); }
    .sug-why { font-size: 12px; color: var(--text-secondary); line-height: 1.45; }
    .sug-samples { list-style: none; margin: 2px 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 5px; }
    .sug-samples li { font-family: var(--font-mono, monospace); font-size: 11px; padding: 2px 7px;
      border-radius: 999px; background: var(--bg-elevated); border: 1px solid var(--border-muted);
      color: var(--text-primary); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sug-more { font-size: 11px; color: var(--text-muted); }
    .sug-passing { margin-top: 18px; font-size: 12.5px; color: var(--text-secondary); }
    .sug-passing summary { cursor: pointer; }
    .sug-passing ul { list-style: none; margin: 9px 0 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
    .sug-passing li { display: flex; align-items: flex-start; gap: 7px; }
    .sug-passing ph-icon { color: var(--success); flex: none; margin-top: 2px; }
  `],
  template: `
    <h2 class="page-title">{{ 'review.title' | transloco }}</h2>

    <!-- Sub-tabs, not a compact toggle: this is the space's record-QA queue and it will grow past two
         views (contradictions now, orphans / schema violations later). A full tab strip keeps them all
         discoverable and reuses the same affordance as every other tab in the app, rather than hiding
         the second view behind a control people have to notice. -->
    <nav class="tabs" role="tablist" [attr.aria-label]="'review.title' | transloco">
      @for (t of SUBTABS; track t) {
        <button class="tab" type="button" role="tab" [class.active]="sub() === t"
          [attr.aria-selected]="sub() === t" [attr.id]="'review-tab-' + t"
          [attr.aria-controls]="'review-panel-' + t" (click)="sub.set(t)">
          {{ 'review.sub.' + t | transloco }}
        </button>
      }
    </nav>

    <!-- Record-TYPE filter, shared by both sub-tabs. The tabs are kinds of finding; this is the record
         type. Keeping them as separate axes is what avoids a duplicates×type / contradictions×type matrix.
         Only shown when the loaded rows actually span more than one type — a control with one real choice
         is noise. -->
    @if (showTypeFilter()) {
      <div class="type-filter">
        <label [attr.for]="'review-type-filter'">{{ 'review.typeFilter.label' | transloco }}</label>
        <select id="review-type-filter" [ngModel]="typeFilter()" (ngModelChange)="typeFilter.set($event)"
          [attr.aria-label]="'review.typeFilter.label' | transloco">
          <option value="all">{{ 'review.typeFilter.all' | transloco }}</option>
          @for (t of typeOptions(); track t) {
            <option [value]="t">{{ t }}</option>
          }
        </select>
        <!-- The lists are capped server-side with no pagination, so a filter over them can only ever mean
             "…among the first 500". Saying so beats letting the filter imply completeness. -->
        @if (listCapped()) {
          <span class="cap-note">{{ 'review.typeFilter.capped' | transloco }}</span>
        }
      </div>
    }

    @if (sub() === 'suggestions') {
      <section role="tabpanel" id="review-panel-suggestions" aria-labelledby="review-tab-suggestions">
        <p class="intro">{{ 'review.suggestions.intro' | transloco }}</p>

        @if (compLoading()) {
          <div class="loading-overlay"><span class="spinner"></span></div>
        } @else if (compError()) {
          <!-- Never render a failed load as a clean space: "nothing to fix" and "we could not look" are
               opposite answers and must not share a screen. -->
          <div class="alert alert-warning" style="margin-top:16px;">{{ 'review.suggestions.loadError' | transloco }}</div>
        } @else {
          @if (compScore(); as score) {
            <div class="sug-score">
              <span class="sug-score-v" [class.good]="score >= 85" [class.mid]="score >= 60 && score < 85" [class.bad]="score < 60">{{ score }}%</span>
              <span class="sug-score-l">{{ 'review.suggestions.scoreLabel' | transloco: { count: compChecks().length } }}</span>
            </div>
          }

          @if (failingChecks().length) {
            <div class="dup-grid">
              @for (c of failingChecks(); track c.id + c.scope) {
                <div class="dup-card">
                  <div class="dup-card-h">
                    <app-status-pill [variant]="c.severity === 'warn' ? 'warn' : 'off'">{{ 'review.suggestions.severity.' + c.severity | transloco }}</app-status-pill>
                    <span class="dup-type">{{ 'brain.overview.comp.scope.' + c.scope | transloco }}</span>
                    <span class="dup-when">{{ 'review.suggestions.pointsLost' | transloco: { lost: (c.weight - c.earned).toFixed(1), weight: c.weight } }}</span>
                  </div>

                  <div class="sug-body">
                    <div class="sug-title">{{ 'brain.overview.comp.check.' + c.id | transloco: { affected: c.affected, total: c.total, scope: ('brain.overview.comp.scope.' + c.scope | transloco) } }}</div>
                    <div class="sug-why">{{ 'review.suggestions.why.' + c.id | transloco }}</div>
                    <div class="conf">
                      <span class="conf-track"><span class="conf-fill" [class]="scoreVariant(c.earned / c.weight)" [style.width.%]="earnedPct(c)"></span></span>
                      <span class="conf-pct">{{ earnedPct(c) }}%</span>
                    </div>

                    @if (c.sample.length) {
                      <ul class="sug-samples">
                        @for (s of c.sample; track s) {
                          <li [title]="s">{{ sampleLabel(c, s) }}</li>
                        }
                      </ul>
                      @if (c.affected > c.sample.length) {
                        <!-- The sample is capped server-side. Say so rather than letting five entries
                             read as the whole finding. -->
                        <div class="sug-more">{{ 'review.suggestions.andMore' | transloco: { more: c.affected - c.sample.length } }}</div>
                      }
                    }
                  </div>

                  @if (c.targetTab; as tab) {
                    <div class="dup-actions">
                      <button class="btn btn-sm btn-secondary sug-go" type="button" (click)="openTab.emit(tab)">
                        {{ 'review.suggestions.open' | transloco: { tab: ('brain.tab.' + tab | transloco) } }}
                      </button>
                    </div>
                  }
                </div>
              }
            </div>
          } @else if (compChecks().length) {
            <div class="empty-state">
              <div class="empty-state-icon"><ph-icon name="check-circle" [size]="48"/></div>
              <h3>{{ 'review.suggestions.clean.title' | transloco }}</h3>
              <p>{{ 'review.suggestions.clean.body' | transloco }}</p>
            </div>
          } @else {
            <!-- No check applied at all. Not a perfect space — an unmeasurable one. -->
            <div class="empty-state">
              <div class="empty-state-icon"><ph-icon name="info" [size]="48"/></div>
              <h3>{{ 'review.suggestions.none.title' | transloco }}</h3>
              <p>{{ 'review.suggestions.none.body' | transloco }}</p>
            </div>
          }

          @if (passingChecks().length) {
            <details class="sug-passing">
              <summary>{{ 'review.suggestions.passing' | transloco: { count: passingChecks().length } }}</summary>
              <ul>
                @for (c of passingChecks(); track c.id + c.scope) {
                  <li><ph-icon name="check-circle" [size]="13"/>{{ 'brain.overview.comp.check.' + c.id | transloco: { affected: c.affected, total: c.total, scope: ('brain.overview.comp.scope.' + c.scope | transloco) } }}</li>
                }
              </ul>
            </details>
          }

          @if (compTruncated()) {
            <div class="cap-note" style="margin-top:12px;">{{ 'brain.overview.comp.truncated' | transloco }}</div>
          }
        }
      </section>
    } @else if (sub() === 'contradictions') {
      <section role="tabpanel" id="review-panel-contradictions" aria-labelledby="review-tab-contradictions">
        <p class="intro">{{ 'review.contradictions.intro' | transloco }}</p>

        <!-- Its own strip rather than one lifted above the tabs: the search box IS shared (same signal as
             Duplicates), but the status piles are not the same set — contradictions have a resolved pile
             and duplicates do not — so a single control would have to offer an option meaning nothing on
             one side. Sharing it would be a worse lie than repeating fifteen lines of markup. -->
        <app-summary-strip [items]="conSummaryItems()">
          <div class="strip-ctl">
            <label class="dup-search">
              <ph-icon name="magnifying-glass" [size]="14"/>
              <input type="search" [ngModel]="query()" (ngModelChange)="query.set($event)"
                [placeholder]="'duplicates.searchPlaceholder' | transloco"
                [attr.aria-label]="'duplicates.searchPlaceholder' | transloco" />
            </label>
            <select [(ngModel)]="conStatusFilter" (change)="loadContradictions()"
              [attr.aria-label]="'duplicates.statusFilterAria' | transloco">
              <option value="open">{{ 'duplicates.status.open' | transloco }}</option>
              <option value="dismissed">{{ 'duplicates.status.dismissed' | transloco }}</option>
              <option value="resolved">{{ 'duplicates.status.resolved' | transloco }}</option>
              <option value="all">{{ 'duplicates.status.all' | transloco }}</option>
            </select>
            <button class="btn btn-sm btn-secondary" (click)="scanContradictions()" [disabled]="conScanning()">
              @if (conScanning()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }
              {{ 'duplicates.scanNow' | transloco }}
            </button>
          </div>
        </app-summary-strip>

        @if (conLoading()) {
          <div class="loading-overlay"><span class="spinner"></span></div>
        } @else if (conError() !== null) {
          <app-error-state [message]="'review.contradictions.loadError' | transloco" [reason]="conError() ?? ''"
                           (retry)="loadContradictions()" />
        } @else if (conFilteredRows().length === 0) {
          <div class="empty-state">
            <div class="empty-state-icon"><ph-icon name="warning" [size]="48"/></div>
            <!-- Four different reasons for an empty list, and they used to share one message which
                 asserted the most alarming of them. Narrowest cause first. -->
            @if (query().trim() && conRows().length) {
              <h3>{{ 'duplicates.noMatches.title' | transloco }}</h3>
              <p>{{ 'duplicates.noMatches.body' | transloco }}</p>
            } @else if (typeFilter() !== 'all' && conRows().length) {
              <!-- Distinct from "nothing to review": the queue is not empty, this filter is. -->
              <h3>{{ 'review.typeFilter.noneOfType' | transloco }}</h3>
              <p>{{ 'review.typeFilter.noneOfTypeBody' | transloco }}</p>
            } @else if (conStatusFilter !== 'open') {
              <!-- An empty dismissed or resolved pile is not a finding about the space at all. -->
              <h3>{{ 'review.contradictions.noneWithStatus' | transloco }}</h3>
              <p>{{ 'review.contradictions.noneWithStatusBody' | transloco }}</p>
            } @else if (conNliConfigured() === false) {
              <!-- No judge configured — so say what that costs and what still runs, rather than "detection
                   is not running". The deterministic pass runs with no model at all. -->
              <h3>{{ 'review.contradictions.structuredOnlyTitle' | transloco }}</h3>
              <p>{{ 'review.contradictions.structuredOnlyBody' | transloco }}</p>
            } @else {
              <!-- Nothing found. The body states only that; the extra line claiming BOTH passes ran is
                   added only when the server actually said so, never on an unknown. -->
              <h3>{{ 'review.contradictions.cleanTitle' | transloco }}</h3>
              <p>{{ 'review.contradictions.cleanBody' | transloco }}</p>
              @if (conNliConfigured() === true) {
                <p>{{ 'review.contradictions.judgeRan' | transloco }}</p>
              }
            }
          </div>
        } @else {
          <div class="dup-grid">
            @for (c of conFilteredRows(); track c.id) {
              <div class="dup-card" [class.expanded]="expanded() === c.id">
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
                    @if (expanded() === c.id) {
                      <div class="rec-full">
                        @if (fullA(); as full) { <pre>{{ full }}</pre> } @else { <span class="rec-err">{{ fullError() ?? ('common.loading' | transloco) }}</span> }
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
                    @if (expanded() === c.id) {
                      <div class="rec-full">
                        @if (fullB(); as full) { <pre>{{ full }}</pre> } @else { <span class="rec-err">{{ fullError() ?? ('common.loading' | transloco) }}</span> }
                      </div>
                    }
                  </div>
                </div>

                @if (c.resolution === 'superseded' && c.resolvedBy) {
                  <div class="superseded-note">{{ 'review.contradictions.decidedBy' | transloco: { who: c.resolvedBy } }}</div>
                }

                <div class="dup-actions">
                  @if (c.status === 'dismissed') {
                    <button class="btn btn-sm btn-secondary" type="button" [disabled]="conBusy() === c.id" (click)="reopenContradiction(c)">
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
                      <button class="btn btn-sm btn-secondary" type="button" [disabled]="conBusy() === c.id" (click)="keepSide(c, 'a')">
                        {{ 'review.contradictions.action.keepA' | transloco }}
                      </button>
                      <button class="btn btn-sm btn-secondary" type="button" [disabled]="conBusy() === c.id" (click)="keepSide(c, 'b')">
                        {{ 'review.contradictions.action.keepB' | transloco }}
                      </button>
                      <button class="btn btn-sm btn-ghost" type="button" (click)="toggleFull(c)"
                              [attr.aria-expanded]="expanded() === c.id">
                        {{ (expanded() === c.id ? 'review.contradictions.action.hideFull' : 'review.contradictions.action.showFull') | transloco }}
                      </button>
                    </div>
                    <button class="btn btn-sm btn-secondary" type="button" [disabled]="conBusy() === c.id" (click)="dismissContradiction(c)">
                      {{ 'duplicates.dismiss' | transloco }}
                    </button>
                    <!-- Contradictions are never merged: both records are real and which is wrong is a
                         judgement call, so the reviewer records HOW they settled it. -->
                    <button class="btn btn-sm btn-secondary" type="button" [disabled]="conBusy() === c.id" (click)="resolveContradiction(c, 'edited')">
                      {{ 'review.contradictions.action.edited' | transloco }}
                    </button>
                    <button class="btn btn-sm btn-secondary" type="button" [disabled]="conBusy() === c.id" (click)="resolveContradiction(c, 'linked')">
                      {{ 'review.contradictions.action.linked' | transloco }}
                    </button>
                  }
                </div>
              </div>
            }
          </div>
        }
      </section>
    } @else {
    <section role="tabpanel" id="review-panel-duplicates" aria-labelledby="review-tab-duplicates">
    <p class="intro">{{ 'duplicates.intro' | transloco }}</p>

    <app-summary-strip [items]="summaryItems()">
      <div class="strip-ctl">
        <label class="dup-search">
          <ph-icon name="magnifying-glass" [size]="14"/>
          <input type="search" [ngModel]="query()" (ngModelChange)="query.set($event)"
            [placeholder]="'duplicates.searchPlaceholder' | transloco"
            [attr.aria-label]="'duplicates.searchPlaceholder' | transloco" />
        </label>
        <select [(ngModel)]="statusFilter" (change)="load()" [attr.aria-label]="'duplicates.statusFilterAria' | transloco">
          <option value="open">{{ 'duplicates.status.open' | transloco }}</option>
          <option value="dismissed">{{ 'duplicates.status.dismissed' | transloco }}</option>
          <option value="all">{{ 'duplicates.status.all' | transloco }}</option>
        </select>
        <button class="btn btn-sm btn-secondary" (click)="scan()" [disabled]="scanning()">
          @if (scanning()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }
          {{ 'duplicates.scanNow' | transloco }}
        </button>
      </div>
    </app-summary-strip>

    @if (loading()) {
      <div class="loading-overlay"><span class="spinner"></span></div>
    } @else if (error()) {
      <div class="alert alert-warning" style="margin-top:16px;">{{ 'duplicates.loadError' | transloco }}</div>
    } @else if (filteredRows().length === 0) {
      <div class="empty-state">
        <div class="empty-state-icon"><ph-icon name="check-circle" [size]="48"/></div>
        @if (query().trim() && rows().length) {
          <h3>{{ 'duplicates.noMatches.title' | transloco }}</h3>
          <p>{{ 'duplicates.noMatches.body' | transloco }}</p>
        } @else if (typeFilter() !== 'all' && rows().length) {
          <!-- The queue is not empty, this filter is — a distinction "nothing to review" would hide. -->
          <h3>{{ 'review.typeFilter.noneOfType' | transloco }}</h3>
          <p>{{ 'review.typeFilter.noneOfTypeBody' | transloco }}</p>
        } @else {
          <h3>{{ 'duplicates.empty.title' | transloco }}</h3>
          <p>{{ 'duplicates.empty.body' | transloco }}</p>
        }
      </div>
    } @else {
      <div class="dup-grid">
        @for (d of filteredRows(); track d.id) {
          <div class="dup-card">
            <div class="dup-card-h">
              <span class="dup-type">{{ d.type }}</span>
              <span class="conf" [attr.title]="'duplicates.confidence' | transloco">
                <span class="conf-track"><span class="conf-fill" [class]="scoreVariant(d.score)" [style.width.%]="scorePct(d.score)"></span></span>
                <span class="conf-pct">{{ scorePct(d.score) }}%</span>
              </span>
              @if (d.status !== 'open') {
                <app-status-pill [variant]="d.status === 'resolved' ? 'ok' : 'off'">{{ ('duplicates.status.' + d.status) | transloco }}</app-status-pill>
              }
              <span class="dup-when"><app-relative-time [value]="d.detectedAt"/></span>
            </div>

            <div class="dup-ab">
              <div class="dup-rec">
                <div class="dup-rec-l">{{ 'duplicates.table.recordA' | transloco }}</div>
                <div class="dup-rec-txt">{{ d.aSummary }}</div>
              </div>
              <div class="dup-vs">{{ 'duplicates.vs' | transloco }}</div>
              <div class="dup-rec b">
                <div class="dup-rec-l">{{ 'duplicates.table.recordB' | transloco }}</div>
                <div class="dup-rec-txt">{{ d.bSummary }}</div>
              </div>
            </div>

            @if (d.status === 'resolved') {
              @if (d.resolution) {
                <div class="dup-resolved">{{ ('duplicates.resolution.' + d.resolution) | transloco }}</div>
              }
            } @else if (d.status === 'dismissed') {
              <!-- A dismissed pair resurfaces on its own only if its content materially changes; this is
                   the manual way to bring it back for review sooner. -->
              <div class="dup-actions">
                <button class="btn btn-sm btn-secondary" (click)="reopen(d)" [disabled]="busy() === d.id">
                  <ph-icon name="arrows-clockwise" [size]="14" style="margin-right:4px;vertical-align:-2px;"/>{{ 'duplicates.reRate' | transloco }}
                </button>
              </div>
            } @else {
              <div class="dup-actions">
                @if (d.type === 'entity') {
                  <button class="btn btn-sm btn-primary" (click)="merge(d)" [disabled]="busy() === d.id">{{ 'duplicates.merge' | transloco }}</button>
                }
                <button class="btn btn-sm btn-secondary" (click)="dismiss(d)" [disabled]="busy() === d.id">
                  <ph-icon name="x" [size]="14" style="margin-right:4px;vertical-align:-2px;"/>{{ 'duplicates.dismiss' | transloco }}
                </button>
              </div>
            }
          </div>
        }
      </div>
    }
    </section>
    }
  `,
})
export class ReviewTabComponent implements OnInit, OnChanges {
  private contradictionsApi = inject(ContradictionsApi);
  readonly conRows = signal<ContradictionRecord[]>([]);
  readonly conLoading = signal(false);
  /**
   * Null until the contradictions load failed. The toast alone was not enough: it is transient, and
   * on a FIRST load `conRows()` is empty, so the page settled on "no contradictions — your brain is
   * consistent" while nobody had actually checked.
   */
  readonly conError = signal<string | null>(null);
  readonly conBusy = signal<string | null>(null);
  readonly conScanning = signal(false);

  /**
   * Which pile to show. Was **hardcoded to `open`**, which made `Dismiss` and both `Resolve` buttons
   * one-way: the API has supported `dismissed` / `resolved` / `all` all along, the UI simply never asked.
   * Three things were dead because of it — the status pill (rendered only when `status !== 'open'`), the
   * `re-rate` button (rendered only when `status === 'dismissed'`), and any chance of undoing a mis-click.
   */
  conStatusFilter: 'open' | 'dismissed' | 'resolved' | 'all' = 'open';

  /**
   * Whether the model-judged pass is among the ones that run, as reported by the server.
   *
   * `null` means NOT KNOWN, and is deliberately a third state rather than a default of `true`. Defaulting
   * would make the strongest available claim — "both passes have run and found nothing" — on the weakest
   * available evidence, which is the exact move that produced the bug this whole item is about. When it is
   * unknown the empty state says only what it can see: nothing was found.
   */
  readonly conNliConfigured = signal<boolean | null>(null);

  /** Load this space's contradictions. Called on init, on space switch, and after every action. */
  loadContradictions(): void {
    this.conLoading.set(true);
    this.conError.set(null);
    this.contradictionsApi.listContradictions(this.conStatusFilter, this.spaceId).subscribe({
      next: r => {
        this.conRows.set(r.contradictions);
        this.conNliConfigured.set(typeof r.nliConfigured === 'boolean' ? r.nliConfigured : null);
        this.conLoading.set(false);
      },
      // A load failure must not read as "no contradictions" — the empty state would be a lie. Surface it
      // and leave whatever was already on screen.
      error: (err) => {
        this.conError.set(httpErrorReason(err));
        this.conLoading.set(false);
        this.toast.error(this.transloco.translate('review.contradictions.loadError'));
      },
    });
  }

  dismissContradiction(c: ContradictionRecord): void {
    this.conBusy.set(c.id);
    this.contradictionsApi.dismissContradiction(c.id).subscribe({
      next: () => { this.conBusy.set(null); this.loadContradictions(); },
      error: () => { this.conBusy.set(null); this.toast.error(this.transloco.translate('duplicates.dismissError')); },
    });
  }

  reopenContradiction(c: ContradictionRecord): void {
    this.conBusy.set(c.id);
    this.contradictionsApi.reopenContradiction(c.id).subscribe({
      next: () => { this.conBusy.set(null); this.loadContradictions(); },
      error: () => { this.conBusy.set(null); this.toast.error(this.transloco.translate('duplicates.dismissError')); },
    });
  }

  resolveContradiction(c: ContradictionRecord, resolution: 'edited' | 'linked'): void {
    this.conBusy.set(c.id);
    this.contradictionsApi.resolveContradiction(c.id, resolution).subscribe({
      next: () => { this.conBusy.set(null); this.loadContradictions(); },
      error: () => { this.conBusy.set(null); this.toast.error(this.transloco.translate('duplicates.dismissError')); },
    });
  }

  // ── Keep A / Keep B ────────────────────────────────────────────────────────────────────────────────────
  //
  // The reviewer's real decision about two disagreeing records is "this one is right, that one is stale".
  // Neither existing resolution said it, so they were being recorded as `edited` (nothing was corrected) or
  // `linked` (nobody drew an edge). This names the loser and lets the server draw `supersedes` for an entity
  // pair — and nothing is deleted, which is the line between this and a duplicate merge.

  /** Which card has its full records expanded. One at a time: two full records is already a lot to read. */
  readonly expanded = signal<string | null>(null);
  readonly fullA = signal<string | null>(null);
  readonly fullB = signal<string | null>(null);
  readonly fullError = signal<string | null>(null);

  keepSide(c: ContradictionRecord, winner: 'a' | 'b'): void {
    this.conBusy.set(c.id);
    this.contradictionsApi.keepSide(c.id, winner).subscribe({
      next: (r) => {
        this.conBusy.set(null);
        /*
         * This branch used to announce that no edge had been drawn, for a pair that was not two entities.
         * 5.0 draws the edge for every pair kind, so that message could only ever have been a lie, and it
         * is replaced rather than deleted: the same place now surfaces the one outcome a reviewer must not
         * be left to assume.
         *
         * `markedRecord: false` means the decision was stored and the LOSING RECORD was not marked — so
         * the next search still returns both claims looking equally current, which is the state the whole
         * feature exists to end. Success stays silent; only this is worth a reviewer's attention.
         */
        if (r.note) this.toast.info(r.note); else if (r.resolution === 'superseded' && r.markedRecord === false) this.toast.error(this.transloco.translate('review.contradictions.notMarked'));
        this.loadContradictions();
      },
      error: () => { this.conBusy.set(null); this.toast.error(this.transloco.translate('duplicates.dismissError')); },
    });
  }

  /**
   * Show both records IN FULL, fetched on demand.
   *
   * The card carries one-line summaries, which is enough to triage most pairs and not enough to decide one:
   * picking a winner means reading both. Fetched on expand rather than with the list because a queue of
   * fifty cards would otherwise pull a hundred records nobody opened.
   */
  toggleFull(c: ContradictionRecord): void {
    if (this.expanded() === c.id) { this.expanded.set(null); return; }
    this.expanded.set(c.id);
    this.fullA.set(null); this.fullB.set(null); this.fullError.set(null);
    for (const [id, sink] of [[c.aId, this.fullA], [c.bId, this.fullB]] as const) {
      this.brainApi.getRecord(c.spaceId, c.type, id).subscribe({
        next: (rec) => sink.set(JSON.stringify(rec, null, 2)),
        // Named, not silent: a record that cannot be loaded is exactly the case where a reviewer must not
        // decide from the summary alone.
        error: () => this.fullError.set(this.transloco.translate('review.contradictions.fullError')),
      });
    }
  }

  /** Sub-views of the space's record-QA queue. Ordered as a reviewer meets them. */
  readonly SUBTABS = ['duplicates', 'contradictions', 'suggestions'] as const;
  readonly sub = signal<'duplicates' | 'contradictions' | 'suggestions'>('duplicates');

  /** The space's completeness tab jumps back into the Brain's own tabs; the shell owns that switch. */
  @Output() openTab = new EventEmitter<CollectionTab>();

  /** The space being reviewed. Required: this view is per-space now, never instance-wide. */
  @Input({ required: true }) spaceId = '';

  private duplicatesApi = inject(DuplicatesApi);
  private spacesApi = inject(SpacesApi);
  private brainApi = inject(BrainApi);
  private transloco = inject(TranslocoService);
  private toast = inject(ToastService);
  private confirmDialog = inject(ConfirmDialogService);

  loading = signal(true);
  error = signal(false);
  scanning = signal(false);
  busy = signal<string | null>(null);
  rows = signal<DuplicateRecord[]>([]);
  statusFilter: 'open' | 'dismissed' | 'all' = 'open';
  /** Free-text filter over the loaded list — a dismissed pile can grow large, so it is searchable. */
  query = signal('');

  /**
   * Record-type filter, shared by BOTH sub-tabs.
   *
   * The sub-tabs are kinds of FINDING (duplicates vs contradictions); this is the record TYPE. They are
   * orthogonal, which is exactly why type is not a third and fourth tab — that would produce a matrix
   * (duplicates×memory, contradictions×chrono, …) that grows badly. Sharing one signal across both panels
   * means "I am looking at chrono findings" survives a tab switch, rather than the filter silently meaning
   * something different on each side.
   */
  typeFilter = signal<string>('all');

  /**
   * The types actually present in the current sub-tab's loaded rows, so the control never offers a choice
   * that can only ever yield nothing. Derived from the UNFILTERED rows — deriving from the filtered list
   * would make every other option vanish the moment one was picked.
   */
  availableTypes = computed<string[]>(() => {
    const list: Array<{ type: string }> = this.sub() === 'contradictions' ? this.conRows() : this.rows();
    return [...new Set(list.map(r => r.type))].sort();
  });

  /**
   * Whether to render the control.
   *
   * Normally hidden when the queue is all one type — a filter with a single real choice is noise. But it
   * MUST stay visible whenever a filter is actually applied, even if this tab has one type or none: the
   * signal is shared across both sub-tabs, so filtering Duplicates to `memory` and switching to
   * Contradictions would otherwise hide the control while it was still constraining the list, leaving an
   * empty view and no way to clear it. Never hide a control that is currently narrowing what is on screen.
   */
  showTypeFilter = computed(() =>
    // Suggestions are not record findings — they are findings about the SCHEMA and the space, so a
    // record-type filter has nothing to narrow there. Showing it would imply the list is filtered when
    // it is not, which is the same lie as hiding an active filter.
    this.sub() !== 'suggestions' && (this.availableTypes().length > 1 || this.typeFilter() !== 'all'));

  // ── Suggestions (space completeness, part B) ─────────────────────────────────
  //
  // Overview shows the score and its three heaviest deductions; this is where the whole report lives,
  // with the samples resolved into something a reviewer can recognise. A raw entity UUID is not a
  // finding anyone can act on, so the entity-scoped samples are looked up by name.

  readonly compLoading = signal(false);
  readonly compError = signal(false);
  readonly compScore = signal<number | null>(null);
  readonly compTruncated = signal(false);
  readonly compChecks = signal<CompletenessCheck[]>([]);
  /** Entity id → name, for the samples that are record ids rather than schema keys. */
  readonly entityNames = signal<Record<string, string>>({});

  /** Costing points, heaviest loss first — what a reviewer came here to work through. */
  readonly failingChecks = computed(() => this.compChecks()
    .filter(c => c.earned < c.weight)
    .sort((a, b) => (b.weight - b.earned) - (a.weight - a.earned)));

  /** Everything already clean. Listed, not hidden: on a healthy space this is the whole answer, and an
   *  empty page would read as "we checked nothing" rather than "nothing is wrong". */
  readonly passingChecks = computed(() => this.compChecks().filter(c => c.earned >= c.weight));

  /** A sample entry rendered for a human: an entity id becomes its name, everything else is already one. */
  sampleLabel(check: CompletenessCheck, value: string): string {
    if (check.scope !== 'entity' || check.id !== 'entity-without-edges') return value;
    return this.entityNames()[value] ?? value;
  }

  /** How much of this check's weight the space kept, as a percentage — the card's bar. */
  earnedPct(c: CompletenessCheck): number {
    return c.weight > 0 ? Math.round((c.earned / c.weight) * 100) : 100;
  }

  loadCompleteness(): void {
    if (!this.spaceId) return;
    this.compLoading.set(true);
    this.compError.set(false);
    const forSpace = this.spaceId;
    this.spacesApi.getCompleteness(forSpace).subscribe({
      next: r => {
        if (this.spaceId !== forSpace) return;      // space switched mid-flight
        this.compScore.set(r.score);
        this.compChecks.set(r.checks);
        this.compTruncated.set(r.truncated);
        this.compLoading.set(false);
        this.resolveEntitySamples(forSpace, r.checks);
      },
      // A failed load must not render as a perfect space. Surface it and show nothing else.
      error: () => { if (this.spaceId === forSpace) { this.compError.set(true); this.compLoading.set(false); } },
    });
  }

  /** Turn the entity-id samples into names. Best-effort: a failure leaves the ids, which still identify
   *  the records — degraded, not broken. */
  private resolveEntitySamples(forSpace: string, checks: CompletenessCheck[]): void {
    const ids = checks.filter(c => c.id === 'entity-without-edges').flatMap(c => c.sample);
    if (!ids.length) { this.entityNames.set({}); return; }
    this.brainApi.getEntitiesByIds(forSpace, ids).subscribe({
      next: r => {
        if (this.spaceId !== forSpace) return;
        this.entityNames.set(Object.fromEntries(r.entities.map(e => [e._id, e.name])));
      },
      error: () => { if (this.spaceId === forSpace) this.entityNames.set({}); },
    });
  }

  /**
   * The options to render: the types present here, plus the active filter if this tab has none of them.
   *
   * Without that union the `<select>` would hold a value with no matching `<option>` after a tab switch and
   * render blank — the control would look unset while still filtering the list.
   */
  typeOptions = computed<string[]>(() => {
    const types = this.availableTypes();
    const active = this.typeFilter();
    return active !== 'all' && !types.includes(active) ? [...types, active].sort() : types;
  });

  /** The list actually shown: the loaded rows narrowed by the search box (summaries, type, space). */
  filteredRows = computed<DuplicateRecord[]>(() => {
    const q = this.query().trim().toLowerCase();
    const type = this.typeFilter();
    let list = this.rows();
    if (type !== 'all') list = list.filter(r => r.type === type);
    if (!q) return list;
    return list.filter(r =>
      `${r.aSummary} ${r.bSummary} ${r.type} ${r.spaceId}`.toLowerCase().includes(q));
  });

  /**
   * Contradictions narrowed by the shared type filter and the shared search box.
   *
   * `query` is shared with Duplicates on purpose, exactly as `typeFilter` is: both are questions about
   * WHICH RECORDS, not about which kind of finding, so "I am looking at the Vault records" should survive
   * a tab switch. The status filters are NOT shared — contradictions have a `resolved` pile and duplicates
   * do not, so one control would have to offer an option that means nothing on one side.
   *
   * The searched text includes the disagreeing field values, which is what a reviewer actually remembers
   * about a structured finding — "the one about `region`" — and it is not in either summary.
   */
  conFilteredRows = computed<ContradictionRecord[]>(() => {
    const q = this.query().trim().toLowerCase();
    const type = this.typeFilter();
    let list = this.conRows();
    if (type !== 'all') list = list.filter(r => r.type === type);
    if (!q) return list;
    return list.filter(r => {
      const fields = (r.fields ?? []).map(f => `${f.key} ${f.aValue} ${f.bValue}`).join(' ');
      return `${r.aSummary} ${r.bSummary} ${r.type} ${r.spaceId} ${fields}`.toLowerCase().includes(q);
    });
  });

  /** The same rollup Duplicates gets: what still needs attention, and how much of it is on screen. */
  conSummaryItems = computed<SummaryItem[]>(() => {
    const list = this.conRows();
    const open = list.filter(r => r.status === 'open').length;
    return [
      { label: this.transloco.translate('duplicates.summary.open'), value: String(open), variant: open ? 'warn' : 'ok' },
      { label: this.transloco.translate('duplicates.summary.shown'), value: String(this.conFilteredRows().length) },
    ];
  });

  /** Run the contradiction scan now. The API method existed from the start with no caller. */
  scanContradictions(): void {
    this.conScanning.set(true);
    this.contradictionsApi.scanContradictions(this.spaceId).subscribe({
      next: (r) => {
        this.conScanning.set(false);
        // `nliStalled` means the judge was unreachable, so the NLI pass settled nothing and its cursor is
        // parked. Silence here would leave "0 found" reading as "nothing disagrees" — the same conflation
        // the empty state used to make, one layer up.
        if (r.nliStalled) this.toast.error(this.transloco.translate('review.contradictions.scanStalled'));
        this.loadContradictions();
      },
      error: (e) => {
        this.conScanning.set(false);
        this.toast.error(this.transloco.translate(e?.status === 403 ? 'duplicates.scanForbidden' : 'duplicates.scanError'));
      },
    });
  }

  /**
   * True when the server's per-space cap was reached, so the list on screen is not the whole story.
   *
   * Both list endpoints return a capped set (500 per space) with no pagination. Filtering a truncated set
   * client-side would quietly under-report while looking authoritative — the filter would imply "these are
   * all the chrono findings" when it can only mean "these are the chrono findings among the first 500".
   * Say so rather than adding pagination as a side quest.
   */
  private static readonly SERVER_CAP = 500;
  listCapped = computed(() =>
    (this.sub() === 'contradictions' ? this.conRows() : this.rows()).length >= ReviewTabComponent.SERVER_CAP);

  /** Operator-first rollup atop the list: how many still need attention + how strong the matches are. */
  summaryItems = computed<SummaryItem[]>(() => {
    const list = this.rows();
    const open = list.filter(r => r.status === 'open').length;
    const scores = list.map(r => r.score);
    const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
    return [
      { label: this.transloco.translate('duplicates.summary.open'), value: String(open), variant: open ? 'warn' : 'ok' },
      { label: this.transloco.translate('duplicates.summary.avgScore'), value: scores.length ? `${Math.round(avg * 100)}%` : '—' },
      { label: this.transloco.translate('duplicates.summary.shown'), value: String(this.filteredRows().length) },
    ];
  });

  scorePct(s: number): number { return Math.round(Math.min(Math.max(s, 0), 1) * 100); }
  scoreVariant(s: number): 'high' | 'mid' | 'low' { return s >= 0.95 ? 'high' : s >= 0.85 ? 'mid' : 'low'; }

  ngOnInit(): void { this.load(); this.loadContradictions(); this.loadCompleteness(); }
  /** Switching space in the Brain re-points this tab rather than leaving another space's pairs on screen. */
  ngOnChanges(ch: SimpleChanges): void {
    if (ch['spaceId'] && !ch['spaceId'].firstChange) { this.load(); this.loadContradictions(); this.loadCompleteness(); }
  }

  load(): void {
    this.loading.set(true);
    this.error.set(false);
    this.duplicatesApi.listDuplicates(this.statusFilter, this.spaceId).subscribe({
      next: ({ duplicates }) => { this.rows.set(duplicates); this.loading.set(false); },
      error: () => { this.error.set(true); this.loading.set(false); },
    });
  }

  scan(): void {
    this.scanning.set(true);
    this.duplicatesApi.scanDuplicates(this.spaceId).subscribe({
      next: () => { this.scanning.set(false); this.load(); },
      error: (e) => {
        this.scanning.set(false);
        this.toast.error(this.transloco.translate(e?.status === 403 ? 'duplicates.scanForbidden' : 'duplicates.scanError'));
      },
    });
  }

  async dismiss(d: DuplicateRecord): Promise<void> {
    // Guarded: dismissing hides the pair from the open list, so confirm before discarding it (U8).
    const ok = await this.confirmDialog.confirm({
      title: this.transloco.translate('duplicates.confirmDismissTitle'),
      message: this.transloco.translate('duplicates.confirmDismiss'),
      confirmLabel: this.transloco.translate('duplicates.dismiss'),
    });
    if (!ok) return;
    this.busy.set(d.id);
    this.duplicatesApi.dismissDuplicate(d.id).subscribe({
      next: () => { this.rows.update(list => this.statusFilter === 'open' ? list.filter(x => x.id !== d.id) : list.map(x => x.id === d.id ? { ...x, status: 'dismissed' } : x)); this.busy.set(null); },
      error: (e) => { this.busy.set(null); this.toast.error(e?.error?.error || this.transloco.translate('duplicates.dismissError')); },
    });
  }

  async reopen(d: DuplicateRecord): Promise<void> {
    // Re-rating is the deliberate counterpart to a sticky dismissal — no confirm needed, it only
    // moves the pair back onto the review list (nothing is destroyed).
    this.busy.set(d.id);
    this.duplicatesApi.reopenDuplicate(d.id).subscribe({
      next: () => {
        // In the dismissed view the pair no longer belongs; in the "all" view it flips back to open.
        this.rows.update(list => this.statusFilter === 'dismissed'
          ? list.filter(x => x.id !== d.id)
          : list.map(x => x.id === d.id ? { ...x, status: 'open' } : x));
        this.busy.set(null);
        this.toast.success(this.transloco.translate('duplicates.reRateDone'));
      },
      error: (e) => { this.busy.set(null); this.toast.error(e?.error?.error || this.transloco.translate('duplicates.reRateError')); },
    });
  }

  async merge(d: DuplicateRecord): Promise<void> {
    const ok = await this.confirmDialog.confirm({
      title: this.transloco.translate('duplicates.confirmMergeTitle'),
      message: this.transloco.translate('duplicates.confirmMerge'),
      confirmLabel: this.transloco.translate('duplicates.mergeButton'),
    });
    if (!ok) return;
    this.busy.set(d.id);
    this.duplicatesApi.mergeDuplicate(d.id).subscribe({
      next: () => { this.rows.update(list => list.filter(x => x.id !== d.id)); this.busy.set(null); },
      error: (e) => { this.busy.set(null); this.toast.error(e?.error?.error || this.transloco.translate('duplicates.mergeError')); },
    });
  }
}
