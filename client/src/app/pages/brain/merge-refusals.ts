import { computed, signal, type Signal } from '@angular/core';
import { describeRefusal, type RefusalSource, type RefusalTranslator, type RefusalView } from '../../core/refusal-text';

/**
 * The refusals of duplicate merges, by pair id: held as the answers they were, so each stays on screen until it is dismissed or its merge
 * goes through, and read in the viewer's language.
 *
 * Moved out of `review-tab.component.ts` (frozen by the size ratchet) when personal views needed three lines there: it is one concern, "what
 * a refused merge said", and nothing else in the tab touches it.
 */
export class MergeRefusals {
  private readonly failures = signal<Record<string, RefusalSource>>({});
  /** The same, in words and rows. */
  readonly views: Signal<Record<string, RefusalView>>;

  constructor(transloco: RefusalTranslator) {
    this.views = computed(() =>
      Object.fromEntries(Object.entries(this.failures()).map(([id, failure]) => [id, describeRefusal(transloco, '', failure, 'duplicates.mergeError')])));
  }

  /** Remember what the server said about pair `id`, or forget it (`null`). */
  set(id: string, failure: RefusalSource | null): void {
    this.failures.update(all => {
      const { [id]: _gone, ...rest } = all;
      return failure ? { ...rest, [id]: failure } : rest;
    });
  }
}
