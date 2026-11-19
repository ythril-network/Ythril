import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, inject, input, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { TranslocoPipe } from '@jsverse/transloco';
import { DateFormatService } from '../../core/date-format.service';
import { pageTranslator } from '../../core/page-translator';
import { formatCount } from '../../core/plural-text';
import { PluralText } from '../../core/plural-text.service';
import { ActiveLanguage } from '../../core/active-language';
import type { UnconvertedRow } from '../../core/conversion.types';
import { UNCONVERTED_CLASSES, reasonClassOf, type OpenTypeRef, type UnconvertedClass } from '../../core/unconverted-reasons';
import { ErrorStateComponent } from '../../shared/error-state.component';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { rovingIndex } from '../../shared/roving-focus';
import { REVIEW_CARD_STYLES, REVIEW_SEGMENTED_STYLES, reviewSegmentedPhone } from './review-panel.styles';
import { UNCONVERTED_PAGE_SIZE, type RunLine, type ReviewUnconvertedState, type UnconvertedClassChoice } from './review-unconverted-state';

/** The fields of a record's properties are listed as the server names them (`properties.age`); the card names the property. */
const PROPERTY_PREFIX = 'properties.';

/** A type name longer than this is not written into the phone's one-line summary of the filters: it says "one type" instead, as the drawing does. */
const SUMMARY_TYPE_MAX = 24;

/** The widest screen the filters fold on: the drawing's phone rule. */
const PHONE_MAX_WIDTH = 760;
const PHONE_QUERY = `(max-width: ${PHONE_MAX_WIDTH}px)`;

/** How many characters of a record's id the card shows. */
const SHORT_ID_LENGTH = 8;

/** One pill of the class switch. `count` is null where the numbers would be a lie (the Dismissed list: the counts are of open records). */
interface Pill { key: UnconvertedClassChoice; label: string; count: string | null }

/** What the panel shows of one record, worked out once per change instead of once per question the template asks. */
interface CardView {
  row: UnconvertedRow;
  cls: UnconvertedClass;
  kindLabel: string;
  /** The record's own name or summary; null when the record is gone. Never a stored property. */
  name: string | null;
  shortId: string;
  violations: string[];
  found: string;
  iso: string;
  dismissed: boolean;
}

/**
 * The Unconverted section of Review as the green-lit drawing draws it (bundle-285, Q-939, moments 5 and 5b): the intro, the filters (record type and
 * status), "Convert again" and "Dismiss all N shown", the class switch with a count per class, one card per record in the Duplicates cards' language
 * (the record's name first, its short id last), and the pager. The Review tab hosts it and owns the sub-tab; the state is `ReviewUnconvertedState`.
 *
 * Order matters in the states: a caller who may not read, a load that has not answered, and a load that failed are each checked BEFORE the list, so a
 * server that did not answer never reads as "no unconverted records", the friendliest sentence the panel has. Three empty screens are different
 * sentences: nothing is unconverted in the space; the filters match nothing in a space that has records; and (before them) "we could not look".
 *
 * Everything a record carries is bound as text: its name and the reasons of its violations are written by whoever wrote the record. A control a caller
 * may not use is locked and its reason is on the page, never only in a tooltip. On a phone the two filters fold behind one line that says what they are
 * set to, the actions stay outside it, and the class switch is a two-by-two grid.
 */
