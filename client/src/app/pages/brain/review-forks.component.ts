import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, input, linkedSignal, output, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { ActiveLanguage } from '../../core/active-language';
import { DateFormatService } from '../../core/date-format.service';
import { formatList } from '../../core/list-format';
import { PluralText } from '../../core/plural-text.service';
import {
  FORK_KINDS, FORK_KIND_TAB, type ForkCounts, type ForkKeep, type ForkKind, type ForkKindsFields, type ForkMarkedCounts, type ForkResolvedElsewhere, type ForkRow, type ForkVersion,
} from '../../core/forks.types';
import { ModalDirective } from '../../shared/modal.directive';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { DIALOG_STYLES } from '../settings/dialog.styles';
import { compareForkVersions, fieldSegments, forkOwnFields, textSegments, type FieldDifference, type Segment } from './fork-diff';

/** Characters of the discarded text the confirmation quotes: enough to recognise it, short enough to read in a dialog. */
const QUOTE_CHARS = 90;

/** What Review shows of one fork, worked out once per change instead of once per question the template asks. */
interface RowView {
  row: ForkRow;
  /** The parent is gone: the fork stands alone and there is nothing to compare. */
  orphan: boolean;
  type: string;
  label: string;
  thisWho: string;
  /** The other version's line; empty for an orphan, whose other version is gone. */
  otherWho: string;
  ends: { from: string; label: string; to: string } | null;
  main: Segment[];
  fullThis: string;
  fullOther: string;
  fields: { key: string; marks: Segment[]; plain: string }[];
  same: string;
  pointed: string;
  elsewhere: string[];
  capNote: boolean;
  keepOtherWord: string;
}

/**
 * The forks of a space, one kind at a time, one hairline row each, with the difference inline (bundle-81, design rev 8 section 5, decisions 19, 41 and
 * 43; mockup layout 3 "Inline difference", chosen by the owner 2026-10-24; Q-624, design rev 4 sections 9a and 11, with the kind switch of layout B, chosen
 * by the owner 2026-10-25).
 *
 * A fork is a record two peers wrote differently at one version; both copies were kept. A segmented control above the list chooses the kind (a fact, an
 * entity, a chrono entry, an edge), each with its count; it is a roving radio group (one tab stop, arrows, Home and End move AND select, focus
 * follows). Each row writes the kind's main text ONCE, with the words only this version has marked `<ins>` and the words only the other has marked `<del>`,
 * and every other field that differs on a line of marks; which fields a kind compares and which one is main is the list answer's (`kinds`), never the
 * client's. Below 40% shared words the main text is not interleaved but written whole, the other struck and this one underlined. The marks are not colour
 * alone: underline and strike carry them, and each starts with the legend's words for a screen reader. Both versions stay available whole behind
 * "Show both versions in full".
 *
 * An orphan (its parent was deleted) shows the fork alone, with "Keep this version" and "Let the deletion stand". A fork another instance already
 * decided carries one line per such instance under the pair, and the confirm of keeping this version says it overrides that choice everywhere. An empty
 * kind says so and offers the next kind that has forks.
 *
 * Two actions per fork, each behind a confirmation that names what is deleted; nothing is resolved before it is confirmed. The component only asks: it
 * emits `resolve` and the Review tab does the request. It draws its own focus ring, as the app has no global one (decision 41).
 */
