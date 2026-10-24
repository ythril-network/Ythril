import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import { ForksApi } from '../../core/forks-api.service';
import type { ForkKeep, ForkRow } from '../../core/forks.types';
import { LatestWins } from '../../core/latest-wins';
import { PluralText } from '../../core/plural-text.service';
import { httpErrorReason, refusalText, type RefusalSource } from '../../core/refusal-text';
import { ToastService } from '../../core/toast.service';

/** Forks per page: the size of the other Review lists' pages. */
export const FORKS_PAGE_SIZE = 25;

/** The family a failed resolve's `code` is said under; a code is only a sentence inside its own family. */
const FORK_REFUSALS = 'brain.review.forks.refusal';

/**
 * The Forks section's lists and resolutions: what the Review tab holds for it (bundle-81, design rev 8 section 5).
 *
 * One question: "which forks does this space have, and what happened to the last one resolved". It pages the list by `skip` and `limit`, keeps
 * the newest answer only (a slow answer for a space or page the reviewer has left never replaces the rows on screen), and after a resolve reads
 * the page again from the server, so what is shown is what is stored: a resolve repoints edges and deletes a fork, which the client does not
 * guess. A refusal is kept until dismissed or the list is reloaded, as a refused merge is: it is about one fork in a list the reviewer is working
 * down, and a toast would be gone before they read it. Provided by the Review tab, one per mounted tab.
 */
@Injectable()
export class ReviewForksState {
  private readonly api = inject(ForksApi);
  private readonly transloco = inject(TranslocoService);
  private readonly toast = inject(ToastService);
  private readonly plural = inject(PluralText);
  private readonly latest = new LatestWins(inject(DestroyRef));

  readonly rows = signal<readonly ForkRow[]>([]);
  /** How many forks the space has, or null when the answer does not say. */
  readonly total = signal<number | null>(null);
  readonly skip = signal(0);
  readonly loading = signal(false);
  /** Null until the last load failed: checked before the empty state, so a failure never reads as "no forks". */
  readonly loadError = signal<string | null>(null);
  /** The sentence of the last refused resolve; empty when there is none. */
  readonly refusal = signal('');

  readonly hasPrevious = computed(() => this.skip() > 0);
  readonly hasNext = computed(() => {
    const total = this.total();
    return total !== null ? this.skip() + this.rows().length < total : this.rows().length >= FORKS_PAGE_SIZE;
  });
  /** The range on screen, for the pager's "1-25 of 87". */
  readonly range = computed(() => (this.rows().length ? `${this.skip() + 1}–${this.skip() + this.rows().length}` : '–'));

  /** "1-25 of 87 forks" in the page's language, or the range alone when the answer does not say how many there are. */
  pagerText(): string {
    const total = this.total();
    return total === null ? this.range() : this.plural.text('brain.review.forks.count', total, { range: this.range() });
  }

  /** Read a page of `spaceId`'s forks. `quiet` keeps the rows on screen while it loads (a refresh after a resolve), instead of the spinner. */
  load(spaceId: string, skip = 0, quiet = false): void {
    if (!quiet) this.loading.set(true);
    this.loadError.set(null);
    this.latest.run(this.api.listForks(spaceId, skip, FORKS_PAGE_SIZE), {
      next: page => {
        // A page past the end (the last fork of the last page was just resolved) steps back rather than showing an empty list.
        if (page.forks.length === 0 && skip > 0) { this.load(spaceId, Math.max(0, skip - FORKS_PAGE_SIZE), true); return; }
        this.rows.set(page.forks);
        this.total.set(page.total ?? null);
        this.skip.set(skip);
        this.loading.set(false);
      },
      error: err => { this.loadError.set(httpErrorReason(err)); this.loading.set(false); },
    });
  }

  /** Read the current page again, discarding a refusal that said the list was out of date. */
  reload(spaceId: string): void {
    this.refusal.set('');
    this.load(spaceId, this.skip(), true);
  }

  dismissRefusal(): void { this.refusal.set(''); }

  /** Keep one version of a fork and delete the fork; the page is read again once it is done. */
  resolve(spaceId: string, request: { forkId: string; keep: ForkKeep }): void {
    const row = this.rows().find(r => r.forkId === request.forkId);
    this.refusal.set('');
    this.api.resolveFork(spaceId, request.forkId, request.keep).subscribe({
      next: () => {
        if (row) {
          this.toast.success(this.transloco.translate(request.keep === 'fork' ? 'brain.review.forks.resolvedThis' : 'brain.review.forks.resolvedOther',
            { parent: row.parentId.slice(0, 8), fork: row.forkId.slice(0, 8) }));
        }
        this.load(spaceId, this.skip(), true);
      },
      error: (err: RefusalSource) => {
        // A fork that is already gone (resolved on another instance) is the refusal a reviewer meets most; a code names it, and a bare 404 means it.
        this.refusal.set(err?.status === 404 && !err.error?.code
          ? this.transloco.translate(`${FORK_REFUSALS}.fork_not_found`)
          : refusalText(this.transloco, err, `${FORK_REFUSALS}.generic`, FORK_REFUSALS));
      },
    });
  }
}
