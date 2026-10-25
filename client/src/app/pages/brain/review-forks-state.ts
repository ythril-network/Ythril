import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import { ForksApi } from '../../core/forks-api.service';
import { FORK_KINDS, type ForkCounts, type ForkKeep, type ForkKind, type ForkKindsFields, type ForkMarkedCounts, type ForkRow } from '../../core/forks.types';
import { LatestWins } from '../../core/latest-wins';
import { PluralText } from '../../core/plural-text.service';
import { httpErrorReason, refusalText, type RefusalSource } from '../../core/refusal-text';
import { ToastService } from '../../core/toast.service';

/** Forks per page: the size of the other Review lists' pages. */
export const FORKS_PAGE_SIZE = 25;

/** The family a failed resolve's `code` is said under; a code is only a sentence inside its own family. */
const FORK_REFUSALS = 'brain.review.forks.refusal';

/** The first kind, in the order Review lists them, that has forks; undefined when none does. */
export function firstKindWithForks(counts: ForkCounts | null | undefined): ForkKind | undefined {
  return counts ? FORK_KINDS.find(kind => counts[kind] > 0) : undefined;
}

/**
 * The Forks section's lists and resolutions: what the Review tab holds for it (bundle-81, design rev 8 section 5; every kind, Q-624).
 *
 * One question: "which forks of the chosen kind does this space have, and what happened to the last one resolved". The list is read one kind at a
 * time, paged by `skip` and `limit`, so a page is always the chosen kind's and the answer's `counts` (per kind, over the whole space) say what the
 * other kinds hold. The first read asks for no kind: the counts decide which kind to open on (the first that has forks), and only a page that holds
 * rows of another kind is read again. It keeps the newest answer only (a slow answer for a space, kind or page the reviewer has left never replaces the
 * rows on screen), and after a resolve reads the page again from the server, so what is shown is what is stored: a resolve repoints edges and deletes
 * a fork, which the client does not guess. A resolve names the kind and the two versions of the row ON SCREEN, as that page read them, so a record
 * edited since is refused rather than overwritten. A refusal is kept until dismissed or the list is reloaded, as a refused merge is: it is about one
 * fork in a list the reviewer is working down, and a toast would be gone before they read it. Provided by the Review tab, one per mounted tab.
 */
@Injectable()
export class ReviewForksState {
  private readonly api = inject(ForksApi);
  private readonly transloco = inject(TranslocoService);
  private readonly toast = inject(ToastService);
  private readonly plural = inject(PluralText);
  private readonly latest = new LatestWins(inject(DestroyRef));

  readonly rows = signal<readonly ForkRow[]>([]);
  /** The kind on screen; null until the first answer has said which kind has forks. */
  readonly kind = signal<ForkKind | null>(null);
  /** Forks per kind over the whole space, or null when the answer does not say. */
  readonly counts = signal<ForkCounts | null>(null);
  /** Per kind, how many of the counted forks another instance decided already. */
  readonly marked = signal<ForkMarkedCounts | null>(null);
  /** The fields each kind compares, as the answer says them; null when it does not. */
  readonly kinds = signal<ForkKindsFields | null>(null);
  /** How many forks one record may hold, as the list's answer says it; null when it does not. */
  readonly maxForksPerRecord = signal<number | null>(null);
  readonly skip = signal(0);
  readonly loading = signal(false);
  /** True while the page of a newly chosen kind is on its way: the switch stays, the list says it is waiting instead of "nothing to review". */
  readonly kindLoading = signal(false);
  /** Null until the last load failed: checked before the empty state, so a failure never reads as "no forks". */
  readonly loadError = signal<string | null>(null);
  /** The sentence of the last refused resolve; empty when there is none. */
  readonly refusal = signal('');

  private readonly pageTotal = signal<number | null>(null);

  /** How many forks the space has in all kinds, or null when the answer does not say. */
  readonly total = computed(() => {
    const counts = this.counts();
    return counts ? FORK_KINDS.reduce((sum, kind) => sum + counts[kind], 0) : this.pageTotal();
  });
  /** How many forks the kind on screen has, which is what the pager pages through. */
  readonly kindTotal = computed(() => {
    const kind = this.kind();
    const counts = this.counts();
    return counts && kind ? counts[kind] : this.pageTotal();
  });

  readonly hasPrevious = computed(() => this.skip() > 0);
  readonly hasNext = computed(() => {
    const total = this.kindTotal();
    return total !== null ? this.skip() + this.rows().length < total : this.rows().length >= FORKS_PAGE_SIZE;
  });
  /** The range on screen, for the pager's "1-25 of 87". */
  readonly range = computed(() => (this.rows().length ? `${this.skip() + 1}–${this.skip() + this.rows().length}` : '–'));

