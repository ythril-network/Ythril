import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { ActiveLanguage } from '../../core/active-language';
import { ConversionApi } from '../../core/conversion-api.service';
import { stepRefusalWords, stepSentence } from '../../core/conversion-step-words';
import type { ConversionStep, ConvertRunNotice, ConvertStatus, ConvertStatusAnswer, ConvertTypeRef } from '../../core/conversion.types';
import { pageTranslator, type PageTranslator } from '../../core/page-translator';
import { formatCount } from '../../core/plural-text';
import { PluralText } from '../../core/plural-text.service';
import { piecesOf, type SentencePiece } from './vote-conversion-block.component';

/**
 * The run block: a conversion running and finished, as the green-lit drawing has it (bundle-285 slice S5, Q-747; plan sections 3.1 item 8 and
 * 5 rows R1 to R12; moments 3a and 3b). It is the BODY of the progress dialog; the footer is the dialog's, from {@link runFooterOf}.
 *
 * The host gives it the run (`status`, as the status door answers it) and, for what a save answered, the `notice`; the block reads nothing of
 * the run itself. The one thing it asks for is the number of records Review lists as "the steps were refused here", and only for a finished
 * run that refused a step.
 *
 * ## What it prevents
 *
 * - **A total that was not counted.** The run has CHECKED stamped + rewritten + unconverted + moved records and will check `left` more; the
 *   total is the two together. `left: null` is "not counted in time": there is then NO total and no percentage (the bar has no value and the
 *   block says it is counting the records left), never a total made of the records read so far, which would read 100% at every step.
 * - **Zeros as news.** The line says the parts that are not zero. Records that could not be converted are in bold.
 * - **A silent refusal.** A finished run that refused steps says how many of them, each as the step's sentence with its reason in words (a
 *   reason this client has no words for is the generic sentence, `stepRefusalWords`), how many records are listed in Review for it (left
 *   out when that could not be read), and what to do; a vote refused whole has its own sentence.
 * - **A blank block.** A run that never was (an empty type, a space with no run, a save that started nothing), a save that did not start
 *   the run and a run that stopped each say so in words, with the error the server gave.
 * - **A name taken for markup.** Every type and property name in a sentence is bound as text, cut out of the sentence by the vote row's own
 *   private markers (`piecesOf`) so it is set in the code face; a name cannot carry a marker of its own.
 */

// ── Names in sentences ──────────────────────────────────────────────────────────────────────────────────────────────────

/** The private marker characters of the vote row's `piecesOf`: control characters, so no real name holds one. */
/** The bar's whole width, as a percentage. */
const PERCENT_FULL = 100;

const OPEN = '\u0001';
const CLOSE = '\u0002';
const stripMarkers = (s: string): string => s.split(OPEN).join('').split(CLOSE).join('');
const mark = (name: string): string => `${OPEN}${stripMarkers(name)}${CLOSE}`;

/** How a sentence's text parameters are treated: a name is marked; `plain` text has its markers taken out; `trusted` text is a sentence already made here. */
export interface Params { plain?: readonly string[]; trusted?: readonly string[] }

function markedParams(params: Record<string, unknown> | undefined, how: Params): Record<string, unknown> | undefined {
  if (!params) return params;
  return Object.fromEntries(Object.entries(params).map(([key, value]) => {
    if (typeof value !== 'string' || how.trusted?.includes(key)) return [key, value];
    return [key, how.plain?.includes(key) ? stripMarkers(value) : mark(value)];
  }));
}

/** A name wrapped in the private markers, for a counted sentence (`PluralText`) that sets it in the code face; read back with `piecesOf`. */
export const markName = mark;

/** The pieces of any sentence whose text parameters are names (marked) unless `how` says they are plain text or a sentence already made here. */
export function markedPieces(say: PageTranslator, key: string, params: Record<string, unknown>, how: Params = {}): SentencePiece[] {
  return piecesOf(say(key, markedParams(params, how)));
}

/** Parameters of a step's sentence that are sentences already made (a map's pairs, a split's cases) or an operation name: not names. */
const STEP_PARAMS: Params = { trusted: ['pairs', 'cases'], plain: ['op'] };

