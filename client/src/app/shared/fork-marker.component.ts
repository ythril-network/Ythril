import { Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import type { ForkKind } from '../core/forks.types';

/**
 * Says that a listed record is one of two versions kept for a decision, and goes to where it is decided (Q-624 design §11).
 *
 * ## Why this is a component and not a span at each site
 *
 * A fork row is listed in Facts, Entities, Edges and Chrono, each a template written by a different hand (the superseded badge is wanted in the same four
 * places, for the same reason). Four copies of `@if (row.forkOf)` are four chances to badge a row that is no fork, or to leave one that is looking like
 * a duplicate the reader should delete.
 *
 * **The condition is inside, and it is strict.** A row is a fork when `forkOf` is a non-empty string (the server stores it as one and never as anything
 * else); absent, empty and any other value render NOTHING, so a caller writes the tag unconditionally and cannot get the test wrong.
 *
 * ## What it says, and where it goes
 *
 * It uses the app's own words: the thing is a "fork" and its place is Review, Forks (`brain.review.forks.*`, `brain.tab.review`). It links to
 * `?tab=review&section=forks&forkKind=<kind>`, merged into the Brain's own query (the space stays), which the Review tab reads on opening and answers by
 * showing the Forks section with the row's kind chosen. The kind is the caller's because a row does not carry its own.
 */
@Component({
  selector: 'app-fork-marker',
  standalone: true,
  imports: [RouterLink, TranslocoPipe],
  template: `
    @if (isFork()) {
      <a class="badge badge-yellow fork-marker" [routerLink]="['/brain']" queryParamsHandling="merge"
         [queryParams]="{ tab: 'review', section: 'forks', forkKind: kind() }"
         [attr.title]="'brain.review.forks.markerOpen' | transloco" [attr.aria-label]="'brain.review.forks.markerOpen' | transloco">
        {{ 'brain.review.forks.marker' | transloco }}
      </a>
    }
  `,
  styles: [`.fork-marker { text-decoration: none; }`],
})
export class ForkMarkerComponent {
  /** The row's `forkOf`: the id of the record it is a version of. Anything but a non-empty string means the row is no fork. */
  readonly forkOf = input<unknown>(undefined);
  /** The kind of record the row is: which kind Review's Forks section is opened on. */
  readonly kind = input.required<ForkKind>();

  protected readonly isFork = computed(() => { const of = this.forkOf(); return typeof of === 'string' && of !== ''; });
}
