import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, effect, inject, input, linkedSignal, output, signal, untracked, viewChild } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import type { Subscription } from 'rxjs';
import { ConversionApi } from '../../core/conversion-api.service';
import { rewriteScopeOf, type BlockCounts, type ConvertBlock } from '../../core/conversion-counts';
import type { ConversionRefusal, ConversionStep, ConvertRunNotice, ConvertStatusAnswer, ConvertTypeRef } from '../../core/conversion.types';
import { pageTranslator } from '../../core/page-translator';
import { PluralText } from '../../core/plural-text.service';
import { mayConvertRecords } from '../../core/token-capability';
import { ModalDirective } from '../../shared/modal.directive';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { CONVERSION_LIMITS } from '../../shared/conversion-limits';
import { STACK } from '../../shared/stacking';
import { ConvertRunBlockComponent, markName, markedPieces, runFooterOf, stepPieces } from './convert-run-block.component';
import { ConvertStepEditorComponent } from './convert-step-editor.component';
import { editOf, locateStep, offerStep, sortEdits, stepsOfEdits, withAddedTypes, type AddedType, type ConvertBlockPlan, type ConvertSchemas, type EditStep } from './convert-steps';
import { DIALOG_STYLES } from './dialog.styles';
import type { TokenRights } from './rights-glyph.component';
import { piecesOf, type SentencePiece } from './vote-conversion-block.component';

/**
 * The dialog that offers converting records at Save, and its other faces (bundle-285 slice S5, Q-747; plan sections 3.1 item 4, 4, 5 rows D,
 * N, R and A, 6, 7, 11; drawing moments 1a to 2b, 3a, 3b, 4a, 4b and 6).
 *
 * ONE dialog, four modes, so the page that opens it holds one component and one set of rules:
 *
 * - `offer`: Save with a changed type. One block per changed type (its steps as sentences, its counts, its warnings), "Edit steps" for the
 *   step editor, the choice "Convert the records now" or "Save only, convert later", and the vote's words when `network` names one.
 * - `act`: the Convert records button on a type. One block with no steps yet, the editor's add row, how many records are checked, and Convert records.
 * - `progress`: a run, running and finished, as the run block shows it, with Open Review in the footer.
 * - `submitted`: after a vote was opened, the steps and this instance's counts and the way to Networks.
 *
 * The host gives it the blocks (`convertBlocks`, from the rename ledger and the schema difference) and the staged schema, and takes ONE value
 * back, `choice`; the save itself is the host's. The dialog asks the server one thing, the counts, through S2's `ConversionApi.countsFor`.
 *
 * ## What it prevents
 *
 * - **A number the server cannot give, shown anyway.** The counts are S2's only (`countsFor`), per type, under the type's stored name. A split
 *   says every record changes its type and that how many go to each type is counted as the conversion runs, at every size (owner, 2026-11-19);
 *   a count still being read, or that failed, says so and NEVER blocks Save: both outcomes stay offered. Under the counts sits the owner's
 *   hint that records which do not fit the new schema are listed in Review instead (a record no step changes is counted "only stamped" and
 *   may still end unconverted).
 * - **`convertRecords` sent for Save only.** `choice` for "Save only" and for Cancel carries NO steps, no blocks, no types and no new type, so a
 *   host that sends `convertRecords` from `choice.steps` can never send one for them. A new type made for a split that is not sent is not reported.
 * - **A step that is not one.** Only complete rows are sent, in the order the server applies them. A map offered for a removed enum value starts
 *   with no target and is no step until each value has one; until then the primary waits (Save only does not), and the hint says why.
 * - **An unexplained lock.** Without the right to convert (`mayConvertRecords`, or a refusal `no_right`) the convert choice is disabled WITH its
 *   reason, "Save only" is picked and the primary says Save.
 * - **A refusal as a code.** A rate limit with its retry time, a conversion already running, a stale schema, any other failure, each in words
 *   (through S2's typed refusal); a bad step is shown on its own row, by the index the server names among the steps SENT, with the editor opened
 *   on it and focus on its sentence.
 * - **Nothing to convert, said as a choice.** With no records of any type the choice is not offered: the footer says there is nothing to
 *   convert and the one act is Save.
 * - **A rule left behind.** A rename rewrites no rule: a rule or naming pattern that still names a renamed property's old name is a warning
 *   line on the block of its type.
 * - **Escape closing too much.** Escape closes the innermost layer: a new type's name, then the step editor, then the dialog. Focus stays
 *   inside (the modal directive's trap) and returns to the Edit steps button when the editor closes.
 * - **A name taken for markup.** Every type, property and rule name is bound as text, cut out of its sentence by the vote row's markers
 *   (`piecesOf`) so it is set in the code face.
 *
 * `closed` is the dialog closed in `progress` and `submitted` (nothing is cancelled by it); in `offer` and `act` closing is a `choice` of
 * `cancel`.
 */