/** A step's sentence with each name wrapped in the private markers, for a sentence that embeds it. */
function markedStepSentence(say: PageTranslator, step: ConversionStep): string {
  return stepSentence({ translate: (key, params) => say(key, markedParams(params, STEP_PARAMS)) }, step);
}

/** A step as pieces: its sentence cut at its names, which are set in the code face. Words every step, however a peer shaped it (`stepSentence`). */
export function stepPieces(say: PageTranslator, step: ConversionStep): SentencePiece[] {
  return piecesOf(markedStepSentence(say, step));
}

// ── The footer of the finished dialog ──────────────────────────────────────────────────────────────────────────────────

/** What the footer of the progress dialog offers: Open Review (primary when finished, secondary while running) or a hint saying nothing is to be done. */
export type RunFooter =
  | { kind: 'review'; n: number }
  | { kind: 'reviewSoFar'; n: number }
  | { kind: 'hint'; key: 'spaces.schema.convert.run.nothingToDo' | 'spaces.schema.convert.run.nothingLeft' }
  | { kind: 'none' };

const isRun = (s: ConvertStatusAnswer | null | undefined): s is ConvertStatus => !!s && s.state !== 'none' && s.state !== 'per_member';

/**
 * The progress dialog's footer: Open Review once the run has listed something (with "so far" while it runs), "Nothing left to review." after a
 * run that listed nothing, and NOTHING while a run goes and has listed nothing yet: it may still list records, so "Nothing to do here." would be
 * wrong in its first seconds (bundle-285 S10, drive D8). "Nothing to do here." is for a dialog that knows of no run at all.
 */
export function runFooterOf(status: ConvertStatusAnswer | null | undefined, notice: ConvertRunNotice | null | undefined): RunFooter {
  if (isRun(status) && notice?.state !== 'not_started') {
    const n = status.counts.unconverted;
    if (n > 0) return status.state === 'running' ? { kind: 'reviewSoFar', n } : { kind: 'review', n };
    return status.state === 'running' ? { kind: 'none' } : { kind: 'hint', key: 'spaces.schema.convert.run.nothingLeft' };
  }
  if (!isRun(status) && notice?.state === 'started') return { kind: 'none' };
  return { kind: 'hint', key: notice ? 'spaces.schema.convert.run.nothingLeft' : 'spaces.schema.convert.run.nothingToDo' };
}

// ── The view ────────────────────────────────────────────────────────────────────────────────────────────────────────────

type RunView =
  | { kind: 'loading' }
  | { kind: 'nothing'; types: ConvertTypeRef[] }
  | { kind: 'notStarted'; error: string }
  | { kind: 'run'; status: ConvertStatus };

/** The distinct types, by kind and name, in order. */
function distinct(types: readonly ConvertTypeRef[]): ConvertTypeRef[] {
  const seen = new Set<string>();
  return types.filter(t => { const key = JSON.stringify([t.kind, t.type]); return seen.has(key) ? false : (seen.add(key), true); });
}

const checkedOf = (s: ConvertStatus): number => s.counts.stamped + s.counts.rewritten + s.counts.unconverted + s.counts.moved;

