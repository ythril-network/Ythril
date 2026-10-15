import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output, computed, inject, signal } from '@angular/core';
import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { pluralText } from '../core/plural-text';

/** A property the retype would remove, with the value it holds. */
export interface RetypeKey { key: string; value: unknown }

/** At most this many keys are listed; the rest are counted. */
export const RETYPE_LIST_MAX = 20;
/** A value longer than this is cut with an ellipsis: a pasted blob must not push the buttons off screen. */
const VALUE_MAX = 80;

/**
 * The confirmation before a type change removes properties (bundle-23, Q-93, R6-14).
 *
 * Under a strict schema a record whose NEW type does not declare a key it carries is refused. The retype flow offers the way
 * out - remove those keys with the change - and this is where the person agrees to it. The generic confirm shows ONE pre-wrapped
 * string in a 440px box with no height limit, default button words and a danger button measured at 3.35:1, none of which can carry
 * a list of keys and values. So this is its own dialog:
 *
 * - it LISTS the keys with their values, each value shortened in the DOM (shortening by CSS alone leaves the whole blob there for
 *   a screen reader), at most {@link RETYPE_LIST_MAX} of them with the rest counted, in a box that scrolls;
 * - it says the removal cannot be undone, because it cannot: the fields are unset;
 * - its confirm button names the EFFECT and the number ("Remove 3 properties"), the count of ALL of them, shown or not;
 * - the danger button is the global `.btn-danger`, red text on the card (5:1), not white on red (3.35:1).
 *
 * It is opened through `RetypeConfirmService` (a CDK dialog: role, `aria-modal`, focus trap, Escape and focus restore come with
 * it), and works as a plain component with `keys` as an input and `confirmed` / `cancelled` as outputs.
 */
@Component({
  selector: 'app-retype-confirm-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe],
  styles: [`
    .dialog {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 1.5rem;
      inline-size: 100%; max-inline-size: 520px;
      box-shadow: var(--shadow-sm, 0 4px 12px rgba(0,0,0,0.25));
    }
    h2 { margin: 0 0 0.6rem; font-size: 1.1rem; color: var(--text-primary); }
    p { margin: 0 0 0.8rem; color: var(--text-secondary); font-size: 0.9rem; line-height: 1.5; }
    .final { color: var(--text-primary); font-weight: 600; }
    .keys { list-style: none; margin: 0 0 0.8rem; padding: 0; max-height: 220px; overflow-y: auto; border: 1px solid var(--border); border-radius: 6px; }
    .keys li { display: flex; gap: 10px; padding: 5px 10px; border-block-end: 1px solid var(--border); font-size: 0.82rem; }
    .keys li:last-child { border-block-end: none; }
    .key { font-family: var(--font-mono, monospace); color: var(--text-primary); flex-shrink: 0; max-inline-size: 45%; overflow-wrap: anywhere; }
    .val { color: var(--text-muted); overflow-wrap: anywhere; min-inline-size: 0; }
    .more { color: var(--text-secondary); font-size: 0.85rem; margin: 0 0 0.8rem; }
    .actions { display: flex; gap: 10px; justify-content: flex-end; }
  `],
  template: `
    <div class="dialog" role="document">
      <h2 id="retype-confirm-title">{{ 'retype.title' | transloco }}</h2>
      <p>{{ 'retype.intro' | transloco }}</p>
      <ul class="keys">
        @for (k of shown(); track k.key) {
          <li><span class="key">{{ k.key }}</span><span class="val">{{ shorten(k.value) }}</span></li>
        }
      </ul>
      @if (rest() > 0) { <p class="more">{{ moreText() }}</p> }
      <p class="final">{{ 'retype.irreversible' | transloco }}</p>
      <div class="actions">
        <button type="button" class="btn btn-secondary btn-sm" (click)="cancel()">{{ 'common.cancel' | transloco }}</button>
        <button type="button" class="btn btn-danger btn-sm" (click)="confirm()">{{ confirmText() }}</button>
      </div>
    </div>
  `,
})
export class RetypeConfirmDialogComponent {
  private readonly transloco = inject(TranslocoService);
  private readonly data = inject<{ keys: RetypeKey[] } | null>(DIALOG_DATA, { optional: true });
  private readonly ref = inject<DialogRef<boolean> | null>(DialogRef, { optional: true });

  private readonly given = signal<RetypeKey[]>([]);

  /**
   * The properties that would be removed. Opened through the service, they arrive as the dialog's data instead.
   * Decorator inputs and outputs, not `input()` / `output()`: the specs load this component by a computed path, which leaves it
   * outside the TypeScript program the signal-input transform runs over.
   */
  @Input() set keys(value: RetypeKey[] | null | undefined) { this.given.set(value ?? []); }
  @Output() readonly confirmed = new EventEmitter<void>();
  @Output() readonly cancelled = new EventEmitter<void>();

  private readonly all = computed(() => (this.given().length ? this.given() : this.data?.keys ?? []));
  protected readonly shown = computed(() => this.all().slice(0, RETYPE_LIST_MAX));
  protected readonly rest = computed(() => Math.max(0, this.all().length - RETYPE_LIST_MAX));
  protected readonly confirmText = computed(() => pluralText(this.transloco, this.transloco.getActiveLang(), 'retype.confirm', this.all().length));
  protected readonly moreText = computed(() => pluralText(this.transloco, this.transloco.getActiveLang(), 'retype.more', this.rest()));

  /** A value as a person reads it: text as is, numbers and booleans plainly, an object as JSON, all cut at {@link VALUE_MAX}. */
  protected shorten(value: unknown): string {
    let text: string;
    if (typeof value === 'string') text = value;
    else if (value !== null && typeof value === 'object') { try { text = JSON.stringify(value); } catch { text = String(value); } }
    else text = String(value);
    if (text === '') return this.transloco.translate('retype.valueEmpty');
    return text.length > VALUE_MAX ? `${text.slice(0, VALUE_MAX)}…` : text;
  }

  protected confirm(): void {
    this.confirmed.emit();
    this.ref?.close(true);
  }

  protected cancel(): void {
    this.cancelled.emit();
    this.ref?.close(false);
  }
}