@Component({
  selector: 'app-review-forks',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, TranslocoPipe, ModalDirective, PhIconComponent],
  styles: [DIALOG_STYLES, `
    :host { display: block; }

    /* The kind switch: one radio group, four cells on a desktop and a 2 x 2 grid on a phone. */
    .sg { display: inline-flex; border: 1px solid var(--border); border-radius: var(--radius-md); overflow: hidden; margin: 0 0 10px; background: var(--bg-surface); }
    .sg-opt { display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 7px 16px; min-height: 36px; font: inherit; font-size: 13px; font-weight: 500; color: var(--text-secondary); background: transparent; border: none; border-left: 1px solid var(--border); cursor: pointer; white-space: nowrap; }
    .sg-opt:first-child { border-left: none; }
    .sg-opt:hover { color: var(--text-primary); background: var(--bg-elevated); }
    .sg-opt:focus-visible { outline: 2px solid var(--accent); outline-offset: -3px; }
    .sg-opt[aria-checked="true"] { color: var(--text-primary); background: var(--bg-overlay); box-shadow: inset 0 -2px 0 var(--accent); }
    .sg-n { font-size: 12px; font-variant-numeric: tabular-nums; color: var(--text-muted); }
    .sg-opt[aria-checked="true"] .sg-n { color: var(--text-secondary); }
    .sg-opt[data-zero="1"] { color: var(--text-muted); }
    .sg-el { width: 6px; height: 6px; border-radius: 50%; background: var(--warning); flex-shrink: 0; }

    /* The legend and the kind's hint are one block. */
    .l3-legend { display: flex; gap: 8px 20px; flex-wrap: wrap; font-size: 12.5px; padding: 0 0 10px; border-bottom: 1px solid var(--border); }
    .kind-hint { flex: 1 1 100%; margin: 0; font-size: 12.5px; color: var(--text-muted); }
    .kind-panel { min-width: 0; }
    .kind-empty { padding: 32px 0; }

    .l3-list { list-style: none; margin: 0; padding: 0; max-width: 860px; }
    .l3-item { padding: 16px 0; border-bottom: 1px solid var(--border-muted); }
    .l3-h { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
    .fk-id { font-family: var(--font-mono); font-size: 12px; font-weight: 600; color: var(--text-primary); }
    .con-key { font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); }
    .fk-type { color: var(--text-secondary); font-family: var(--font-mono); font-size: 11px; }
    .fk-cap { font-size: 11.5px; font-weight: 600; padding: 2px 9px; border-radius: 999px; color: var(--text-muted); background: var(--bg-elevated); border: 1px solid var(--border); white-space: nowrap; }
    .cap-note { margin: 0 0 8px; font-size: 11px; color: var(--warning); }
    .l3-orphan { margin: 0 0 10px; padding: 8px 12px; font-size: 12.5px; line-height: 1.5; color: var(--text-secondary); background: var(--warning-bg); border: 1px solid var(--warning-border); border-radius: var(--radius-md); max-width: 72ch; }
    .l3-ends { margin: 0 0 8px; font-size: 13px; color: var(--text-secondary); display: flex; gap: 6px; align-items: baseline; flex-wrap: wrap; }
    .l3-ends strong { color: var(--text-primary); font-weight: 600; overflow-wrap: anywhere; }
    .l3-label { font-style: italic; }
    .l3-who { display: flex; gap: 4px 24px; flex-wrap: wrap; margin: 0 0 10px; }
    .l3-who > div { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
    .l3-who dt { font-size: 12.5px; font-weight: 600; color: var(--text-primary); }
    .l3-who dd { font-size: 11.5px; color: var(--text-muted); margin: 0; }
    .l3-text { font-size: 14px; line-height: 1.7; color: var(--text-primary); max-width: 72ch; overflow-wrap: anywhere; margin: 0; }
    .l3-text-entity, .l3-text-chrono { font-size: 15px; font-weight: 600; }
    .l3-fields { margin: 8px 0 0; display: flex; flex-direction: column; gap: 4px; }
    .l3-f { display: grid; grid-template-columns: 200px 1fr; gap: 10px; align-items: baseline; font-size: 13px; }
    .l3-f dd { overflow-wrap: anywhere; line-height: 1.6; margin: 0; }
    .l3-same { margin: 8px 0 0; font-size: 11.5px; color: var(--text-muted); overflow-wrap: anywhere; }
    .l3-elsewhere { list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-direction: column; gap: 2px; font-size: 12.5px; color: var(--text-secondary); }
    .l3-foot { display: flex; align-items: center; gap: 10px 16px; flex-wrap: wrap; margin-top: 12px; }
    .fk-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .fk-pointed { font-size: 12px; color: var(--text-muted); }
    .l3-full { margin-top: 8px; font-size: 12px; color: var(--text-secondary); }
    .l3-full summary { cursor: pointer; width: fit-content; }
    .l3-full > div { margin-top: 8px; max-width: 72ch; }
    .l3-full h4 { font-size: 12.5px; font-weight: 600; color: var(--text-primary); margin: 0; }
    .l3-full p { font-size: 13px; line-height: 1.6; color: var(--text-secondary); overflow-wrap: anywhere; margin: 0; }

    /* Inline marking: words only one side has. Underline and strike carry it as well as colour. */
    ins.ins, del.del { color: var(--text-primary); border-radius: 2px; padding: 0 1px; }
    ins.ins { background: var(--success-bg); text-decoration: underline; text-decoration-color: var(--success); text-underline-offset: 3px; text-decoration-thickness: 2px; }
    del.del { background: var(--error-bg); text-decoration: line-through; text-decoration-color: var(--error); }
    del.del + ins.ins, ins.ins + del.del { margin-left: 5px; }

    /* The confirmation, in the geometry of the app's confirm dialog. */
    .dialog { --dialog-max-width: 440px; background: var(--bg-card); border-radius: 10px; padding: 1.5rem; }
    .dialog h2 { margin: 0 0 0.6rem; font-size: 1.1rem; color: var(--text-primary); }
    .dialog .message { margin: 0 0 1.1rem; color: var(--text-secondary); font-size: 0.9rem; line-height: 1.5; }
    .dialog .message span { display: block; margin-top: 0.8rem; }
    .dialog .actions { display: flex; gap: 10px; justify-content: flex-end; flex-wrap: wrap; }
    .btn-danger-solid { background: var(--danger); color: #fff; border-color: var(--danger); }
    .btn-danger-solid:not(:disabled):hover { opacity: .9; }

    /* The app has no global focus ring, so the keep actions and the confirmation draw their own (decision 41). */
    .fk-actions button:focus-visible, .dialog button:focus-visible, .l3-full summary:focus-visible, .kind-empty button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

    @media (max-width: 560px) {
      .sg { display: grid; grid-template-columns: 1fr 1fr; width: 100%; }
      .sg-opt { border-left: none; border-top: 1px solid var(--border); justify-content: space-between; }
      .sg-opt:nth-child(-n+2) { border-top: none; }
      .sg-opt:nth-child(even) { border-left: 1px solid var(--border); }
      .l3-f { grid-template-columns: 1fr; gap: 0; }
      .fk-actions .btn { flex: 1 1 100%; justify-content: center; }
    }
  `],
  template: `
    <ng-template #marks let-segments>
      @for (s of segments; track $index) {
        @switch (s.kind) {
          @case ('ins') {<ins class="ins"><span class="sr-only">{{ 'brain.review.forks.legend.onlyThis' | transloco }}: </span>{{ s.text }}</ins>}
          @case ('del') {<del class="del"><span class="sr-only">{{ 'brain.review.forks.legend.onlyOther' | transloco }}: </span>{{ s.text }}</del>}
          @default {<ng-container>{{ s.text }}</ng-container>}
        }
      }
    </ng-template>

    <div class="sg" role="radiogroup" [attr.aria-label]="'brain.review.forks.kindSwitch' | transloco">
      @for (k of kindList; track k) {
        <button type="button" role="radio" class="sg-opt" [attr.data-kind]="k" [attr.data-zero]="count(k) ? 0 : 1"
                [attr.aria-checked]="current() === k" [attr.tabindex]="current() === k ? 0 : -1" [attr.aria-label]="kindLabel(k)"
                (click)="choose(k, false)" (keydown)="onKey($event, k)">
          <span aria-hidden="true">{{ kindName(k) }}</span><span class="sg-n" aria-hidden="true">{{ count(k) }}</span>
          @if (markedCount(k) > 0) { <span class="sg-el" aria-hidden="true" [attr.title]="markedWords(k)"></span> }
        </button>
      }
    </div>
    <p class="sr-only" role="status">{{ kindLabel(current()) }}</p>

    <div class="kind-panel">
      @if (views().length > 0) {
        @if (comparing()) {
          <div class="l3-legend" role="note">
            <span class="kind-hint">{{ 'brain.review.forks.kindHint.' + current() | transloco }}</span>
            <span><ins class="ins">{{ 'brain.review.forks.legend.onlyThis' | transloco }}</ins></span>
            <span><del class="del">{{ 'brain.review.forks.legend.onlyOther' | transloco }}</del></span>
          </div>
        }
        <ul class="l3-list">
          @for (v of views(); track v.row.forkId) {
            <li class="l3-item" [attr.data-kind]="v.row.kind">
              <article [attr.aria-label]="v.label">
                <header class="l3-h">
                  <span class="fk-id" [attr.title]="v.row.forkId">{{ 'brain.review.forks.forkOf' | transloco: { id: short(v.row.forkId) } }}</span>
                  @if (v.type) { <span class="fk-type">{{ v.type }}</span> }
                  @if (v.orphan) { <span class="badge badge-yellow">{{ 'brain.review.forks.orphaned' | transloco }}</span> }
                  @if (v.capNote) { <span class="fk-cap">{{ 'brain.review.forks.atCap' | transloco: { cap: cap() } }}</span> }
                </header>
                @if (v.capNote) { <p class="cap-note">{{ 'brain.review.forks.atCapBody' | transloco: { cap: cap() } }}</p> }
                @if (v.orphan) { <p class="l3-orphan">{{ 'brain.review.forks.orphanedBody' | transloco }}</p> }
                @if (v.ends; as e) {
                  <p class="l3-ends"><span class="con-key">{{ 'brain.review.forks.endpoints' | transloco }}</span> <strong>{{ e.from }}</strong> <span class="l3-label">{{ e.label }}</span> <strong>{{ e.to }}</strong></p>
                }
                <dl class="l3-who">
                  <div><dt>{{ 'brain.review.forks.thisVersion' | transloco }}</dt><dd>{{ v.thisWho }}</dd></div>
                  @if (v.otherWho) { <div><dt>{{ 'brain.review.forks.otherVersion' | transloco }}</dt><dd>{{ v.otherWho }}</dd></div> }
                </dl>
                <p class="l3-text" [class]="'l3-text-' + v.row.kind" data-forks-text><ng-container *ngTemplateOutlet="marks; context: { $implicit: v.main }"/></p>
                @if (!v.orphan) {
                  <details class="l3-full">
                    <summary>{{ 'brain.review.forks.showBoth' | transloco }}</summary>
                    <div><h4>{{ 'brain.review.forks.thisVersion' | transloco }}</h4><p>{{ v.fullThis }}</p></div>
                    <div><h4>{{ 'brain.review.forks.otherVersion' | transloco }}</h4><p>{{ v.fullOther }}</p></div>
                  </details>
                }
                @if (v.fields.length > 0) {
                  <dl class="l3-fields">
                    @for (f of v.fields; track f.key) {
                      <div class="l3-f"><dt class="con-key">{{ f.key }}</dt><dd>
                        @if (v.orphan) { {{ f.plain }} } @else { <ng-container *ngTemplateOutlet="marks; context: { $implicit: f.marks }"/> }
                      </dd></div>
                    }
                  </dl>
                }
                @if (v.same) { <p class="l3-same">{{ 'brain.review.forks.unchanged' | transloco: { fields: v.same } }}</p> }
                @if (v.elsewhere.length > 0) {
                  <ul class="l3-elsewhere">
                    @for (line of v.elsewhere; track $index) { <li>{{ line }}</li> }
                  </ul>
                }
                <footer class="l3-foot">
                  <div class="fk-actions">
                    <button type="button" class="btn btn-sm btn-secondary" [attr.aria-label]="keepLabel(v, 'fork')" (click)="ask(v.row, 'fork')">{{ 'brain.review.forks.keepThis' | transloco }}</button>
                    <button type="button" class="btn btn-sm btn-secondary" [attr.aria-label]="keepLabel(v, 'parent')" (click)="ask(v.row, 'parent')">{{ v.keepOtherWord }}</button>
                  </div>
                  @if (v.pointed) { <span class="fk-pointed">{{ v.pointed }}</span> }
                </footer>
              </article>
            </li>
          }
        </ul>
      } @else if (busy()) {
        <div class="loading-overlay"><span class="spinner"></span></div>
      } @else {
        <div class="empty-state kind-empty">
          <div class="empty-state-icon"><ph-icon name="check-circle" [size]="40"/></div>
          <h3>{{ 'brain.review.forks.empty.kind.title' | transloco: { kind: kindName(current()) } }}</h3>
          <p>{{ 'brain.review.forks.empty.kind.body' | transloco: { noun: kindNoun(current()) } }}</p>
          @if (nextKind(); as next) {
            <p>{{ 'brain.review.forks.empty.elsewhere' | transloco }} <button type="button" class="btn btn-sm btn-secondary" (click)="choose(next, true)">{{ 'brain.review.forks.empty.show' | transloco: { kind: kindName(next), count: count(next) } }}</button></p>
          }
        </div>
      }
    </div>

    @if (pending(); as p) {
      <div class="dialog-backdrop">
        <div class="dialog" [appModal]="confirmTitle(p)" appModalCloseOnBackdrop (dismiss)="cancel()" (click)="$event.stopPropagation()"
             aria-labelledby="forks-confirm-title" aria-describedby="forks-confirm-message">
          <h2 id="forks-confirm-title">{{ confirmTitle(p) }}</h2>
          <p class="message" id="forks-confirm-message">{{ confirmBody(p) }}<span>{{ confirmDeletes(p) }}</span>@if (confirmElsewhere(p); as overrides) {<span>{{ overrides }}</span>}</p>
          <div class="actions">
            <button type="button" class="btn btn-secondary btn-sm" (click)="cancel()">{{ 'common.cancel' | transloco }}</button>
            <button type="button" class="btn btn-sm btn-danger-solid" (click)="confirm()">{{ confirmWord(p) }}</button>
          </div>
        </div>
      </div>
    }
  `,
})
export class ReviewForksComponent {
  private readonly transloco = inject(TranslocoService);
  private readonly active = inject(ActiveLanguage);
  private readonly dates = inject(DateFormatService);
  private readonly plural = inject(PluralText);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** The forks to show, each beside its parent; the rows of the kind on screen are the ones drawn. */
  readonly rows = input.required<readonly ForkRow[]>();
  /** Forks per kind over the whole space, as the list answers; absent, the rows given are counted. */
  readonly counts = input<Partial<ForkCounts> | null>(null);
  /** Per kind, how many of its forks another instance already decided; absent, no kind is marked. */
  readonly marked = input<ForkMarkedCounts | null>(null);
  /** The fields each kind compares and its main field, as the list answers; the client names none of its own. */
  readonly kinds = input<ForkKindsFields | null>(null);
  /** The kind on screen when the host decides it; absent, the first kind that has forks, and the reviewer's choices after that. */
  readonly kind = input<ForkKind | null>(null);
  /** The rows of a newly chosen kind are on their way: an empty list then waits instead of saying nothing is to be reviewed. */
  readonly busy = input(false);
  /** The most forks one record may hold, as the server's list says it; null when it does not (no "at the limit" notice then). */
  readonly cap = input<number | null>(null);
  /** The reviewer chose a kind; a host that pages by kind reads that kind's rows. */
  readonly kindChange = output<ForkKind>();
  /** A confirmation was confirmed: which fork, of which kind, and which version to keep (`fork` is this version, `parent` the other). */
  readonly resolve = output<{ forkId: string; kind: ForkKind; keep: ForkKeep }>();