@Component({
  selector: 'app-review-unconverted-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, TranslocoPipe, ErrorStateComponent, PhIconComponent],
  styles: [REVIEW_SEGMENTED_STYLES, reviewSegmentedPhone(PHONE_MAX_WIDTH), REVIEW_CARD_STYLES, `
    :host { display: block; --rv-grid-top: 12px; }
    .intro { color: var(--text-muted); font-size: 13px; margin: 0 0 16px; }
    .refusal { display: flex; gap: 8px; align-items: flex-start; flex-wrap: wrap; margin: 8px 0 12px; font-size: 13px; }
    .refusal-body { flex: 1 1 220px; min-width: 0; }
    .refusal-body p { margin: 0; overflow-wrap: anywhere; }
    .refusal-close { background: none; border: none; color: inherit; cursor: pointer; padding: 2px; line-height: 1; flex-shrink: 0; }
    .run-line { display: flex; gap: 8px; align-items: flex-start; margin: 12px 0 0; font-size: 13px; }
    .run-line span { min-width: 0; overflow-wrap: anywhere; }

    /* The filters and the two actions: one row on a wide screen; on a phone the filters fold and the actions sit below. */
    .type-filter { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 12px 0 0; font-size: 13px; }
    .type-filter label { color: var(--text-muted); font-size: 12px; }
    /* width and flex are explicit: a global full-width rule on select otherwise stretches it across the page and pushes the label onto its own line. */
    .type-filter select { font-size: 13px; padding: 4px 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-primary); color: var(--text-primary); width: auto; min-width: 140px; max-width: 100%; flex: 0 0 auto; }
    .acts { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .lock-note { margin: 6px 0 0; font-size: 12px; color: var(--text-secondary); }
    .filters-d { margin-top: 12px; border: 1px solid var(--border); border-radius: var(--radius-md); padding: 8px 10px; font-size: 13px; }
    .filters-d summary { cursor: pointer; color: var(--text-secondary); overflow-wrap: anywhere; }
    .filters-d .type-filter { flex-direction: column; align-items: stretch; }
    .filters-d .type-filter select { width: 100%; }
    .phone-acts { margin-top: 10px; }
    .cap-note { margin: 8px 0 0; font-size: 11px; color: var(--warning); }

    /* The class switch: one radio group, one cell per class with its count; a 2 x 2 grid on a phone. */
    .sw { margin: 12px 0 0; }
    /* The switch and the cards are the shared Review style (review-panel.styles.ts): the same queue does not look like two products. */
    .dup-when time { font-variant-numeric: tabular-nums; white-space: nowrap; }
    .gone { color: var(--text-muted); font-style: italic; }
    .cv-rid { margin-top: 4px; font-family: var(--font-mono); font-size: 10.5px; color: var(--text-muted); }
    .sug-why { margin: 0; font-size: 12px; color: var(--text-secondary); line-height: 1.45; }
    .sug-why.todo { color: var(--text-muted); }
    .sug-samples { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 5px; }
    .sug-samples li { font-family: var(--font-mono); font-size: 11px; padding: 2px 7px; border-radius: 999px; background: var(--bg-elevated); border: 1px solid var(--border-muted); color: var(--text-primary); max-width: 100%; overflow-wrap: anywhere; }
    .dup-actions { display: flex; gap: 8px; justify-content: flex-end; align-items: center; flex-wrap: wrap; margin-top: auto; }
    .pagination { margin-top: 16px; }

    /* The app has no global focus ring, so these controls draw their own. */
    .refusal-close:focus-visible, .filters-d summary:focus-visible, .type-filter select:focus-visible, .dup-actions button:focus-visible, .acts button:focus-visible, .pagination button:focus-visible, .empty-state button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

    @media (max-width: 760px) {
      .dup-grid { grid-template-columns: minmax(0, 1fr); }
      .dup-actions .btn { flex: 1 1 40%; justify-content: center; }
    }
  `],
  template: `
    <ng-template #filters>
      <label for="unconverted-type">{{ 'brain.review.unconverted.typeLabel' | transloco }}</label>
      <select id="unconverted-type" [attr.aria-label]="'brain.review.unconverted.typeLabel' | transloco" (change)="onType($any($event.target).value)">
        <option value="" [selected]="state().typeChoice() === null">{{ 'brain.review.unconverted.allTypes' | transloco }}</option>
        @for (t of state().typeOptions(); track typeKey(t)) {
          <option [value]="typeKey(t)" [selected]="isChosen(t)">{{ t.type }}</option>
        }
      </select>
      <select id="unconverted-status" [attr.aria-label]="'duplicates.statusFilterAria' | transloco" (change)="onStatus($any($event.target).value)">
        <option value="open" [selected]="state().statusChoice() === 'open'">{{ 'duplicates.status.open' | transloco }}</option>
        <option value="dismissed" [selected]="state().statusChoice() === 'dismissed'">{{ 'duplicates.status.dismissed' | transloco }}</option>
        <option value="all" [selected]="state().statusChoice() === 'all'">{{ 'duplicates.status.all' | transloco }}</option>
      </select>
    </ng-template>

    <ng-template #actions>
      <div class="acts">
        <button type="button" class="btn btn-sm btn-secondary" data-testid="convert-again" [disabled]="!canConvertAgain()"
                [attr.title]="convertAgainTitle()" [attr.aria-describedby]="state().canConvert() ? null : 'unconverted-convert-locked'"
                (click)="state().convertAgain()">{{ 'brain.review.unconverted.convertAgain' | transloco }}</button>
        @if (dismissAllLabel(); as label) {
          <button type="button" class="btn btn-sm btn-secondary" data-testid="dismiss-all" [disabled]="!state().canDismiss() || state().bulkBusy()"
                  [attr.aria-describedby]="state().canDismiss() ? null : 'unconverted-dismiss-locked'"
                  (click)="state().dismissShown()">{{ label }}</button>
        }
      </div>
    </ng-template>

    <section role="tabpanel" id="review-panel-unconverted" aria-labelledby="review-tab-unconverted">
      <p class="intro">{{ 'brain.review.unconverted.intro' | transloco }}</p>

      @if (state().refusal(); as refusal) {
        <div class="alert alert-warning refusal" role="alert">
          <div class="refusal-body"><p>{{ refusal }}</p></div>
          <button class="btn btn-sm btn-secondary" type="button" (click)="state().dismissRefusal(); state().reload(true)">{{ 'brain.review.forks.refusal.reload' | transloco }}</button>
          <button class="refusal-close" type="button" [attr.aria-label]="'brain.review.forks.refusal.dismiss' | transloco" (click)="state().dismissRefusal()"><ph-icon name="x" [size]="14"/></button>
        </div>
      }

      @if (state().denied()) {
        <div class="alert alert-warning" role="alert" data-testid="unconverted-denied">{{ 'brain.review.unconverted.rung' | transloco }}</div>
      } @else if (state().loading() && !state().loaded()) {
        <div class="loading-overlay"><span class="spinner"></span></div>
      } @else if (state().loadError() !== null) {
        <app-error-state [reason]="state().loadError() ?? ''" (retry)="state().reload()" />
      } @else if (state().loaded()) {
        @if (state().running(); as run) {
          <div class="alert alert-info run-line" role="status" data-testid="unconverted-running"><ph-icon name="arrows-clockwise" [size]="16"/><span>{{ runText(run) }}</span></div>
        }

        @if (phone()) {
          <details class="filters-d">
            <summary>{{ filtersSummary() }}</summary>
            <div class="type-filter"><ng-container *ngTemplateOutlet="filters"/></div>
          </details>
          <div class="phone-acts"><ng-container *ngTemplateOutlet="actions"/></div>
        } @else {
          <div class="type-filter"><ng-container *ngTemplateOutlet="filters"/><ng-container *ngTemplateOutlet="actions"/></div>
        }
        @if (!state().canConvert()) {
          <p class="lock-note" id="unconverted-convert-locked" data-testid="convert-locked">{{ 'spaces.schema.convert.locked' | transloco }}</p>
        }
        @if (!state().canDismiss() && (state().dismissCount() ?? 0) > 0) {
          <p class="lock-note" id="unconverted-dismiss-locked" data-testid="dismiss-locked">{{ 'brain.review.unconverted.dismissLocked' | transloco }}</p>
        }

        <div class="sw">
          <div class="sg" role="radiogroup" [attr.aria-label]="'brain.review.unconverted.switchAria' | transloco">
            @for (p of pills(); track p.key) {
              <button type="button" role="radio" class="sg-opt" [attr.data-class]="p.key" [attr.aria-checked]="p.key === state().classChoice()"
                      [attr.tabindex]="p.key === state().classChoice() ? 0 : -1" (click)="choose(p.key, false)" (keydown)="onKey($event, p.key)">
                <span class="sg-l">{{ p.label }}</span>@if (p.count !== null) {<span class="sg-n">{{ p.count }}</span>}
              </button>
            }
          </div>
        </div>
        @if (state().countsCut()) {
          <p class="cap-note" data-testid="counts-cut">{{ 'brain.review.unconverted.cut' | transloco }}</p>
        }

        @if (state().loading()) {
          <div class="loading-overlay"><span class="spinner"></span></div>
        } @else if (state().rows().length === 0) {
          @if (state().spaceEmpty()) {
            <div class="empty-state" data-empty="overall">
              <div class="empty-state-icon"><ph-icon name="check-circle" [size]="48"/></div>
              <h3>{{ 'brain.review.unconverted.emptyTitle' | transloco }}</h3>
              <p>{{ 'brain.review.unconverted.emptyBody' | transloco }}</p>
            </div>
          } @else {
            <!-- The queue is not empty, this filter is: a distinction "nothing is unconverted" would hide. -->
            <div class="empty-state" data-empty="filter">
              <div class="empty-state-icon"><ph-icon name="check-circle" [size]="48"/></div>
              <h3>{{ 'brain.review.unconverted.emptyFilter.title' | transloco }}</h3>
              <p>{{ 'brain.review.unconverted.emptyFilter.body' | transloco }}</p>
            </div>
          }
        } @else {
          <div class="dup-grid">
            @for (c of cards(); track c.row.itemId) {
              <article class="dup-card" data-testid="unconverted-card">
                <div class="dup-card-h">
                  <span class="dup-type">{{ c.row.type }}</span>
                  <span class="badge" [class.badge-yellow]="c.cls !== 'refused'" [class.badge-gray]="c.cls === 'refused'">{{ ('brain.review.unconverted.badge.' + c.cls) | transloco }}</span>
                  @if (c.dismissed) { <span class="badge badge-gray">{{ 'duplicates.status.dismissed' | transloco }}</span> }
                  <span class="dup-when"><time [attr.datetime]="c.iso" [attr.title]="c.iso">{{ c.found }}</time></span>
                </div>
                <div class="dup-rec">
                  <div class="dup-rec-l">{{ c.kindLabel }}</div>
                  <div class="dup-rec-txt">@if (c.name !== null) {<strong>{{ c.name }}</strong>} @else {<span class="gone">{{ 'brain.review.unconverted.gone' | transloco }}</span>}</div>
                  <div class="cv-rid">{{ c.shortId }}</div>
                </div>
                <p class="sug-why">{{ ('brain.review.unconverted.why.' + c.cls) | transloco }}</p>
                @if (c.violations.length > 0) {
                  <ul class="sug-samples" [attr.aria-label]="'brain.review.unconverted.violationsAria' | transloco">
                    @for (v of c.violations; track $index) { <li>{{ v }}</li> }
                  </ul>
                }
                <p class="sug-why todo">{{ ('brain.review.unconverted.todo.' + c.cls) | transloco }}</p>
                <div class="dup-actions">
                  <button type="button" class="btn btn-sm btn-secondary" [disabled]="c.name === null" (click)="state().openRecord(c.row)">{{ 'brain.review.unconverted.open' | transloco }}</button>
                  @if (!c.dismissed) {
                    <button type="button" class="btn btn-sm btn-secondary" [disabled]="!state().canDismiss() || state().busyItem() === c.row.itemId"
                            [attr.aria-describedby]="state().canDismiss() ? null : 'unconverted-dismiss-locked'"
                            (click)="state().dismissOne(c.row)">{{ 'brain.review.unconverted.dismiss' | transloco }}</button>
                  }
                </div>
              </article>
            }
          </div>
          @if (state().hasPrevious() || state().hasNext()) {
            <div class="pagination">
              <button class="btn btn-sm btn-secondary" type="button" [disabled]="!state().hasPrevious()" (click)="state().goTo(state().skip() - pageSize)"><ph-icon name="arrow-left" [size]="14" style="display:inline-flex;vertical-align:middle;"/> {{ 'common.prev' | transloco }}</button>
              <span class="pager-info">{{ state().pagerText() }}</span>
              <button class="btn btn-sm btn-secondary" type="button" [disabled]="!state().hasNext()" (click)="state().goTo(state().skip() + pageSize)">{{ 'common.next' | transloco }} <ph-icon name="arrow-right" [size]="14" style="display:inline-flex;vertical-align:middle;"/></button>
            </div>
          }
        }
      }
    </section>
  `,
})
export class ReviewUnconvertedPanelComponent {
  /** The space whose unconverted records these are. */
  readonly spaceId = input.required<string>();
  /** The Review tab's state for this section: its rows, filters, page and refusal. */
  readonly state = input.required<ReviewUnconvertedState>();

