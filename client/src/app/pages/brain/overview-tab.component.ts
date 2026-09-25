/**
 * Brain → Overview tab (F9, slice 1).
 *
 * The space's landing view: a governance/health dashboard assembled over data the Brain shell already
 * holds, so it adds almost no fetch of its own. Presentational by design — `space` and `stats` come in as
 * inputs (the shell preloads them for every space), and the one action, Reindex, is emitted back to the
 * shell's existing reindex flow behind a confirm.
 *
 * Panels so far: Statistics, Indexing, Embedding queue (per-space media-job counts), Governance (open
 * votes across the space's networks), Networks (F8's `networks`/`networkStatus`) and Instance
 * (`/api/about`). Every input is preloaded by the shell.
 *
 * ONE EXCEPTION, added with the data-model panel: that panel asks for its own ER model. A full derivation is
 * too expensive to put on the shell's critical path for a space nobody opens this panel on, so it fetches
 * lazily and owns its own loading, empty and FAILED states. The claim above was 'this component still
 * fetches nothing itself' until 2026-08-08; it is corrected rather than left to be discovered.
 * The token-access panel is a later slice (admin-gating).
 */
import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { StatusPillComponent, StatusVariant } from '../../shared/status-pill.component';
import { SkeletonLinesComponent } from '../../shared/skeleton-lines.component';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { Space, SpaceStats, AboutInfo, EmbeddingQueue, VoteRound, TokenAccessEntry, CompletenessReport, CompletenessCheck, SpaceActivity } from '../../core/api.types';
// Aliased: the class members below carry the same names, and a bare call that resolves to the import
// rather than the member is the kind of line a reader has to stop and check.
import { retentionSummary as summariseRetention, retentionTypeOverrides as retentionOverridesOf } from './overview-retention';

import { CollectionTab } from './brain-tabs';
import { ErModelPanelComponent } from './er-model-panel.component';

