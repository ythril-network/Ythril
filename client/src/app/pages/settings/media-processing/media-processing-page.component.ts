/**
 * Settings → Models & Pipelines — the page shell.
 *
 * Replaces the 656-line `mediaProcessing.component.ts`, whose six cards sat in the order they were added
 * rather than any order a reader would choose ("very wild, no logic structure or consistent layout" —
 * owner, 2026-07-21).
 *
 * **One route, three tabs across the top of the panel.** Not the main navigation, not a left rail,
 * not a full-width strip — that was settled after three wrong attempts, so it is worth stating
 * plainly: tabs, top of the panel, sized to content.
 *
 * The shell owns the three things the tabs cannot own individually:
 *
 *   - **One load, one save.** All three tabs edit one config object, so `MediaProcessingStateService` is
 *     provided here and lives exactly as long as the page.
 *   - **One status fetch**, shared by Pipelines and Tools. Requested once on entry, never per tab.
 *   - **The unsaved-changes guard spans the tabs.** Switching tabs with a dirty form prompts rather
 *     than silently discarding — the tabs look like navigation, and navigation that eats edits is a
 *     data-loss bug regardless of how small the edit was.
 */
import { ChangeDetectionStrategy, Component, OnInit, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { PhIconComponent } from '../../../shared/ph-icon.component';
import { ConfirmDialogService } from '../../../core/confirm-dialog.service';
import { MediaProcessingStateService } from './media-processing-state.service';
import { PipelineStatusService } from './pipeline-status.service';
import { ModelsTabComponent } from './models-tab.component';
import { PipelinesTabComponent } from './pipelines-tab.component';
import { ToolsTabComponent } from './tools-tab.component';
import { PinnedUnknownNoticeComponent } from './pinned-unknown-notice.component';

type Tab = 'models' | 'pipelines' | 'tools';

@Component({
  selector: 'app-models-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  // Both services are page-scoped, not root: leaving and re-entering must start from the server's
  // state rather than a previous visit's half-finished edits.
  providers: [MediaProcessingStateService, PipelineStatusService],
  imports: [
    FormsModule, TranslocoPipe, PhIconComponent,
    ModelsTabComponent, PipelinesTabComponent, ToolsTabComponent,
    PinnedUnknownNoticeComponent,
  ],
  styles: [`
    :host { display: block; }
    /* No page header: media embedding is always on (controlled per class on the Models tab), the sidebar
       nav and tab strip already say where you are, and the old title/subtitle were redundant. */

    /* Tabs sized to content, at the top of the panel — not a full-width strip. */
    .tabs { display: flex; flex-wrap: wrap; row-gap: 2px; gap: 2px;
      border-bottom: 1px solid var(--border); margin-bottom: 18px; }
    .tabs > * { flex: none; white-space: nowrap; }
    .tab { background: none; border: none; border-bottom: 2px solid transparent; padding: 9px 16px;
      cursor: pointer; font-size: 13px; font-family: var(--font); color: var(--text-muted);
      display: flex; align-items: center; gap: 7px; }
    .tab:hover { color: var(--text-primary); }
    .tab.active { color: var(--text-primary); border-bottom-color: var(--accent); font-weight: 550; }
    .tab:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    /* The unsaved marker rides the tab that owns the edit, so switching away names what is at stake. */
    .tab .unsaved { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); flex: none; }

    .managed-banner { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; padding: 11px 14px;
      border-radius: 10px; background: rgba(88,166,255,.1); border: 1px solid rgba(88,166,255,.35);
      font-size: 13px; color: var(--text-secondary); }
    .managed-banner code { font-family: var(--font-mono, monospace); }
    .managed-banner b { color: var(--text-primary); }
    .managed-banner ph-icon { flex: none; }

    .actions { display: flex; gap: 12px; align-items: center; margin-top: 20px;
      padding-top: 16px; border-top: 1px solid var(--border-muted); }
    .save-error { color: var(--error); font-size: 13px; }
    .save-ok { color: var(--success); font-size: 13px; }
  `],
  template: `
    @if (s.loading()) {
      <div class="loading-overlay"><span class="spinner"></span></div>
    } @else if (s.loadError(); as e) {
      <div class="alert alert-error">{{ e }}</div>
    } @else {
      @if (s.managed) {
        <div class="managed-banner">
          <ph-icon name="lock" [size]="16"/>
          <span [innerHTML]="'mediaProcessing.page.managedBanner' | transloco"></span>
        </div>
      }

      <nav class="tabs" role="tablist" [attr.aria-label]="'mediaProcessing.page.title' | transloco">
        @for (t of TABS; track t) {
          <button class="tab" type="button" role="tab" [class.active]="tab() === t"
            [attr.aria-selected]="tab() === t" [attr.id]="'tab-' + t" [attr.aria-controls]="'panel-' + t"
            (click)="switchTo(t)">
            {{ 'mediaProcessing.tab.' + t | transloco }}
            @if (t === 'models' && s.isDirty()) { <span class="unsaved" [attr.aria-label]="'mediaProcessing.page.unsaved' | transloco"></span> }
          </button>
        }
      </nav>

      <!-- AN UNRECOGNISED PIN, on the PAGE rather than inside a tab.
           YTHRIL_PINNED_FIELDS names fields across all three tabs, so a typo in it is not a Models-tab fact —
           and putting it in one tab would hide it from an operator who happened to open another. Above the panel,
           because a pin the operator believes is in force is exactly what they must not scroll past.
           NOTE: no backticks in this template, including in comments. One ends the template string and the
           error points at @Component, never here. -->
      <app-pinned-unknown-notice [paths]="s.pinnedUnknown" />

      <!-- The whole panel delegates input/change so any field marks the form touched. One listener
           instead of an (ngModelChange) on every control — which is how a control gets added later
           without one and quietly stops arming the guard. -->
      <div [attr.id]="'panel-' + tab()" role="tabpanel" [attr.aria-labelledby]="'tab-' + tab()"
        (input)="s.touched.set(true)" (change)="s.touched.set(true)">
        @switch (tab()) {
          @case ('models') { <app-models-tab/> }
          @case ('pipelines') { <app-pipelines-tab/> }
          @case ('tools') { <app-tools-tab/> }
        }
      </div>

      <!--
        WHAT THE SERVER SAID, wherever the save was clicked.

        This block used to be guarded by showsSave(), which is a computed returning a literal false — so the
        page-level bar was never rendered, and with it went the only place saveError and saveOk were shown.
        Every per-card and per-pipeline Save sets them and nothing displayed either: a refusal left the button
        looking inert, and the reason the API had already given was discarded.

        Reported by the canary operator against 4.0.0 -- selecting the repair extraction mode did nothing
        visible, and they spent an hour not knowing which field was objecting.

        Rendered on the presence of a MESSAGE rather than on which tab is open, because the saves are spread
        across cards and pipelines and any of them can be refused.
      -->
      @if (s.saveError() || s.saveOk()) {
        <div class="actions" role="status" aria-live="polite">
          @if (s.saveError()) { <span class="save-error">{{ s.saveError() }}</span> }
          @if (s.saveOk()) { <span class="save-ok">{{ s.saveOk() }}</span> }
        </div>
      }
    }
  `,
})
export class MediaProcessingPageComponent implements OnInit {
  readonly s = inject(MediaProcessingStateService);
  readonly pipeline = inject(PipelineStatusService);
  private readonly confirmDialog = inject(ConfirmDialogService);
  private readonly transloco = inject(TranslocoService);

  /**
   * Pipelines first, and the landing tab.
   *
   * Owner, 2026-07-30. It is the right default because it answers the question an operator actually
   * arrives with — *what happens to a file I upload* — whereas Models answers *what is configured*, which
   * is the follow-up. Clicking a step in a pipeline already jumps to the model that implements it, so
   * the natural direction is pipeline → model, and the tab order now matches it.
   */
  readonly TABS: Tab[] = ['pipelines', 'models', 'tools'];
  readonly tab = signal<Tab>('pipelines');

  /**
   * Tools is read-only, so it never needs the save bar — and Models no longer does either: each of its
   * cards carries its own Save, shown only when that card has an unsaved change. Owner, 2026-07-28:
   * "save button on model page should appear only after change in the changed models box and not one
   * global on the bottom of the page."
   *
   * Pipelines keeps the bar. Its knobs are not grouped into per-provider boxes, so there is no "the box
   * that changed" to put a button in.
   */
  /*
   * GONE, not left returning false. It guarded the block that displays what a save returned, so a literal
   * false meant no refusal was ever shown — see the template. A flag that exists only to be false is a
   * switch somebody will read as "this is configurable" while it silently disables a message.
   */

  /**
   * A pipeline step actor was clicked (see `focusCard`): jump to the Models tab and reveal the card
   * that configures that step. Restores the "click a model in the viz to go configure it" affordance.
   * The signal is cleared inside `focusModelCard` (in a later task), so writing it there is not a
   * write-during-effect.
   */
  protected readonly focusReaction = effect(() => {
    const cardId = this.s.focusCard();
    if (cardId) this.focusModelCard(cardId);
  });

  ngOnInit(): void {
    this.s.load();
    this.pipeline.load();
  }

  /**
   * Switch to the Models tab (honouring the unsaved-changes guard in `switchTo`) and scroll the named
   * card into view with a brief flash. If the operator cancels the discard prompt we stay put and just
   * clear the request. The scroll is deferred a tick so the tab's cards have rendered.
   */
  private async focusModelCard(cardId: string): Promise<void> {
    await this.switchTo('models');
    if (this.tab() !== 'models') { this.s.focusCard.set(null); return; }  // discard was cancelled
    setTimeout(() => {
      const el = document.getElementById('model-card-' + cardId);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('flash');
        setTimeout(() => el.classList.remove('flash'), 1400);
      }
      this.s.focusCard.set(null);
    }, 80);
  }

  /**
   * Switching tabs with unsaved edits prompts before discarding.
   *
   * The tabs read as navigation, and navigation that silently eats edits is a data-loss bug however
   * small the edit — a typed API key is the case that stings, since it cannot be recovered by
   * remembering what was in the box.
   */
  async switchTo(t: Tab): Promise<void> {
    if (t === this.tab()) return;
    if (this.s.isDirty()) {
      const ok = await this.confirmDialog.confirm({
        title: this.transloco.translate('mediaProcessing.confirm.discardTitle'),
        message: this.transloco.translate('mediaProcessing.confirm.discardMessage'),
        confirmLabel: this.transloco.translate('mediaProcessing.confirm.discardConfirm'),
        cancelLabel: this.transloco.translate('mediaProcessing.confirm.discardCancel'),
        danger: true,
      });
      if (!ok) return;
      // Discarding means going back to what the server has, not keeping the edits around invisibly on
      // a tab the operator can no longer see.
      this.s.load();
    }
    this.tab.set(t);
  }
}
