/**
 * Instant — one timestamp on one line, in the viewer's chosen format, with the exact UTC instant on hover (`Q-146`).
 *
 * The inline counterpart of `<app-timestamp>` (two lines, for table cells) and `<app-relative-time>` ("2 hours
 * ago"). It replaced the Angular `date` pipe wherever a date sat in running text — a drawer's Created field, a
 * member's last sync, a change note's time — so the Date and time preference reaches those too, and each of them
 * answers "exactly when" the same way: `datetime` and the hover carry the original UTC ISO string.
 *
 * Inside a translation parameter, where an element cannot go, use the `instant` pipe from
 * `core/date-format.service.ts` instead.
 *
 * Usage:  <app-instant [value]="record.createdAt" variant="datetimeSeconds"/>
 */
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { DateFormatService } from '../core/date-format.service';
import type { InstantValue, InstantVariant } from '../core/date-format';

@Component({
  selector: 'app-instant',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`time { font-variant-numeric: tabular-nums; }`],
  template: `@if (iso()) {<time [attr.datetime]="iso()" [attr.title]="iso()">{{ text() }}</time>}`,
})
export class InstantComponent {
  private readonly dates = inject(DateFormatService);
  value = input.required<InstantValue>();
  variant = input<InstantVariant>('datetime');

  protected iso = computed(() => this.dates.iso(this.value()));
  protected text = computed(() => this.dates.format(this.value(), this.variant()));
}
