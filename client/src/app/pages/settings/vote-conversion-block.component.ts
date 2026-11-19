import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { Observable, defer, forkJoin, of } from 'rxjs';
import { catchError, map, switchMap } from 'rxjs/operators';
import { AuthApi } from '../../core/auth-api.service';
import type { BlockCounts, ConvertBlock } from '../../core/conversion-counts';
import { ConversionApi } from '../../core/conversion-api.service';
import { stepSentence } from '../../core/conversion-step-words';
import type { ConversionStep } from '../../core/conversion.types';
import { pageTranslator, type PageTranslator } from '../../core/page-translator';
import { PluralText } from '../../core/plural-text.service';
import { knowledgeAllowed } from '../../core/token-capability';
import { convertBlocksOfRound, orderedConversionSteps } from '../../core/vote-round-view';

/**
 * A vote round's conversion, as the member who votes reads it: what will happen to ITS OWN records if the round passes (bundle-285 slice S8,
 * Q-940; drawing moment 4c).
 *
 * ## Why it exists
 *
 * A schema round can carry a conversion (`convertRecords`), and a yes is a yes to the schema AND to rewriting the records. The row used to
 * show the proposer's summary and nothing of the steps, so a member approved a rewrite it could not read. This block shows the steps as
 * sentences and, per type, how many records of this instance they would convert.
 *
 * ## What it prevents
 *
 * - **Peer text taken for markup.** Every type, property and condition in a step was written by another member. A sentence is made by the
 *   translation layer from the closed set of `conversion.step.*` keys with the names as parameters, wrapped in two private marker characters
 *   so the block can draw each name in its own span, and the pieces are bound by interpolation, which escapes. Nothing here is bound as HTML,
 *   and a name cannot forge a marker: the markers are stripped from every name first.
 * - **A number that was not counted, or is not this instance's.** The counts are asked of the round's `localSpaceId` (the name THIS instance
 *   holds the space under, never the network's id for it), only when the token may read that space's records, and a count that failed or
 *   could not be asked shows no number at all (never a zero). Without a local space the block shows the steps alone and asks nothing.
 * - **A blank line.** A step this client has no words for (an operation a newer member added) or one whose shape a peer got wrong is a line
 *   that names its operation, never an empty bullet and never an error that takes the other steps with it.
 * - **A count for a stale space.** The counting restarts when the round or its space changes and a request in flight is cancelled with it.
 *
 * `data-counts` on the block says where the counting stands (`off`, `loading`, `ready`, `noright`, `failed`) for a verify drive and for the
 * specs; nothing styles on it.
 */

/** The state of the counting. */
type CountsView =
  | { state: 'off' }
  | { state: 'loading' }
  | { state: 'noright' }
  | { state: 'failed' }
  | { state: 'ready'; rows: { block: ConvertBlock; counts: BlockCounts }[]; complete: boolean };

/** A piece of a sentence: some words, or one name the drawing sets in the code face. */
export interface SentencePiece { text: string; name: boolean }

/** Private marker characters a name is wrapped in on its way through the translation layer. They are control characters, so no real name holds one. */
const OPEN = '\u0001';
const CLOSE = '\u0002';
const stripMarkers = (s: string): string => s.split(OPEN).join('').split(CLOSE).join('');
const mark = (name: string): string => `${OPEN}${stripMarkers(name)}${CLOSE}`;

/** A sentence with its marked names cut out as pieces, in order. A marker the translation left unpaired is dropped, never shown. */
export function piecesOf(sentence: string): SentencePiece[] {
  const parts = sentence.split(CLOSE);
  const pieces: SentencePiece[] = [];
  parts.forEach((part, i) => {
    const open = i < parts.length - 1 ? part.indexOf(OPEN) : -1;
    if (open < 0) {
      const text = stripMarkers(part);
      if (text) pieces.push({ text, name: false });
      return;
    }
    const before = stripMarkers(part.slice(0, open));
    if (before) pieces.push({ text: before, name: false });
    pieces.push({ text: stripMarkers(part.slice(open + 1)), name: true });
  });
  return pieces;
}

/** The step with every name in it marked, so the sentence made of it can be cut at the names. Shapes a peer got wrong throw here: the caller catches. */
function markedStep(step: ConversionStep): ConversionStep {
  switch (step.op) {
    case 'renameType':
    case 'renameProperty':
      return { ...step, from: mark(step.from), to: mark(step.to) };
    case 'mapEnum':
      return {
        ...step, property: mark(step.property),
        values: Object.fromEntries(Object.entries(step.values).map(([from, to]) => [mark(from), mark(to)])),
      };
    case 'splitType':
      return {
        ...step, from: mark(step.from), cases: step.cases.map(c => ({ when: mark(c.when), to: mark(c.to) })),
        ...(step.otherwise !== undefined ? { otherwise: mark(step.otherwise) } : {}),
      };
    default:
      return step;
  }
}

/** The longest an operation name a peer sent is shown: it is the only thing said of a step this client has no words for. */
const OP_SHOWN_MAX = 60;

/** One step as pieces: its sentence, or, for a step with no words or a wrong shape, the name of its operation. Never empty, never thrown. */
function linePieces(say: PageTranslator, step: ConversionStep): SentencePiece[] {
  try {
    const sentence = stepSentence({ translate: say }, markedStep(step));
    if (typeof sentence === 'string' && sentence.trim() !== '') return piecesOf(sentence);
  } catch { /* a step a peer shaped wrongly: said by its operation below */ }
  return [{ text: stripMarkers(String(step.op)).slice(0, OP_SHOWN_MAX) || '?', name: true }];
}

const OFF: CountsView = { state: 'off' };
const LOADING: CountsView = { state: 'loading' };