@Component({
  selector: 'app-convert-run-block',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe],
  styles: [`
    :host { display: block; }
    .cv-run-type { padding: 10px 0; }
    .cv-run-h { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; }
    .cv-tn { font-family: var(--font-mono); font-size: 12px; color: var(--accent); overflow-wrap: anywhere; }
    .cv-run-types { list-style: none; margin: 0 0 6px; padding: 0; display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 12.5px; color: var(--text-secondary); }
    .cv-run-types li { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
    .cv-run-line { margin: 6px 0 0; font-size: 12.5px; color: var(--text-secondary); overflow-wrap: anywhere; }
    .cv-explain { margin: 4px 0 0; font-size: 11.5px; color: var(--text-muted); line-height: 1.5; max-width: 78ch; }
    .cv-warn { color: var(--warning); }
    .cv-sent { margin: 6px 0 4px; padding-left: 18px; font-size: 12.5px; color: var(--text-secondary); line-height: 1.7; overflow-wrap: anywhere; }
    .cv-refused { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border-muted); }
    .sch-hint { font-size: 11px; font-weight: 400; text-transform: none; letter-spacing: 0; color: var(--text-muted); }
    .bar-wrap { display: flex; flex-direction: column; gap: 3px; }
    .bar-track { display: flex; gap: 2px; height: 6px; border-radius: 3px; overflow: hidden; }
    .bar-seg { position: relative; flex: 1; background: var(--bg-elevated); border-radius: 2px; overflow: hidden; }
    .bar-fill { position: absolute; inset: 0 auto 0 0; background: var(--accent); border-radius: 2px; transition: width .4s ease; }
    .bar-seg.indeterminate .bar-fill { width: 30%; opacity: .5; animation: cv-pulse 1.6s ease-in-out infinite alternate; }
    @keyframes cv-pulse { from { transform: translateX(0); } to { transform: translateX(233%); } }
    @media (prefers-reduced-motion: reduce) { .bar-fill { transition: none; } .bar-seg.indeterminate .bar-fill { animation: none; } }
    .bar-label { font-size: 11px; color: var(--text-secondary); font-weight: 550; }
  `],
  template: `
    @switch (view().kind) {
      @case ('loading') {
        <p class="cv-run-line"><span class="spinner" style="width: 11px; height: 11px; border-width: 2px;"></span> {{ 'common.loading' | transloco }}</p>
      }
      @case ('notStarted') {
        <div class="alert alert-error" role="alert">{{ notStartedText() }}</div>
      }
      @case ('nothing') {
        <div class="cv-run-type">
          <div class="cv-run-h">
            @if (heads().length === 1) { <span class="cv-tn">{{ heads()[0] }}</span> }
            @else if (heads().length > 1) { <span data-testid="run-types">{{ typesText() }}</span> }
            <span class="badge badge-gray" data-testid="run-badge">{{ 'spaces.schema.convert.run.nothing' | transloco }}</span>
          </div>
          <p class="cv-run-line" data-testid="run-line">{{ 'spaces.schema.convert.run.noneHere' | transloco }}</p>
        </div>
      }
      @case ('run') {
        <div class="cv-run-type" [attr.data-state]="running()?.state">
          <div class="cv-run-h">
            @if (heads().length === 1) { <span class="cv-tn">{{ heads()[0] }}</span> }
            @else if (heads().length > 1) { <span data-testid="run-types">{{ typesText() }}</span> }
            <span class="badge" [class]="badge().cls" data-testid="run-badge">{{ badge().text }}</span>
          </div>
          @if (heads().length > 1) {
            <ul class="cv-run-types">
              @for (t of typeRows(); track t.name) {
                <li data-testid="run-type"><span class="cv-tn">{{ t.name }}</span>@if (t.done) { <span class="badge badge-green">{{ 'spaces.schema.convert.run.done' | transloco }}</span> }</li>
              }
            </ul>
          }
          @if (failed(); as error) { <div class="alert alert-error" role="alert">{{ error }}</div> }
          <div class="bar-wrap">
            <div class="bar-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" [attr.aria-valuenow]="percent()" [attr.aria-label]="barLabel()">
              <div class="bar-seg" [class.indeterminate]="percent() === null"><div class="bar-fill" [style.width.%]="percent()"></div></div>
            </div>
            <div class="bar-label" data-testid="run-label">{{ checkedText() }}</div>
          </div>
          @if (parts().length > 0) {
            <p class="cv-run-line" data-testid="run-line">@for (p of parts(); track $index) {@if (p.strong) {<strong>{{ p.text }}</strong>} @else {<span>{{ p.text }}</span>}}</p>
          }
          <p class="cv-explain">{{ 'spaces.schema.convert.defineShort' | transloco }}</p>
          @if (retrying()) { <p class="cv-run-line sch-hint" data-testid="run-retry">{{ 'spaces.schema.convert.run.retrying' | transloco }}</p> }
          @if (refused(); as r) {
            <div class="cv-refused">
              @if (r.head) { <p class="cv-run-line cv-warn" data-testid="run-refused-head"><strong>{{ r.head }}</strong></p> }
              @if (r.listed) { <p class="cv-run-line" data-testid="run-refused-listed">{{ r.listed }}</p> }
              @if (r.items.length > 0) {
                <ul class="cv-sent">
                  @for (item of r.items; track $index) {
                    <li data-testid="run-refused-item">@for (p of item; track $index) {<span [class.cv-tn]="p.name">{{ p.text }}</span>}</li>
                  }
                </ul>
              }
              @for (all of r.all; track $index) {
                <p class="cv-run-line" data-testid="run-refused-all">@for (p of all; track $index) {<span [class.cv-tn]="p.name">{{ p.text }}</span>}</p>
              }
              <p class="cv-run-line" data-testid="run-refused-fix">{{ 'spaces.schema.convert.refused.fix' | transloco }}</p>
            </div>
          }
        </div>
      }
    }
  `,
})
export class ConvertRunBlockComponent {
  /** The space the run is of: the records "refused here" are asked of it. */
  readonly spaceId = input.required<string>();
  /** The run as the status door answers it; `null` until the first answer. */
  readonly status = input<ConvertStatusAnswer | null>(null);
  /** What the save that started the run answered (`nothing`, `not_started`, or none). */
  readonly notice = input<ConvertRunNotice | null>(null);

