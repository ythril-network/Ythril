/**
 * RelativeTime — "2 hours ago", with the exact instant on hover (settings design system, PR-U1).
 *
 * Renders a locale-aware relative label, tabular-nums, in a machine-readable `<time datetime>`. The hover is the
 * original instant in UTC ISO 8601 (`Q-146`: *"the full ISO UTC value on hover"*), the same as `<app-timestamp>`,
 * so every date on the page answers "exactly when" the same way.
 *
 * The language comes from `DateFormatService`, as a SIGNAL. It used to be `transloco.getActiveLang()` read inside a
 * `computed` — a plain call the computed could not track — so after a switch to Deutsch this kept saying
 * "2 hours ago" until something re-created it (`Q-100`).
 *
 * Usage:  <app-relative-time [value]="token.lastUsed"/>
 */
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { DateFormatService } from '../core/date-format.service';
import type { InstantValue } from '../core/date-format';

@Component({
  selector: 'app-relative-time',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`time { font-variant-numeric: tabular-nums; white-space: nowrap; }`],
  template: `<time [attr.datetime]="iso()" [title]="iso()">{{ rel() }}</time>`,
})
export class RelativeTimeComponent {
  private readonly dates = inject(DateFormatService);
  value = input.required<InstantValue>();

  protected iso = computed(() => this.dates.iso(this.value()));
  // Date.now() is read on each recomputation — fresh enough for settings screens (no live ticking).
  protected rel = computed(() => this.dates.relative(this.value()));
}
