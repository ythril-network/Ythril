import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { BrainApi } from '../../core/brain-api.service';
import { saveBlob } from '../../core/authenticated-download';
import { SPILL_FAILURE_KEYS, spillRefusalKey, type SpillLink } from '../../core/read-spill';
import { httpErrorReason } from '../../core/http-error';
import { DateFormatService } from '../../core/date-format.service';

/**
 * How a shortened answer's notice ENDS — the one question this answers, for the results notice and the graph
 * notice alike.
 *
 * Exactly one of three: the download of what the server KEPT (with when it expires), WHY nothing was kept when the
 * search asked and the keep was refused, or the notice's own advice when neither applies. Found driving the Query
 * tab (Q-92 verify, 2026-09-28): the refusal sat in a box of its own below a notice that still advised ticking
 * "Keep what did not fit" — two endings that disagreed, and the refusal sentence written out once per notice.
 *
 * The download pages the WHOLE spill through HttpClient, so the interceptor sends the token (a link could not), and
 * tells 404 from 410: unknown, expired or not yours, against evicted early to make room for a newer one.
 */
@Component({
  selector: 'app-spill-ending',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe],
  styles: [`
    :host { display: block; }
    .spill-line { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 6px; font-size: 12px; }
    .note { font-size: 12px; margin-top: 4px; }
  `],
  template: `
    @if (link(); as l) {
      <div class="spill-line">
        <button type="button" class="btn btn-secondary btn-sm" [disabled]="busy()" (click)="download(l)">{{ labelKey() | transloco: labelParams() }}</button>
        <span>{{ 'brain.query.remainder.expires' | transloco: { date: expiresLabel(l.expiresAt) } }}</span>
        @if (extraKey(); as x) { <span>{{ x | transloco }}</span> }
      </div>
      @if (error(); as e) { <div class="alert alert-error note" role="alert">{{ e }}</div> }
    } @else if (refused(); as reason) {
      <div class="note">{{ 'brain.query.spillRefused' | transloco: { reason: (refusalKey(reason) ? (refusalKey(reason)! | transloco) : reason) } }}</div>
    } @else {
      <div class="note">{{ fallbackKey() | transloco }}</div>
    }
  `,
})
export class SpillEndingComponent {
  private brainApi = inject(BrainApi);
  private transloco = inject(TranslocoService);

  /** What the server kept, or null. */
  link = input<SpillLink | null>(null);
  /** Why nothing was kept, as the server said it; only read when there is no link. */
  refused = input<string | null>(null);
  /** The download button's label and its parameters (how many matches or nodes it holds). */
  labelKey = input.required<string>();
  labelParams = input<Record<string, unknown>>({});
  /** A remark after the expiry, such as the graph's ceiling. */
  extraKey = input<string | null>(null);
  /** The notice's own last line when nothing was kept and nothing was refused. */
  fallbackKey = input.required<string>();

  /** A download in flight; the button is disabled until it ends. */
  readonly busy = signal(false);
  /** Why the last download failed, in the reader's language. */
  readonly error = signal<string | null>(null);

  /** A refusal code's words, or null for a code from a newer server, which is shown as it arrived. */
  readonly refusalKey = spillRefusalKey;

  private dates = inject(DateFormatService);

  /** A spill's expiry in the viewer's chosen date format (Q-146), to the second. */
  expiresLabel(value: string): string {
    return this.dates.format(value, 'datetimeSeconds') || value;
  }

  /** Save the WHOLE spill as one JSON file: every page, through HttpClient. */
  download(link: SpillLink): void {
    this.busy.set(true);
    this.error.set(null);
    this.brainApi.readWholeSpill(link.spillId).subscribe({
      next: (whole) => {
        saveBlob(new Blob([JSON.stringify(whole, null, 2)], { type: 'application/json' }), `${whole.kind}-${link.spillId}.json`);
        this.busy.set(false);
      },
      error: (err) => {
        const key = SPILL_FAILURE_KEYS[err?.status];
        this.error.set(key ? this.transloco.translate(key)
          : `${this.transloco.translate('files.downloadFailed')} ${httpErrorReason(err)}`.trim());
        this.busy.set(false);
      },
    });
  }
}
