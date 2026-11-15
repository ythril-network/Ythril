import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { EMPTY, expand, reduce } from 'rxjs';
import { SchemaApi, typeHistoryFailure, type TypeChange, type TypeDefinition, type TypeHistoryAnswer, type TypeRead } from '../../core/schema-api.service';
import { DateFormatService } from '../../core/date-format.service';
import { definitionSpan, typeReadReason, type Words } from '../../core/type-definition-words';
import { changePlaceWords, changeValueWords, type Say } from '../../core/type-change-words';
import { STACK } from '../../shared/stacking';
import { FORK_KIND_TAB } from '../../core/forks.types';
import type { TypedKind } from '../../core/type-field';
import { ModalDirective } from '../../shared/modal.directive';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { HelpToggleComponent } from '../../shared/help-toggle.component';
import { rovingIndex } from '../../shared/roving-focus';
import { DIALOG_STYLES } from './dialog.styles';

/** Where a definition's records open: the type's Brain tab, filtered by `definition` (`older` or `sameAs:<rep>`, r4 §5.4). */
export function brainDefinitionLink(spaceId: string, kind: TypedKind, type: string, definition: string): string {
  const q = new URLSearchParams({ space: spaceId, tab: FORK_KIND_TAB[kind], type, definition });
  return `/brain?${q.toString()}`;
}

type Phase =
  | { phase: 'loading' }
  | { phase: 'failed'; reason: string }
  | { phase: 'unsupported' }
  | { phase: 'ready'; answer: TypeHistoryAnswer };

type Comparison = { phase: 'loading' } | { phase: 'none' } | { phase: 'ready'; changes: TypeChange[]; unread: string[] };

let headSeq = 0;

/** Stands for the type in the title's sentence while it is cut in two; no word of any language holds it. */
const TYPE_MARK = '';

/**
 * The history of one type (Q-744, design r4 §7.6, round 5 layout M): its definitions with their spans and where each is now, what
 * changed in the chosen one against the current one, and the Open links into the Brain. Counts nothing (r5 rule 1).
 *
 * Every read goes through `SchemaApi`'s type reads, which retry a busy answer and read an answer without the echo as "not supported".
 * A failure is one quiet block with Read again (r5 rule 6). Withheld record facts hide the Open links, never the definitions (r4 §6).
 *
 * Focus returns to whatever had it when the dialog opened, on Close as on Escape: the History button, or the drawer's Compare.
 */