  private readonly say = pageTranslator();
  private readonly plural = inject(PluralText);
  private readonly active = inject(ActiveLanguage);
  private readonly conversion = inject(ConversionApi);

  /** How many records Review lists as refused for this run; null until read, and when it could not be. */
  private readonly refusedListed = signal<number | null>(null);

  protected readonly view = computed<RunView>(() => {
    const notice = this.notice();
    if (notice?.state === 'not_started') return { kind: 'notStarted', error: notice.error ?? '' };
    const status = this.status();
    if (!status) return notice?.state === 'nothing' ? { kind: 'nothing', types: distinct(notice.types) } : { kind: 'loading' };
    if (!isRun(status)) return { kind: 'nothing', types: [] };
    if (status.state === 'complete' && checkedOf(status) === 0 && (status.left ?? 0) === 0) return { kind: 'nothing', types: distinct(status.types) };
    return { kind: 'run', status };
  });

  /** The run being shown, or null. */
  protected readonly running = computed(() => { const v = this.view(); return v.kind === 'run' ? v.status : null; });

  private number(n: number): string { return formatCount(this.active.language() || 'en', n); }

  protected readonly notStartedText = computed(() => {
    const v = this.view();
    return this.say('spaces.schema.convert.run.notStarted', { error: v.kind === 'notStarted' ? v.error : '' });
  });

  /** The names the head shows: the distinct types of the run (or of the save's notice). */
  protected readonly heads = computed<string[]>(() => {
    const v = this.view();
    const types = v.kind === 'run' ? distinct(v.status.types) : v.kind === 'nothing' ? v.types : [];
    return types.map(t => t.type);
  });
  protected readonly typesText = computed(() => this.plural.text('spaces.schema.convert.run.types', this.heads().length));
  protected readonly typeRows = computed(() => {
    const run = this.running();
    if (!run) return [];
    return distinct(run.types).map(t => ({ name: t.type, done: run.types.some(r => r.kind === t.kind && r.type === t.type && r.done) }));
  });

  protected readonly badge = computed(() => {
    const run = this.running();
    if (!run) return { cls: 'badge-gray', text: '' };
    if (run.state === 'running') return { cls: 'badge-blue', text: this.say('spaces.schema.convert.run.converting') };
    if (run.state === 'failed') return { cls: 'badge-yellow', text: this.say('spaces.schema.convert.run.doneSome') };
    return run.counts.unconverted > 0
      ? { cls: 'badge-yellow', text: this.say('spaces.schema.convert.run.doneSome') }
      : { cls: 'badge-green', text: this.say('spaces.schema.convert.run.done') };
  });

  /** A run that stopped says why. */
  protected readonly failed = computed(() => {
    const run = this.running();
    return run?.state === 'failed' ? this.say('spaces.schema.convert.run.failed', { error: run.error ?? '' }) : null;
  });