  protected readonly kindList = FORK_KINDS;

  /** The fork whose keep action is awaiting its confirmation. */
  protected readonly pending = signal<{ row: ForkRow; keep: ForkKeep } | null>(null);

  private readonly counted = computed(() => {
    const out = Object.fromEntries(FORK_KINDS.map(k => [k, 0])) as ForkCounts;
    for (const r of this.rows()) out[r.kind]++;
    return out;
  });

  /** The kind on screen: the host's, else the first that has forks, and whatever the reviewer chose after that. */
  protected readonly current = linkedSignal<ForkKind | null, ForkKind>({
    source: this.kind,
    computation: (given, previous) => given ?? previous?.value ?? FORK_KINDS.find(k => this.count(k) > 0) ?? FORK_KINDS[0],
  });

  private readonly visible = computed(() => this.rows().filter(r => r.kind === this.current()));
  /** The rows on screen, worked out once; recomputed when the rows, the answer's fields or the page's words change. */
  protected readonly views = computed<RowView[]>(() => this.visible().map(r => this.viewOf(r)));
  /** The legend explains marks, so it appears when some row on screen has a comparison: an orphan has none to explain. */
  protected readonly comparing = computed(() => this.visible().some(r => !this.isOrphan(r)));

  protected short(id: string): string { return id.slice(0, 8); }

