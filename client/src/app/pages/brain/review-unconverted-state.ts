import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TranslocoService } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { ActiveLanguage } from '../../core/active-language';
import { AuthApi } from '../../core/auth-api.service';
import { BrainApi } from '../../core/brain-api.service';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import { ConversionApi } from '../../core/conversion-api.service';
import type {
  ConversionRefusal, ConversionResult, ConvertStatus, ConvertStatusAnswer, UnconvertedFilter, UnconvertedListAnswer, UnconvertedOpenGroup, UnconvertedQuery,
  UnconvertedListStatus, UnconvertedRow,
} from '../../core/conversion.types';
import { LatestWins } from '../../core/latest-wins';
import { formatCount } from '../../core/plural-text';
import { PluralText } from '../../core/plural-text.service';
import { pollUntil, type PollHandle } from '../../core/poll-until';
import { knowledgeAllowed, mayConvertRecords } from '../../core/token-capability';
import {
  openCountsByClass, openTypesOf, reasonsOfClass, soleOpenType, type OpenTypeRef, type UnconvertedClass,
} from '../../core/unconverted-reasons';
import type { TokenRights } from '../settings/rights-glyph.component';
import { RecordDrawerState } from './record-drawer-state.service';

/** Records per page: the size of the other Review lists' pages. */
export const UNCONVERTED_PAGE_SIZE = 25;

/** How long a running conversion waits before it is asked about again. */
export const UNCONVERTED_POLL_MS = 3_000;

/** The class pill chosen: one of the three classes of reasons, or every record. */
export type UnconvertedClassChoice = UnconvertedClass | 'all';

/** How far a running conversion has come: the types it converts, the records it has checked, and the records it will check (null: not counted in time). */
export interface RunLine { names: readonly string[]; done: number; total: number | null }

const sameType = (a: OpenTypeRef, b: OpenTypeRef): boolean => a.kind === b.kind && a.type === b.type;

/** The first words of a refusal the server worded itself, for a failed load's detail line: only the one kind of refusal that carries a sentence. */
const reasonOf = (refusal: ConversionRefusal): string => (refusal.kind === 'other' ? refusal.error : '');

/**
 * The Review "Unconverted" section's state (bundle-285, Q-939): the records a conversion could not convert, the counts the class switch is made of,
 * the filters, the pages, what a dismiss does and says, Convert again, and the run that is going.
 *
 * One question: "which records did a conversion leave in this space, and what became of the last thing the reader did to them". Built on the Forks
 * section's pattern: it keeps the newest answer only (`LatestWins`), reads the page again after every act so what is shown is what is stored, and keeps
 * a refusal until it is dismissed, because a refusal is about one record in a list the reviewer is working down.
 *
 * ## What it prevents
 *
 * - **A count made up from the page.** The class counts, the type choices and the badge are the server's `counts.openBy` and `counts.open` over the
 *   WHOLE space; a page of 25 never says how many records a class holds. When the answer says the groups were cut (`openByCut`) the panel says so.
 * - **A class that sends one reason.** A class is several reasons; the pill asks for all of them as a list, and "Dismiss all N shown" sends the same list
 *   and `expect` N: the number the reader was shown. A 409 (the set moved) reloads and asks again with the new number, and dismisses that number only after
 *   the reader says yes; nothing is dismissed that was not shown.
 * - **A lock that is only a refusal.** A caller without the write right cannot dismiss and one without the conversion price cannot Convert again: the
 *   server is not asked, and the panel says why. The server still decides every act; rights that are not known yet count as allowed.
 * - **A server that did not answer reading as a clean list.** A failed load is `loadError`, a caller who may not read is `denied`; neither is "no records".
 * - **A poll that outlives its space.** The status of a running conversion is asked every three seconds while it runs and stops when it ends, when
 *   another space opens, and when the state is destroyed; a list is read again only when a record was listed since, and once when the run ends.
 *
 * The status choice is Open, Dismissed or All: the server lists `all` as one newest-first list with one paging, each row carrying its own status. The
 * class counts are of OPEN records (the server's `counts.openBy`), so they stay on Open and All and are not shown on Dismissed; "Dismiss all N shown" says the
 * OPEN records of the filter, which on All is read from `counts.openBy` and never from the list's `total` (that counts the dismissed too), and the bulk
 * dismiss carries no status (the server refuses any but open).
 * Provided by the Review tab, one per mounted tab.
 */