@Component({
  selector: 'app-overview-tab',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ErModelPanelComponent, TranslocoPipe, PhIconComponent, StatusPillComponent, SkeletonLinesComponent, RouterLink, DatePipe],
  styles: [`
    :host { display: block; }

    /* Deterministic column count instead of auto-fit: auto-fit re-flowed at every viewport width and
       regularly orphaned a card on a row of its own, which is what made the board look arbitrary.
       Cards STRETCH to their row height (no align-items:start), so every card in a row ends level. */
    .grid { display: grid; grid-template-columns: 1fr; gap: 16px; }
    @media (min-width: 820px)  { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @media (min-width: 1280px) { .grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }

    /* The summary spans the full row — it is the heaviest card (six tiles + the storage bar) and
       reads as the page's headline rather than one tile among equals. */
    .panel.span-all { grid-column: 1 / -1; }

    /* A card is a column: header, then a body that FILLS the stretched height. Without the filling
       body a short card's content floats against a tall border box. */
    .panel { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 10px; overflow: hidden;
      display: flex; flex-direction: column; }
    .panel-h { display: flex; align-items: center; gap: 9px; padding: 13px 16px;
      border-bottom: 1px solid var(--border-muted); }
    .panel-h .ic { width: 30px; height: 30px; border-radius: 8px; display: grid; place-items: center; flex: none;
      background: var(--bg-elevated); border: 1px solid var(--border); color: var(--accent); }
    .panel-h h3 { margin: 0; font-size: 14px; font-weight: 620; }
    /* Every hint RESERVES two lines and clamps to two, so a card whose hint wraps and one whose hint
       fits on a single line still put their divider rule at the same height. Reserving (rather than
       truncating to one line) keeps the full hint readable — the alignment costs a little whitespace,
       not information. em-based, so it survives a font-size change; no magic total-height number. */
    .panel-h p { margin: 1px 0 0; font-size: 12px; color: var(--text-secondary); line-height: 1.35;
      min-height: calc(2 * 1.35em);
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .panel-b { padding: 14px 16px; flex: 1; }

    /* Default tile grid: the embedding-queue card's three counters, in a normal-width card. NOTE the
       breakpoints below are VIEWPORT-based, so they must not be allowed to reach this card — six
       columns inside a one-third-width card squeezes the labels to nothing. Hence the .span-all scope. */
    .stat-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
    /* The summary's six tiles (five collections + total) across the full-width card. */
    .span-all .stat-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    @media (min-width: 560px)  { .span-all .stat-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
    @media (min-width: 1000px) { .span-all .stat-grid { grid-template-columns: repeat(6, minmax(0, 1fr)); } }
    .stat { background: var(--bg-elevated); border: 1px solid var(--border-muted); border-radius: 8px; padding: 11px 12px; }
    .stat .v { font-size: 22px; font-weight: 700; font-family: var(--font-mono, monospace); font-variant-numeric: tabular-nums; line-height: 1.1; }
    .stat .l { display: flex; align-items: center; gap: 5px; margin-top: 4px; font-size: 11.5px; color: var(--text-secondary); }
    /* The five collection tiles are buttons now. Reset the UA button styling so they still read as
       tiles, and give them a real affordance — a clickable thing that looks inert gets clicked by
       nobody. The total tile stays a div: it has no single tab to open. */
    .stat-link { font: inherit; color: inherit; text-align: left; width: 100%; cursor: pointer;
      transition: border-color var(--transition), background var(--transition); }
    .stat-link:hover { border-color: var(--accent); background: var(--bg-surface); }
    .stat-link:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .stat.total { border-color: color-mix(in srgb, var(--accent) 45%, transparent);
      background: color-mix(in srgb, var(--accent) 10%, var(--bg-elevated)); }
    .stat.total .v { color: var(--accent-ink, var(--accent)); }

    .store { margin-top: 14px; }
    .store-row { display: flex; align-items: baseline; justify-content: space-between; font-size: 12.5px; }
    .store-row .cap { color: var(--text-secondary); }
    .store-row .num { font-family: var(--font-mono, monospace); font-variant-numeric: tabular-nums; color: var(--text-primary); }
    /* A qualified figure, not an error state: the number is still the best available, and the icon is what
       says it is a lower bound. Sits on its own line when the row runs out of width rather than pushing the
       number out of view. */
    .store-row .usage-floor { display: inline-flex; align-items: center; gap: 4px; margin-left: 8px;
      color: var(--warn, #b26a00); font-size: 11.5px; white-space: nowrap; cursor: help; }
    .bar { height: 7px; border-radius: 4px; background: var(--bg-elevated); margin-top: 7px; overflow: hidden; border: 1px solid var(--border-muted); }
    .bar > span { display: block; height: 100%; border-radius: 4px; background: var(--accent); }
    .bar > span.warn { background: var(--warning); } .bar > span.err { background: var(--error); }

    .idx-row { display: flex; align-items: center; gap: 10px; }
    .idx-row .lab { font-size: 13px; color: var(--text-secondary); flex: 1; }
    .reindex-note { display: flex; align-items: flex-start; gap: 8px; margin-top: 13px; padding: 10px 12px;
      border-radius: 8px; font-size: 12.5px; border: 1px solid var(--warning-border); background: var(--warning-bg); }
    .reindex-note ph-icon { flex: none; margin-top: 1px; color: var(--warning); }
    .actions { margin-top: 13px; }
    .retention { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border-muted); }
    .ret-line { margin: 4px 0 0; font-size: 12.5px; color: var(--text-primary); }
    .ret-types { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 3px;
      font-size: 11.5px; color: var(--text-secondary); }
    .ret-edit { margin: 7px 0 0; font-size: 11px; }
    .muted { color: var(--text-muted); font-size: 12.5px; }

    .net-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 7px; }
    .net-list li { display: flex; align-items: center; gap: 8px; font-size: 13px; }
    .net-list ph-icon { color: var(--text-muted); flex: none; }
    .net-list .nl { flex: 1; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .net-list .nt { font-size: 11px; color: var(--text-muted); font-family: var(--font-mono, monospace); }

    .kv { display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; font-size: 12.5px; margin: 0; }
    .kv dt { color: var(--text-secondary); white-space: nowrap; }
    .kv dd { margin: 0; color: var(--text-primary); text-align: right; }
    .kv dd.mono { font-family: var(--font-mono, monospace); font-size: 11px; word-break: break-all; }

    .stat.err-stat { border-color: color-mix(in srgb, var(--error) 45%, transparent); background: color-mix(in srgb, var(--error) 10%, var(--bg-elevated)); }
    .stat.err-stat .v { color: var(--error); }
    .fail-list { list-style: none; margin: 12px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
    .fail-list li { display: flex; flex-direction: column; gap: 1px; font-size: 11.5px; border-top: 1px solid var(--border-muted); padding-top: 6px; }
    .fail-list .fp { font-family: var(--font-mono, monospace); color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .fail-list .fe { color: var(--error); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* Reasons read as a count-first tally, deliberately unlike the path list below it: the eye should land on
       "38" before the message, because the number is the diagnosis. */
    .fail-reasons { list-style: none; margin: 12px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
    .fail-reasons li { display: flex; align-items: baseline; gap: 8px; font-size: 11.5px; }
    .fail-reasons .rc { font-family: var(--font-mono, monospace); font-weight: 650; color: var(--error); min-width: 2.5ch; text-align: right; flex: none; }
    .fail-reasons .re { color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .fail-more { font-size: 11px; margin: 6px 0 0; }

    .vote-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 9px; }
    .vote-list li { border: 1px solid var(--border-muted); border-radius: 8px; padding: 9px 11px; background: var(--bg-elevated); }
    .vote-top { display: flex; align-items: baseline; gap: 8px; }
    .vote-top .vs { flex: 1; font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .vote-top .vt { font-size: 11px; color: var(--text-muted); font-family: var(--font-mono, monospace); }
    .vote-meta { display: flex; justify-content: space-between; gap: 10px; margin-top: 4px; font-size: 11.5px; color: var(--text-secondary); flex-wrap: wrap; }
    .vote-meta .tally { font-variant-numeric: tabular-nums; }
    .tok-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 7px; }
    .tok-list li { display: flex; align-items: center; gap: 8px; font-size: 13px; }
    .tok-list .tn { flex: 1; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tok-list .tx { font-size: 11px; color: var(--text-muted); white-space: nowrap; }
    .lvl { font-size: 10.5px; font-weight: 620; padding: 1px 7px; border-radius: 999px; text-transform: uppercase; letter-spacing: 0.03em; flex: none; }
    .lvl.admin { background: color-mix(in srgb, var(--error) 16%, transparent); color: var(--error); }

    /* Rows are as tall as their tallest card, so an unbounded list (many tokens, many peers) used to
       stretch every sibling with it. Cap the lists and let the long ones scroll in place. */
    .net-list, .vote-list, .tok-list, .fail-list { max-height: 216px; overflow-y: auto; }
    .lvl.full { background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent); }
    .lvl.readOnly { background: color-mix(in srgb, var(--text-muted) 18%, transparent); color: var(--text-secondary); }

    /* Completeness. The score sits beside its deductions, never alone: a number on its own is the one
       thing this panel must not be. Same bar primitive as storage — no new visual language. */
    .comp-top { display: flex; align-items: baseline; gap: 10px; }
    .comp-score { font-size: 30px; font-weight: 700; font-family: var(--font-mono, monospace);
      font-variant-numeric: tabular-nums; line-height: 1; }
    .comp-score.good { color: var(--success); } .comp-score.mid { color: var(--warning); } .comp-score.bad { color: var(--error); }
    .comp-of { font-size: 12.5px; color: var(--text-secondary); }
    .comp-list { list-style: none; margin: 13px 0 0; padding: 0; display: flex; flex-direction: column; gap: 7px; max-height: 216px; overflow-y: auto; }
    .comp-list li { display: flex; align-items: flex-start; gap: 8px; font-size: 12.5px;
      border-top: 1px solid var(--border-muted); padding-top: 7px; }
    .comp-list ph-icon { flex: none; margin-top: 2px; }
    .comp-list .warn-ic { color: var(--warning); } .comp-list .info-ic { color: var(--text-muted); }
    .comp-txt { flex: 1; min-width: 0; }
    .comp-txt .ct { color: var(--text-primary); }
    .comp-txt .cs { display: block; color: var(--text-muted); font-size: 11px; font-family: var(--font-mono, monospace);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .comp-go { font: inherit; font-size: 11.5px; background: none; border: 0; color: var(--accent); cursor: pointer;
      padding: 0; flex: none; text-decoration: underline; }
    .comp-go:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .comp-clear { display: flex; align-items: center; gap: 7px; font-size: 12.5px; color: var(--success); margin-top: 13px; }
  `],
  template: `
    <div class="grid">
      <!-- ── Data model (full width: a diagram in a third-width card is unreadable) ──── -->
      <section class="panel span-all">
        <header class="panel-h">
          <!-- NO BACKTICKS in a template comment: one ends the inline template string and the error points
               at @Component, not here.
               This is "stack", not "graph". The panel is the space's SCHEMA — record TYPES and their fields,
               with the relationships between them. "graph" is the node-graph VIEW and now labels that tab;
               two things wearing one icon made this read as a small copy of the Graph tab. Not "database"
               either: the Indexing panel below already owns that, and swapping one collision for another is
               not a fix. -->
          <span class="ic"><ph-icon name="stack" [size]="16"/></span>
          <div>
            <h3>{{ 'brain.overview.er.title' | transloco }}</h3>
            <p class="hint">{{ 'brain.overview.er.hint' | transloco }}</p>
          </div>
        </header>
        <app-er-model-panel [spaceId]="space().id" [canEdit]="canEditSchema()"
                            (editType)="editSchemaType.emit($event)" />
      </section>

      <!-- The record-count strip that used to sit here is gone (owner, 2026-08-08): the ER diagram above
           shows the same counts per type AND how the types relate, so a flat row of the same numbers was
           the diagram's data with the structure removed. Its per-type tab links live on the diagram now.
           The STORAGE bar was not duplicated by the diagram, so it moved into Usage below rather than
           being deleted with the strip around it — disk consumed is usage. -->

      <!-- ── Usage: storage, and whether anyone gets anything OUT of this space ── -->
      <!-- The SECTION is unconditional; only the ACTIVITY block inside it is gated. It used to be the other
           way round, which is why storage could not live here: the whole card waited on activity data, so on
           a space nobody had called yet the card was absent and storage with it — exactly the space where a
           filling disk is least expected. Giving storage its own card worked around that and was the wrong
           fix: it made a card for one number. -->
      <section class="panel">
        <header class="panel-h">
          <span class="ic"><ph-icon name="broadcast" [size]="16"/></span>
          <div><h3>{{ 'brain.overview.useTitle' | transloco }}</h3>
            <p>{{ 'brain.overview.useHint' | transloco }}</p></div>
        </header>
        <div class="panel-b">
          @if (activity(); as act) {
            @if (act.calls > 0) {
              <div class="stat-grid">
                <div class="stat">
                  <div class="v">{{ act.calls }}</div>
                  <div class="l"><ph-icon name="binoculars" [size]="13"/>{{ 'brain.overview.useCalls' | transloco }}</div>
                </div>
                <div class="stat">
                  <div class="v">{{ act.recall }}</div>
                  <div class="l"><ph-icon name="magnifying-glass" [size]="13"/>{{ 'brain.overview.useRecall' | transloco }}</div>
                </div>
                <!-- The headline. Demand without this number is not usefulness — a space asked 380 times that
                     answered 41 reads identically to the best space in the instance if you only count calls. -->
                <div class="stat" [class.total]="answerRate() !== null">
                  <div class="v">{{ answerRate() === null ? '—' : answerRate() + '%' }}</div>
                  <div class="l"><ph-icon name="check-circle" [size]="13"/>{{ 'brain.overview.useAnswered' | transloco }}</div>
                </div>
                <div class="stat">
                  <div class="v">{{ act.writes }}</div>
                  <div class="l"><ph-icon name="pencil-simple" [size]="13"/>{{ 'brain.overview.useWrites' | transloco }}</div>
                </div>
                <div class="stat">
                  <div class="v">{{ act.meanMs === null ? '—' : act.meanMs + ' ms' }}</div>
                  <div class="l"><ph-icon name="timer" [size]="13"/>{{ 'brain.overview.useMean' | transloco }}</div>
                </div>
              </div>

              @if (answerRate(); as rate) {
                <div class="store">
                  <div class="store-row">
                    <span class="cap">{{ 'brain.overview.useAnswerRate' | transloco }}</span>
                    <span class="num">{{ act.answered }} / {{ act.recall }}<!--
                      -->@if (act.meanTopScore !== null) { · {{ 'brain.overview.useTopScore' | transloco }} {{ act.meanTopScore }} }</span>
                  </div>
                  <!-- Inverted thresholds against the storage bar below: there, full is bad. Here a LOW rate
                       is the warning — questions arriving and going unanswered is the content gap this panel
                       exists to make visible. -->
                  <div class="bar"><span [class.warn]="rate < 50 && rate >= 20" [class.err]="rate < 20" [style.width.%]="rate"></span></div>
                </div>
              }

              @if (act.over1s > 0) {
                <div class="store-row" style="margin-top:9px">
                  <span class="cap">{{ 'brain.overview.useSlow' | transloco }}</span>
                  <span class="num">{{ act.over1s }} · max {{ act.maxMs }} ms</span>
                </div>
              }
            } @else {
              <!-- Not "no data": no calls. A space with nothing asked of it is the clearest answer this panel
                   can give, and blanking it would look like a loading failure instead. -->
              <span class="muted">{{ 'brain.overview.useNone' | transloco }}</span>
            }
          } @else if (pending().activity) {
            <app-skeleton-lines [rows]="4" />
          }

          <!-- Reset. Inside the calls>0 branch on purpose: with nothing recorded there is nothing to clear,
               and a control that does nothing is worse than an absent one. Admin only, matching the server —
               clearing a usage record is bookkeeping rather than a knowledge write, but it is still an
               irreversible delete. -->
          @if (canEditSchema() && activity(); as act) {
            @if (act.calls > 0) {
              <div class="store-row" style="margin-top:12px;justify-content:flex-end;">
                <button class="btn btn-secondary btn-sm" type="button"
                        [disabled]="resettingUsage()"
                        [attr.title]="'brain.overview.useResetHint' | transloco"
                        (click)="requestUsageReset()">
                  @if (resettingUsage()) { <span class="spinner" style="width:11px;height:11px;border-width:2px;"></span> }
                  {{ 'brain.overview.useReset' | transloco }}
                </button>
                <!-- The outcome, beside the button. Afterwards the panel reads zero either way, so without this
                     the cleared count — which the route returns for exactly this reason — reaches nobody. -->
                @if (usageResetResult()) {
                  <span class="muted" style="margin-left:10px;font-size:12px;">{{ usageResetResult() }}</span>
                }
              </div>
            }
          }

          <!-- Storage: a SECTION of usage, not a card of its own. Disk consumed IS usage, and one number does
               not earn a card in a grid of panels. It sits OUTSIDE the activity branch above, so it renders
               whether or not anyone has ever called this space. -->
          <div class="store">
            <div class="store-row">
              <span class="cap">{{ 'brain.overview.storage' | transloco }}</span>
              @if (space().maxGiB) {
                <span class="num">{{ usageIsFloor() ? '≥ ' : '' }}{{ used() }} / {{ space().maxGiB }} GiB</span>
              } @else {
                <span class="num">{{ usageIsFloor() ? '≥ ' : '' }}{{ used() }} GiB · {{ 'brain.overview.storageUnlimited' | transloco }}</span>
              }
              <!-- The figure is a floor, and saying which paths could not be read is what an operator acts on.
                   A warning icon rather than a hidden number: the number is still the best available. -->
              @if (usageIsFloor()) {
                <span class="usage-floor" [title]="usageIncompleteReason()">
                  <ph-icon name="warning" [size]="14"></ph-icon>
                  {{ 'brain.overview.storageIncomplete' | transloco }}
                </span>
              }
            </div>
            @if (usagePct(); as pct) {
              <div class="bar"><span [class.warn]="pct >= 80 && pct < 95" [class.err]="pct >= 95" [style.width.%]="pct"></span></div>
            }
          </div>
        </div>
      </section>

      <!-- ── Completeness ───────────────────────────────────────────── -->
      @if (completeness(); as comp) {
        @if (comp.score !== null) {
          <section class="panel">
            <header class="panel-h">
              <span class="ic"><ph-icon name="check-circle" [size]="16"/></span>
              <div><h3>{{ 'brain.overview.compTitle' | transloco }}</h3>
                <p>{{ 'brain.overview.compHint' | transloco }}</p></div>
            </header>
            <div class="panel-b">
              <div class="comp-top">
                <span class="comp-score" [class.good]="comp.score >= 85" [class.mid]="comp.score >= 60 && comp.score < 85" [class.bad]="comp.score < 60">{{ comp.score }}%</span>
                <span class="comp-of">{{ 'brain.overview.comp.of' | transloco: { count: comp.checks.length } }}</span>
              </div>
              <div class="bar"><span [class.warn]="comp.score < 85" [class.err]="comp.score < 60" [style.width.%]="comp.score"></span></div>

              <!-- The deductions, heaviest first. The score never appears without them: a percentage
                   nobody can decompose is a number nobody can act on. -->
              @if (deductions().length) {
                <ul class="comp-list">
                  @for (c of deductions(); track c.id + c.scope) {
                    <li>
                      <ph-icon [name]="c.severity === 'warn' ? 'warning' : 'info'" [size]="14"
                               [class.warn-ic]="c.severity === 'warn'" [class.info-ic]="c.severity !== 'warn'"/>
                      <span class="comp-txt">
                        <span class="ct">{{ 'brain.overview.comp.check.' + c.id | transloco: { affected: c.affected, total: c.total, scope: ('brain.overview.comp.scope.' + c.scope | transloco) } }}</span>
                        @if (c.sample.length) { <span class="cs" [title]="c.sample.join(', ')">{{ c.sample.join(', ') }}</span> }
                      </span>
                      @if (c.targetTab; as tab) {
                        <button type="button" class="comp-go" (click)="openTab.emit(tab)">{{ 'brain.overview.comp.go' | transloco }}</button>
                      }
                    </li>
                  }
                </ul>
              } @else {
                <div class="comp-clear"><ph-icon name="check-circle" [size]="15"/>{{ 'brain.overview.comp.clear' | transloco }}</div>
              }

              @if (comp.truncated) {
                <div class="muted" style="margin-top:10px;">{{ 'brain.overview.comp.truncated' | transloco }}</div>
              }
            </div>
          </section>
        }
      } @else if (pending().completeness) {
        <section class="panel" [attr.aria-busy]="true">
          <header class="panel-h">
            <span class="ic"><ph-icon name="check-circle" [size]="16"/></span>
            <div><h3>{{ 'brain.overview.compTitle' | transloco }}</h3>
              <p>{{ 'brain.overview.compHint' | transloco }}</p></div>
          </header>
          <div class="panel-b"><app-skeleton-lines [rows]="4" /></div>
        </section>
      }

      <!-- ── Indexing ───────────────────────────────────────────────── -->
      <section class="panel">
        <header class="panel-h">
          <span class="ic"><ph-icon name="database" [size]="16"/></span>
          <div><h3>{{ 'brain.overview.indexingTitle' | transloco }}</h3>
            <p>{{ 'brain.overview.indexingHint' | transloco }}</p></div>
        </header>
        <div class="panel-b">
          <div class="idx-row">
            <span class="lab">{{ 'brain.overview.vectorIndex' | transloco }}</span>
            <app-status-pill [variant]="indexVariant()" [dot]="true">{{ 'brain.overview.idx.' + indexState() | transloco }}</app-status-pill>
          </div>

          @if (needsReindex() && !isProxy()) {
            <div class="reindex-note">
              <ph-icon name="warning" [size]="15"/>
              <span>{{ 'brain.overview.reindexNeeded' | transloco }}</span>
            </div>
          }
          @if (isProxy()) {
            <!-- Said rather than left blank: a card whose action silently vanishes reads as broken, and the
                 remedy (reindex the members) is not guessable from an absent button. -->
            <div class="reindex-note">
              <ph-icon name="info" [size]="15"/>
              <span>{{ 'brain.overview.reindexProxy' | transloco }}</span>
            </div>
          }

          <!-- Retention belongs on this card: both answers here are about the lifecycle of what is stored,
               and "why did that record disappear?" is asked far more often than it is answered. Read-only —
               it is set in the Danger Zone (space-wide) and on the type in the Schema tab, and duplicating an
               editor is how the two drift. -->
          <div class="retention">
            <div class="idx-row">
              <span class="lab">{{ 'brain.overview.retentionTitle' | transloco }}</span>
            </div>
            <p class="ret-line">{{ retentionSummary() }}</p>
            @if (retentionTypes().length) {
              <ul class="ret-types">
                @for (r of retentionTypes(); track r.key) { <li>{{ r.label }}</li> }
              </ul>
            }
            <p class="muted ret-edit">{{ 'brain.overview.retentionEdit' | transloco }}</p>
          </div>

          <!-- Not offered on a proxy at all. The server has refused it since the double-embed fix -- a proxy
               has no index of its own, and reindexing one re-embedded every member a second time -- so the
               button could only ever produce a 400. -->
          @if (!isProxy()) {
            <div class="actions">
              <button class="btn btn-sm btn-secondary" type="button" [disabled]="reindexing()" (click)="requestReindex()">
                @if (reindexing()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }
                <ph-icon name="arrows-clockwise" [size]="14" style="margin-right:5px;vertical-align:-2px;"/>{{ 'brain.overview.reindexButton' | transloco }}
              </button>
            </div>
          }
        </div>
      </section>

      <!-- ── Embedding queue ────────────────────────────────────────── -->
      @if (embeddingQueue(); as q) {
        <section class="panel">
          <header class="panel-h">
            <span class="ic"><ph-icon name="stack" [size]="16"/></span>
            <div><h3>{{ 'brain.overview.queueTitle' | transloco }}</h3>
              <p>{{ 'brain.overview.queueHint' | transloco }}</p></div>
          </header>
          <div class="panel-b">
            <div class="stat-grid">
              <div class="stat"><div class="v">{{ q.pending }}</div><div class="l">{{ 'brain.overview.queue.pending' | transloco }}</div></div>
              <div class="stat"><div class="v">{{ q.processing }}</div><div class="l">{{ 'brain.overview.queue.processing' | transloco }}</div></div>
              <div class="stat" [class.err-stat]="q.failed > 0"><div class="v">{{ q.failed }}</div><div class="l">{{ 'brain.overview.queue.failed' | transloco }}</div></div>
            </div>
            @if (q.failed === 0 && q.pending === 0 && q.processing === 0) {
              <div class="muted" style="margin-top:12px;">{{ 'brain.overview.queue.idle' | transloco }}</div>
            }
            <!-- Reasons first, and only when they add something. Five paths answer "which file"; the
                 grouping answers "why", over EVERY failure rather than the arbitrary first five — which is
                 the difference between one dead endpoint and forty unrelated problems. Hidden when there is
                 a single reason, because then the list below already says it. -->
            @if (failureReasons().length > 1) {
              <ul class="fail-reasons">
                @for (r of failureReasons(); track r.reason) {
                  <li>
                    <span class="rc">{{ r.count }}</span>
                    <span class="re" [title]="r.reason">{{ r.reason || ('brain.overview.queue.unknownError' | transloco) }}</span>
                  </li>
                }
              </ul>
            }
            @if (q.failedSample.length) {
              <ul class="fail-list">
                @for (f of q.failedSample; track f.path) {
                  <li><span class="fp" [title]="f.path">{{ f.path }}</span><span class="fe" [title]="f.lastError">{{ f.lastError || ('brain.overview.queue.unknownError' | transloco) }}</span></li>
                }
              </ul>
              @if (q.failed > q.failedSample.length) {
                <p class="muted fail-more">{{ 'brain.overview.queue.failedMore' | transloco: { shown: q.failedSample.length, total: q.failed } }}</p>
              }
            }
            @if (q.failed > 0) {
              <button class="btn btn-sm btn-secondary retry-failed-btn" type="button" style="margin-top:12px;" (click)="requestRetryFailed()">
                <ph-icon name="arrows-clockwise" [size]="14" style="margin-right:5px;vertical-align:-2px;"/>{{ 'brain.overview.queue.retryFailed' | transloco }}
              </button>
            }
          </div>
        </section>
      } @else if (pending().queue) {
        <section class="panel" [attr.aria-busy]="true">
          <header class="panel-h">
            <span class="ic"><ph-icon name="stack" [size]="16"/></span>
            <div><h3>{{ 'brain.overview.queueTitle' | transloco }}</h3>
              <p>{{ 'brain.overview.queueHint' | transloco }}</p></div>
          </header>
          <div class="panel-b"><app-skeleton-lines [rows]="3" /></div>
        </section>
      }

      <!-- ── Governance (open votes) ────────────────────────────────── -->
      @if (openVotes().length) {
        <section class="panel">
          <header class="panel-h">
            <span class="ic"><ph-icon name="broadcast" [size]="16"/></span>
            <div><h3>{{ 'brain.overview.govTitle' | transloco }}</h3>
              <p>{{ 'brain.overview.govHint' | transloco }}</p></div>
          </header>
          <div class="panel-b">
            <ul class="vote-list">
              @for (v of openVotes(); track v.id) {
                <li>
                  <div class="vote-top"><span class="vs" [title]="v.subject">{{ v.subject }}</span><span class="vt">{{ v.type }}</span></div>
                  <div class="vote-meta">
                    <span>{{ 'brain.overview.gov.deadline' | transloco }}: {{ v.deadline | date:'dd.MM.yyyy HH:mm' }}</span>
                    <span class="tally">{{ tallyYes(v) }} {{ 'brain.overview.gov.yes' | transloco }} · {{ tallyVeto(v) }} {{ 'brain.overview.gov.veto' | transloco }}</span>
                  </div>
                </li>
              }
            </ul>
            <a class="btn btn-sm btn-secondary" routerLink="/settings/networks" style="margin-top:12px; display:inline-flex; align-items:center; gap:5px;">
              <ph-icon name="broadcast" [size]="14"/> {{ 'brain.overview.gov.review' | transloco }}
            </a>
          </div>
        </section>
      }

      <!-- ── Networks ───────────────────────────────────────────────── -->
      <section class="panel">
        <header class="panel-h">
          <span class="ic"><ph-icon name="link" [size]="16"/></span>
          <div><h3>{{ 'brain.overview.networksTitle' | transloco }}</h3>
            <p>{{ 'brain.overview.networksHint' | transloco }}</p></div>
        </header>
        <div class="panel-b">
          @if (networks().length) {
            <div class="idx-row" style="margin-bottom:11px;">
              <span class="lab">{{ 'brain.overview.syncStatus' | transloco }}</span>
              <app-status-pill [variant]="netVariant()" [dot]="true">{{ 'brain.overview.net.' + netStatus() | transloco }}</app-status-pill>
            </div>
            <ul class="net-list">
              @for (n of networks(); track n.id) {
                <li><ph-icon name="link" [size]="13"/><span class="nl">{{ n.label }}</span><span class="nt">{{ n.type }}</span></li>
              }
            </ul>
          } @else {
            <span class="muted">{{ 'brain.overview.noNetworks' | transloco }}</span>
          }
        </div>
      </section>

      <!-- The Instance card is gone (owner, 2026-08-08): instance label, version, id, uptime and Mongo
           version are properties of the INSTANCE, not of the space being looked at, and every one of them
           is already on the About page. A space overview that answers "which build am I on?" invites the
           reader to think it is telling them something about this space. -->

      <!-- ── Token access (admin-only; null for non-admins → hidden) ──── -->
      @if (tokenAccess(); as toks) {
        <section class="panel">
          <header class="panel-h">
            <span class="ic"><ph-icon name="key" [size]="16"/></span>
            <div><h3>{{ 'brain.overview.tokenTitle' | transloco }}</h3>
              <p>{{ 'brain.overview.tokenHint' | transloco }}</p></div>
          </header>
          <div class="panel-b">
            @if (toks.length) {
              <ul class="tok-list">
                @for (t of toks; track t.name) {
                  <li>
                    <span class="lvl" [class.admin]="t.level === 'admin'" [class.full]="t.level === 'full'" [class.readOnly]="t.level === 'readOnly'">{{ 'brain.overview.tok.' + t.level | transloco }}</span>
                    <span class="tn">{{ t.name }}</span>
                    @if (t.peer) { <span class="tx">{{ 'brain.overview.tok.peer' | transloco }}</span> }
                    @if (t.allSpaces) { <span class="tx">{{ 'brain.overview.tok.allSpaces' | transloco }}</span> }
                    @if (t.expiresAt) { <span class="tx">{{ 'brain.overview.tok.expires' | transloco: { date: (t.expiresAt | date:'mediumDate') } }}</span> }
                  </li>
                }
              </ul>
            } @else {
              <div class="muted">{{ 'brain.overview.tok.none' | transloco }}</div>
            }
          </div>
        </section>
      } @else if (pending().tokens) {
        <section class="panel" [attr.aria-busy]="true">
          <header class="panel-h">
            <span class="ic"><ph-icon name="key" [size]="16"/></span>
            <div><h3>{{ 'brain.overview.tokenTitle' | transloco }}</h3>
              <p>{{ 'brain.overview.tokenHint' | transloco }}</p></div>
          </header>
          <div class="panel-b"><app-skeleton-lines [rows]="3" /></div>
        </section>
      }
    </div>
  `,
})
export class OverviewTabComponent {
  space = input.required<Space>();
  /** Admin tokens get the schema pen on each type card. */
  canEditSchema = input(false);
  /** Set by the host while the reset request is in flight, so a second press cannot fire a second delete. */
  resettingUsage = input(false);
  /** What the last reset did, reported inline the way runReindex reports its result. */
  usageResetResult = input('');
  /** The panel confirms; the host performs the request and reloads. Same split as reindex and retry-failed. */
  resetUsage = output<void>();
  /** The SHELL owns the schema dialog: this tab reports which type was asked for and nothing more. */
  editSchemaType = output<string>();
  stats = input<SpaceStats | undefined>(undefined);
  reindexing = input(false);
  /**
   * A proxy space stands in for its members and holds no records — so it has no index of its own and
   * nothing to reindex. The server has refused the call since the double-embed fix (`planReindex` answers
   * 400 naming the members), so offering the button could only ever produce that refusal.
   *
   * Read from the space this panel was already given, not fetched: `proxyFor` is on the record, and the
   * space chip beside this panel already branches on it to draw the proxy badge.
   */
  isProxy = () => (this.space().proxyFor?.length ?? 0) > 0;
  needsReindex = input(false);
  /** Instance identity/health (from /api/about), preloaded by the shell — null until it lands. */
  about = input<AboutInfo | null>(null);
  /** Embedding-job backlog for this space (from the shell) — null until it lands. */
  embeddingQueue = input<EmbeddingQueue | null>(null);
  /** Open governance votes across this space's networks (from the shell). */
  openVotes = input<VoteRound[]>([]);
  /** Tokens that can reach this space (from the shell). Null for non-admins → the panel stays hidden. */
  tokenAccess = input<TokenAccessEntry[] | null>(null);
  /** Completeness checks + roll-up (from the shell) — null until it lands, and the panel stays hidden. */
  completeness = input<CompletenessReport | null>(null);
  /**
   * This space's usage over the shell's window (from the shell) — null until it lands, panel hidden.
   *
   * A single already-summed row rather than the endpoint's array: for a proxy space the shell sums its
   * members, because the question "is this space useful" is about the thing the operator sees in the list, not
   * about which member answered.
   */
  activity = input<SpaceActivity | null>(null);

