import { Injectable, inject, signal } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import type { ContradictionRecord, ContradictionResolveNote } from '../../core/api.types';
import { BrainApi } from '../../core/brain-api.service';
import { ContradictionsApi } from '../../core/contradictions-api.service';
import { httpErrorReason } from '../../core/http-error';
import { refusalText } from '../../core/refusal-text';
import { ToastService } from '../../core/toast.service';
import { translatedOrEmpty } from '../../core/translated-text';

/** The family a failed contradiction resolve's `code` is said under (`resolvedOtherwise`, and the codes every family carries). */
const RESOLVE_REFUSALS = 'review.contradictions.refusal';

/**
 * The Contradictions section's list and actions: what the Review tab holds for it (moved out of the tab by Q-391, as Forks was).
 *
 * One question: "which contradictions of the chosen status does this space have, and what has the reviewer done with them". It reads the
 * list for the status pile on screen, and every action (dismiss, re-open, resolve, keep a side) says what it could not do in the reviewer's
 * words and then reads the list again from the server, so what is shown is what is stored. The search box and the record-type filter are the
 * tab's, shared with Duplicates, so they are not held here. Methods that need the space take it as an argument, as the Forks state's do.
 * Provided by the Review tab, one per mounted tab.
 */
@Injectable()
export class ReviewContradictionsState {
  private readonly api = inject(ContradictionsApi);
  private readonly brainApi = inject(BrainApi);
  private readonly transloco = inject(TranslocoService);
  private readonly toast = inject(ToastService);

  readonly rows = signal<ContradictionRecord[]>([]);
  readonly loading = signal(false);
  /**
   * Null until the contradictions load failed. The toast alone was not enough: it is transient, and
   * on a FIRST load `rows()` is empty, so the page settled on "no contradictions — your brain is
   * consistent" while nobody had actually checked.
   */
  readonly error = signal<string | null>(null);
  readonly busy = signal<string | null>(null);
  readonly scanning = signal(false);

  /**
   * Which pile to show. Was **hardcoded to `open`**, which made `Dismiss` and both `Resolve` buttons
   * one-way: the API has supported `dismissed` / `resolved` / `all` all along, the UI simply never asked.
   * Three things were dead because of it — the status pill (rendered only when `status !== 'open'`), the
   * `re-rate` button (rendered only when `status === 'dismissed'`), and any chance of undoing a mis-click.
   */
  statusFilter: 'open' | 'dismissed' | 'resolved' | 'all' = 'open';

  /**
   * Whether the model-judged pass is among the ones that run, as reported by the server.
   *
   * `null` means NOT KNOWN, and is deliberately a third state rather than a default of `true`. Defaulting
   * would make the strongest available claim — "both passes have run and found nothing" — on the weakest
   * available evidence, which is the exact move that produced the bug this whole item is about. When it is
   * unknown the empty state says only what it can see: nothing was found.
   */
  readonly nliConfigured = signal<boolean | null>(null);

  /** Load the space's contradictions. Called on init, on space switch, and after every action. */
  load(spaceId: string): void {
    this.loading.set(true);
    this.error.set(null);
    this.api.listContradictions(this.statusFilter, spaceId).subscribe({
      next: r => {
        this.rows.set(r.contradictions);
        this.nliConfigured.set(typeof r.nliConfigured === 'boolean' ? r.nliConfigured : null);
        this.loading.set(false);
      },
      // A load failure must not read as "no contradictions" — the empty state would be a lie. Surface it
      // and leave whatever was already on screen.
      error: (err) => {
        this.error.set(httpErrorReason(err));
        this.loading.set(false);
        this.toast.error(this.transloco.translate('review.contradictions.loadError'));
      },
    });
  }

  dismiss(spaceId: string, c: ContradictionRecord): void {
    this.busy.set(c.id);
    this.api.dismissContradiction(c.id).subscribe({
      next: () => { this.busy.set(null); this.load(spaceId); },
      // A dismiss that lost a race with a resolve is refused `409 alreadyResolved`, said by its code in the resolve's family.
      error: (e) => { this.busy.set(null); this.toast.error(refusalText(this.transloco, e as Parameters<typeof refusalText>[1], 'duplicates.dismissError', RESOLVE_REFUSALS)); },
    });
  }

  reopen(spaceId: string, c: ContradictionRecord): void {
    this.busy.set(c.id);
    this.api.reopenContradiction(c.id).subscribe({
      next: () => { this.busy.set(null); this.load(spaceId); },
      error: () => { this.busy.set(null); this.toast.error(this.transloco.translate('duplicates.dismissError')); },
    });
  }

  resolve(spaceId: string, c: ContradictionRecord, resolution: 'edited' | 'linked'): void {
    this.busy.set(c.id);
    this.api.resolveContradiction(c.id, resolution).subscribe({
      next: () => { this.busy.set(null); this.load(spaceId); },
      error: (e) => this.resolveFailed(e),
    });
  }

  /**
   * A failed resolve, said by the answer's `code` under the resolve's own family (`Q-442`): `resolvedOtherwise` (someone settled
   * it differently first) reads differently from a fault. It used to be `duplicates.dismissError` for every failure, a sentence
   * about a dismiss, for a request that was not one.
   */
  private resolveFailed(e: unknown): void {
    this.busy.set(null);
    this.toast.error(refusalText(this.transloco, e as Parameters<typeof refusalText>[1], 'review.contradictions.resolveError', RESOLVE_REFUSALS));
  }

