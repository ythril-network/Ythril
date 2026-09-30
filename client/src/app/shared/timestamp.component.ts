/**
 * Timestamp — one absolute-time treatment for every data table.
 *
 * Date on the first line, time with SECONDS on the second. Owner request, 2026-08-10: *"in data tables timestamps
 * should also show the time rendered in local time below the date with precision: seconds"*. The two-line stack is
 * the treatment the owner approved for the tokens table — *"last used and expires should be date and below
 * time"* — generalised. A relative label needs the absolute one AVAILABLE, not replaced, so this does not compete
 * with `RelativeTime`: use that where "3 minutes ago" is the useful answer and this where the exact moment is.
 *
 * ## The format is the VIEWER's choice now (`Q-146`)
 *
 * This component used to pin `de-DE` so a column could be scanned whatever the browser said. The owner asked for a
 * setting instead (2026-09-29), and a column stays scannable because it is uniform per viewer: every row of it goes
 * through the one preference in `core/date-format.service.ts`. The formatting itself lives in `core/date-format.ts`
 * — the only file allowed to format a date (`testing/one-date-formatter.spec.ts`).
 *
 * ## RENDERING ONLY
 *
 * Owner, 2026-08-10: *"dont change the 'we save utc' stance. just for rendering local"*. `datetime` and the hover
 * carry the ORIGINAL UTC ISO string, so anything reading the DOM — a test, a scraper, a copy-paste — gets UTC, and
 * `sortKey()` returns epoch-ms, because a table sorting on the RENDERED text is how this goes wrong: `01.02.2026`
 * sorts before `02.01.2025` as a string.
 */
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { DateFormatService } from '../core/date-format.service';
import { toEpochMs, type InstantValue } from '../core/date-format';

export type TimestampValue = InstantValue;

@Component({
  selector: 'app-timestamp',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    :host { display: inline-block; font-variant-numeric: tabular-nums; line-height: 1.25; }
    .d { display: block; }
    /* The time is secondary: an operator scans dates first and reads the time on the row they stopped at. Dimmed
       rather than smaller alone, because two lines of identical weight read as two separate values. */
    .t { display: block; font-size: .85em; color: var(--text-muted); }
    .empty { color: var(--text-muted); }
  `],
  template: `
    @if (parts(); as p) {
      <time [attr.datetime]="p.iso" [attr.title]="p.iso">
        <span class="d">{{ p.date }}</span><span class="t">{{ p.time }}</span>
      </time>
    } @else {
      <span class="empty">{{ empty() }}</span>
    }
  `,
})
export class TimestampComponent {
  private readonly dates = inject(DateFormatService);

  value = input.required<TimestampValue>();
  /** What to show when there is no timestamp. A dash, not an empty cell — an empty cell reads as a layout bug. */
  empty = input<string>('—');

  readonly parts = computed(() => this.dates.parts(this.value()));

  /** Epoch-ms, for a caller that sorts a column of these — never the rendered text. */
  readonly sortKey = computed(() => toEpochMs(this.value()));
}