@Component({
  selector: 'app-schema-type-history',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, ModalDirective, PhIconComponent, HelpToggleComponent],
  styles: [DIALOG_STYLES, `
    :host { display: block; }
    /* Above the drawer and the popup that host it (stacking.ts), or their layer covers Close and the Open links. */
    .dialog-backdrop { z-index: ${STACK.hostedDialog}; }
    .dialog { --dialog-max-width: 860px; padding: 20px 24px 24px; }
    .hist-head { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-bottom: 12px; }
    .hist-title { margin: 0; min-width: 0; font-size: 15px; font-weight: 700; overflow-wrap: anywhere; }
    .hist-title .tn { font-family: var(--font-mono, monospace); color: var(--accent); }
    .hist-head .close { margin-left: auto; }
    .one { margin: 0; font-size: 13px; color: var(--text-secondary); }
    .hcols { display: grid; grid-template-columns: minmax(0, 260px) minmax(0, 1fr); gap: 20px; align-items: start; }
    .selbox { min-width: 0; }
    .dl { display: flex; flex-direction: column; min-width: 0; max-height: 372px; overflow-y: auto; border: 1px solid var(--border-muted); border-radius: var(--radius-md); }
    .di { display: grid; grid-template-columns: minmax(0, 1fr) 12px; text-align: left; gap: 2px 8px; padding: 8px 10px 8px 12px; border: 0; border-bottom: 1px solid var(--border-muted);
      background: transparent; color: inherit; cursor: pointer; font: inherit; flex: none; white-space: normal; }
    .di:last-child { border-bottom: 0; }
    .di:hover { background: var(--bg-elevated); }
    .di[aria-selected="true"] { background: var(--bg-elevated); box-shadow: inset 2px 0 0 var(--accent); }
    .di .l1 { grid-column: 1; font-size: 12.5px; color: var(--text-primary); overflow-wrap: anywhere; }
    .di .l2 { grid-column: 1; font-size: 11.5px; color: var(--text-muted); overflow-wrap: anywhere; }
    .di .chev { grid-column: 2; grid-row: 1 / span 2; align-self: center; color: var(--text-muted); }
    .di[aria-selected="true"] .chev { color: var(--accent); }
    .sel-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 6px 16px; margin: 2px 0 12px; font-size: 13px; }
    .sel-head b { font-weight: 600; min-width: 0; overflow-wrap: anywhere; }
    .quiet { font-size: 12.5px; color: var(--text-secondary); text-decoration: underline; text-decoration-color: var(--border); }
    .quiet:hover { color: var(--text-primary); }
    .cmp { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, 1fr); gap: 4px 16px; align-items: baseline; font-size: 12.5px; }
    .cmp .h { font-size: 11px; color: var(--text-muted); }
    .cmp .pl { font-family: var(--font-mono, monospace); font-size: 12px; color: var(--text-secondary); overflow-wrap: anywhere; }
    .cmp .was { color: var(--text-muted); overflow-wrap: anywhere; }
    .cmp .now { color: var(--text-primary); font-weight: 600; overflow-wrap: anywhere; }
    .cmp .val { overflow-wrap: anywhere; }
    .cmp .lbl { display: none; }
    .muted { font-size: 12px; color: var(--text-muted); margin: 8px 0 0; }
    .warn { font-size: 12px; color: var(--warning, var(--text-secondary)); margin: 0 0 8px; }
    .foot { display: flex; justify-content: flex-end; margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--border-muted); }
    .failed .err { margin: 0 0 10px; font-size: 13px; color: var(--error); }
    /* Phone: nothing scrolls or clips sideways. The list and the comparison stack, and each change is one block: the place, then
       "This definition: {value}", then "Current: {value}" (the head row is hidden, so each value names its side). */
    @media (max-width: 760px) {
      .dialog { padding: 16px; }
      .hcols { grid-template-columns: minmax(0, 1fr); }
      .dl { max-height: 220px; }
      .cmp { grid-template-columns: minmax(0, 1fr); }
      .cmp .h { display: none; }
      .cmp .lbl { display: inline; }
      .cmp .pl { grid-column: 1; margin-top: 6px; }
      .cmp .was, .cmp .now { grid-column: 1; }
    }
  `],
  template: `
<div class="dialog-backdrop">
  <div class="dialog" [appModal]="'spaces.schema.history.title' | transloco: { type: type() }" [attr.aria-labelledby]="headId"
       appModalCloseOnBackdrop (dismiss)="close()" (click)="$event.stopPropagation()">
    <div class="hist-head">
      <h3 class="hist-title" [id]="headId">@let words = titleParts('spaces.schema.history.title' | transloco: { type: TYPE_MARK });{{ words.pre }}<span class="tn">{{ type() }}</span>{{ words.post }}</h3>
      <app-help-toggle label="spaces.schema.history.helpAria" testId="history-help-toggle">
        <p>{{ 'spaces.schema.history.help.keeps' | transloco }}</p>
        @if (undeclared()) { <p>{{ 'spaces.schema.history.help.undeclared' | transloco }}</p> }
        @if (several()) { <p>{{ 'spaces.schema.history.help.origin' | transloco }}</p> }
        @if (!undeclared()) {
          <p>{{ 'spaces.schema.history.help.cannotTell' | transloco }}</p>
          <p>{{ 'spaces.schema.history.help.mark' | transloco }}</p>
        }
      </app-help-toggle>
      <button class="icon-btn close" type="button" data-testid="history-close" [attr.title]="'spaces.schema.history.closeAria' | transloco"
              [attr.aria-label]="'spaces.schema.history.closeAria' | transloco" (click)="close()"><ph-icon name="x" [size]="14"/></button>
    </div>

    @switch (view().phase) {
      @case ('loading') {
        <p class="one" aria-busy="true">{{ 'spaces.schema.history.loading' | transloco }}</p>
      }
      @case ('failed') {
        <div class="failed" data-testid="history-failed">
          <p class="err">{{ 'spaces.schema.history.failed' | transloco: { reason: failedReason() } }}</p>
          <button class="btn btn-secondary btn-sm" type="button" data-testid="history-read-again" (click)="load()">{{ 'spaces.schema.history.readAgain' | transloco }}</button>
        </div>
      }
      @case ('ready') {
        @if (undeclared()) { <p class="one">{{ 'spaces.schema.history.notInSchema' | transloco }}</p> }
        @if (definitions().length === 1) {
          <p class="one" data-testid="history-one">{{ 'spaces.schema.history.oneDefinition' | transloco: { since: date(definitions()[0]!.since) } }}</p>
        } @else if (several()) {
          <div class="hcols">
            <div class="dl" role="listbox" [attr.aria-label]="'spaces.schema.history.listAria' | transloco: { type: type() }">
              @for (d of definitions(); track d.rep; let i = $index) {
                <button class="di" type="button" role="option" [attr.aria-selected]="i === chosenIndex()" [attr.tabindex]="i === chosenIndex() ? 0 : -1"
                        (click)="choose(i)" (keydown)="onKey($event, i)">
                  <span class="l1">@if (spanOf(d); as s) { {{ s.key | transloco: s.params }} }</span>
                  <span class="l2">@for (o of originsOf(d); track $index) { <span>{{ o.key | transloco: o.params }}</span> }</span>
                  <span class="chev"><ph-icon name="caret-right" [size]="12"/></span>
                </button>
              }
            </div>
            @if (chosen(); as d) {
              <div class="selbox" aria-live="polite">
                <div class="sel-head">
                  <b>@if (spanOf(d); as s) { {{ s.key | transloco: s.params }} }</b>
                  @if (!withheld()) {
                    <a class="quiet" data-testid="history-open-records" [href]="linkTo('sameAs:' + d.rep)" (click)="follow($event, 'sameAs:' + d.rep)"
                       [attr.aria-label]="'spaces.schema.history.openRecordsAria' | transloco: { span: spanText(d) }">{{ 'spaces.schema.history.openRecords' | transloco }}</a>
                  }
                </div>
                @if (comparison(); as c) {
                  @if (c.phase === 'ready') {
                    @for (place of c.unread; track place) { <p class="warn">{{ 'spaces.schema.history.unread' | transloco: { place: place } }}</p> }
                    @if (c.changes.length) {
                      <div class="cmp">
                        <span class="h">{{ 'spaces.schema.history.whatChanged' | transloco }}</span>
                        <span class="h">{{ 'spaces.schema.history.thisDefinition' | transloco }}</span>
                        <span class="h">{{ 'spaces.schema.history.currentColumn' | transloco }}</span>
                        @for (ch of c.changes; track ch.place) {
                          <span class="pl">{{ placeText(ch.place) }}</span>
                          <span class="was"><span class="lbl">{{ 'spaces.schema.history.thisDefinition' | transloco }}: </span><span class="val">{{ valueText(ch.from, ch.place) }}</span></span>
                          <span class="now"><span class="lbl">{{ 'spaces.schema.history.currentColumn' | transloco }}: </span><span class="val">{{ valueText(ch.to, ch.place) }}</span></span>
                        }
                      </div>
                    }
                  }
                }
              </div>
            }
          </div>
        }
        @if (cut()) { <p class="muted">{{ 'spaces.schema.history.cut' | transloco }}</p> }
        @if (several() && !undeclared() && !withheld()) {
          <div class="foot">
            <a class="btn btn-primary btn-sm" data-testid="history-open-older" [href]="linkTo('older')" (click)="follow($event, 'older')">{{ 'spaces.schema.history.openOlder' | transloco }}</a>
          </div>
        }
      }
    }
  </div>
</div>
  `,
})
export class SchemaTypeHistoryComponent implements OnInit {
  readonly spaceId = input.required<string>();
  readonly kind = input.required<TypedKind>();
  readonly type = input.required<string>();
  /** A version to choose first: the drawer's Compare opens the history on the record's definition. */
  readonly chosen0 = input<string | undefined>(undefined, { alias: 'chosen' });
  /** The dialog asked to close (Close, Escape, the backdrop). */
  readonly closed = output<void>();
  /** An Open link was followed: the host may close what the dialog sits in. */
  readonly left = output<void>();