  /** One words lookup, in the page's language and recomputed when its words arrive. */
  private tr(key: string, params?: Record<string, unknown>): string {
    this.active.revision();
    return this.transloco.translate(key, params, this.active.language() || undefined);
  }

  protected count(kind: ForkKind): number { return this.counts()?.[kind] ?? this.counted()[kind]; }
  protected markedCount(kind: ForkKind): number { return this.marked()?.[kind] ?? 0; }
  /** A kind goes by the name the Brain tab of that kind already has: the switch reads `brain.tab.*` and holds no label of its own. */
  protected kindName(kind: ForkKind): string { return this.tr(`brain.tab.${FORK_KIND_TAB[kind]}`); }
  protected kindNoun(kind: ForkKind): string { return this.tr(`brain.review.forks.kindNoun.${kind}`); }

  /** The control's accessible name says the number in words: "Facts, 3 forks". */
  protected kindLabel(kind: ForkKind): string {
    const label = this.plural.text('brain.review.forks.kindCount', this.count(kind), { kind: this.kindName(kind) });
    return this.markedCount(kind) > 0 ? `${label}; ${this.markedWords(kind)}` : label;
  }
  protected markedWords(kind: ForkKind): string { return this.plural.text('brain.review.forks.kindElsewhere', this.markedCount(kind)); }