  protected readonly pageSize = UNCONVERTED_PAGE_SIZE;
  private readonly say = pageTranslator();
  private readonly plural = inject(PluralText);
  private readonly dates = inject(DateFormatService);
  private readonly active = inject(ActiveLanguage);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** The screen is a phone's: the filters fold behind one line. Read once and followed, so a rotated phone folds and unfolds them. */
  protected readonly phone = signal(false);

  constructor() {
    if (typeof matchMedia !== 'function') return;
    const query = matchMedia(PHONE_QUERY);
    this.phone.set(query.matches);
    const follow = (event: MediaQueryListEvent): void => this.phone.set(event.matches);
    query.addEventListener?.('change', follow);
    inject(DestroyRef).onDestroy(() => query.removeEventListener?.('change', follow));
  }

  private number(n: number): string { return formatCount(this.active.language() || 'en', n); }

  /** The class switch: All, then each class that has open records (the chosen one stays even at none), each with its count from the whole space. */
  protected readonly pills = computed<Pill[]>(() => {
    const counts = this.state().classCounts();
    const chosen = this.state().classChoice();
    const all: Pill = { key: 'all', label: this.say('brain.review.unconverted.all'), count: counts ? this.number(this.state().openAll()) : null };
    const classes = UNCONVERTED_CLASSES
      // A class that holds nothing is not offered: a choice that can only ever be empty is noise. The Dismissed list has no counts, so it offers them all.
      .filter(c => !counts || counts[c] > 0 || c === chosen)
      .map<Pill>(c => ({ key: c, label: this.say(`brain.review.unconverted.class.${c}`), count: counts ? this.number(counts[c]) : null }));
    return [all, ...classes];
  });