  /**
   * Which panels have been blanked for a space switch and are still awaiting a first answer.
   *
   * Separate from the values because `null` cannot say it: `tokenAccess` is null **permanently** for a non-admin
   * (the endpoint 403s) and `completeness` is null after a failure, so a skeleton keyed on null alone would sit
   * there forever. The parent raises these only where it blanks, and clears each from both handlers.
   */
  // `stats` and `about` are gone from this record with the panels they gated (owner, 2026-08-08). A pending
  // flag with no skeleton branch left to drive is not harmless: it is a blank that never resolves into
  // anything, and the gate that enforces the pairing is what caught them.
  pending = input<Record<'activity' | 'completeness' | 'queue' | 'tokens', boolean>>({
    activity: false, completeness: false, queue: false, tokens: false,
  });
  /** Emitted (after a confirm) so the shell's existing reindex flow runs — no duplicate API path. */
  /** A collection tile was clicked — the shell switches to that tab. */
  openTab = output<CollectionTab>();

  reindex = output<void>();
  /** Emitted so the shell re-queues every failed embedding job and reloads the queue (fetch-free tab). */
  retryFailed = output<void>();

  private confirmDialog = inject(ConfirmDialogService);
  private transloco = inject(TranslocoService);

  /**
   * Answered recalls as a percentage, or null when nothing was asked.
   *
   * Null rather than 0 for "no questions": 0% reads as "this space answers nothing", which is a judgement
   * about quality, when the truth is that nobody asked it anything. The two need different responses from an
   * operator — fill the space, versus find out why nobody queries it.
   */
  answerRate = computed<number | null>(() => {
    const a = this.activity();
    if (!a || a.recall === 0) return null;
    return Math.round((a.answered / a.recall) * 100);
  });

