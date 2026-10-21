import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import type { ActSetReport, ActSetSpaceReport } from '../../core/admin-data.types';
import { DateFormatService } from '../../core/date-format.service';
import { pluralText } from '../../core/plural-text';
import { actRowView, actWhenText, type ActRowView } from '../../core/space-act-view';
import { SettingsCardComponent } from '../../shared/settings-card.component';
import { StatusPillComponent, type StatusVariant } from '../../shared/status-pill.component';
import { StepProgressBarComponent } from '../../shared/step-progress-bar.component';
import type { StepProgress } from '../../shared/step-progress.model';

/** A report that may name the spaces a restore emptied or left out (a migrate's names neither). */
type ShownReport = ActSetReport & { emptied?: string[]; leftOut?: string[] };

/**
 * A restore or a migrate as it runs, on the Data page (bundle-157, R5.3): k of n spaces as a progress bar (role=progressbar), and one row
 * per space with its state, tries, our sentence for its last failure and when it is tried next. For a running set (a restore or a
 * migrate) with an owed space, the abandon button: the page confirms and calls the kind's door; this card only offers it.
 *
 * The rows are the Networks page's owed-acts rows (`network-owed-acts`), with the same words from `space-act-view`, so one owed act is
 * never described in two vocabularies. The poll that feeds it lives with the page, which knows when it is open.
 */
@Component({
  selector: 'app-act-set-progress',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, SettingsCardComponent, StatusPillComponent, StepProgressBarComponent],
  template: `
<app-settings-card icon="arrows-clockwise" [heading]="(kind() === 'migrate' ? 'data.progress.migrateTitle' : 'data.progress.restoreTitle') | transloco"
  [purpose]="(kind() === 'migrate' ? 'data.progress.migratePurpose' : 'data.progress.restorePurpose') | transloco">
  <app-status-pill pill [variant]="setVariant()" [dot]="true">{{ setStateKey() | transloco }}</app-status-pill>
  <div style="margin:4px 0 10px;"><app-step-progress-bar [progress]="progress()" [stageLabelKey]="endedStageKey()"/></div>
  <p style="margin:0 0 8px;font-size:13px;">{{ doneText() }}</p>
  @if (halted()) {
    <p class="alert alert-warning" role="alert" style="margin:0 0 8px;font-size:13px;">{{ 'data.progress.migrateStopped' | transloco }}</p>
  }
  @if (report().lastError; as e) { <p style="color:var(--text-secondary);margin:0 0 8px;font-size:13px;">{{ 'spaces.dangerZone.act.lastError' | transloco }} {{ e }}</p> }
  @if (emptiedText(); as t) { <p style="color:var(--text-muted);margin:0 0 6px;font-size:12.5px;">{{ t }}</p> }
  @if (leftOutText(); as t) { <p style="color:var(--text-muted);margin:0 0 6px;font-size:12.5px;">{{ t }}</p> }
  <ul style="list-style:none;margin:0;padding:0;">
    @for (s of report().spaces; track s.id) {
      <li style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;">
        <span style="font-weight:500;">{{ s.id }}</span>
        @let row = rowView(s);
        <app-status-pill [variant]="row.variant" [dot]="true">{{ row.stateKey | transloco }}</app-status-pill>
        @if (row.showsAttempts) {
          <span style="color:var(--text-muted);">{{ 'spaces.dangerZone.act.attempts' | transloco: { count: s.attempts } }}</span>
        }
        @if (row.showsNextTry) {
          <span style="color:var(--text-muted);">{{ 'networks.owedActs.nextTry' | transloco: { when: whenText(s) } }}</span>
        }
        @if (s.lastError) { <span style="flex-basis:100%;color:var(--text-secondary);">{{ 'spaces.dangerZone.act.lastError' | transloco }} {{ s.lastError }}</span> }
        @if (s.needsAbandon) { <span style="flex-basis:100%;color:var(--text-secondary);">{{ 'data.progress.needsAbandon' | transloco }}</span> }
      </li>
    }
  </ul>
  @if (canAbandon()) {
    <div style="margin-top:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
      <button class="btn btn-danger btn-sm" type="button" [disabled]="abandoning()" [attr.aria-busy]="abandoning()" (click)="abandon.emit()">
        @if (abandoning()) { <span class="spinner spinner-sm"></span> }{{ abandonKey() | transloco }}
      </button>
      <span style="color:var(--text-muted);font-size:12.5px;">{{ (abandonKey() + 'Hint') | transloco }}</span>
    </div>
  }
</app-settings-card>
`,
})
export class ActSetProgressComponent {
  /** `restore` or `migrate`: the set's kind, as the server names it. */
  readonly kind = input.required<string>();
  readonly report = input.required<ShownReport>();
  readonly abandoning = input(false);
  readonly abandon = output<void>();
  /** A migrate ends by exiting the process: true once its report can no longer be reached, so the card says the instance has stopped. */
  readonly stopped = input(false);

