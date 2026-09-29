/**
 * Which of the selected node's linked records does the side panel show right now?
 *
 * The filter state (a kind and a text), the view it asks the row pipeline for, and the two lists it narrows.
 * `graph-details.ts` holds the pure row pipeline; this is the reactive state over it, which is why it is a small
 * class of signals rather than more functions there.
 *
 * Split out of `graph.component.ts` when it exceeded its size limit (`Q-162`). The rows themselves stay on the
 * component (`allDetails`, `filteredDetails`), where `graph.component.characterization.spec.ts` pins them, and
 * are handed in as `survivors` — the rows the pipeline kept for `view()`.
 *
 * The lists render `Fact`/`ChronoEntry` records, not `DetailRow`s, and that matters: a chrono row shows
 * `startsAt` (when the thing happens) while a `DetailRow` only carries `createdAt` (when it was written). Feeding
 * rows straight through would silently swap the date on every chrono entry. So the tested pipeline decides WHICH
 * records survive, and the records themselves still supply what is drawn.
 */
import { computed, signal, type Signal } from '@angular/core';
import type { Fact, ChronoEntry } from '../../core/api.types';
import type { DetailRow, DetailView } from './graph-details';

export class GraphDetailFilter {
  readonly type = signal<'all' | 'fact' | 'chrono'>('all');
  readonly text = signal('');

  /*
   * The sort arguments are FIXED, and saying so is the honest version of what was already happening. Nothing
   * could change them once the detail table moved to `graph-linked-records`, which filters but does not sort —
   * and the order is discarded anyway, because the only reader of this turns it into a Set of ids.
   */
  readonly view = computed<DetailView>(() => ({ type: this.type(), text: this.text(), field: 'createdAt', asc: false }));

  /** True when the panel is showing less than everything — drives the "no matches" empty state. */
  readonly active = computed(() => this.type() !== 'all' || this.text().trim() !== '');

  private readonly visibleIds = computed<Set<string>>(() => new Set(this.survivors().map(r => r.id)));

  readonly visibleFacts = computed<Fact[]>(() => {
    if (!this.active()) return this.facts();
    const ids = this.visibleIds();
    return this.facts().filter(m => ids.has(m._id));
  });

  readonly visibleChrono = computed<ChronoEntry[]>(() => {
    if (!this.active()) return this.chrono();
    const ids = this.visibleIds();
    return this.chrono().filter(c => ids.has(c._id));
  });

  constructor(
    private readonly facts: Signal<Fact[]>,
    private readonly chrono: Signal<ChronoEntry[]>,
    private readonly survivors: () => DetailRow[],
  ) {}

  /** Back to showing everything — what a new selection starts from. */
  reset(): void {
    this.type.set('all');
    this.text.set('');
  }
}