  /** The cards on screen, worked out once per change. */
  protected readonly cards = computed<CardView[]>(() => this.state().rows().map(row => this.cardOf(row)));

  private cardOf(row: UnconvertedRow): CardView {
    return {
      row,
      cls: reasonClassOf(row.reason),
      kindLabel: this.say(`brain.review.forks.kindNoun.${row.kind}`),
      name: row.record ? row.record.summary : null,
      shortId: row.recordId.slice(0, SHORT_ID_LENGTH),
      violations: row.violations.map(v => `${v.field.startsWith(PROPERTY_PREFIX) ? v.field.slice(PROPERTY_PREFIX.length) : v.field}: ${v.reason}`),
      found: this.say('brain.review.unconverted.found', { when: this.dates.relative(row.detectedAt) }),
      iso: this.dates.iso(row.detectedAt),
      dismissed: row.status === 'dismissed',
    };
  }

  protected typeKey(t: OpenTypeRef): string { return `${t.kind}:${t.type}`; }
  protected isChosen(t: OpenTypeRef): boolean {
    const chosen = this.state().typeChoice();
    return chosen !== null && chosen.kind === t.kind && chosen.type === t.type;
  }

  protected onType(value: string): void {
    this.state().chooseType(value === '' ? null : (this.state().typeOptions().find(t => this.typeKey(t) === value) ?? null));
  }