/** What the dialog answers: convert (with what to convert), later (Save only) or cancel. Only `convert` carries anything. */
export interface ConvertDialogChoice {
  outcome: 'convert' | 'later' | 'cancel';
  /** The complete steps over all blocks, in the order they are sent and applied: the `convertRecords.steps` of the save, or the Convert act's `steps`. */
  steps: ConversionStep[];
  /** Each block with its final steps (the counts and the progress are read by them). */
  blocks: ConvertBlock[];
  /** The types the conversion reaches, for the Convert act's `types`. */
  types: ConvertTypeRef[];
  /** The types "Add a new type" made and a sent step targets: the host adds each to the staged schema (`withAddedTypes`) before it saves. */
  addedTypes: AddedType[];
}

const NOTHING: Omit<ConvertDialogChoice, 'outcome'> = { steps: [], blocks: [], types: [], addedTypes: [] };

/** One empty object and one empty list for every "nothing here" a binding hands a child: a fresh one per check would be a change at every check. */
const NO_ERRORS: Record<number, string> = {};

type CountView = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; counts: BlockCounts };
const LOADING: CountView = { state: 'loading' };
const FAILED: CountView = { state: 'failed' };

/** A type name past this length is shown as "this type" in the act's title: the title is one line. */
const ACT_TITLE_NAME_MAX = 30;

/** What the counts of a block depend on: the records it counts and the rows it rewrites (not the text of a condition). */
const countKey = (block: ConvertBlock): string => JSON.stringify([block.kind, block.type, block.was ?? null, rewriteScopeOf(block)]);

let seq = 0;