  private readonly transloco = inject(TranslocoService);
  private readonly dates = inject(DateFormatService);

  /** The process that runs a migrate has exited while the report still says running: nothing here is running any more. */
  readonly halted = computed(() => this.stopped() && this.kind() === 'migrate' && this.report().state === 'running');

  /** One row, by the one rule (`actRowView`); a halted set shows no unfinished space as running. */
  rowView(s: ActSetSpaceReport): ActRowView { return actRowView({ ...s, stopped: this.halted() }); }

  /** k of n as the shared bar draws it: one stage, the spaces done of the spaces in the set. */
  readonly progress = computed<StepProgress>(() => ({ step: this.kind(), steps: [this.kind()], done: this.report().done, total: this.report().total }));

  /**
   * Abandon is offered for a running set with an owed space, of either kind (a migrate whose target keeps timing out is owed for ever
   * without it, Q-564): the case the server accepts it for and that needs it. Not for a halted migrate: its process has exited.
   */
  readonly canAbandon = computed(() =>
    !this.halted() && this.report().state === 'running' && this.report().spaces.some(s => s.state === 'owed'));

  /** Where the set stands for the reader: the report's state, except that a halted migrate is Stopped. */
  private setState(): string { return this.halted() ? 'stopped' : this.report().state; }

  setVariant(): StatusVariant {
    const s = this.setState();
    return s === 'completed' ? 'ok' : s === 'abandoned' || s === 'stopped' ? 'warn' : 'pending';
  }

  setStateKey(): string { return `data.progress.state.${this.setState()}`; }

  /** The abandon button's words, and with `Hint` its line: a migrate's abandon is not a restore's ("Abandon migration", the old database stays). */
  abandonKey(): string { return this.kind() === 'migrate' ? 'data.progress.abandonMigrate' : 'data.progress.abandon'; }

  /** The bar's stage label once the set has ended or stopped: it names that (Completed, Abandoned, Stopped), where it said "Working" for ever. */
  endedStageKey(): string | null { return this.setState() === 'running' ? null : this.setStateKey(); }

  // Methods, not computeds: they translate, and a computed would keep the words of a language file that had not loaded yet.
  doneText(): string {
    const r = this.report();
    return pluralText(this.transloco, this.transloco.getActiveLang(), 'data.progress.spacesDone', r.total, { done: r.done });
  }

  emptiedText(): string { return this.listText('data.restore.emptied', this.report().emptied); }
  leftOutText(): string { return this.listText('data.restore.leftOut', this.report().leftOut); }

  whenText(s: ActSetSpaceReport): string { return actWhenText(this.transloco, this.dates, s.retryAt, Date.now()); }

  private listText(base: string, spaces: string[] | undefined): string {
    if (!spaces?.length) return '';
    return pluralText(this.transloco, this.transloco.getActiveLang(), base, spaces.length, { spaces: spaces.join(', ') });
  }
}
