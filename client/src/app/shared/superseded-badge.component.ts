import { Component, input } from '@angular/core';
import { TranslocoModule } from '@jsverse/transloco';

/**
 * Says that a record is no longer true, wherever a record is listed.
 *
 * ## Why this is a component and not a span at each site
 *
 * It is wanted in five places — the query results and the Facts, Entities, Edges and Chrono tabs — and
 * each of them is a different template written by a different hand. Five copies of `@if (r.superseded)`
 * is five chances to write the condition slightly differently, and the one that reads `@if
 * (r.superseded !== false)` badges every record in the list while looking exactly like the others.
 *
 * **The condition is inside, and it is strict.** `superseded` is only ever written as `true`; absent and
 * `false` both mean current, and neither may badge. The component renders NOTHING in that case, so a
 * caller writes the tag unconditionally and cannot get the test wrong.
 *
 * ## Why no icon
 *
 * An unregistered `<ph-icon name>` renders blank with no error anywhere, so an icon is a thing that can
 * silently disappear from a list. A word cannot.
 *
 * ## What it must not say
 *
 * Not *deleted*, not *hidden*, not *wrong*. The record is still there, still searchable and still returned
 * — it was true once, and that history is usually why it was kept instead of edited. The badge says the one
 * thing an operator needs: do not read this as current.
 */
@Component({
  selector: 'app-superseded-badge',
  standalone: true,
  imports: [TranslocoModule],
  /*
   * `badge-yellow` and NO styles of its own. The global class is mixed from `var(--warning)`, and the
   * comment beside it in `styles.scss` says why that matters: every variant that repeated a semantic colour
   * as a literal could not follow its token, which is what showed red text on a green pill before `#637`.
   * A first draft of this component carried three hardcoded hex fallbacks and would have reproduced it on
   * any theme but the one they were picked against.
   *
   * Warning rather than gray: gray reads as "inactive" and this record is not — it is live, searchable and
   * returned. The badge's job is to catch the eye of somebody about to read it as current.
   */
  template: `
    @if (superseded() === true) {
      <span class="badge badge-yellow" [attr.title]="'brain.superseded.hint' | transloco">
        {{ 'brain.superseded.badge' | transloco }}
      </span>
    }
  `,
})
export class SupersededBadgeComponent {
  /** The record's mark. Absent and `false` both mean current — see the class docblock. */
  readonly superseded = input<boolean | undefined>(undefined);
}