@Component({
  selector: 'app-convert-records-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, TranslocoPipe, PhIconComponent, ModalDirective, ConvertStepEditorComponent, ConvertRunBlockComponent],
  styles: [DIALOG_STYLES, `
    /* Above the settings popup that hosts it, as every dialog opened from inside it. */
    .dialog-backdrop { z-index: ${STACK.hostedDialog}; }
    .cv-dialog { --dialog-max-width: 780px; display: flex; flex-direction: column; padding: 0; overflow: hidden; max-height: 100%; background: var(--bg-card); }
    .cv-dhead { display: flex; align-items: flex-start; gap: 8px; padding: 1.25rem 1.5rem .4rem; flex-shrink: 0; }
    .cv-dhead h2 { flex: 1; margin: 0; font-size: 1.1rem; color: var(--text-primary); }
    .cv-dbody { overflow-y: auto; padding: 0 1.5rem 1rem; flex: 1 1 auto; min-height: 0; }
    .cv-dfoot { display: flex; gap: 10px; justify-content: flex-end; align-items: center; flex-wrap: wrap; padding: 12px 1.5rem; border-top: 1px solid var(--border); flex-shrink: 0; background: var(--bg-card); }
    .cv-lead { margin: 0 0 .8rem; color: var(--text-secondary); font-size: .9rem; line-height: 1.5; }
    .cv-steps-h { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin: 4px 0 2px; font-size: 12.5px; color: var(--text-secondary); }
    .cv-type { padding: 10px 0; border-top: 1px solid var(--border-muted); }
    .cv-type-h { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
    .cv-type-h .cv-count { margin-inline-start: auto; font-size: 12px; color: var(--text-muted); }
    .cv-tn { font-family: var(--font-mono); font-size: 12px; color: var(--accent); overflow-wrap: anywhere; }
    .cv-preview { margin: 10px 0 4px; font-size: 13px; color: var(--text-primary); overflow-wrap: anywhere; }
    .cv-sent { margin: 6px 0 4px; padding-left: 18px; font-size: 12.5px; color: var(--text-secondary); line-height: 1.7; overflow-wrap: anywhere; }
    .cv-explain { margin: 6px 0 0; font-size: 11.5px; color: var(--text-muted); line-height: 1.5; max-width: 78ch; }
    .cv-warn-line { margin: 6px 0 0; padding: 6px 10px; font-size: 12.5px; overflow-wrap: anywhere; }
    .cv-outs { border: 0; margin: 14px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
    .cv-out { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-md); cursor: pointer; font-size: 13px; }
    .cv-out:has(input:checked) { border-color: var(--accent); background: var(--accent-dim); }
    .cv-out:has(input:disabled) { cursor: not-allowed; opacity: .7; }
    .cv-out input { margin-top: 3px; flex-shrink: 0; }
    .cv-out strong { display: block; font-weight: 600; color: var(--text-primary); }
    .cv-out .sch-hint { display: block; margin-top: 2px; font-size: 12px; color: var(--text-secondary); }
    .cv-locked-line { margin: -2px 0 0; font-size: 12px; color: var(--text-secondary); }
    .cv-foot-msg { flex: 1 1 100%; margin: 0; font-size: 12.5px; color: var(--text-secondary); overflow-wrap: anywhere; }
    .cv-foot-msg.cv-err { color: var(--error); }
    .cv-foot-info { flex: 1 1 100%; margin: 0; padding: 6px 12px; font-size: 13px; }
    .sch-hint { font-size: 11px; font-weight: 400; text-transform: none; letter-spacing: 0; color: var(--text-muted); }
    @media (max-width: 760px) {
      .cv-dhead { padding: 1rem 1rem .3rem; }
      .cv-dbody { padding: 0 1rem .8rem; }
      .cv-dfoot { padding: 10px 1rem; }
      .cv-dfoot .btn { flex: 1 1 40%; justify-content: center; }
    }
  `],
  template: `
    <div class="dialog-backdrop">
      <div class="dialog cv-dialog" [appModal]="title()" (dismiss)="onDismiss()" (click)="$event.stopPropagation()">
        <div class="cv-dhead">
          <h2 [id]="titleId" data-testid="cv-title">{{ title() }}</h2>
          <button class="icon-btn" type="button" data-testid="cv-close" [attr.aria-label]="'common.close' | transloco" (click)="close()"><ph-icon name="x" [size]="14"/></button>
        </div>

        <div class="cv-dbody">
          @if (lead(); as text) { <p class="cv-lead" data-testid="cv-lead">{{ text }}</p> }

          @switch (mode()) {
            @case ('progress') {
              <app-convert-run-block [spaceId]="spaceId()" [status]="status()" [notice]="notice()" />
            }
            @default {
              @if (mode() === 'offer') {
                <div class="cv-steps-h">
                  <span data-testid="cv-steps-bar">{{ stepsBarText() }}</span>
                  <button class="btn btn-secondary btn-sm" type="button" #toggle data-testid="cv-edit-toggle" [attr.aria-expanded]="editing()" (click)="toggleEditor()">
                    {{ (editing() ? 'spaces.schema.convert.hideSteps' : 'spaces.schema.convert.editSteps') | transloco }}
                  </button>
                </div>
              }
              @for (b of blocks(); track $index; let i = $index) {
                @if (!(mode() === 'submitted' && isEmpty(i))) {
                  <section class="cv-type" data-testid="cv-block">
                    <div class="cv-type-h">
                      <span class="cv-tn">{{ b.type }}</span>
                      @if (b.was) { <span class="sch-hint" data-testid="cv-was">{{ wasText(b.was) }}</span> }
                      <span class="cv-count" data-testid="cv-stepcount">{{ stepCountText(i) }}</span>
                    </div>
                    @for (w of warnings()[i] ?? none; track $index) {
                      <div class="alert alert-warning cv-warn-line" role="status" data-testid="cv-warning">@for (p of w; track $index) {<span [class.cv-tn]="p.name">{{ p.text }}</span>}</div>
                    }
                    <p class="cv-preview" data-testid="cv-counts">
                      @if (countLines()[i]; as line) { @for (p of line; track $index) {<span [class.cv-tn]="p.name">{{ p.text }}</span>} }
                      @else if (countState(i).state === 'failed') { {{ 'spaces.schema.convert.countFailed' | transloco }} }
                      @else { <span class="spinner" style="width: 11px; height: 11px; border-width: 2px;"></span> {{ 'spaces.schema.convert.counting' | transloco }} }
                    </p>
                    @if (showUnfit(i)) { <p class="sch-hint" data-testid="cv-unfit">{{ 'spaces.schema.convert.dialog.unfitHint' | transloco }}</p> }
                    @if (showWhole(i)) { <p class="sch-hint" data-testid="cv-whole">{{ 'spaces.schema.convert.wholeType' | transloco }}</p> }
                    @if (editing() || mode() === 'act') {
                      <app-convert-step-editor [steps]="rows()[i] ?? noRows" [kind]="b.kind" [type]="b.type" [staged]="stagedWithAdded()" [canAddStep]="canAddStep()"
                        [errors]="errorsByBlock()[i] ?? noErrors" [focusError]="focusFor(i)" (stepsChange)="setRows(i, $event)" (typeAdded)="addType($event)" />
                    } @else {
                      @if (sentences()[i]?.length) {
                        <ul class="cv-sent">
                          @for (s of sentences()[i] ?? none; track $index) { <li data-testid="cv-sentence">@for (p of s; track $index) {<span [class.cv-tn]="p.name">{{ p.text }}</span>}</li> }
                        </ul>
                      }
                    }
                  </section>
                }
              }

              @if (mode() === 'submitted') {
                <p class="cv-explain" data-testid="cv-after">{{ 'spaces.schema.convert.submitted.after' | transloco }}</p>
              } @else {
                <p class="cv-explain" data-testid="cv-define">{{ 'spaces.schema.convert.define' | transloco }}</p>
              }

              @if (mode() === 'offer' && !allEmpty()) {
                <fieldset class="cv-outs">
                  <legend class="sr-only">{{ 'spaces.schema.convert.outcomesLegend' | transloco }}</legend>
                  <label class="cv-out" data-testid="cv-outcome-now">
                    <input type="radio" [name]="groupName" [checked]="effectiveOutcome() === 'convert'" [disabled]="locked()" [attr.aria-describedby]="locked() ? lockedId : null" (change)="pick('convert')">
                    <span>
                      <strong>{{ (network() ? 'spaces.schema.convert.afterVote' : 'spaces.schema.convert.now') | transloco }}</strong>
                      <span class="sch-hint">{{ (network() ? 'spaces.schema.convert.afterVoteHint' : 'spaces.schema.convert.nowHint') | transloco }}</span>
                    </span>
                  </label>
                  @if (locked()) { <p class="cv-locked-line" [id]="lockedId" data-testid="cv-locked">{{ 'spaces.schema.convert.lockedChoice' | transloco }}</p> }
                  <label class="cv-out" data-testid="cv-outcome-later">
                    <input type="radio" [name]="groupName" [checked]="effectiveOutcome() === 'later'" (change)="pick('later')">
                    <span>
                      <strong>{{ 'spaces.schema.convert.later' | transloco }}</strong>
                      <span class="sch-hint">{{ 'spaces.schema.convert.laterHint' | transloco }}</span>
                    </span>
                  </label>
                </fieldset>
              }
              @if (mode() === 'act' && locked()) {
                <p class="cv-locked-line" data-testid="cv-locked">{{ 'spaces.schema.convert.locked' | transloco }}</p>
              }
            }
          }
        </div>

        <div class="cv-dfoot" data-testid="cv-foot">
          @if (refusalText(); as refused) { <p class="cv-foot-msg cv-err" role="alert" data-testid="cv-refusal">{{ refused }}</p> }
          @if (showIncomplete()) { <p class="cv-foot-msg" role="status" data-testid="cv-incomplete">{{ 'spaces.schema.convert.incomplete' | transloco }}</p> }
          @if (footInfo(); as info) {
            <div class="alert alert-info cv-foot-info" role="status" data-testid="cv-foot-info">@for (p of info; track $index) {<span [class.cv-tn]="p.name">{{ p.text }}</span>}</div>
          }
          @switch (mode()) {
            @case ('progress') {
              @let footer = runFooter();
              @if (footer.kind === 'hint') {
                <span class="sch-hint" style="margin-right: auto;" data-testid="cv-foot-hint">{{ footer.key | transloco }}</span>
              } @else {
                <button type="button" class="btn btn-sm" data-testid="cv-open-review" [class.btn-primary]="footer.kind === 'review'" [class.btn-secondary]="footer.kind === 'reviewSoFar'" (click)="openReview.emit()">
                  {{ (footer.kind === 'review' ? 'spaces.schema.convert.run.openReview' : 'spaces.schema.convert.run.openReviewSoFar') | transloco: { n: footer.n } }}
                </button>
              }
            }
            @case ('submitted') {
              <button type="button" class="btn btn-primary btn-sm" data-testid="cv-primary" (click)="openNetworks.emit()">{{ 'spaces.schema.convert.submitted.openNetworks' | transloco }}</button>
            }
            @default {
              <button type="button" class="btn btn-secondary btn-sm" data-testid="cv-cancel" [disabled]="busy()" (click)="close()">{{ 'common.cancel' | transloco }}</button>
              <button type="button" class="btn btn-primary btn-sm" data-testid="cv-primary" [disabled]="primaryDisabled()" (click)="submit()">
                @if (busy()) { <span class="spinner" style="width: 12px; height: 12px; border-width: 2px;"></span> }
                {{ primaryLabel() }}
              </button>
            }
          }
        </div>
      </div>
    </div>
  `,
})
export class ConvertRecordsDialogComponent {
  /** Which face of the dialog. */
  readonly mode = input.required<'offer' | 'act' | 'progress' | 'submitted'>();
  readonly spaceId = input.required<string>();
  /** The changed types (`convertBlocks`), or the one type of the Convert act (no steps). Unused by `progress`. */
  readonly blocks = input<readonly ConvertBlockPlan[]>([]);
  /** The staged schema (`buildMeta().typeSchemas`): the editor's pickers list its types and read its enums. */
  readonly staged = input<ConvertSchemas>({});
  /** The network the space votes in: the offer is then the vote's (counts say "here", Convert after the vote, Submit). `submitted` names it. */
  readonly network = input<string | null>(null);
  /** The token's rights, for the lock on the convert choice; unknown rights (null) count as allowed, the server decides. */
  readonly rights = input<TokenRights | null | undefined>(undefined);
  /** The refusal of the last save or start, from S2's `conversionRefusalOf`; the host clears it when it tries again. */
  readonly refusal = input<ConversionRefusal | null>(null);
  /** The save or the start is in flight: the buttons wait. */
  readonly busy = input(false);
  /** `progress`: the run as the status door answers it, and what the save answered. */
  readonly status = input<ConvertStatusAnswer | null>(null);
  readonly notice = input<ConvertRunNotice | null>(null);

