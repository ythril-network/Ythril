import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import type { CompletenessCheck } from '../../core/api.types';
import { BrainApi } from '../../core/brain-api.service';
import { LatestWins } from '../../core/latest-wins';
import { SpacesApi } from '../../core/spaces-api.service';

/**
 * The Suggestions sub-tab's report: what the Review tab holds for the space's completeness (design: space completeness, part B).
 *
 * One question: "what does the completeness report say, and with the samples in words a reviewer can act on". Overview shows the score and its three
 * heaviest deductions; the Suggestions sub-tab is where the whole report lives. A raw entity UUID is not a finding anyone can act on, so the
 * entity-scoped samples are looked up by name; that lookup is best-effort, and a failure leaves the ids, which still identify the records.
 *
 * It keeps the newest answer only (`LatestWins`, one slot per destination): a slow answer for a space the reviewer has left never replaces the report
 * on screen. A failed load is its own state, never an empty list: a failure must not render as a perfect space. Provided by the Review tab, one per
 * mounted tab, as the forks state is.
 */
@Injectable()
export class ReviewCompletenessState {
  private readonly spacesApi = inject(SpacesApi);
  private readonly brainApi = inject(BrainApi);
  private readonly report = new LatestWins(inject(DestroyRef));
  private readonly names = new LatestWins(inject(DestroyRef));

  readonly loading = signal(false);
  readonly error = signal(false);
  readonly score = signal<number | null>(null);
  readonly truncated = signal(false);
  readonly checks = signal<CompletenessCheck[]>([]);
  /** Entity id → name, for the samples that are record ids rather than schema keys. */
  readonly entityNames = signal<Record<string, string>>({});

  /** Costing points, heaviest loss first — what a reviewer came here to work through. */
  readonly failing = computed(() => this.checks()
    .filter(c => c.earned < c.weight)
    .sort((a, b) => (b.weight - b.earned) - (a.weight - a.earned)));

  /** Everything already clean. Listed, not hidden: on a healthy space this is the whole answer, and an
   *  empty page would read as "we checked nothing" rather than "nothing is wrong". */
  readonly passing = computed(() => this.checks().filter(c => c.earned >= c.weight));

  /** A sample entry rendered for a human: an entity id becomes its name, everything else is already one. */
  sampleLabel(check: CompletenessCheck, value: string): string {
    if (check.scope !== 'entity' || check.id !== 'entity-without-edges') return value;
    return this.entityNames()[value] ?? value;
  }

  /** How much of this check's weight the space kept, as a percentage — the card's bar. */
  earnedPct(c: CompletenessCheck): number {
    return c.weight > 0 ? Math.round((c.earned / c.weight) * 100) : 100;
  }

  /** Read the report of `spaceId`; an answer for a space read since is dropped. */
  load(spaceId: string): void {
    if (!spaceId) return;
    this.loading.set(true);
    this.error.set(false);
    this.report.run(this.spacesApi.getCompleteness(spaceId), {
      next: r => {
        this.score.set(r.score);
        this.checks.set(r.checks);
        this.truncated.set(r.truncated);
        this.loading.set(false);
        this.resolveEntitySamples(spaceId, r.checks);
      },
      // A failed load must not render as a perfect space. Surface it and show nothing else.
      error: () => { this.error.set(true); this.loading.set(false); },
    });
  }

  /** Turn the entity-id samples into names. Best-effort: a failure leaves the ids, which still identify the records — degraded, not broken. */
  private resolveEntitySamples(spaceId: string, checks: CompletenessCheck[]): void {
    const ids = checks.filter(c => c.id === 'entity-without-edges').flatMap(c => c.sample);
    if (!ids.length) { this.names.cancel(); this.entityNames.set({}); return; }
    this.names.run(this.brainApi.getEntitiesByIds(spaceId, ids), {
      next: r => this.entityNames.set(Object.fromEntries(r.entities.map(e => [e._id, e.name]))),
      error: () => this.entityNames.set({}),
    });
  }
}