  /** "1-25 of 87 forks" in the page's language, or the range alone when the answer does not say how many there are. */
  pagerText(): string {
    const total = this.kindTotal();
    return total === null ? this.range() : this.plural.text('brain.review.forks.count', total, { range: this.range() });
  }

  /** Read a page of `spaceId`'s forks of the kind on screen. `quiet` keeps the rows on screen while it loads (a refresh after a resolve), instead of the spinner. */
  load(spaceId: string, skip = 0, quiet = false): void {
    if (!quiet) this.loading.set(true);
    this.loadError.set(null);
    const asked = this.kind();
    this.latest.run(this.api.listForks(spaceId, skip, FORKS_PAGE_SIZE, asked ?? undefined), {
      next: page => {
        // A page past the end (the last fork of the last page was just resolved) steps back rather than showing an empty list.
        if (page.forks.length === 0 && skip > 0) { this.load(spaceId, Math.max(0, skip - FORKS_PAGE_SIZE), true); return; }
        this.counts.set(page.counts ?? null);
        this.marked.set(page.resolvedElsewhere ?? null);
        this.kinds.set(page.kinds ?? null);
        this.pageTotal.set(page.total ?? null);
        this.maxForksPerRecord.set(page.maxForksPerRecord ?? null);
        // The first read named no kind: open on the first one that has forks, and read that kind's pages if this one holds rows of others.
        const chosen = asked ?? firstKindWithForks(page.counts) ?? page.forks[0]?.kind ?? 'fact';
        this.kind.set(chosen);
        if (asked === null && page.forks.some(r => r.kind !== chosen)) { this.load(spaceId, 0, quiet); return; }
        this.rows.set(page.forks);
        this.skip.set(skip);
        this.loading.set(false);
        this.kindLoading.set(false);
      },
      error: err => { this.loadError.set(httpErrorReason(err)); this.loading.set(false); this.kindLoading.set(false); },
    });
  }

  /** Show another kind: its first page is read, and the kind stays chosen even when it has none (an empty kind says so and offers the next). */
  selectKind(spaceId: string, kind: ForkKind): void {
    if (kind === this.kind()) return;
    this.kind.set(kind);
    this.kindLoading.set(true);
    this.rows.set([]);
    this.load(spaceId, 0, true);
  }

  /** Read the current page again, discarding a refusal that said the list was out of date. */
  reload(spaceId: string): void {
    this.refusal.set('');
    this.load(spaceId, this.skip(), true);
  }

  dismissRefusal(): void { this.refusal.set(''); }

  /**
   * Keep one version of a fork and delete the fork; the page is read again once it is done. The request names the fork and the side; the KIND and the
   * two seqs are the row's, as the page on screen read them, never whatever the caller says and never read again at the click: they are what the
   * server holds the resolve to (`ifMatchSeq`, `ifMatchParentSeq`).
   *
   * An orphan has no parent to name a version of. The design asks every parameter of every resolve and leaves this one open, so an orphan sends 0.
   */
  resolve(spaceId: string, request: { forkId: string; kind?: ForkKind; keep: ForkKeep }): void {
    const row = this.rows().find(r => r.forkId === request.forkId && (!request.kind || r.kind === request.kind)) ?? this.rows().find(r => r.forkId === request.forkId);
    if (!row) return;
    this.refusal.set('');
    const body = { kind: row.kind, keep: request.keep, ifMatchSeq: row.fork.seq ?? 0, ifMatchParentSeq: row.parent?.seq ?? 0 };
    this.api.resolveFork(spaceId, row.forkId, body).subscribe({
      next: () => {
        const params = { parent: row.parentId.slice(0, 8), fork: row.forkId.slice(0, 8) };
        const key = row.orphaned
          ? (request.keep === 'fork' ? 'brain.review.forks.resolvedOrphan.keep' : 'brain.review.forks.resolvedOrphan.drop')
          : (request.keep === 'fork' ? 'brain.review.forks.resolvedThis' : 'brain.review.forks.resolvedOther');
        this.toast.success(this.transloco.translate(key, params));
        this.load(spaceId, this.skip(), true);
      },
      error: (err: RefusalSource) => {
        // A fork that is already gone (resolved on another instance) is the refusal a reviewer meets most; a code names it, and a bare 404 means it.
        // A bare 409 means a version moved since the list was read: nothing was changed, and the list is the thing to read again.
        const bare = !err?.error?.code;
        this.refusal.set(err?.status === 404 && bare
          ? this.transloco.translate(`${FORK_REFUSALS}.fork_not_found`)
          : err?.status === 409 && bare
            ? this.transloco.translate('brain.review.forks.stale')
            : refusalText(this.transloco, err, `${FORK_REFUSALS}.generic`, FORK_REFUSALS));
      },
    });
  }
}