  /** `offer` and `act`: the answer. */
  readonly choice = output<ConvertDialogChoice>();
  /** `progress` and `submitted`: the dialog was closed (nothing is cancelled by it). */
  readonly closed = output<void>();
  /** `progress`: Open Review. */
  readonly openReview = output<void>();
  /** `submitted`: Open Networks. */
  readonly openNetworks = output<void>();

  private readonly conversion = inject(ConversionApi);
  private readonly plural = inject(PluralText);
  private readonly say = pageTranslator();
  private readonly toggle = viewChild<ElementRef<HTMLButtonElement>>('toggle');

  protected readonly none: SentencePiece[][] = [];
  protected readonly noRows: EditStep[] = [];
  protected readonly noErrors = NO_ERRORS;

  private readonly id = ++seq;
  protected readonly titleId = `cv-title-${this.id}`;
  protected readonly lockedId = `cv-locked-${this.id}`;
  /** One radio group per dialog: two dialogs on a page never share one. */
  protected readonly groupName = `cv-outcome-${this.id}`;

  /** The editor's rows per block: its steps and the maps offered for its removed enum values, in the order they are sent. Start again when the blocks change. */
  protected readonly rows = linkedSignal<readonly ConvertBlockPlan[], EditStep[][]>({
    source: this.blocks,
    computation: blocks => blocks.map(b => sortEdits([...b.steps.map(editOf), ...b.offers.map(offerStep)])),
  });
  /** Types "Add a new type" made. */
  private readonly added = linkedSignal<readonly ConvertBlockPlan[], AddedType[]>({ source: this.blocks, computation: () => [] });
  /** Is the step editor open? It starts open for an offered map (a person has to choose), and is always open in the act. */
  protected readonly editing = linkedSignal(() => this.mode() === 'act' || this.blocks().some(b => b.offers.length > 0));
  private readonly picked = signal<'convert' | 'later'>('convert');
  private readonly counts = signal<Record<number, CountView>>({});
  private readonly refusedRight = signal(false);