@Injectable()
export class ReviewUnconvertedState {
  private readonly api = inject(ConversionApi);
  private readonly auth = inject(AuthApi);
  private readonly brain = inject(BrainApi);
  private readonly confirmDialog = inject(ConfirmDialogService);
  /** Provided by the Brain page, not by the Review tab: a tab hosted without it (a spec of the tab alone) cannot open a record, and says so. */
  private readonly drawer = inject(RecordDrawerState, { optional: true });
  private readonly transloco = inject(TranslocoService);
  private readonly plural = inject(PluralText);
  private readonly active = inject(ActiveLanguage);
  private readonly destroyRef = inject(DestroyRef);
  private readonly lists = new LatestWins(this.destroyRef);
  private readonly runRead = new LatestWins(this.destroyRef);
  private poll: PollHandle | null = null;
  /** The first answer of a space decides the type to open on; later answers never move a choice the reader made. */
  private firstAnswer = true;

  /** The space whose records these are. */
  readonly space = signal('');
  readonly rows = signal<readonly UnconvertedRow[]>([]);
  /** How many records the filter lists in all, as the server counted them; the pager pages through it. */
  readonly total = signal<number | null>(null);
  readonly skip = signal(0);
  /** An answer has arrived since the space opened: the controls have counts to show. */
  readonly loaded = signal(false);
  readonly loading = signal(false);
  /** Null until the last load failed: checked before the empty state, so a failure never reads as "no records". */
  readonly loadError = signal<string | null>(null);
  /** The caller may not read this space's records: said in its own sentence, not as a failure. */
  readonly denied = signal(false);
  /** The sentence of the last refused act; empty when there is none. */
  readonly refusal = signal('');
  readonly classChoice = signal<UnconvertedClassChoice>('all');
  /** The record type chosen; null is "All types". */
  readonly typeChoice = signal<OpenTypeRef | null>(null);
  readonly statusChoice = signal<UnconvertedListStatus>('open');
  /** The item whose dismiss is on its way. */
  readonly busyItem = signal<string | null>(null);
  readonly bulkBusy = signal(false);
  readonly convertBusy = signal(false);
  /** The rights of the caller, null while unknown (the server decides then). */
  private readonly rights = signal<TokenRights | null>(null);
  private readonly groups = signal<readonly UnconvertedOpenGroup[]>([]);
  private readonly counts = signal<{ open: number; dismissed: number } | null>(null);
  /** The counts were cut: the space holds more groups than the answer carries, so the pills do not add up to the whole. */
  readonly countsCut = signal(false);
  private readonly runStatus = signal<ConvertStatus | null>(null);

  /** How many records the space holds open, all types and reasons, or null before the first answer: the badge on the tab. */
  readonly badge = computed(() => this.counts()?.open ?? null);
  /**
   * The open count with the space it is of, a new value after EVERY list answer (a load, the read after a dismiss or a bulk dismiss, the reads a
   * run's progress causes), null until the space's first answer: what the Brain page's own Review tab shows from then on (S12, Q-939). A new object
   * per answer, so an equal number still reaches a reader that showed another one in between.
   */
  readonly openRead = computed<{ space: string; open: number } | null>(() => {
    const counts = this.counts();
    return counts ? { space: this.space(), open: counts.open } : null;
  });
  /** The space holds no unconverted record of any status: the empty screen that says what makes one appear, as against a filter that matches none. */
  readonly spaceEmpty = computed(() => {
    const counts = this.counts();
    return counts !== null && counts.open === 0 && counts.dismissed === 0;
  });
  /** The badge as the language writes a number ('1,046'), or null when there is nothing to show. */
  readonly badgeText = computed(() => {
    const n = this.badge();
    this.active.revision();
    return n ? formatCount(this.active.language() || 'en', n) : null;
  });

