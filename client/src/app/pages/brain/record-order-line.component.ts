import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';

/**
 * The order a Brain list is in, said on the page when no column sort chooses it (bundle-81, design rev 8 section 6a, decision 20).
 *
 * Every Brain list (facts, chrono, entities, edges) defaults to landing order on the server, REST and MCP alike: what landed on this instance
 * most recently, whether written here or arrived from a peer. The tabs send no `sort` and draw no caret while no column is chosen, so without
 * this line the order was unnamed, and "newest first" is not what it is. It says nothing once a column sort is chosen (the caret says which),
 * and nothing while a ranked search answers, whose order is relevance and not landing.
 *
 * One component for the four tabs: the sentence, its explanation and the two conditions it is hidden under are one question ("what order is this
 * list in"), and four copies would drift apart on the next list that gains a sort.
 */
@Component({
  selector: 'app-record-order-line',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe],
  styles: [`
    .order-line { margin: 0 0 6px; font-size: 12px; color: var(--text-muted); }
  `],
  template: `
    @if (!sortField() && !ranked()) {
      <p class="order-line" [attr.title]="'brain.list.order.landingHelp' | transloco">{{ 'brain.list.order.landing' | transloco }}</p>
    }
  `,
})
export class RecordOrderLineComponent {
  /** The column the list is sorted by; empty when no column sort is chosen. */
  readonly sortField = input('');
  /** A ranked (semantic) search is answering: its order is relevance, so no landing order is claimed. */
  readonly ranked = input(false);
}
