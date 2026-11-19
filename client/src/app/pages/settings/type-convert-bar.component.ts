import { ChangeDetectionStrategy, Component, DestroyRef, InjectionToken, Injector, TemplateRef, computed, effect, inject, input, signal, untracked, viewChild, type ProviderToken } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { forkJoin, of, type Observable, type Subscription } from 'rxjs';
import { catchError, map, shareReplay } from 'rxjs/operators';
import type { VoteRound } from '../../core/api.types';
import { ConversionApi } from '../../core/conversion-api.service';
import type { BlockCounts, ConvertBlock } from '../../core/conversion-counts';
import type { ConversionRefusal, ConvertRunNotice, ConvertSource, ConvertStatus, ConvertStatusAnswer } from '../../core/conversion.types';
import { NetworksApi } from '../../core/networks-api.service';
import { pageTranslator } from '../../core/page-translator';
import { pollUntil, type PollHandle } from '../../core/poll-until';
import { PluralText } from '../../core/plural-text.service';
import { mayConvertRecords } from '../../core/token-capability';
import type { TypedKind } from '../../core/type-field';
import { convertBlocksOfRound } from '../../core/vote-round-view';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { ConvertRecordsDialogComponent, type ConvertDialogChoice } from './convert-records-dialog.component';
import { refusedSentence } from './convert-run-block.component';
import { CONVERT_POLL_FAILURES_MAX, watchConvertRun } from './convert-status-watch';
import type { ConvertBlockPlan, ConvertSchemas } from './convert-steps';
import type { TokenRights } from './rights-glyph.component';
import { SpaceSettingsState } from './space-settings-state.service';

/**
 * What the Schema tab's type head says and offers about converting that type's records (bundle-285 slice S6, Q-747; plan sections 3.1 item 7, 5 rows
 * P4, P5, P7 to P11 and A, 7; drawing moments 3a, 3b, 4b and 6).
 *
 * ONE component for two places in the head: the labelled button belongs among the head's actions and the note under the head, so the component
 * exposes the button as a template (`button`) that the tab renders inside its actions, and renders the lock's reason, the note and the dialog itself.
 *
 * ## What it prevents
 *
 * - **A button that cannot say why it is dead.** The button is labelled, not an icon. Without the right to convert (`mayConvertRecords`: an
 *   instance administrator, or a knowledge admin who also administers the space; unknown rights are allowed, the server decides) or while the type is
 *   not saved (a conversion works on the stored schema, which has no new type and no new name), it is disabled WITH its reason visible under the head
 *   and named by `aria-describedby`.
 * - **Two notes at once, or a stale one.** One note at a time, in this order: waiting for a vote (nothing has changed yet), the run in progress, the
 *   run that finished, a Save that found no records to convert (told by `saveNotice`, never by a read of its own), records on an older version. The finished note is for a run THIS bar saw, or one begun after the settings opened (a Save
 *   re-baselines them): an old finished run found on opening is never announced as news.
 * - **A vote the type does not know it is waiting on.** A round counts for this type when the vote row's own reading of its steps
 *   (`convertBlocksOfRound`) names the type by either of its names, or when the round says it changes the type (`changedTypes`, `kind:type`); the counts are
 *   those of this instance's records, under the name they still carry, so the note and the vote row cannot count different records.
 * - **A run read for ever.** The status is read on `watchConvertRun`'s bound: at once, every three seconds while it runs, ended by the run's end, by a
 *   re-read after a save, and by the bar going. A read that fails says nothing here (the dialog a converting Save leaves open does say so).
 * - **A vote read at a run's pace.** The networks are scanned once per popup opening and a waited round is read every {@link VOTE_WATCH_MS} while the
 *   tab is visible, at once on returning to the type or the tab (`watchRound` states the rule).
 * - **A note that outlives its answer.** Every read belongs to a generation; an answer of an older one (another type, another space, a save since) is dropped.
 * - **A host with no network to ask.** The reads go through the injector and a host that has no HTTP client reads no note; the button still shows.
 *
 * The note says nothing for what it cannot read (the votes of a token that is not an instance administrator, a count that failed): an absent note is
 * never an error, and nothing here blocks the button.
 *
 * A run the act starts is shown by whoever provides {@link CONVERT_RUN_HOST} (the settings popup): the same progress dialog, watch and Open Review a
 * converting Save leaves open, so a run is shown one way whichever button started it. A host without one shows the note only.
 */