  /** The number on each class pill: the open items of the class, for the chosen type or all. Null on the Dismissed list: the counts are of open records. */
  readonly classCounts = computed<Record<UnconvertedClass, number> | null>(() =>
    this.statusChoice() !== 'dismissed' ? openCountsByClass(this.groups(), this.typeChoice() ?? undefined) : null);
  /** The number on the "All" pill. */
  readonly openAll = computed(() => {
    const counts = this.classCounts();
    return counts ? counts.fit + counts.exists + counts.refused : 0;
  });
  /** The record types the select offers: those with open items, and the chosen one even when it has none left, so a filter that narrows is never hidden. */
  readonly typeOptions = computed(() => {
    const real = openTypesOf(this.groups());
    const chosen = this.typeChoice();
    if (!chosen || real.some(t => sameType(t, chosen))) return real;
    // The chosen type has nothing open now: name it once through the same ordering, then say it holds none.
    return openTypesOf([...this.groups(), { kind: chosen.kind, type: chosen.type, reason: '', n: 1 }]).map(t => (sameType(t, chosen) ? { ...t, open: 0 } : t));
  });

  /** What "Dismiss all N shown" says N is: the list's total for the filter on the Open list. Null on the Dismissed list: only open records are dismissed. */
  readonly dismissCount = computed<number | null>(() => {
    const status = this.statusChoice();
    if (status === 'open') return this.total();
    // All: the list's total holds the dismissed records too, so the OPEN ones of the type and class come from the server's groups. Cut groups do not
    // add up to the whole, so no number is offered rather than one the server would refuse.
    if (status === 'all' && !this.countsCut()) {
      const counts = openCountsByClass(this.groups(), this.typeChoice() ?? undefined);
      const cls = this.classChoice();
      return cls === 'all' ? counts.fit + counts.exists + counts.refused : counts[cls];
    }
    return null;
  });
  readonly canDismiss = computed(() => knowledgeAllowed(this.rights(), this.space(), 'write'));
  readonly canConvert = computed(() => mayConvertRecords(this.rights(), this.space()));

  readonly hasPrevious = computed(() => this.skip() > 0);
  readonly hasNext = computed(() => {
    const total = this.total();
    return total !== null && this.skip() + this.rows().length < total;
  });
  /** The range on screen, for the pager's "1–25 of 1,046 records". */
  readonly range = computed(() => (this.rows().length ? `${this.skip() + 1}–${this.skip() + this.rows().length}` : '–'));

  /** How far the running conversion has come, or null when none is running (or the caller may not read it). */
  readonly running = computed<RunLine | null>(() => {
    const run = this.runStatus();
    if (!run) return null;
    const done = run.counts.stamped + run.counts.rewritten + run.counts.unconverted + run.counts.moved;
    return { names: run.types.map(t => t.type), done, total: run.left === null ? null : done + run.left };
  });

  /** "1–25 of 1,046 records" in the page's language, or the range alone when the answer does not say how many there are. */
  pagerText(): string {
    const total = this.total();
    return total === null ? this.range() : this.plural.text('brain.review.unconverted.count', total, { range: this.range() });
  }

  constructor() {
    this.destroyRef.onDestroy(() => this.stopPoll());
  }

  /** Open `spaceId`: forget the last space's records, filters and run, and read this one. */
  open(spaceId: string): void {
    this.stopPoll();
    this.lists.cancel();
    this.runRead.cancel();
    this.space.set(spaceId);
    this.rows.set([]);
    this.groups.set([]);
    this.counts.set(null);
    this.countsCut.set(false);
    this.total.set(null);
    this.skip.set(0);
    this.loaded.set(false);
    this.loadError.set(null);
    this.denied.set(false);
    this.refusal.set('');
    this.classChoice.set('all');
    this.typeChoice.set(null);
    this.statusChoice.set('open');
    this.runStatus.set(null);
    this.rights.set(null);
    this.firstAnswer = true;
    this.readRights(spaceId);
    void this.load(0);
    this.readRun(spaceId);
  }