  private readonly api = inject(SchemaApi);
  private readonly dates = inject(DateFormatService);
  private readonly transloco = inject(TranslocoService);
  private readonly router = inject(Router, { optional: true });
  private readonly destroyRef = inject(DestroyRef);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  /** What had the focus when the dialog opened; Close gives it back. Read before the dialog's focus trap moves it. */
  private readonly opener = (typeof document !== 'undefined' ? document.activeElement : null) as HTMLElement | null;

  protected readonly headId = `hist-head-${++headSeq}`;
  protected readonly view = signal<Phase>({ phase: 'loading' });
  protected readonly chosenIndex = signal(0);
  private readonly comparisons = signal<ReadonlyMap<string, Comparison>>(new Map());

  protected readonly answer = computed(() => { const v = this.view(); return v.phase === 'ready' ? v.answer : null; });
  protected readonly definitions = computed<TypeDefinition[]>(() => this.answer()?.definitions ?? []);
  protected readonly several = computed(() => this.definitions().length > 1);
  protected readonly undeclared = computed(() => this.answer()?.declared === 'none');
  protected readonly withheld = computed(() => this.answer()?.recordFacts === 'withheld');
  protected readonly cut = computed(() => this.answer()?.cut === true);
  protected readonly failedReason = computed(() => { const v = this.view(); return v.phase === 'failed' ? v.reason : ''; });
  protected readonly chosen = computed(() => this.definitions()[this.chosenIndex()] ?? null);
  protected readonly comparison = computed(() => { const d = this.chosen(); return d ? this.comparisons().get(d.rep) ?? null : null; });