  /** The first other kind that has forks, offered where a kind is empty. */
  protected nextKind(): ForkKind | undefined { return FORK_KINDS.find(k => k !== this.current() && this.count(k) > 0); }

  /** Choose a kind; `focus` moves focus to its control (the arrow keys and the offer do, a click already has it). */
  protected choose(kind: ForkKind, focus: boolean): void {
    if (kind !== this.current()) {
      this.current.set(kind);
      this.kindChange.emit(kind);
    }
    if (focus) this.host.nativeElement.querySelector<HTMLElement>(`[role="radio"][data-kind="${kind}"]`)?.focus();
  }

  /** The keys of a roving radio group: arrows move and select, wrapping at both ends; Home and End jump. Anything else is left alone. */
  protected onKey(event: KeyboardEvent, kind: ForkKind): void {
    const i = FORK_KINDS.indexOf(kind);
    const n = FORK_KINDS.length;
    let target: number;
    switch (event.key) {
      case 'ArrowRight': case 'ArrowDown': target = (i + 1) % n; break;
      case 'ArrowLeft': case 'ArrowUp': target = (i - 1 + n) % n; break;
      case 'Home': target = 0; break;
      case 'End': target = n - 1; break;
      default: return;
    }
    event.preventDefault();
    this.choose(FORK_KINDS[target]!, true);
  }

