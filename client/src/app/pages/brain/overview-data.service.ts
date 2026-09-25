import { Injectable, inject, signal } from '@angular/core';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { SpacesApi } from '../../core/spaces-api.service';
import { BrainApi } from '../../core/brain-api.service';
import { NetworksApi } from '../../core/networks-api.service';
import type { CompletenessReport, EmbeddingQueue, SpaceActivity, TokenAccessEntry, VoteRound } from '../../core/api.types';

/** Just the shape `loadOverviewVotes` needs — the shell knows about SpaceView; this service must not. */
export interface SpaceNetworkRef { id: string }

/**
 * The Overview panel's data: five loaders, their five signals, and the pending flags that drive the skeletons.
 *
 * ## Why this is not in the Brain shell any more
 *
 * `brain.component.ts` crossed the god-file ceiling at 659 lines and it is the SHELL — it owns the tab strip,
 * the space chips, every panel's inputs and eight tabs' worth of orchestration. Shaving handlers would have
 * lowered the number while leaving the shape; moving one tab's data out is the split that changes it.
 *
 * ## The two things it deliberately does NOT own
 *
 * `activeSpaceId` arrives as a callback per load, not as state. A response for a space the user has left must
 * be discarded, and that question belongs to whoever owns the selection — holding a copy here would be a
 * second answer to it, able to disagree with the shell's.
 *
 * `loadOverviewVotes` takes the space's networks directly rather than reaching into a space list. It then
 * knows nothing about `SpaceView`, which is a shell concept.
 *
 * ## The invariant that survived the move
 *
 * The guard gates the RESULT, never the skeleton: a discarded response still clears its pending flag. Getting
 * that half wrong left every quiet space's usage card spinning for ever, which is what the characterization
 * tests written before this move exist to catch.
 */
@Injectable()
export class OverviewDataService {
  private spacesApi = inject(SpacesApi);
  private brainApi = inject(BrainApi);
  private networksApi = inject(NetworksApi);

  /** Embedding-job backlog for the ACTIVE space (Overview embedding-queue panel); refreshed on space switch + live events. */
  embeddingQueue = signal<EmbeddingQueue | null>(null);

  /** Open governance votes across the ACTIVE space's networks (Overview Governance panel). */
  overviewVotes = signal<VoteRound[]>([]);

  /** Tokens that can reach the ACTIVE space (Overview token-access matrix). Null unless the caller is
   *  admin — the endpoint 403s otherwise, so a null keeps the panel hidden for non-admins. */
  tokenAccess = signal<TokenAccessEntry[] | null>(null);

  /** Completeness report for the ACTIVE space (Overview panel). Null until it lands or on failure —
   *  a governance panel that cannot load is hidden, not rendered as a zero. */
  completeness = signal<CompletenessReport | null>(null);

  /**
   * This space's usage over the window below — one already-summed row, so a proxy space reports the total of
   * its members rather than a list the panel would have to add up itself.
   */
  spaceActivity = signal<SpaceActivity | null>(null);

  /**
   * Which Overview panels have been blanked for a space switch and are still awaiting their first answer.
   *
   * The Overview's cards each render only when their own value arrives, so the board assembled itself one card at
   * a time and every arrival pushed the ones below it down — the milder half of a canary flicker report. A
   * skeleton at the card's final size fixes that, but only if it can tell "not yet" from "never".
   *
   * `null` alone cannot: `tokenAccess` is null **permanently** for a non-admin (the endpoint 403s), and
   * `completeness` is null after a failure. A skeleton keyed on null would sit there forever in both cases.
   *
   * So pending is set ONLY where the value is blanked — in `selectSpace` — and cleared by both the success and
   * the failure handler. It is deliberately not set by the live-event refresh: that has good data on screen, and
   * covering it with a skeleton would be the same defect this exists to remove.
   */
  overviewPending = signal<Record<'activity' | 'completeness' | 'queue' | 'tokens', boolean>>({
    // `stats` and `about` left with the statistics strip and the Instance card (owner, 2026-08-08). `about`
    // was the one key with a different lifetime — fetched once at init, cleared exactly once — and that
    // asymmetry is gone with the panel it existed for.
    activity: false, completeness: false, queue: false, tokens: false,
  });

  /** Clear one panel's pending flag — called from both handlers of each loader, success or failure. */
  private settled(key: 'activity' | 'completeness' | 'queue' | 'tokens'): void {
    if (!this.overviewPending()[key]) return;
    this.overviewPending.update(p => ({ ...p, [key]: false }));
  }