let seq = 0;

/** Who shows a run the Convert act started, as it shows the run a converting Save started. */
export interface ConvertRunHost {
  /**
   * Show a run in the progress dialog: `from` says what led there (the type's Convert act, or the note's "Show the run" for a run of any source),
   * `status` is the run as last read when the caller has it, so a finished run shows at once.
   */
  showRun(notice: ConvertRunNotice | null, from: 'act' | 'note', status?: ConvertStatusAnswer | null): void;
}

/** The strong lead of a run's note while it runs (null: none) and when it finished, by what started the run. */
const RUN_LEADS: Record<ConvertSource['kind'], { running: string | null; finished: string }> = {
  write: { running: 'spaces.schema.convert.note.saved', finished: 'spaces.schema.convert.note.finished' },
  round: { running: 'spaces.schema.convert.note.byVote', finished: 'spaces.schema.convert.note.finishedByVote' },
  act: { running: null, finished: 'spaces.schema.convert.note.actFinished' },
};

/** Provided by the settings popup for the bars inside it; a bar with no host shows its note only. */
export const CONVERT_RUN_HOST = new InjectionToken<ConvertRunHost>('CONVERT_RUN_HOST');

/**
 * Milliseconds between two reads of a round a type waits on, while the tab is visible. A vote stays open for hours or days: half a minute keeps the
 * note honest without a request every few seconds for as long as the popup is open (lens finding 2, S13).
 */
export const VOTE_WATCH_MS = 30_000;

/** One popup opening's (or save's) scan of the space's networks for open rounds: `key` is the space and the settings' baseline it was made at. */
interface RoundsScan { key: string; answer: Observable<{ label: string; rounds: VoteRound[] }[]> }

/**
 * The scan each settings state made last, shared by every type the reader selects in that opening, so a type selection costs no request per network.
 * A save or a new opening moves the baseline (`schemaEpoch`) and so the key; a waited round that changes drops the entry.
 */
const roundScans = new WeakMap<SpaceSettingsState, RoundsScan>();

@Component({
  selector: 'app-type-convert-bar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, PhIconComponent, ConvertRecordsDialogComponent],
  styles: [`
    :host { display: block; }
    .cv-btn { gap: 5px; }
    .cv-btn[disabled] { cursor: not-allowed; }
    /* Records wait: the theme's "ready" green, outlined, as drawn (the accent fill is violet in the dark theme). */
    .cv-btn-attn { color: var(--accent); background: var(--success-dim); box-shadow: inset 0 0 0 1px var(--success-border); }
    .cv-reason { margin: 6px 0 0; }
    .cv-note { margin: 8px 0 0; font-size: 13px; }
    .cv-show-run { margin-top: 6px; }
    .cv-bar-hint { font-size: 11px; font-weight: 400; color: var(--text-muted); }
  `],
  template: `
    <ng-template #button>
      <button class="btn btn-ghost btn-sm cv-btn" type="button" data-testid="convert-records" style="padding:2px 6px;" [class.cv-btn-attn]="attention()"
        [disabled]="reason() !== null" [attr.title]="reason()" [attr.aria-describedby]="reason() !== null ? reasonId : null" (click)="open()">
        <ph-icon name="arrows-clockwise" [size]="13"/>{{ 'spaces.schema.convert.button' | transloco }}
      </button>
    </ng-template>
    @if (reason(); as why) { <p class="cv-reason cv-bar-hint" [id]="reasonId" data-testid="convert-locked">{{ why }}</p> }
    @if (note(); as n) {
      <div class="alert alert-info cv-note" role="status" data-testid="convert-note">@if (n.lead) { <strong>{{ n.lead }}</strong> } {{ n.text }}</div>
      @if (n.run && runHost) {
        <button class="btn btn-ghost btn-sm cv-show-run" type="button" data-testid="convert-show-run" (click)="showRun()">{{ 'spaces.schema.convert.note.showRun' | transloco }}</button>
      }
    }
    @if (dialog(); as d) {
      <app-convert-records-dialog mode="act" [spaceId]="spaceId()" [blocks]="d.blocks" [staged]="d.staged" [rights]="rights()"
        [refusal]="refusal()" [busy]="starting()" (choice)="onChoice($event)" />
    }
  `,
})
export class TypeConvertBarComponent {
  private readonly state = inject(SpaceSettingsState);
  private readonly injector = inject(Injector);
  private readonly say = pageTranslator();
  private readonly plural = inject(PluralText);
  protected readonly runHost = inject(CONVERT_RUN_HOST, { optional: true });

