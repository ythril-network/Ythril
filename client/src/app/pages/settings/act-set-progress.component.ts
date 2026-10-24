import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import type { ActSetReport, ActSetSpaceReport, RestoreFileClass } from '../../core/admin-data.types';
import { DateFormatService } from '../../core/date-format.service';
import { actRowView, actWhenText, type ActRowView } from '../../core/space-act-view';
import { SettingsCardComponent } from '../../shared/settings-card.component';
import { StatusPillComponent, type StatusVariant } from '../../shared/status-pill.component';
import { StepProgressBarComponent } from '../../shared/step-progress-bar.component';
import type { StepProgress } from '../../shared/step-progress.model';
import { PluralText } from '../../core/plural-text.service';

/** The colour of a set's state pill, as a pure function of the state the reader sees (a set state, or the client's own `stopped`). */
export function actSetVariant(state: string): StatusVariant {
  return state === 'completed' ? 'ok' : state === 'abandoned' || state === 'stopped' ? 'warn' : 'pending';
}

/** The classes of a restore's files report this client has words for, in the order a reader meets them; others follow, by their raw name. */
const FILE_CLASS_ORDER = ['missing_row', 'stale_row', 'unprocessed', 'row_without_bytes', 'soft_deleted_with_bytes'];

/** What the card says of one restored space's files (`ActSetProgressComponent.filesView`). */
interface FilesView {
  /** The space is not plainly OK: files are out of step, or were not checked. */
  attention: boolean;
  /** Why the check did not run, in the active language; empty when it did. */
  reason: string;
  summary: string;
  groups: { cls: string; text: string; paths: string[] }[];
  /** Some class names fewer paths than it has files. */
  truncated: boolean;
}

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
        @let files = filesView(s);
        <app-status-pill [variant]="files?.attention ? 'warn' : row.variant" [dot]="true">{{ row.stateKey | transloco }}</app-status-pill>
        @if (row.showsAttempts) {
          <span style="color:var(--text-muted);">{{ 'spaces.dangerZone.act.attempts' | transloco: { count: s.attempts } }}</span>
        }
        @if (row.showsNextTry) {
          <span style="color:var(--text-muted);">{{ 'networks.owedActs.nextTry' | transloco: { when: whenText(s) } }}</span>
        }
        @if (s.lastError) { <span style="flex-basis:100%;color:var(--text-secondary);">{{ 'spaces.dangerZone.act.lastError' | transloco }} {{ s.lastError }}</span> }
        @if (s.needsAbandon) { <span style="flex-basis:100%;color:var(--text-secondary);">{{ 'data.progress.needsAbandon' | transloco }}</span> }
        @if (files; as f) {
          @if (f.reason) {
            <span style="flex-basis:100%;color:var(--text-secondary);">{{ f.reason }}</span>
          } @else if (f.groups.length > 0) {
            <span style="flex-basis:100%;color:var(--text-secondary);">{{ f.summary }}</span>
            <details style="flex-basis:100%;color:var(--text-secondary);">
              <summary style="cursor:pointer;">{{ 'data.progress.files.showNames' | transloco }}</summary>
              @for (g of f.groups; track g.cls) {
                <div style="margin:6px 0 2px;font-weight:500;">{{ g.text }} </div>
                @for (p of g.paths; track p) { <div style="overflow-wrap:anywhere;word-break:break-word;font-family:var(--font-mono, monospace);font-size:12px;">{{ p }} </div> }
              }
              <p style="margin:6px 0 0;color:var(--text-muted);font-size:12px;">
                @if (f.truncated) { {{ 'data.progress.files.truncated' | transloco }} }
                {{ 'data.progress.files.syncNote' | transloco }}
              </p>
            </details>
          }
        }
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

  private readonly plural = inject(PluralText);
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
    return actSetVariant(this.setState());
  }

  setStateKey(): string { return `data.progress.state.${this.setState()}`; }

  /** The abandon button's words, and with `Hint` its line: a migrate's abandon is not a restore's ("Abandon migration", the old database stays). */
  abandonKey(): string { return this.kind() === 'migrate' ? 'data.progress.abandonMigrate' : 'data.progress.abandon'; }

  /** The bar's stage label once the set has ended or stopped: it names that (Completed, Abandoned, Stopped), where it said "Working" for ever. */
  endedStageKey(): string | null { return this.setState() === 'running' ? null : this.setStateKey(); }

  // Methods, not computeds: they translate, and a computed would keep the words of a language file that had not loaded yet.
  doneText(): string {
    const r = this.report();
    return this.plural.text('data.progress.spacesDone', r.total, { done: r.done });
  }

  /**
   * What a RESTORE says of one space's files, or null where it says nothing: a migrate's card (its rows carry no such field, and one that
   * did is not shown), a row without the field, and a space checked with nothing out of step. `attention` paints the row's pill a warning,
   * and the words say the same, so the colour is never the only signal. An unknown class (a newer server) keeps its raw name.
   */
  filesView(s: ActSetSpaceReport): FilesView | null {
    const files = this.kind() === 'restore' ? s.files : undefined;
    if (!files) return null;
    if (!files.checked) return { attention: true, reason: this.notCheckedText(files), summary: '', groups: [], truncated: false };
    const entries = Object.entries(files.classes).filter(([, c]) => c.count > 0);
    if (entries.length === 0) return null;
    const known = (cls: string): number => FILE_CLASS_ORDER.indexOf(cls);
    entries.sort(([a], [b]) => (known(a) < 0 ? FILE_CLASS_ORDER.length : known(a)) - (known(b) < 0 ? FILE_CLASS_ORDER.length : known(b)));
    const total = entries.reduce((n, [, c]) => n + c.count, 0);
    return {
      attention: true, reason: '', truncated: entries.some(([, c]) => c.paths.length < c.count),
      summary: this.plural.text('data.progress.files.mismatch', total),
      groups: entries.map(([cls, c]) => ({ cls, text: this.classText(cls, c), paths: c.paths })),
    };
  }

  /**
   * Why a space's files were not checked, in the active language, from the server's code: the server's own `reason` is English, so it is
   * shown only for a code this client has no words for (a newer server), never in place of a translation.
   */
  private notCheckedText(files: { reasonCode?: string; limitMs?: number; reason: string }): string {
    switch (files.reasonCode) {
      case 'timeout': return this.transloco.translate('data.progress.files.notChecked.timeout', { seconds: Math.round((files.limitMs ?? 0) / 1000) });
      case 'failed': return this.transloco.translate('data.progress.files.notChecked.failed');
      default: return this.transloco.translate('data.progress.files.notChecked.other', { reason: files.reason });
    }
  }

  /** One class's sentence, in the plural form of its count; a class this client has no words for is its raw name and its count. */
  private classText(cls: string, c: RestoreFileClass): string {
    // One literal base per class, so the key-coverage gate can see every plural key this reads (a template literal it cannot).
    switch (cls) {
      case 'missing_row': return this.counted('data.progress.files.class.missing_row', c.count);
      case 'stale_row': return this.counted('data.progress.files.class.stale_row', c.count);
      case 'unprocessed': return this.counted('data.progress.files.class.unprocessed', c.count);
      case 'row_without_bytes': return this.counted('data.progress.files.class.row_without_bytes', c.count);
      case 'soft_deleted_with_bytes': return this.counted('data.progress.files.class.soft_deleted_with_bytes', c.count);
      default: return this.counted('data.progress.files.class.unknown', c.count, { name: cls });
    }
  }

  /** A sentence about `count`, in the active language's plural form. */
  private counted(base: string, count: number, params: Record<string, unknown> = {}): string {
    return this.plural.text(base, count, params);
  }

  emptiedText(): string { return this.listText('data.restore.emptied', this.report().emptied); }
  leftOutText(): string { return this.listText('data.restore.leftOut', this.report().leftOut); }

  whenText(s: ActSetSpaceReport): string { return actWhenText(this.transloco, this.dates, s.retryAt, Date.now()); }

  private listText(base: string, spaces: string[] | undefined): string {
    if (!spaces?.length) return '';
    return this.plural.text(base, spaces.length, { spaces: spaces.join(', ') });
  }
}