  /** Read the page of the filter chosen, starting at `skip`. `quiet` keeps the rows on screen while it loads (a refresh after an act). Resolves when this request is over. */
  load(skip = 0, quiet = false): Promise<void> {
    const spaceId = this.space();
    if (!quiet) this.loading.set(true);
    this.loadError.set(null);
    return new Promise<void>(resolve => {
      this.lists.run(this.api.listUnconverted(spaceId, this.queryAt(skip)), {
        next: result => this.take(spaceId, skip, result),
        finally: () => resolve(),
      });
    });
  }

  /** The request of the filter on screen: the type by kind and name, the reasons of the class as a list, the status, and the page. */
  private queryAt(skip: number): UnconvertedQuery {
    const type = this.typeChoice();
    const cls = this.classChoice();
    return {
      ...(type ? { kind: type.kind, type: type.type } : {}),
      ...(cls !== 'all' ? { reasons: [...reasonsOfClass(cls)] } : {}),
      status: this.statusChoice(), skip, limit: UNCONVERTED_PAGE_SIZE,
    };
  }

  private take(spaceId: string, skip: number, result: ConversionResult<UnconvertedListAnswer>): void {
    if (spaceId !== this.space()) return;
    if (!result.ok) {
      this.loading.set(false);
      const denied = result.refusal.kind === 'no_right';
      this.denied.set(denied);
      this.loadError.set(denied ? null : reasonOf(result.refusal));
      return;
    }
    const page = result.value;
    // A page past the end (the last record of the last page was just dismissed) steps back rather than showing an empty list.
    if (page.items.length === 0 && skip > 0) { void this.load(Math.max(0, skip - UNCONVERTED_PAGE_SIZE), true); return; }
    const openBy = page.counts.openBy ?? [];
    this.groups.set(openBy);
    this.countsCut.set(page.counts.openByCut === true);
    this.counts.set({ open: page.counts.open, dismissed: page.counts.dismissed });
    this.rows.set(page.items);
    this.total.set(page.total);
    this.skip.set(skip);
    this.denied.set(false);
    this.loadError.set(null);
    this.loaded.set(true);
    this.loading.set(false);
    // The first answer was unfiltered: when exactly one type has open items, the list it holds IS that type's list, so the type is chosen without a second read.
    if (this.firstAnswer) {
      this.firstAnswer = false;
      const sole = soleOpenType(openBy);
      if (sole && !this.typeChoice() && this.statusChoice() === 'open') this.typeChoice.set(sole);
    }
  }

  /** Read the page again, as after a failed load; the rows stay on screen when `quiet`. */
  reload(quiet = false): Promise<void> { return this.load(this.skip(), quiet); }

  goTo(skip: number): void { void this.load(Math.max(0, skip)); }

  chooseClass(choice: UnconvertedClassChoice): void {
    if (choice === this.classChoice()) return;
    this.classChoice.set(choice);
    void this.load(0);
  }

  chooseType(type: OpenTypeRef | null): void {
    const now = this.typeChoice();
    if ((now === null && type === null) || (now !== null && type !== null && sameType(now, type))) return;
    this.typeChoice.set(type);
    void this.load(0);
  }

  chooseStatus(status: UnconvertedListStatus): void {
    if (status === this.statusChoice()) return;
    this.statusChoice.set(status);
    void this.load(0);
  }

  dismissRefusal(): void { this.refusal.set(''); }

  // ── the acts ────────────────────────────────────────────────────────────────────────────────────────────────────────

  private words(key: string, params?: Record<string, unknown>): string { return this.transloco.translate(key, params, this.active.language() || undefined); }