  /** The type in the pane: its kind, and its name as the schema holds it now. */
  readonly kind = input.required<TypedKind>();
  readonly type = input.required<string>();
  /** The name the type is stored under when it was renamed and not saved; a conversion cannot name it yet. */
  readonly was = input<string | null>(null);
  /** The type exists in the stored schema (it is not new). */
  readonly saved = input(true);
  /** The type list marks the type's records as on an older version. */
  readonly older = input(false);
  /** The token's rights, for the lock; unknown rights allow. */
  readonly rights = input<TokenRights | null | undefined>(undefined);
  /**
   * What the popup's converting Save answered (`SaveConvertAnswer.convert`), handed down by the popup and the Schema tab: the save already knows
   * whether it converted anything, so the pane learns it here and asks the server nothing more. Only `nothing` (the type had no records) says
   * something in the pane; the dialog the save leaves open says the rest.
   */
  readonly saveNotice = input<ConvertRunNotice | null>(null);

  /** The button, for the head to render among its actions. */
  readonly button = viewChild<TemplateRef<unknown>>('button');

  protected readonly reasonId = `cv-bar-reason-${++seq}`;
  protected readonly spaceId = computed(() => this.state.settingsSpace()?.id ?? '');

  /** Why the button is dead, or null when it is not: the right comes first, then the Save the conversion waits for. */
  protected readonly reason = computed<string | null>(() => {
    if (!mayConvertRecords(this.rights(), this.spaceId())) return this.say('spaces.schema.convert.locked');
    if (!this.saved() || this.was() !== null) return this.say('spaces.schema.convert.saveFirst');
    return null;
  });

  // ── What was read ────────────────────────────────────────────────────────────────────────────────────────────────────────
  private readonly run = signal<ConvertStatus | null>(null);
  private readonly olderCount = signal<number | null>(null);
  private readonly waiting = signal<{ network: string; type: string; counts: BlockCounts | null } | null>(null);
  /** This bar saw the run in progress, or the person pressed Convert records here: its finish is news. */
  private readonly sawRun = signal(false);
  /** The person pressed Convert records: "nothing to convert" is an answer to them. */
  private readonly pressed = signal(false);
  /** The settings' baseline when this bar opened: a later baseline is a Save, and a run begun since is news. */
  private readonly openedAt = this.state.schemaEpoch();

  // ── The act ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  protected readonly dialog = signal<{ blocks: ConvertBlockPlan[]; staged: ConvertSchemas } | null>(null);
  protected readonly refusal = signal<ConversionRefusal | null>(null);
  protected readonly starting = signal(false);

  private generation = 0;
  private lastTarget = '';
  private watch: PollHandle | null = null;
  /** The re-read of the round the waiting note is about (`watchRound`). */
  private roundWatch: PollHandle | null = null;
  /** The round the bar waited on and saw close: its run, even one already finished, is news. */
  private awaitedRound: string | null = null;
  private reads: Subscription[] = [];
  private startRead: Subscription | undefined;

  /** The button is drawn in the accent while records wait on an older version (drawing 6): the note points at it, so it should be findable. */
  protected readonly attention = computed(() => this.older() && (this.olderCount() ?? 0) > 0);