  private fieldsOf(kind: ForkKind): { fields: readonly string[]; mainField: string } {
    return this.kinds()?.[kind] ?? { fields: [], mainField: '' };
  }

  private text(v: unknown): string { return v === undefined || v === null ? '' : String(v); }

  /** The name an instance goes by in a sentence: its label, or the start of its id when all it has is an id. */
  private instance(name: string): string { return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(name) ? name.slice(0, 8) : name; }

  /** The instance that decided a fork elsewhere, by the label the server knows it under (the one the author line shows), else by its short id. */
  private resolver(e: ForkResolvedElsewhere): string { return e.byLabel || this.instance(e.by); }

  private written(v: ForkVersion): string {
    const at = v.updatedAt ?? v.createdAt;
    const when = at ? this.dates.relative(at) : '';
    const instance = v.author?.instanceLabel ?? v.author?.instanceId?.slice(0, 8);
    return instance ? this.tr('brain.review.forks.writtenOn', { instance, when }) : this.tr('brain.review.forks.writtenHere', { when });
  }

  private plainText(v: unknown): string {
    return Array.isArray(v) ? (v.length ? v.join(', ') : this.tr('brain.review.forks.valueNone')) : this.text(v) || this.tr('brain.review.forks.valueEmpty');
  }

  /** One line per instance that decided this fork already: who, and which side they kept; an unproven entry is worded as reported. */
  private elsewhereLine(e: ForkResolvedElsewhere): string {
    const by = this.resolver(e);
    if (!e.proven) {
      return e.via ? this.tr('brain.review.forks.resolvedElsewhere.reported', { via: e.viaLabel || this.instance(e.via), by })
        : this.tr('brain.review.forks.resolvedElsewhere.reportedNoVia', { by });
    }
    return this.tr(e.kept === 'original' ? 'brain.review.forks.resolvedElsewhere.keptOriginal'
      : e.kept === 'this version' ? 'brain.review.forks.resolvedElsewhere.keptThis' : 'brain.review.forks.resolvedElsewhere.waiting', { by });
  }