  ngOnInit(): void { this.load(); }

  /** Read the history, every page of it (a page past the first reads the server's class memo and diffs nothing, r4 §5.2). */
  protected load(): void {
    this.view.set({ phase: 'loading' });
    const page = (skip?: number) => this.api.typeHistory(this.spaceId(), this.kind(), this.type(), skip);
    page().pipe(
      expand((r: TypeRead<TypeHistoryAnswer>) => r.supported && r.answer.nextSkip ? page(r.answer.nextSkip) : EMPTY),
      reduce((acc: TypeRead<TypeHistoryAnswer> | null, r: TypeRead<TypeHistoryAnswer>) => {
        if (!acc || !acc.supported || !r.supported) return acc ?? r;
        return { supported: true as const, answer: { ...acc.answer, definitions: [...acc.answer.definitions, ...r.answer.definitions], cut: acc.answer.cut ?? r.answer.cut } };
      }, null),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe({
      next: r => {
        if (!r || !r.supported) { this.view.set({ phase: 'unsupported' }); return; }
        this.view.set({ phase: 'ready', answer: r.answer });
        const want = this.chosen0();
        const at = want ? r.answer.definitions.findIndex(d => d.rep === want) : -1;
        // First the asked definition; else the newest older one, as the mockup opens; else the only one.
        this.choose(at >= 0 ? at : r.answer.definitions.length > 1 ? 1 : 0);
      },
      error: err => this.view.set({ phase: 'failed', reason: typeReadReason(typeHistoryFailure(err), this.transloco) }),
    });
  }

  /** Choose a definition, and read what changed in it against the current one, once per definition. */
  protected choose(i: number): void {
    this.chosenIndex.set(i);
    const d = this.definitions()[i];
    const a = this.answer();
    if (!d || !a || d.current || a.declared === 'none' || this.comparisons().has(d.rep)) return;
    this.setComparison(d.rep, { phase: 'loading' });
    this.api.typeComparison(this.spaceId(), this.kind(), this.type(), d.rep, a.current).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: r => {
        if (!r.supported) { this.setComparison(d.rep, { phase: 'none' }); return; }
        const own = r.answer.types.find(t => t.kind === this.kind() && t.type === this.type());
        this.setComparison(d.rep, { phase: 'ready', changes: own?.changes ?? [], unread: r.answer.unread });
      },
      // The comparison is a detail of the chosen definition; failing, it is left out and the list still stands.
      error: () => this.setComparison(d.rep, { phase: 'none' }),
    });
  }

  private setComparison(rep: string, c: Comparison): void {
    const next = new Map(this.comparisons());
    next.set(rep, c);
    this.comparisons.set(next);
  }

  /** The listbox keys (r3 §9.3): Up/Down step without wrapping, Home/End go to the ends, and the focus follows the choice. */
  protected onKey(event: KeyboardEvent, at: number): void {
    const to = rovingIndex(event.key, at, this.definitions().length, { axis: 'vertical', wrap: false });
    if (to < 0) return;
    event.preventDefault();
    this.choose(to);
    const option = this.host.nativeElement.querySelectorAll<HTMLElement>('[role="option"]')[to];
    option?.focus();
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    option?.scrollIntoView?.({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
  }

  protected close(): void {
    this.closed.emit();
    this.opener?.focus?.();
  }

  protected linkTo(definition: string): string {
    return brainDefinitionLink(this.spaceId(), this.kind(), this.type(), definition);
  }

  /** Follow an Open link inside the app (the router), so the page is not reloaded; a host without a router follows the href. */
  protected follow(event: MouseEvent, definition: string): void {
    if (!this.router || event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    this.left.emit();
    void this.router.navigateByUrl(this.linkTo(definition));
  }

  protected date(iso: string | undefined): string {
    return iso ? this.dates.format(iso, 'date') : '';
  }

  protected spanOf(d: TypeDefinition): Words | null {
    return definitionSpan(d, iso => this.date(iso));
  }

  protected spanText(d: TypeDefinition): string {
    const s = this.spanOf(d);
    return s ? this.transloco.translate(s.key, s.params) : '';
  }

  /** Where the definition is now (amend 2): edited here, each network layer holding it, fetched from a member. */
  protected originsOf(d: TypeDefinition): Words[] {
    const out: Words[] = [];
    if (d.origin?.edited === true) out.push({ key: 'spaces.schema.history.origin.edited', params: {} });
    for (const name of d.origin?.networks ?? []) out.push({ key: 'spaces.schema.history.origin.layer', params: { name } });
    if (d.origin?.fetched === true) out.push({ key: 'spaces.schema.history.origin.fetched', params: {} });
    return out;
  }

  /** The title's sentence cut at the type's place, so the type can be set in its own face wherever the language puts it. */
  protected titleParts(sentence: string): { pre: string; post: string } {
    const [pre = '', ...rest] = sentence.split(TYPE_MARK);
    return { pre, post: rest.join(TYPE_MARK) };
  }

  protected readonly TYPE_MARK = TYPE_MARK;

  private readonly say: Say = (key, params) => this.transloco.translate(key, params);

  /** A change's place as the property it is about (`type-change-words.ts`). Text binding only, never markup. */
  protected placeText(place: string): string {
    return changePlaceWords(place, this.say);
  }

  /** One side of a change in words (`type-change-words.ts`). Text binding only, never markup. */
  protected valueText(v: unknown, place: string): string {
    return changeValueWords(v, place, this.say);
  }
}