  /**
   * Failed jobs grouped by reason, most common first — over the whole failed set, not the five-path sample.
   *
   * Tolerates the field being absent so an older server (or a cached response from one) renders the panel
   * rather than throwing on `.length`: absent and empty both mean "nothing to add here".
   */
  failureReasons = computed<Array<{ reason: string | null; count: number }>>(
    () => this.embeddingQueue()?.failedByReason ?? [],
  );
  /**
   * The space-wide tier, in words. "No expiry" is a real answer and the one most spaces give.
   *
   * Reads the buckets rather than the raw field, because the tier is five numbers now. When they all agree it
   * still says the one sentence it always did — a space with one window should not be made to look complicated
   * by an implementation detail — and only lists per bucket when they actually differ.
   */
  /** Delegated to `overview-retention.ts` — pure, and out of a file the ratchet has frozen. */
  retentionSummary = computed<string>(() => summariseRetention(this.space(), (k, p) => this.transloco.translate(k, p)));

  /** Same. The list of types whose own schema overrides the space-wide window. */
  retentionTypes = computed(() => retentionOverridesOf(this.space(), (k, p) => this.transloco.translate(k, p)));

  // `total` and `statCards` went with the statistics strip. Both existed only to feed those tiles, and the
  // ER diagram computes its own per-type counts from the model it already fetched — keeping a second
  // source of the same numbers is how two counts of one thing come to disagree.