  /** The parent holds as many forks as it may: said on the first of its forks in the list only, so the notice is not repeated per row. */
  private capNoteFor(row: ForkRow): boolean {
    const cap = this.cap();
    if (cap === null || row.siblings < cap) return false;
    return this.visible().find(r => r.parentId === row.parentId)?.forkId === row.forkId;
  }

  /** What points at the fork, said in one sentence: edges, links, both, or nothing. An edge is pointed at by nothing. */
  private pointedAt(row: ForkRow): string {
    if (row.kind === 'edge') return '';
    const { edgeCount, linkCount } = row;
    if (edgeCount && linkCount) {
      return this.tr('brain.review.forks.pointedAt', {
        edgePhrase: this.plural.text('brain.review.forks.edgeCount', edgeCount),
        linkPhrase: this.plural.text('brain.review.forks.linkCount', linkCount),
      });
    }
    if (edgeCount) return this.plural.text('brain.review.forks.edges', edgeCount);
    if (linkCount) return this.plural.text('brain.review.forks.links', linkCount);
    return this.tr('brain.review.forks.pointedAtNone');
  }

  private viewOf(row: ForkRow): RowView {
    const { fields, mainField } = this.fieldsOf(row.kind);
    const language = this.active.language();
    const orphan = row.orphaned || !row.parent;
    const empty = { empty: this.tr('brain.review.forks.valueEmpty'), none: this.tr('brain.review.forks.valueNone') };
    const own = this.text(row.fork[mainField]);
    const comparison = orphan ? null : compareForkVersions(row.fork, row.parent!, fields, mainField);
    const shown: FieldDifference[] = comparison ? comparison.others : forkOwnFields(row.fork, fields, mainField);
    return {
      row,
      orphan,
      type: this.text(row.fork['type']),
      label: `${this.tr('brain.review.forks.forkOf', { id: this.short(row.forkId) })}, ${this.tr(`brain.review.forks.kindOne.${row.kind}`)}`,
      thisWho: this.written(row.fork),
      otherWho: orphan ? '' : this.written(row.parent!),
      ends: row.kind === 'edge' ? { from: row.fromName || this.text(row.fork['from']), label: this.text(row.fork['label']), to: row.toName || this.text(row.fork['to']) } : null,
      main: comparison?.main ? textSegments(this.text(comparison.main.a), this.text(comparison.main.b)) : [{ kind: 'same', text: own }],
      fullThis: own,
      fullOther: orphan ? '' : this.text(row.parent![mainField]),
      fields: shown.map(f => ({ key: f.key, marks: orphan ? [] : fieldSegments(f, empty), plain: this.plainText(f.a) })),
      same: comparison ? formatList(comparison.same, language) : '',
      pointed: this.pointedAt(row),
      elsewhere: (row.resolvedElsewhere ?? []).map(e => this.elsewhereLine(e)),
      capNote: this.capNoteFor(row),
      keepOtherWord: orphan ? this.tr('brain.review.forks.letDeletionStand') : this.tr('brain.review.forks.keepOther'),
    };
  }

  /** The button's accessible name: the action, then whose version it keeps (an orphan's other action keeps nothing, so it names none). */
  protected keepLabel(v: RowView, keep: ForkKeep): string {
    if (keep === 'fork') return `${this.tr('brain.review.forks.keepThis')}, ${v.thisWho}`;
    return v.otherWho ? `${v.keepOtherWord}, ${v.otherWho}` : v.keepOtherWord;
  }

