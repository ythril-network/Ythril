import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { RefusalView } from '../core/refusal-text';

/**
 * A refused write, rendered so it can be heard and acted on (bundle-23, R6-14).
 *
 * The record editors showed a refusal as one English line in a plain `<div>`: a screen reader was not told it appeared, a
 * twentieth row was silently missing, and a rule showed as its internal name. This is the one element every editor puts it in:
 * `role="alert"` (announced when it appears), the headline, one list item per row (a row the write BROKE and a row the record
 * ALREADY had are told apart in words by `describeRefusal`, and the pre-existing ones are dimmed), and the count of rows the
 * server left out. An answer with no rows (a plain refusal) is its sentence alone.
 *
 * The per-property marking is not here: the properties editor marks the input a row is about (`errors`), from the same view.
 * Row ids are `<idPrefix>-row-<n>`, so a caller can point `aria-describedby` at one.
 */
@Component({
  selector: 'app-refusal-alert',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    :host { display: block; }
    .alert { margin-block-end: 12px; font-size: 13px; }
    .refusal-head { margin: 0; font-weight: 600; }
    .refusal-rows { margin: 4px 0 0; padding-inline-start: 18px; }
    .refusal-rows li { margin-block: 2px; overflow-wrap: anywhere; }
    .refusal-rows li.pre-existing { opacity: 0.85; font-style: italic; }
    .refusal-more { margin: 4px 0 0; }
  `],
  template: `
    @if (view(); as v) {
      <div class="alert alert-error" role="alert">
        @if (v.rows.length) {
          <p class="refusal-head"> {{ v.headline }} </p>
          <ul class="refusal-rows">
            @for (row of v.rows; track $index) {
              <li [id]="idPrefix() + '-row-' + $index" [class.pre-existing]="row.kind === 'preExisting'"> {{ row.text }} </li>
            }
          </ul>
          @if (v.more) { <p class="refusal-more"> {{ v.more }} </p> }
        } @else {
          {{ v.text }}
        }
      </div>
    }
  `,
})
export class RefusalAlertComponent {
  /** The refusal to show; nothing renders while it is null. */
  readonly view = input<RefusalView | null>(null);
  /** Prefix of the row ids, unique on the page (one per surface). */
  readonly idPrefix = input('refusal');
}
