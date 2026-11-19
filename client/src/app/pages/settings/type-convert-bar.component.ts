import { ChangeDetectionStrategy, Component, DestroyRef, Injector, TemplateRef, computed, effect, inject, input, signal, untracked, viewChild, type ProviderToken } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { forkJoin, of, type Subscription } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { ConversionApi } from '../../core/conversion-api.service';
import type { BlockCounts, ConvertBlock } from '../../core/conversion-counts';
import type { ConversionRefusal, ConvertStatus, ConvertStatusAnswer } from '../../core/conversion.types';
import { NetworksApi } from '../../core/networks-api.service';
import { pageTranslator } from '../../core/page-translator';
import type { PollHandle } from '../../core/poll-until';
import { PluralText } from '../../core/plural-text.service';
import { mayConvertRecords } from '../../core/token-capability';
import type { TypedKind } from '../../core/type-field';
import { convertBlocksOfRound } from '../../core/vote-round-view';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { ConvertRecordsDialogComponent, type ConvertDialogChoice } from './convert-records-dialog.component';
import { watchConvertRun } from './convert-status-watch';
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
 *   run that finished, records on an older version. The finished note is for a run THIS bar saw, or one begun after the settings opened (a Save
 *   re-baselines them): an old finished run found on opening is never announced as news.
 * - **A vote the type does not know it is waiting on.** A round counts for this type when the vote row's own reading of its steps
 *   (`convertBlocksOfRound`) names the type by either of its names, or when the round says it changes the type (`changedTypes`, `kind:type`); the counts are
 *   those of this instance's records, under the name they still carry, so the note and the vote row cannot count different records.
 * - **A run read for ever.** The status is read on `watchConvertRun`'s bound: at once, every three seconds while it runs, ended by the run's end, by a
 *   re-read after a save, and by the bar going. A read that fails says nothing here (the dialog a converting Save leaves open does say so).
 * - **A note that outlives its answer.** Every read belongs to a generation; an answer of an older one (another type, another space, a save since) is dropped.
 * - **A host with no network to ask.** The reads go through the injector and a host that has no HTTP client reads no note; the button still shows.
 *
 * The note says nothing for what it cannot read (the votes of a token that is not an instance administrator, a count that failed): an absent note is
 * never an error, and nothing here blocks the button.
 */
let seq = 0;

@Component({
  selector: 'app-type-convert-bar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, PhIconComponent, ConvertRecordsDialogComponent],
  styles: [`
    :host { display: block; }
    .cv-btn { gap: 5px; }
    .cv-btn[disabled] { cursor: not-allowed; }
    .cv-reason { margin: 6px 0 0; }
    .cv-note { margin: 8px 0 0; font-size: 13px; }
    .cv-bar-hint { font-size: 11px; font-weight: 400; color: var(--text-muted); }
  `],
  template: `
    <ng-template #button>
      <button class="btn btn-ghost btn-sm cv-btn" type="button" data-testid="convert-records" style="padding:2px 6px;"
        [disabled]="reason() !== null" [attr.title]="reason()" [attr.aria-describedby]="reason() !== null ? reasonId : null" (click)="open()">
        <ph-icon name="arrows-clockwise" [size]="13"/>{{ 'spaces.schema.convert.button' | transloco }}
      </button>
    </ng-template>
    @if (reason(); as why) { <p class="cv-reason cv-bar-hint" [id]="reasonId" data-testid="convert-locked">{{ why }}</p> }
    @if (note(); as sentence) { <div class="alert alert-info cv-note" role="status" data-testid="convert-note">{{ sentence }}</div> }
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
  private reads: Subscription[] = [];
  private startRead: Subscription | undefined;

  /** The one note, or none: waiting for a vote, the run, its finish, records on an older version. */
  protected readonly note = computed<string | null>(() => {
    const w = this.waiting();
    if (w) {
      const waits = this.say('spaces.schema.convert.note.waiting', { network: w.network });
      const c = w.counts;
      return c && c.total > 0
        ? `${waits} ${this.plural.text('spaces.schema.convert.note.waitingCounts', c.total, { type: w.type, stamped: c.stamped, rewritten: c.rewritten })}`
        : waits;
    }
    const run = this.run();
    const entry = run?.types.find(t => t.kind === this.kind() && t.type === this.type());
    if (run && entry) {
      const done = run.counts.stamped + run.counts.rewritten + run.counts.unconverted + run.counts.moved;
      if (run.state === 'running' && !entry.done) {
        return run.left === null
          ? `${this.say('spaces.schema.convert.run.converting')} (${this.say('spaces.schema.convert.run.counting')})`
          : this.plural.text('spaces.schema.convert.note.running', done + run.left, { done });
      }
      if (this.sawRun() || this.state.schemaEpoch() > this.openedAt) {
        if (run.state === 'failed') return this.say('spaces.schema.convert.run.failed', { error: run.error ?? '' });
        const finished = this.say('spaces.schema.convert.note.finished');
        return run.counts.unconverted > 0 ? `${finished} ${this.plural.text('spaces.schema.convert.note.finishedSome', run.counts.unconverted)}` : finished;
      }
    }
    const n = this.olderCount();
    if (n !== null && this.older()) {
      if (n > 0) return this.plural.text('spaces.schema.convert.note.older', n, { type: this.type() });
      if (this.pressed()) return this.say('spaces.schema.convert.note.olderNone', { type: this.type() });
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
    if (target !== this.lastTarget) { this.lastTarget = target; this.sawRun.set(false); this.pressed.set(false); }
    this.run.set(null);
    this.waiting.set(null);
    this.olderCount.set(null);
    const conversion = this.api(ConversionApi);
    if (!space || !conversion) return;

    this.watch = watchConvertRun(conversion, space, {
      onStatus: status => {
        if (gen !== this.generation) return;
        const run = this.runOf(status);
        this.run.set(run);
        if (run?.state === 'running' && run.types.some(t => t.kind === kind && t.type === type && !t.done)) this.sawRun.set(true);
      },
      onFailure: () => { /* the note is auxiliary: a failed read says nothing, and the watch gives up on its own bound */ },
    });
    this.readVotes(conversion, space, kind, type, gen);
    if (this.older()) {
      this.reads.push(conversion.olderCount(space, kind, type).subscribe(n => { if (gen === this.generation) this.olderCount.set(n); }));
    }
  }

  private runOf(status: ConvertStatusAnswer): ConvertStatus | null {
    return status.state === 'none' || status.state === 'per_member' ? null : status;
  }

  /** The open rounds of the space's networks that carry a conversion naming this type; the first one is what the note waits for. */
  private readVotes(conversion: ConversionApi, space: string, kind: TypedKind, type: string, gen: number): void {
    const networks = this.state.settingsSpace()?.networks ?? [];
    const api = networks.length > 0 ? this.api(NetworksApi) : null;
    if (!api) return;
    this.reads.push(forkJoin(networks.map(n => api.listVotes(n.id).pipe(
      map(r => ({ label: n.label, rounds: r.rounds })),
      catchError(() => of({ label: n.label, rounds: [] })),
    ))).subscribe(all => {
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
          return;
        }
      }
    }));
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
    });
  }
}