  private keys: string[] = [];
  private subscriptions: (Subscription | undefined)[] = [];

  protected readonly stagedWithAdded = computed(() => withAddedTypes(this.staged(), this.added()));
  private readonly totalRows = computed(() => this.rows().reduce((n, r) => n + r.length, 0));
  protected readonly canAddStep = computed(() => this.totalRows() < CONVERSION_LIMITS.stepsMax);

  /** The blocks as the counts read them: the type's records and the complete steps. */
  private readonly liveBlocks = computed<ConvertBlock[]>(() => this.blocks().map((b, i) => ({
    kind: b.kind, type: b.type, ...(b.was !== undefined ? { was: b.was } : {}), steps: stepsOfEdits(this.rows()[i] ?? []),
  })));

  protected readonly completeCount = computed(() => this.liveBlocks().reduce((n, b) => n + b.steps.length, 0));
  protected readonly hasIncomplete = computed(() => this.rows().some(r => r.length > stepsOfEdits(r).length));

  // ── Rights ───────────────────────────────────────────────────────────────────────────────────────────────────────────

  protected readonly locked = computed(() => !mayConvertRecords(this.rights(), this.spaceId()) || this.refusedRight());
  protected readonly effectiveOutcome = computed<'convert' | 'later'>(() => (this.locked() ? 'later' : this.picked()));