  /** The Save answered that this type had no records to convert (and no run began for it since: that is what the run's own note is for). */
  private readonly savedNothing = computed(() => {
    const notice = this.saveNotice();
    return notice?.state === 'nothing' && notice.types.some(t => t.kind === this.kind() && t.type === this.type());
  });

  /**
   * The one note, or none: waiting for a vote, the run, its finish, what a Save answered, records on an older version. A note about a Save opens with
   * a strong lead as drawn ("Schema saved." for the run in progress and for the empty type, "Schema saved. Conversion finished." for the finish);
   * a run the Convert act alone started saved no schema, so its running note has no lead and its finish opens with "Conversion finished."; the
   * others have none.
   */
  protected readonly note = computed<{ lead: string | null; text: string; run?: true } | null>(() => {
    const plain = (text: string) => ({ lead: null, text });
    /** A note about a run: it offers to show that run (`showRun`). */
    const ofRun = (lead: string | null, text: string) => ({ lead, text, run: true as const });
    const w = this.waiting();
    if (w) {
      const waits = this.say('spaces.schema.convert.note.waiting', { network: w.network });
      const c = w.counts;
      return plain(c && c.total > 0
        ? `${waits} ${this.plural.text('spaces.schema.convert.note.waitingCounts', c.total, { type: w.type, stamped: c.stamped, rewritten: c.rewritten })}`
        : waits);
    }
    const saved = this.say('spaces.schema.convert.note.saved');
    const run = this.run();
    const entry = run?.types.find(t => t.kind === this.kind() && t.type === this.type());
    if (run && entry) {
      const done = run.counts.stamped + run.counts.rewritten + run.counts.unconverted + run.counts.moved;
      // The lead says what changed the schema, by the run's MOST RECENT source (the server appends them): a Save "Schema saved.", a passed vote
      // "Schema changed by the vote." (this member saved nothing), the Convert act nothing (it changes no schema). A run no source names is a Save's.
      const words = RUN_LEADS[run.sources[run.sources.length - 1]?.kind ?? 'write'];
      if (run.state === 'running' && !entry.done) {
        if (run.left === null) return ofRun(null, `${this.say('spaces.schema.convert.run.converting')} (${this.say('spaces.schema.convert.run.counting')})`);
        const text = this.plural.text('spaces.schema.convert.note.running', done + run.left, { done });
        return ofRun(words.running === null ? null : this.say(words.running), text);
      }
      // A Save that found nothing started no run: a finished run still on the books for the type is an old one, not the Save's.
      const awaited = this.awaitedRound !== null && run.sources.some(s => s.kind === 'round' && s.roundId === this.awaitedRound);
      if (this.sawRun() || awaited || (!this.savedNothing() && this.state.schemaEpoch() > this.openedAt)) {
        if (run.state === 'failed') return ofRun(null, this.say('spaces.schema.convert.run.failed', { error: run.error ?? '' }));
        // What could not be converted, then whether steps were refused here: both on the page without opening the run.
        const parts = [
          run.counts.unconverted > 0 ? this.plural.text('spaces.schema.convert.note.finishedSome', run.counts.unconverted) : '',
          refusedSentence(this.say, this.plural, run),
        ];
        return ofRun(this.say(words.finished), parts.filter(p => p !== '').join(' '));
      }
    }
    if (this.savedNothing()) return { lead: saved, text: this.say('spaces.schema.convert.note.none') };
    const n = this.olderCount();
    if (n !== null && this.older()) {
      if (n > 0) return plain(this.plural.text('spaces.schema.convert.note.older', n, { type: this.type() }));
      if (this.pressed()) return plain(this.say('spaces.schema.convert.note.olderNone', { type: this.type() }));
    }
    return null;
  });

  constructor() {
    effect(() => {
      this.kind(); this.type(); this.older();
      this.state.schemaEpoch();
      this.state.settingsSpace();
      untracked(() => this.refresh());
    });
    inject(DestroyRef).onDestroy(() => this.stopReading());
  }

  /** A read through the injector: null where the host cannot provide it (no HTTP client), so the bar reads no note and still shows its button. */
  private api<T>(token: ProviderToken<T>): T | null {
    try { return this.injector.get(token); } catch { return null; }
  }