  /**
   * The checks that actually cost points, heaviest loss first — a passing check is not a deduction and
   * listing it would bury the three lines that matter. Ranked by points LOST (`weight - earned`), not by
   * `affected`: 3 unreachable files outrank 300 unlinked entities, because that is what the weights say.
   */
  deductions = computed<CompletenessCheck[]>(() => {
    const cs = this.completeness()?.checks ?? [];
    return cs.filter(c => c.earned < c.weight)
      .sort((a, b) => (b.weight - b.earned) - (a.weight - a.earned))
      .slice(0, 6);
  });

  /** Two decimals of GiB, without trailing noise. */
  used(): string { return (this.space().usageGiB ?? 0).toFixed(2); }

  /**
   * True when the server said the usage figure is a FLOOR — a directory it could not read.
   *
   * Shown rather than hidden because the alternative is worse than a missing number: an unreadable space
   * reported 0 GiB, which is what an empty space reports, so the bar sat at 0% while the quota was being
   * approached. A figure qualified as "at least" is usable; one silently short is not.
   */
  usageIsFloor = computed(() => (this.space().usageIncomplete?.length ?? 0) > 0);

  /** What the server could not read, for the tooltip — the operator's actual next step. */
  usageIncompleteReason = computed(() => this.space().usageIncomplete?.join('; ') ?? '');