  protected onStatus(value: string): void { this.state().chooseStatus(value === 'dismissed' || value === 'all' ? value : 'open'); }

  /** Choose a class; `focus` moves focus to its pill (the arrow keys do, a click already has it). */
  protected choose(key: UnconvertedClassChoice, focus: boolean): void {
    this.state().chooseClass(key);
    if (focus) this.host.nativeElement.querySelector<HTMLElement>(`[role="radio"][data-class="${key}"]`)?.focus();
  }

  /** The keys of a roving radio group: arrows move and choose, wrapping at both ends; Home and End jump. Anything else is left alone. */
  protected onKey(event: KeyboardEvent, key: UnconvertedClassChoice): void {
    const keys = this.pills().map(p => p.key);
    const arrow = event.key === 'ArrowDown' ? 'ArrowRight' : event.key === 'ArrowUp' ? 'ArrowLeft' : event.key;
    const to = rovingIndex(arrow, keys.indexOf(key), keys.length, { axis: 'horizontal', wrap: true });
    if (to < 0) return;
    event.preventDefault();
    this.choose(keys[to]!, true);
  }

  /** Convert again needs one type chosen and the conversion price; the title says which is missing. */
  protected canConvertAgain(): boolean {
    return this.state().typeChoice() !== null && this.state().canConvert() && !this.state().convertBusy();
  }
  protected convertAgainTitle(): string {
    if (!this.state().canConvert()) return this.say('spaces.schema.convert.locked');
    return this.say(this.state().typeChoice() === null ? 'brain.review.unconverted.convertAgainPick' : 'brain.review.unconverted.convertAgainTitle');
  }

  /** "Dismiss all N shown", or nothing where there is nothing to dismiss (the Dismissed list, or no record). */
  protected dismissAllLabel(): string | null {
    const n = this.state().dismissCount();
    return n ? this.plural.text('brain.review.unconverted.dismissAll', n) : null;
  }

  /** The phone's one line: what the filters are set to. */
  protected filtersSummary(): string {
    const s = this.state();
    const cls = s.classChoice();
    const type = s.typeChoice();
    return this.say('brain.review.unconverted.filtersSummary', {
      reasons: this.say(cls === 'all' ? 'brain.review.unconverted.all' : `brain.review.unconverted.class.${cls}`),
      type: type === null ? this.say('brain.review.unconverted.allTypes') : type.type.length > SUMMARY_TYPE_MAX ? this.say('brain.review.unconverted.oneType') : type.type,
      status: this.say(`duplicates.status.${s.statusChoice()}`),
    });
  }

  /** The running line: how far the conversion of the type has come, or its types and that the records left are being counted. */
  protected runText(run: RunLine): string {
    const type = run.names.length === 1 ? run.names[0]! : this.plural.text('spaces.schema.convert.run.types', run.names.length);
    if (run.total === null) return `${type}: ${this.say('spaces.schema.convert.run.converting')}, ${this.say('spaces.schema.convert.run.counting')}`;
    return this.plural.text('brain.review.unconverted.running', run.total, { done: run.done, type });
  }
}