  // ── What the counts say ─────────────────────────────────────────────────────────────────────────────────────────────────

  protected countState(i: number): CountView { return this.counts()[i] ?? LOADING; }
  protected isEmpty(i: number): boolean { const c = this.countState(i); return c.state === 'ready' && c.counts.total === 0; }
  private readonly noRecordsAnywhere = computed(() => this.blocks().length > 0 && this.blocks().every((_, i) => this.isEmpty(i)));
  /** Offer only: no record of any changed type, so there is nothing to convert and the one act is Save. */
  protected readonly allEmpty = computed(() => this.mode() === 'offer' && this.noRecordsAnywhere());

  /** The sentence of each block's counts, or null while they are being read or when they failed. Names are in the code face. */
  protected readonly countLines = computed<(SentencePiece[] | null)[]>(() => this.blocks().map((block, i) => {
    const view = this.countState(i);
    if (view.state !== 'ready') return null;
    const c = view.counts;
    if (this.mode() === 'act') {
      return c.total === 0 ? markedPieces(this.say, 'spaces.schema.convert.act.noneToCheck', {}) : piecesOf(this.plural.text('spaces.schema.convert.act.checked', c.total));
    }
    const here = this.network() !== null;
    if (c.total === 0) return markedPieces(this.say, 'spaces.schema.convert.noRecords', { type: block.was ?? block.type });
    if (c.casesCountedAsItRuns) {
      return piecesOf(this.plural.text(here ? 'spaces.schema.convert.splitHere' : 'spaces.schema.convert.split', c.total, { type: markName(block.type) }));
    }
    return piecesOf(this.plural.text(here ? 'spaces.schema.convert.countsHere' : 'spaces.schema.convert.counts', c.total, {
      type: markName(block.was ?? block.type), stamped: c.stamped, rewritten: c.rewritten,
    }));
  }));

  protected showUnfit(i: number): boolean {
    const view = this.countState(i);
    return this.mode() === 'offer' && view.state === 'ready' && view.counts.total > 0;
  }

  protected showWhole(i: number): boolean {
    const view = this.countState(i);
    return this.mode() !== 'act' && view.state === 'ready' && view.counts.total > 0 && (this.liveBlocks()[i]?.steps.length ?? 0) >= 2;
  }

  // ── Words ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

  protected readonly title = computed(() => {
    switch (this.mode()) {
      case 'offer': return this.say(this.network() ? 'spaces.schema.convert.titleNet' : 'spaces.schema.convert.title');
      case 'submitted': return this.say('spaces.schema.convert.submitted.title');
      case 'progress': return this.say(this.runningNow() ? 'spaces.schema.convert.run.titleRunning' : 'spaces.schema.convert.run.titleDone');
      case 'act': {
        const type = this.blocks()[0]?.type ?? '';
        return type.length > ACT_TITLE_NAME_MAX ? this.say('spaces.schema.convert.act.titleShort') : this.say('spaces.schema.convert.act.title', { type });
      }
    }
  });

  private readonly runningNow = computed(() => { const s = this.status(); return !!s && s.state === 'running'; });