  /** The records the run will have checked: those it has plus `left`; unknown while `left` is not counted (never the checked count itself). */
  private readonly total = computed<number | null>(() => {
    const run = this.running();
    if (!run) return null;
    if (run.left === null) return run.state === 'complete' ? checkedOf(run) : null;
    return checkedOf(run) + run.left;
  });

  protected readonly percent = computed<number | null>(() => {
    const run = this.running();
    const total = this.total();
    if (!run || total === null) return null;
    return total > 0 ? Math.min(PERCENT_FULL, Math.round((checkedOf(run) / total) * PERCENT_FULL)) : (run.state === 'complete' ? PERCENT_FULL : null);
  });

  protected readonly barLabel = computed(() => {
    const pct = this.percent();
    return pct === null ? this.say('spaces.schema.convert.run.counting') : this.say('spaces.schema.convert.run.checkedAria', { pct });
  });

  protected readonly checkedText = computed(() => {
    const run = this.running();
    const total = this.total();
    if (!run) return '';
    return total === null ? this.say('spaces.schema.convert.run.counting') : this.plural.text('spaces.schema.convert.run.checked', total, { done: checkedOf(run) });
  });

  /** "599 rewritten, 41 only stamped, 3 could not be converted, 7 left.": the parts that are not zero, the unconverted ones in bold. */
  protected readonly parts = computed<{ text: string; strong: boolean }[]>(() => {
    const run = this.running();
    if (!run) return [];
    const said: { text: string; strong: boolean }[] = [];
    const c = run.counts;
    if (c.rewritten > 0) said.push({ text: this.say('spaces.schema.convert.run.line.rewritten', { rewritten: this.number(c.rewritten) }), strong: false });
    if (c.stamped > 0) said.push({ text: this.say('spaces.schema.convert.run.line.stamped', { stamped: this.number(c.stamped) }), strong: false });
    if (c.unconverted > 0) said.push({ text: this.say('spaces.schema.convert.run.line.unconverted', { unconverted: this.number(c.unconverted) }), strong: true });
    if (run.state === 'running' && run.left !== null && run.left > 0) said.push({ text: this.say('spaces.schema.convert.run.line.left', { left: this.number(run.left) }), strong: false });
    return said.flatMap((part, i) => [part, { text: i < said.length - 1 ? ', ' : '.', strong: false }]);
  });

  protected readonly retrying = computed(() => { const run = this.running(); return run?.state === 'running' && run.failures > 0; });

  /** Does a finished run have refused steps to account for (and so a count of the records listed for them to read)? */
  private readonly refusedNeeded = computed(() => { const run = this.running(); return !!run && run.state !== 'running' && run.stepsRefused.length > 0; });

  protected readonly refused = computed(() => {
    const run = this.running();
    if (!run || !this.refusedNeeded()) return null;
    const named = run.stepsRefused.filter((r): r is { step: ConversionStep; reason: string } => r.step !== null);
    const reasonText = (code: string): string => { const w = stepRefusalWords(code); return this.say(w.key, w.params); };
    const listed = this.refusedListed();
    return {
      head: named.length > 0 ? this.plural.text('spaces.schema.convert.refused.head', Math.max(run.steps.length, named.length), { k: named.length }) : '',
      listed: listed !== null && listed > 0 ? this.plural.text('spaces.schema.convert.refused.listed', listed) : '',
      items: named.map(r => piecesOf(this.say('spaces.schema.convert.refused.item', {
        step: markedStepSentence(this.say, r.step), reason: stripMarkers(reasonText(r.reason)),
      }))),
      all: run.stepsRefused.filter(r => r.step === null).map(r => piecesOf(this.say('spaces.schema.convert.refused.all', { reason: stripMarkers(reasonText(r.reason)) }))),
    };
  });

  constructor() {
    effect(onCleanup => {
      const needed = this.refusedNeeded();
      const space = this.spaceId();
      this.refusedListed.set(null);
      if (!needed) return;
      const subscription = this.conversion.refusedCount(space).subscribe({
        next: n => this.refusedListed.set(n),
        error: () => this.refusedListed.set(null),
      });
      onCleanup(() => subscription.unsubscribe());
    });
  }
}