  private stopReading(): void {
    this.watch?.stop();
    this.watch = null;
    this.roundWatch?.stop();
    this.roundWatch = null;
    this.reads.forEach(s => s.unsubscribe());
    this.reads = [];
    this.startRead?.unsubscribe();
  }

  /** Read again what the note says: the run, the votes, the older count. An answer of an earlier generation is dropped. */
  private refresh(): void {
    this.stopReading();
    const gen = ++this.generation;
    const space = this.spaceId();
    const kind = this.kind();
    const type = this.type();
    const target = `${space}|${kind}|${type}`;
    if (target !== this.lastTarget) { this.lastTarget = target; this.sawRun.set(false); this.pressed.set(false); this.awaitedRound = null; }
    this.run.set(null);
    this.waiting.set(null);
    this.olderCount.set(null);
    const conversion = this.api(ConversionApi);
    if (!space || !conversion) return;

    let ranHere = false;
    this.watch = watchConvertRun(conversion, space, {
      onStatus: status => {
        if (gen !== this.generation) return;
        const run = this.runOf(status);
        this.run.set(run);
        if (run?.state === 'running' && run.types.some(t => t.kind === kind && t.type === type && !t.done)) { this.sawRun.set(true); ranHere = true; }
      },
      onFailure: () => { /* the note is auxiliary: a failed read says nothing, and the watch gives up on its own bound */ },
      // A run of this type ended while it was watched: the records it converted are no longer on an older version, so the count (and the button's
      // accent, which points at them) is read again.
      onFinished: () => { if (gen === this.generation && ranHere) this.readOlder(conversion, space, kind, type, gen); },
    });
    this.readVotes(conversion, space, kind, type, gen);
    this.readOlder(conversion, space, kind, type, gen);
  }

  /** How many records of the type are on an older version, when the type list marks it so. */
  private readOlder(conversion: ConversionApi, space: string, kind: TypedKind, type: string, gen: number): void {
    if (!this.older()) return;
    this.reads.push(conversion.olderCount(space, kind, type).subscribe(n => { if (gen === this.generation) this.olderCount.set(n); }));
  }

  private runOf(status: ConvertStatusAnswer): ConvertStatus | null {
    return status.state === 'none' || status.state === 'per_member' ? null : status;
  }

  /**
   * The open rounds of the space's networks that carry a conversion naming this type; the first one is what the note waits for. The networks are
   * scanned once per popup opening or save (`roundScans`) and the answer is reused for every type selected until a waited round changes.
   */
  private readVotes(conversion: ConversionApi, space: string, kind: TypedKind, type: string, gen: number): void {
    const networks = this.state.settingsSpace()?.networks ?? [];
    const api = networks.length > 0 ? this.api(NetworksApi) : null;
    if (!api) return;
    const key = `${space}|${this.state.schemaEpoch()}`;
    let scan = roundScans.get(this.state);
    // A scan of this opening already exists: the reader came (back) to this type, so a round it waits on is read again at once.
    const reused = scan?.key === key;
    if (!scan || !reused) {
      scan = {
        key,
        answer: forkJoin(networks.map(n => api.listVotes(n.id).pipe(
          map(r => ({ label: n.label, rounds: r.rounds })),
          catchError(() => of({ label: n.label, rounds: [] as VoteRound[] })),
        ))).pipe(shareReplay(1)),
      };
      roundScans.set(this.state, scan);
    }
    this.reads.push(scan.answer.subscribe(all => {
      if (gen !== this.generation) return;
      for (const { label, rounds } of all) {
        for (const round of rounds) {
          if (round.status !== 'open' || round.type !== 'meta_change' || round.localSpaceId !== space || !round.convertRecords) continue;
          const blocks = convertBlocksOfRound(round.convertRecords.steps);
          const named = blocks.find(b => b.kind === kind && ((b.was ?? b.type) === type || b.type === type));
          const block: ConvertBlock | null = named ?? (round.changedTypes?.includes(`${kind}:${type}`) ? { kind, type, steps: [] } : null);
          if (!block) continue;
          this.waiting.set({ network: label, type: block.was ?? block.type, counts: null });
          this.reads.push(conversion.countsFor(space, block).subscribe(answer => {
            if (gen === this.generation && answer.ok) this.waiting.update(w => (w ? { ...w, counts: answer.counts } : w));
          }));
          this.watchRound(api, round.networkId, round.id, gen, reused);
          return;
        }
      }
    }));
  }