  usagePct(): number | null {
    const sp = this.space();
    if (!sp.maxGiB) return null;
    return Math.min(100, ((sp.usageGiB ?? 0) / sp.maxGiB) * 100);
  }

  /** Networks this space belongs to (F8 data, already on the space payload — no extra fetch). */
  networks = computed(() => this.space().networks ?? []);

  /** Aggregate sync/governance status; defaults to 'idle' when connected but unreported. */
  netStatus(): 'idle' | 'syncing' | 'degraded' | 'vote' {
    return this.space().networkStatus ?? 'idle';
  }

  netVariant(): StatusVariant {
    switch (this.space().networkStatus) {
      case 'degraded': return 'error';
      case 'syncing': return 'pending';
      case 'vote': return 'warn';   // a governance vote is awaiting this instance — needs attention
      default: return 'ok';         // idle = connected and healthy
    }
  }

  /** Running vote tallies for the Governance panel. */
  tallyYes(v: VoteRound): number { return v.votes.filter(x => x.vote === 'yes').length; }
  tallyVeto(v: VoteRound): number { return v.votes.filter(x => x.vote === 'veto').length; }

  /** Space.indexStatus is optional (proxy/legacy spaces have none) → 'none'. */
  indexState(): 'ready' | 'building' | 'failed' | 'none' {
    return this.space().indexStatus ?? 'none';
  }