let seq = 0;

@Component({
  selector: 'app-vote-conversion-block',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe],
  styles: [`
    :host { display: block; }
    .cv-vote-steps { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border-muted); }
    .cv-vote-h { font-size: 12px; font-weight: 600; color: var(--text-primary); }
    .cv-sent { margin: 6px 0 4px; padding-left: 18px; font-size: 12.5px; color: var(--text-secondary); line-height: 1.7; overflow-wrap: anywhere; }
    .cv-run-line { margin: 6px 0 0; font-size: 12.5px; color: var(--text-secondary); overflow-wrap: anywhere; }
    .cv-vote-none { margin: 0; font-size: 12px; color: var(--text-secondary); overflow-wrap: anywhere; }
    .cv-tn { font-family: var(--font-mono); font-size: 12px; color: var(--accent); overflow-wrap: anywhere; }
  `],
  template: `
    <div [attr.data-counts]="counts().state">
      @if (onlyNone()) {
        @for (line of countLines(); track $index) {
          <p class="cv-vote-none">@for (p of line.pieces; track $index) {<span [class.cv-tn]="p.name">{{ p.text }}</span>}</p>
        }
      } @else {
        <div class="cv-vote-steps" role="group" [attr.aria-labelledby]="headId">
          <div class="cv-vote-h" [id]="headId">{{ 'networks.network.votes.convert.head' | transloco }}</div>
          <ul class="cv-sent">
            @for (line of lines(); track $index) {
              <li>@for (p of line; track $index) {<span [class.cv-tn]="p.name">{{ p.text }}</span>}</li>
            }
          </ul>
          <div aria-live="polite">
            @switch (counts().state) {
              @case ('loading') {
                <p class="cv-run-line"><span class="spinner" style="width:11px;height:11px;border-width:2px;"></span> {{ 'spaces.schema.convert.counting' | transloco }}</p>
              }
              @case ('noright') {
                <p class="cv-run-line">{{ 'brain.review.unconverted.rung' | transloco }}</p>
              }
              @case ('ready') {
                @for (line of countLines(); track $index) {
                  <p class="cv-run-line">@for (p of line.pieces; track $index) {<span [class.cv-tn]="p.name">{{ p.text }}</span>}</p>
                }
              }
            }
          </div>
        </div>
      }
    </div>
  `,
})
export class VoteConversionBlockComponent {
  /** The round's steps, as the round carried them: the block reads them defensively, a peer wrote them. */
  steps = input.required<readonly ConversionStep[]>();
  /** What THIS instance calls the round's space. Absent: the steps are shown and no record is counted. */
  localSpaceId = input<string | undefined>(undefined);

  private readonly auth = inject(AuthApi);
  private readonly conversion = inject(ConversionApi);
  private readonly plural = inject(PluralText);
  private readonly say = pageTranslator();

  protected readonly headId = `vote-conversion-head-${++seq}`;
  protected readonly counts = signal<CountsView>(OFF);

  private readonly blocks = computed(() => convertBlocksOfRound(this.steps()));

  protected readonly lines = computed(() => orderedConversionSteps(this.steps()).map(step => linePieces(this.say, step)));

  /** One sentence per counted type: its counts, or that this instance holds none. A type whose count failed has none. */
  protected readonly countLines = computed<{ pieces: SentencePiece[]; empty: boolean }[]>(() => {
    const view = this.counts();
    if (view.state !== 'ready') return [];
    return view.rows.map(({ block, counts }) => {
      const type = mark(block.was ?? block.type);
      const sentence = counts.total === 0
        ? this.say('networks.network.votes.convert.none', { type })
        : this.plural.text('networks.network.votes.convert.counts', counts.total, { type, stamped: counts.stamped, rewritten: counts.rewritten });
      return { pieces: piecesOf(sentence), empty: counts.total === 0 };
    });
  });

  /** Every type of the round was counted and this instance holds no record of any: as drawn, the sentence says so alone (nothing would be converted). */
  protected readonly onlyNone = computed(() => {
    const view = this.counts();
    return view.state === 'ready' && view.complete && this.countLines().every(l => l.empty);
  });

  constructor() {
    effect(onCleanup => {
      const space = this.localSpaceId();
      const blocks = this.blocks();
      if (!space || blocks.length === 0) {
        this.counts.set(OFF);
        return;
      }
      this.counts.set(LOADING);
      const subscription = this.load(space, blocks).subscribe(view => this.counts.set(view));
      onCleanup(() => subscription.unsubscribe());
    });
  }

  /**
   * The counts of this instance's records. The rights are read first, so a token that cannot read the space is told so instead of being sent
   * to a refusal; rights that cannot be read count as allowed (the server decides, and a refused count is a failed one).
   */
  private load(space: string, blocks: readonly ConvertBlock[]): Observable<CountsView> {
    return this.auth.verifyToken().pipe(
      map(me => me.rights ?? null),
      catchError(() => of(null)),
      switchMap((rights): Observable<CountsView> => {
        if (!knowledgeAllowed(rights, space, 'read')) return of({ state: 'noright' });
        return forkJoin(blocks.map(block => defer(() => this.conversion.countsFor(space, block)).pipe(
          catchError(() => of({ ok: false as const })),
        ))).pipe(map((answers): CountsView => {
          const rows = answers.flatMap((a, i) => (a.ok ? [{ block: blocks[i]!, counts: a.counts }] : []));
          return rows.length === 0 ? { state: 'failed' } : { state: 'ready', rows, complete: rows.length === blocks.length };
        }));
      }),
      catchError(() => of<CountsView>({ state: 'failed' })),
    );
  }
}