  protected ask(row: ForkRow, keep: ForkKeep): void { this.pending.set({ row, keep }); }
  protected cancel(): void { this.pending.set(null); }
  protected confirm(): void {
    const p = this.pending();
    if (!p) return;
    this.pending.set(null);
    this.resolve.emit({ forkId: p.row.forkId, kind: p.row.kind, keep: p.keep });
  }

  private isOrphan(row: ForkRow): boolean { return row.orphaned || !row.parent; }

  protected confirmTitle(p: { row: ForkRow; keep: ForkKeep }): string {
    if (this.isOrphan(p.row)) return this.tr(p.keep === 'fork' ? 'brain.review.forks.confirm.orphanKeep.title' : 'brain.review.forks.confirm.orphanDrop.title');
    return this.tr(p.keep === 'fork' ? 'brain.review.forks.confirm.keepThis.title' : 'brain.review.forks.confirm.keepOther.title');
  }

  /** The confirm button says what the action does: an orphan's second action lets the deletion stand. */
  protected confirmWord(p: { row: ForkRow; keep: ForkKeep }): string {
    if (p.keep === 'fork') return this.tr('brain.review.forks.keepThis');
    return this.tr(this.isOrphan(p.row) ? 'brain.review.forks.letDeletionStand' : 'brain.review.forks.keepOther');
  }

  /** What the other body becomes: the version that is discarded, quoted by its main text, with the other fields that go with it. */
  protected confirmBody(p: { row: ForkRow; keep: ForkKeep }): string {
    const { row, keep } = p;
    const { fields, mainField } = this.fieldsOf(row.kind);
    const noun = this.kindNoun(row.kind);
    const quote = (v: ForkVersion): string => {
      const text = this.text(v[mainField]);
      return text.length > QUOTE_CHARS ? `${text.slice(0, QUOTE_CHARS - 1).trimEnd()}…` : text;
    };
    if (this.isOrphan(row)) {
      return this.tr(keep === 'fork' ? 'brain.review.forks.confirm.orphanKeep.body' : 'brain.review.forks.confirm.orphanDrop.body', { noun, discarded: quote(row.fork) });
    }
    const discarded = quote(keep === 'fork' ? row.parent! : row.fork);
    const others = compareForkVersions(row.fork, row.parent!, fields, mainField).others.map(f => f.key);
    const extra = others.length ? this.tr('brain.review.forks.confirm.extra', { fields: formatList(others, this.active.language()) }) : '';
    return this.tr(keep === 'fork' ? 'brain.review.forks.confirm.keepThis.body' : 'brain.review.forks.confirm.keepOther.body', { noun, parent: this.short(row.parentId), discarded, extra });
  }

  /** What else the deletion does: the fork goes, and what pointed at it moves to the parent. */
  protected confirmDeletes(p: { row: ForkRow; keep: ForkKeep }): string {
    const { row, keep } = p;
    const fork = this.short(row.forkId);
    if (this.isOrphan(row)) return this.tr(keep === 'fork' ? 'brain.review.forks.confirm.orphanKeep.deletes' : 'brain.review.forks.confirm.orphanDrop.deletes', { fork });
    if (row.kind === 'edge') return this.tr('brain.review.forks.confirm.deletesEdge', { fork });
    if (!row.edgeCount && !row.linkCount) return this.tr('brain.review.forks.confirm.deletesNone', { fork });
    const parts = [
      ...(row.edgeCount ? [this.plural.text('brain.review.forks.edgeCount', row.edgeCount)] : []),
      ...(row.linkCount ? [this.plural.text('brain.review.forks.linkCount', row.linkCount)] : []),
    ];
    return this.tr('brain.review.forks.confirm.deletes', { fork, pointed: formatList(parts, this.active.language()), parent: this.short(row.parentId) });
  }

  /** Keeping this version of a fork another instance decided already overrides that instance's choice on every instance: the confirm says so. */
  protected confirmElsewhere(p: { row: ForkRow; keep: ForkKeep }): string {
    const entries = p.row.resolvedElsewhere ?? [];
    if (p.keep !== 'fork' || entries.length === 0) return '';
    return this.tr('brain.review.forks.resolvedElsewhere.overrides', { instances: formatList(entries.map(e => this.resolver(e)), this.active.language()) });
  }
}