  indexVariant(): StatusVariant {
    switch (this.indexState()) {
      case 'ready': return 'ok';
      case 'building': return 'warn';
      case 'failed': return 'error';
      default: return 'off';
    }
  }

  /**
   * Confirm, then ask the host to clear this space's recorded usage.
   *
   * Exactly the shape `requestReindex` and `requestRetryFailed` already have: the panel owns the confirmation
   * because the panel is where the button is, and the host owns the request and the reload.
   *
   * `danger: true` because the buckets are deleted, not hidden — the usage history for this space is gone and
   * there is no undo. Guarded on `resettingUsage()` so a second press during the request cannot fire a second
   * delete.
   */
  async requestUsageReset(): Promise<void> {
    if (this.resettingUsage()) return;

    const ok = await this.confirmDialog.confirm({
      title: this.transloco.translate('brain.overview.confirmUsageResetTitle'),
      message: this.transloco.translate('brain.overview.confirmUsageReset', { label: this.space().label }),
      confirmLabel: this.transloco.translate('brain.overview.useReset'),
      danger: true,
    });
    if (!ok) return;
    this.resetUsage.emit();
  }

  async requestReindex(): Promise<void> {
    if (this.reindexing()) return;
    const ok = await this.confirmDialog.confirm({
      title: this.transloco.translate('brain.overview.confirmReindexTitle'),
      message: this.transloco.translate('brain.overview.confirmReindex', { label: this.space().label }),
      confirmLabel: this.transloco.translate('brain.overview.reindexButton'),
      danger: true,
    });
    if (!ok) return;
    this.reindex.emit();
  }

  async requestRetryFailed(): Promise<void> {
    const failed = this.embeddingQueue()?.failed ?? 0;
    if (failed <= 0) return;
    const ok = await this.confirmDialog.confirm({
      title: this.transloco.translate('brain.overview.confirmRetryFailedTitle'),
      message: this.transloco.translate('brain.overview.confirmRetryFailed', { count: failed }),
      confirmLabel: this.transloco.translate('brain.overview.queue.retryFailed'),
    });
    if (!ok) return;
    this.retryFailed.emit();
  }
}