  protected readonly lead = computed<string | null>(() => {
    switch (this.mode()) {
      case 'offer': {
        const lead = this.network() ? this.say('spaces.schema.convert.leadNet', { network: this.network() }) : this.say('spaces.schema.convert.lead');
        return this.blocks().length >= 2 ? `${this.say('spaces.schema.convert.twoTypes')} ${lead}` : lead;
      }
      case 'act': return this.say('spaces.schema.convert.act.lead');
      case 'submitted': return this.say('spaces.schema.convert.submitted.lead', { network: this.network() ?? '' });
      case 'progress': return this.runningNow() ? this.say('spaces.schema.convert.run.keepsRunning') : null;
    }
  });

  protected readonly stepsBarText = computed(() => (this.completeCount() === 0
    ? this.say('spaces.schema.convert.noSteps')
    : this.plural.text('spaces.schema.convert.stepsBar', this.completeCount())));

  protected stepCountText(i: number): string {
    const n = this.liveBlocks()[i]?.steps.length ?? 0;
    return n === 0 ? this.say('spaces.schema.convert.noSteps') : this.plural.text('spaces.schema.convert.stepCount', n);
  }

  protected wasText(name: string): string { return this.say('spaces.schema.was', { name }); }

  protected readonly sentences = computed<SentencePiece[][][]>(() => this.liveBlocks().map(b => b.steps.map(step => stepPieces(this.say, step))));

  protected readonly warnings = computed<SentencePiece[][][]>(() => this.blocks().map(b => b.warnings.map(w => (w.kind === 'rule'
    ? markedPieces(this.say, 'spaces.schema.convert.warn.rule', { rule: w.rule, type: w.type, property: w.property, to: w.to })
    : markedPieces(this.say, 'spaces.schema.convert.warn.namingPattern', { type: w.type, property: w.property, to: w.to })))));

  /** With no records anywhere: the footer says there is nothing to convert. */
  protected readonly footInfo = computed<SentencePiece[] | null>(() => {
    if (!this.allEmpty()) return null;
    const blocks = this.blocks();
    const name = blocks[0] ? (blocks[0].was ?? blocks[0].type) : '';
    const net = this.network();
    if (net !== null && net !== '') return markedPieces(this.say, 'spaces.schema.convert.noRecordsNet', { network: net, type: name }, { plain: ['network'] });
    if (blocks.length >= 2) return markedPieces(this.say, 'spaces.schema.convert.noRecordsTwo', {});
    return markedPieces(this.say, 'spaces.schema.convert.noRecordsShort', { type: name });
  });

  protected readonly runFooter = computed(() => runFooterOf(this.status(), this.notice()));

  // ── Refusals ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** The row a refused step is, among the rows sent. */
  private readonly badStep = computed(() => {
    const r = this.refusal();
    return r?.kind === 'bad_step' ? locateStep(this.rows(), r.step) : null;
  });

  /** The server's sentence of the refused step, as the editor of its block takes it; one entry per block (the same object while nothing changed). */
  protected readonly errorsByBlock = computed<Record<number, string>[]>(() => {
    const at = this.badStep();
    const r = this.refusal();
    return this.blocks().map((_, i) => (at && at.block === i && r?.kind === 'bad_step' ? { [at.row]: r.error } : NO_ERRORS));
  });

  protected focusFor(block: number): number | null {
    const at = this.badStep();
    return at && at.block === block ? at.row : null;
  }

  /** The refusal as a sentence, for what is not shown on a row or as the lock. */
  protected readonly refusalText = computed<string | null>(() => {
    const r = this.refusal();
    if (!r) return null;
    switch (r.kind) {
      case 'rate_limited': {
        const base = this.say('spaces.schema.convert.rateLimited');
        return r.retryAfterSeconds === null ? base : `${base} ${this.say('spaces.schema.convert.retryIn', { seconds: r.retryAfterSeconds })}`;
      }
      case 'running': return this.say('spaces.schema.convert.running409');
      case 'stale': return this.say('refusal.schemaChanged');
      case 'no_right': return null;
      case 'bad_step': return this.badStep() ? null : (r.error || this.say('spaces.error.saveFailed'));
      case 'other': return r.error || this.say('spaces.error.saveFailed');
      default: return this.say('spaces.error.saveFailed');
    }
  });

  // ── The choice ───────────────────────────────────────────────────────────────────────────────────────────────────────────

  protected readonly showIncomplete = computed(() => this.hasIncomplete() && (this.mode() === 'act' || (this.mode() === 'offer' && this.effectiveOutcome() === 'convert' && !this.allEmpty())));