  /** The resolve found the record judged stale already gone, so nothing was marked: the card must not say it was. */
  loserWasGone(c: ContradictionRecord): boolean {
    return (c.notes ?? []).some(n => n.code === 'loserGone');
  }

  /**
   * A card whose pair a resolve has claimed and not closed (L3): which choice stands, named by the button that makes it, and
   * what the reviewer can do — the same choice finishes it, a dismiss releases it. Without it the card looked open while
   * every other choice was refused.
   */
  resolvingText(c: ContradictionRecord): string {
    const r = c.resolving;
    if (!r) return '';
    const action = r.resolution === 'superseded' ? (r.winner === 'b' ? 'keepB' : 'keepA') : r.resolution;
    return this.transloco.translate('review.contradictions.resolving', { choice: this.transloco.translate(`review.contradictions.action.${action}`) });
  }

  /** One outcome of a resolve in the reviewer's words: its code's key with its placeholders, or the server's sentence for a code this client does not know. */
  resolveNoteText(n: ContradictionResolveNote): string {
    return translatedOrEmpty(this.transloco, `review.contradictions.note.${n.code}`, { label: n.label ?? '', rule: n.rule ?? '' }) || n.detail;
  }

  // ── Keep A / Keep B ────────────────────────────────────────────────────────────────────────────────────
  //
  // The reviewer's real decision about two disagreeing records is "this one is right, that one is stale".
  // Neither existing resolution said it, so they were being recorded as `edited` (nothing was corrected) or
  // `linked` (nobody drew an edge). This names the loser and lets the server draw `supersedes` for an entity
  // pair — and nothing is deleted, which is the line between this and a duplicate merge.

  /** Which card has its full records expanded. One at a time: two full records is already a lot to read. */
  readonly expanded = signal<string | null>(null);
  readonly fullA = signal<string | null>(null);
  readonly fullB = signal<string | null>(null);
  readonly fullError = signal<string | null>(null);

  keepSide(spaceId: string, c: ContradictionRecord, winner: 'a' | 'b'): void {
    this.busy.set(c.id);
    this.api.keepSide(c.id, winner).subscribe({
      next: (r) => {
        this.busy.set(null);
        /*
         * Success stays silent; what a reviewer must not be left to assume is said, in ONE toast listing every
         * outcome (`Q-442`): each note in the reviewer's language from its code — a link the space's rules
         * refused, a record of the pair that is gone. Never the server's English `note`.
         *
         * `markedRecord: false` with no note means the decision was stored and the LOSING RECORD was not
         * marked — so the next search still returns both claims looking equally current, which is the state
         * the whole feature exists to end. A note (a loser that is gone) already says why, so it is not said twice.
         */
        const notes = r.notes ?? [];
        if (notes.length > 0) this.toast.info(notes.map(n => this.resolveNoteText(n)).join(' '));
        else if (r.resolution === 'superseded' && r.markedRecord === false) this.toast.error(this.transloco.translate('review.contradictions.notMarked'));
        this.load(spaceId);
      },
      error: (e) => this.resolveFailed(e),
    });
  }

  /**
   * Show both records IN FULL, fetched on demand.
   *
   * The card carries one-line summaries, which is enough to triage most pairs and not enough to decide one:
   * picking a winner means reading both. Fetched on expand rather than with the list because a queue of
   * fifty cards would otherwise pull a hundred records nobody opened.
   */
  toggleFull(c: ContradictionRecord): void {
    if (this.expanded() === c.id) { this.expanded.set(null); return; }
    this.expanded.set(c.id);
    this.fullA.set(null); this.fullB.set(null); this.fullError.set(null);
    for (const [id, sink] of [[c.aId, this.fullA], [c.bId, this.fullB]] as const) {
      this.brainApi.getRecord(c.spaceId, c.type, id).subscribe({
        next: (rec) => sink.set(JSON.stringify(rec, null, 2)),
        // Named, not silent: a record that cannot be loaded is exactly the case where a reviewer must not
        // decide from the summary alone.
        error: () => this.fullError.set(this.transloco.translate('review.contradictions.fullError')),
      });
    }
  }

  /** Run the contradiction scan now. The API method existed from the start with no caller. */
  scan(spaceId: string): void {
    this.scanning.set(true);
    this.api.scanContradictions(spaceId).subscribe({
      next: (r) => {
        this.scanning.set(false);
        // `nliStalled` means the judge was unreachable, so the NLI pass settled nothing and its cursor is
        // parked. Silence here would leave "0 found" reading as "nothing disagrees" — the same conflation
        // the empty state used to make, one layer up.
        if (r.nliStalled) this.toast.error(this.transloco.translate('review.contradictions.scanStalled'));
        // The tab scans ONE space, so a space the scan could not scan is the whole scan: a `200` that names it (Q-381) must not read as done.
        if (r.failedSpaces?.length) this.toast.error(this.transloco.translate('duplicates.scanError'));
        this.load(spaceId);
      },
      error: (e) => {
        this.scanning.set(false);
        this.toast.error(this.transloco.translate(e?.status === 403 ? 'duplicates.scanForbidden' : 'duplicates.scanError'));
      },
    });
  }
}