  /** The refusal of a dismiss or a Convert again as a sentence the reader acts on: the key of the kind, else the server's own sentence, else a plain one. */
  private refusalWords(refusal: ConversionRefusal, act: 'dismiss' | 'convert'): string {
    switch (refusal.kind) {
      case 'item_gone': return this.words('brain.review.unconverted.itemGone');
      case 'no_right': return this.words(act === 'dismiss' ? 'brain.review.unconverted.dismissLocked' : 'spaces.schema.convert.locked');
      case 'too_many': return this.words('brain.review.unconverted.tooMany', { max: formatCount(this.active.language() || 'en', refusal.max) });
      case 'running': return this.words('spaces.schema.convert.running409');
      case 'rate_limited': {
        const sentence = this.words('spaces.schema.convert.rateLimited');
        return refusal.retryAfterSeconds === null ? sentence : `${sentence} ${this.words('spaces.schema.convert.retryIn', { seconds: refusal.retryAfterSeconds })}`;
      }
      default: return reasonOf(refusal) || this.words('brain.review.unconverted.actFailed');
    }
  }

  /** Dismiss one record: asked first (as a duplicate's dismiss is), then the page is read again. A record no longer listed says so and reloads. */
  async dismissOne(row: UnconvertedRow): Promise<void> {
    if (!this.canDismiss() || this.busyItem() !== null) return;
    const spaceId = this.space();
    const ok = await this.confirmDialog.confirm({
      title: this.plural.text('brain.review.unconverted.confirm.title', 1),
      message: this.plural.text('brain.review.unconverted.confirm.body', 1, { type: row.type }),
      confirmLabel: this.plural.text('brain.review.unconverted.confirm.ok', 1),
    });
    if (!ok) return;
    this.refusal.set('');
    this.busyItem.set(row.itemId);
    const result = await firstValueFrom(this.api.dismissOne(spaceId, row.itemId));
    this.busyItem.set(null);
    if (spaceId !== this.space()) return;
    if (!result.ok) this.refusal.set(this.refusalWords(result.refusal, 'dismiss'));
    // Read again either way: after a dismiss the record is gone from the Open list, and after a refusal the list may be what was out of date.
    await this.load(this.skip(), true);
  }

  /**
   * Dismiss every open record the filter on screen lists. The filter is the one shown and `expect` is the number shown (`dismissCount`); the reader
   * confirms first, naming the type and the number. When the set moved (409) the list is read again and the reader is asked again with the new
   * number: a different number is never dismissed unasked.
   */
  async dismissShown(): Promise<void> {
    const shown = this.dismissCount();
    if (!shown || !this.canDismiss() || this.bulkBusy()) return;
    const spaceId = this.space();
    const filter = this.shownFilter();
    let expect = shown;
    let confirmed = await this.confirmBulk(expect);
    while (confirmed) {
      this.refusal.set('');
      this.bulkBusy.set(true);
      const result = await firstValueFrom(this.api.dismissShown(spaceId, { ...filter, expect }));
      this.bulkBusy.set(false);
      if (spaceId !== this.space()) return;
      // Read again whatever the answer: after a dismiss the records are gone, after a 409 the number on screen is the thing that was out of date.
      await this.load(this.skip(), true);
      if (result.ok) return;
      if (result.refusal.kind !== 'changed') { this.refusal.set(this.refusalWords(result.refusal, 'dismiss')); return; }
      // Nothing is left to ask about when the set emptied; otherwise ask again with the number the server now counts, and send only what is confirmed.
      if (result.refusal.current === 0) return;
      expect = result.refusal.current;
      confirmed = await this.confirmChanged(expect);
    }
  }

  /** The filter "Dismiss all N shown" sends: the type by kind and name, and the reasons of the class as a list; nothing for what is not chosen. */
  private shownFilter(): UnconvertedFilter {
    const type = this.typeChoice();
    const cls = this.classChoice();
    return {
      ...(type ? { kind: type.kind, type: type.type } : {}),
      ...(cls !== 'all' ? { reasons: [...reasonsOfClass(cls)] } : {}),
    };
  }