  protected readonly primaryDisabled = computed(() => {
    if (this.busy()) return true;
    if (this.mode() === 'act') {
      const first = this.counts()[0];
      return this.locked() || this.hasIncomplete() || (first?.state === 'ready' && first.counts.total === 0);
    }
    return this.showIncomplete();
  });

  protected readonly primaryLabel = computed(() => {
    if (this.mode() === 'act') return this.say('spaces.schema.convert.act.run');
    const net = this.network() !== null;
    if (this.allEmpty() || this.effectiveOutcome() === 'later') return this.say(net ? 'spaces.schema.convert.submitForVote' : 'spaces.schema.convert.save');
    return this.say(net ? 'spaces.schema.convert.submitWith' : 'spaces.schema.convert.saveAndConvert');
  });

  protected pick(outcome: 'convert' | 'later'): void { this.picked.set(outcome); }

  /** The types a complete split step sends records to: only those "Add a new type" made AND a step still targets are reported. */
  private usedAdded(steps: readonly ConversionStep[]): AddedType[] {
    const targets = new Set(steps.flatMap(s => (s.op === 'splitType' ? [...s.cases.map(c => c.to), ...(s.otherwise ? [s.otherwise] : [])] : [])));
    return this.added().filter(a => targets.has(a.name));
  }

  protected submit(): void {
    if (this.mode() === 'offer' && (this.allEmpty() || this.effectiveOutcome() === 'later')) {
      this.choice.emit({ outcome: 'later', ...NOTHING });
      return;
    }
    const blocks = this.liveBlocks();
    const steps = blocks.flatMap(b => b.steps);
    this.choice.emit({
      outcome: 'convert', steps, blocks: blocks.map(b => ({ ...b })),
      types: blocks.map(b => ({ kind: b.kind, type: b.type })), addedTypes: this.usedAdded(steps),
    });
  }

  /** The close button and Cancel: a cancel in the offer and the act, a plain close in the other faces. */
  protected close(): void {
    if (this.mode() === 'offer' || this.mode() === 'act') this.choice.emit({ outcome: 'cancel', ...NOTHING });
    else this.closed.emit();
  }

  /** Escape: the innermost layer first. The new type's name has taken its own Escape already; here the editor closes before the dialog does. */
  protected onDismiss(): void {
    if (this.mode() === 'offer' && this.editing()) {
      this.editing.set(false);
      this.toggle()?.nativeElement.focus();
      return;
    }
    this.close();
  }

  protected toggleEditor(): void { this.editing.update(open => !open); }

  // ── The editor's changes ─────────────────────────────────────────────────────────────────────────────────────────────

  protected setRows(block: number, rows: EditStep[]): void {
    this.rows.update(all => all.map((r, i) => (i === block ? sortEdits(rows) : r)));
  }

  protected addType(type: AddedType): void {
    this.added.update(all => (all.some(a => a.kind === type.kind && a.name === type.name) ? all : [...all, type]));
  }

  constructor() {
    effect(() => {
      const blocks = this.liveBlocks();
      const space = this.spaceId();
      untracked(() => this.recount(space, blocks));
    });
    // A refusal for want of the right locks the choice for good; a bad step opens the editor on its row.
    effect(() => {
      const r = this.refusal();
      const at = this.badStep();
      untracked(() => {
        if (r?.kind === 'no_right') this.refusedRight.set(true);
        if (at && this.mode() === 'offer') this.editing.set(true);
      });
    });
    inject(DestroyRef).onDestroy(() => this.subscriptions.forEach(s => s?.unsubscribe()));
  }

  /** Ask for the counts of each block whose records or rewriting changed since they were last asked; the answer of an older ask is dropped. */
  private recount(space: string, blocks: readonly ConvertBlock[]): void {
    blocks.forEach((block, i) => {
      const key = `${space}|${countKey(block)}`;
      if (this.keys[i] === key) return;
      this.keys[i] = key;
      this.subscriptions[i]?.unsubscribe();
      this.setCount(i, LOADING);
      this.subscriptions[i] = this.conversion.countsFor(space, block).subscribe({
        next: answer => this.setCount(i, answer.ok ? { state: 'ready', counts: answer.counts } : FAILED),
        error: () => this.setCount(i, FAILED),
      });
    });
    for (let i = blocks.length; i < this.keys.length; i++) this.subscriptions[i]?.unsubscribe();
    this.keys.length = blocks.length;
  }

  private setCount(i: number, view: CountView): void { this.counts.update(all => ({ ...all, [i]: view })); }
}