  /**
   * Read the waited round again until it is no longer open (passed, vetoed or expired), then read everything again: the waiting note goes and the
   * run the round started, running or finished, takes over. Neither the run watch (it ends on an answer that is not a run in progress, and a veto
   * starts none) nor a save (a member's schema changes by the vote, with the popup open) would tell the bar.
   *
   * The rule: a vote lasts hours or days, so it is not watched at a run's pace. One read of the round's network every {@link VOTE_WATCH_MS} while the
   * tab is visible (a hidden tab skips its reads), one at once when the tab becomes visible again and when the reader returns to the type
   * (`readNow`: the scan was reused), and none per second-scale tick. Stopped when the popup closes (the bar goes), the type changes or a save
   * re-reads (`stopReading`), the round is no longer open, and after as many failed reads in a row as the run watch allows. Ten visible minutes
   * cost at most one read per interval; the note gives way within one interval of the round closing, or at once on returning to the type or the tab.
   */
  private watchRound(api: NetworksApi, networkId: string, roundId: string, gen: number, readNow: boolean): void {
    let failures = 0;
    let first = readNow;
    const watch = (): PollHandle => pollUntil({
      delayMs: () => { const wait = first ? 0 : VOTE_WATCH_MS; first = false; return wait; },
      request: () => api.listVotes(networkId),
      onAnswer: ({ rounds }) => {
        failures = 0;
        if (gen !== this.generation) return false;
        if (rounds.some(r => r.id === roundId && r.status === 'open')) return true;
        // The round changed: the scan this opening shares is out of date, so the next refresh scans again.
        roundScans.delete(this.state);
        this.awaitedRound = roundId;
        this.refresh();
        return false;
      },
      onError: () => { if (++failures >= CONVERT_POLL_FAILURES_MAX) stop(); },
    });
    let poll = watch();
    const onVisible = (): void => {
      if (document.hidden || !poll.active) return;
      poll.stop();
      first = true;
      poll = watch();
    };
    const stop = (): void => { poll.stop(); document.removeEventListener('visibilitychange', onVisible); };
    document.addEventListener('visibilitychange', onVisible);
    this.roundWatch = { stop, get active() { return poll.active; } };
  }

  /** The note's "Show the run": the progress dialog on the run the note is about, whatever started it (a vote's run has no other way there). */
  protected showRun(): void {
    this.runHost?.showRun(null, 'note', this.run());
  }

  // ── The act ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Open the Convert act on this type: no steps yet, the records counted by the dialog itself. */
  protected open(): void {
    if (this.reason() !== null) return;
    this.pressed.set(true);
    this.refusal.set(null);
    const block: ConvertBlockPlan = { kind: this.kind(), type: this.type(), steps: [], offers: [], warnings: [] };
    this.dialog.set({ blocks: [block], staged: this.state.buildMeta().typeSchemas as ConvertSchemas });
  }

  protected onChoice(choice: ConvertDialogChoice): void {
    if (choice.outcome !== 'convert') { this.dialog.set(null); this.refusal.set(null); return; }
    const conversion = this.api(ConversionApi);
    const space = this.spaceId();
    if (!conversion || !space) return;
    this.starting.set(true);
    this.refusal.set(null);
    this.startRead?.unsubscribe();
    this.startRead = conversion.start(space, choice.types, choice.steps).subscribe(result => {
      this.starting.set(false);
      if (!result.ok) { this.refusal.set(result.refusal); return; }
      this.dialog.set(null);
      this.sawRun.set(true);
      this.refresh();
      const types = result.value.types.length > 0 ? result.value.types : choice.types;
      this.runHost?.showRun({ state: 'started', types, toFp: result.value.toFp }, 'act');
    });
  }
}