  /** The drawn confirm (5b): the number, and the type it is of. With no type chosen the sentence does not name one. */
  private confirmBulk(n: number): Promise<boolean> {
    const type = this.typeChoice();
    return this.confirmDialog.confirm({
      title: this.plural.text('brain.review.unconverted.confirm.title', n),
      message: type ? this.plural.text('brain.review.unconverted.confirm.body', n, { type: type.type }) : this.plural.text('brain.review.unconverted.confirm.bodyAll', n),
      confirmLabel: this.plural.text('brain.review.unconverted.confirm.ok', n),
    });
  }

  /** The confirm after a count that moved: it says the list changed and how many are open now, and asks again. */
  private confirmChanged(n: number): Promise<boolean> {
    return this.confirmDialog.confirm({
      title: this.plural.text('brain.review.unconverted.confirm.title', n),
      message: this.plural.text('brain.review.unconverted.changed', n),
      confirmLabel: this.plural.text('brain.review.unconverted.confirm.ok', n),
    });
  }

  /** Try every open record of the chosen type again, with the current schema and no extra steps; then read the run and the list. */
  convertAgain(): void {
    const type = this.typeChoice();
    if (!type || !this.canConvert() || this.convertBusy()) return;
    const spaceId = this.space();
    this.convertBusy.set(true);
    this.refusal.set('');
    this.api.start(spaceId, [{ kind: type.kind, type: type.type }]).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(result => {
      this.convertBusy.set(false);
      if (spaceId !== this.space()) return;
      if (!result.ok) { this.refusal.set(this.refusalWords(result.refusal, 'convert')); return; }
      this.readRun(spaceId);
      void this.load(this.skip(), true);
    });
  }

  /** Open the record in the Brain's drawer. A record that cannot be read, or a tab hosted without a drawer, says so rather than doing nothing. */
  openRecord(row: UnconvertedRow): void {
    const drawer = this.drawer;
    if (!drawer) { this.refusal.set(this.words('brain.review.unconverted.openFailed')); return; }
    this.brain.getRecord(this.space(), row.kind, row.recordId).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      // The record's kind is the row's: `getRecord` answers the record of that kind, and the drawer takes the pair.
      next: record => drawer.open(row.kind as 'entity', record as never),
      error: () => this.refusal.set(this.words('brain.review.unconverted.openFailed')),
    });
  }

  // ── rights, and the run that is going ──────────────────────────────────────────────────────────────────────────────────

  private readRights(spaceId: string): void {
    this.auth.verifyToken().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: me => { if (spaceId === this.space()) this.rights.set(me.rights ?? null); },
      // Silent: the controls stay as they are and the server decides what the token may do.
      error: () => {},
    });
  }

  /** Ask once how the conversion of the space stands; when one is running, keep asking until it ends. */
  private readRun(spaceId: string): void {
    this.runRead.run(this.api.status(spaceId), result => {
      if (spaceId !== this.space()) return;
      if (this.takeRun(result) === 'going') this.keepAsking(spaceId);
    });
  }

  private keepAsking(spaceId: string): void {
    if (this.poll?.active) return;
    this.poll = pollUntil({
      delayMs: () => UNCONVERTED_POLL_MS,
      request: () => this.api.status(spaceId),
      onAnswer: result => spaceId === this.space() && this.takeRun(result) !== 'over',
    });
  }

  /**
   * What an answer of the status door says: a run `going`, `over` (no run, a finished one, or a caller who may not read it), or `unknown` (the read failed:
   * the run is not known to have ended, so a poll goes on). A list is read again when a record was listed since the last answer, and once when a run ends.
   */
  private takeRun(result: ConversionResult<ConvertStatusAnswer>): 'going' | 'over' | 'unknown' {
    const was = this.runStatus();
    if (!result.ok) {
      if (result.refusal.kind !== 'no_right') return 'unknown';
      this.runStatus.set(null);
      return 'over';
    }
    const run = result.value.state === 'running' ? (result.value as ConvertStatus) : null;
    this.runStatus.set(run);
    if (was && (!run || run.counts.unconverted !== was.counts.unconverted)) void this.load(this.skip(), true);
    return run ? 'going' : 'over';
  }

  private stopPoll(): void {
    this.poll?.stop();
    this.poll = null;
  }
}