  /**
   * Usage over the last 7 days, for the Overview's usage panel.
   *
   * A week rather than a day on purpose: "is this space useful" is a question about a habit, and a space that
   * is queried every Monday reads as dead in a 24-hour window.
   *
   * The endpoint returns one row per member space; they are summed here so the panel receives a single row.
   * Summing in the shell rather than server-side keeps the endpoint honest for an API caller who wants to see
   * WHICH member of a proxy is carrying it.
   */
  loadSpaceActivity(spaceId: string, isActive: () => boolean): void {
    this.spacesApi.getSpaceActivity(spaceId, 7 * 24).subscribe({
      next: r => {
        // Settle even when the answer is discarded. The guard gates the RESULT, never the skeleton: a stale
        // response that returned outright left this panel spinning until the next space switch.
        if (!isActive()) { this.settled('activity'); return; }
        const rows = r.spaces ?? [];
        if (rows.length === 0) {
          // An empty window is still an answer — "nothing was asked" — so the panel must render, not vanish.
          this.spaceActivity.set({
            space: spaceId, calls: 0, recall: 0, answered: 0, writes: 0,
            meanMs: null, maxMs: 0, over1s: 0, meanTopScore: null, lastUsedAt: null,
          });
          // The skeleton comes down here too. It did not, so a space with NO recorded usage showed its usage
          // card spinning for ever — and after the reset button clears the buckets, every space lands in exactly
          // this branch on the next load. Found by a characterization test written for an unrelated refactor.
          this.settled('activity');
          return;
        }
        const sum = (pick: (row: SpaceActivity) => number) => rows.reduce((t, row) => t + pick(row), 0);
        const calls = sum(r2 => r2.calls);
        const answered = sum(r2 => r2.answered);
        // Means are recombined from their weights, never averaged: averaging per-space means would give a
        // one-call member the same say as a thousand-call one.
        const weightedMs = rows.reduce((t, row) => t + (row.meanMs ?? 0) * row.calls, 0);
        const weightedScore = rows.reduce((t, row) => t + (row.meanTopScore ?? 0) * row.answered, 0);
        const lastUsed = rows.map(r2 => r2.lastUsedAt).filter((v): v is string => !!v).sort().at(-1) ?? null;
        this.spaceActivity.set({
          space: spaceId,
          calls,
          recall: sum(r2 => r2.recall),
          answered,
          writes: sum(r2 => r2.writes),
          meanMs: calls > 0 ? Math.round(weightedMs / calls) : null,
          maxMs: rows.reduce((m, row) => Math.max(m, row.maxMs), 0),
          over1s: sum(r2 => r2.over1s),
          meanTopScore: answered > 0 ? Number((weightedScore / answered).toFixed(3)) : null,
          lastUsedAt: lastUsed,
        });
        this.settled('activity');
      },
      // A failure leaves the signal null and the panel does not render — the same rule completeness follows.
      error: () => { if (isActive()) this.spaceActivity.set(null); this.settled('activity'); },
    });
  }

  /** Fetch the completeness report for a space (Overview panel). Only stores it while that space is
   *  still active; a failure leaves the signal null and the panel simply does not render. */
  loadCompleteness(spaceId: string, isActive: () => boolean): void {
    this.spacesApi.getCompleteness(spaceId).subscribe({
      next: r => { if (isActive()) this.completeness.set(r); this.settled('completeness'); },
      error: () => { if (isActive()) this.completeness.set(null); this.settled('completeness'); },
    });
  }

  /** Fetch the embedding-job backlog for a space; only stores it while that space is still active. */
  loadEmbeddingQueue(spaceId: string, isActive: () => boolean): void {
    this.brainApi.getEmbeddingQueue(spaceId).subscribe({
      next: q => { if (isActive()) this.embeddingQueue.set(q); this.settled('queue'); },
      // A failed refresh keeps the last good value on purpose; it only has to stop the skeleton.
      error: () => this.settled('queue'),
    });
  }

  /** Fetch the token-access matrix for a space (Overview panel). ADMIN-only: a 403 for a non-admin
   *  caller leaves the signal null, which keeps the panel hidden. Only stores it while still active. */
  loadTokenAccess(spaceId: string, isActive: () => boolean): void {
    this.brainApi.getTokenAccess(spaceId).subscribe({
      next: r => { if (isActive()) this.tokenAccess.set(r.tokens); this.settled('tokens'); },
      // A 403 for a non-admin lands here and is permanent — clearing pending is what stops a forever-skeleton.
      error: () => { if (isActive()) this.tokenAccess.set(null); this.settled('tokens'); },
    });
  }

  /** Fetch OPEN governance votes across the space's networks (Overview Governance panel). One listVotes
   *  per network the space belongs to; only stores the result while that space is still active. */
  loadOverviewVotes(isActive: () => boolean, networks: SpaceNetworkRef[]): void {
    const nets = networks;
    if (nets.length === 0) { this.overviewVotes.set([]); return; }
    forkJoin(nets.map(n => this.networksApi.listVotes(n.id).pipe(
      catchError(() => of({ rounds: [] as VoteRound[] })), // one unreachable network must not hide the rest
    ))).subscribe({
      next: results => {
        if (!isActive()) return;
        const open = results.flatMap(r => r.rounds).filter(v => v.status === 'open');
        this.overviewVotes.set(open);
      },
      error: () => {},
    });
  }

  /**
   * Blank every panel and raise its pending flag — the ONE place pending goes up.
   *
   * Deliberately not called by the live-event refresh: that has good data on screen already, and covering it
   * with a skeleton is the flicker this whole mechanism exists to remove.
   */
  blankForSpaceSwitch(): void {
    this.embeddingQueue.set(null);
    this.overviewVotes.set([]);
    this.tokenAccess.set(null);
    this.completeness.set(null);
    this.spaceActivity.set(null);
    this.overviewPending.update(p => ({ ...p, activity: true, completeness: true, queue: true, tokens: true }));
  }

  /** Every Overview loader for one space, in one call — so a caller cannot start four of the five. */
  loadAll(spaceId: string, isActive: () => boolean, networks: SpaceNetworkRef[]): void {
    this.loadEmbeddingQueue(spaceId, isActive);
    this.loadOverviewVotes(isActive, networks);
    this.loadTokenAccess(spaceId, isActive);
    this.loadCompleteness(spaceId, isActive);
    this.loadSpaceActivity(spaceId, isActive);
  }
}
