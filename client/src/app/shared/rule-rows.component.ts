import { AfterViewChecked, ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslocoPipe } from '@jsverse/transloco';
import { KNOWLEDGE_TYPES, type KnowledgeType } from '../core/api.types';
import { PhIconComponent } from './ph-icon.component';
import { RULE_LIMITS, isValidRuleName } from './rule-limits';

/** A rule as the editor holds it: a row of a keyed list. A space rule also names the kinds it applies to. */
export interface RuleRowModel { name: string; rule: string; message: string; kinds?: KnowledgeType[] }

/** The rule a refused save named, and the sentence its row says. */
export interface RuleRowRefusal { name: string; field: 'rule' | 'message'; text: string }

const KIND_KEYS: Record<KnowledgeType, string> = {
  entity: 'spaces.schema.tab.entities', fact: 'spaces.schema.tab.facts', edge: 'spaces.schema.tab.edges', chrono: 'spaces.schema.tab.chrono',
};

/**
 * The rules of one type, or the space's, as a list of disclosure rows (F-46, R6-14).
 *
 * ONE component for every place a rule is shown, because a rule row was about to be written four times (a type's rules in the
 * Schema tab, the space's rules there, a linked type's read-only rules, and the schema library's editor) and each would have
 * dropped a different half of the guard: the limit counters, the read-only state, the inline error a refused save opens.
 *
 * ## What a row is
 *
 * A disclosure BUTTON (name and message, `aria-expanded`) that holds nothing interactive; the remove button is its sibling, so every
 * control is reachable by keyboard. Open, a row shows the rule text in a monospace textarea (a rule is a multi-line expression), the
 * message, a counter on each against the server's limit (`RULE_LIMITS`, held equal to the server's by a gate), and for a space rule the
 * kinds it applies to as checkboxes (none ticked: every kind).
 *
 * ## What a refusal does to it
 *
 * \`refusal\` names the rule a refused save pointed at: its row opens, says the sentence in an element with \`role="alert"\` that its
 * control is \`aria-describedby\` and \`aria-invalid\` for, and focus moves into the control the issue named. A new object each time
 * is a new request, even for the same row.
 *
 * It edits the rows IN PLACE (the draft belongs to its host, which decides when it is saved) and says \`changed\`.
 */
@Component({
  selector: 'app-rule-rows',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, TranslocoPipe, PhIconComponent],
  styles: [`
    :host { display: block; }
    .rule-row { border: 1px solid var(--border); border-radius: 6px; margin-block-end: 6px; background: var(--bg-card); }
    .rule-head { display: flex; align-items: center; gap: 4px; }
    .rule-toggle { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: none; border: none; color: var(--text-primary); cursor: pointer; text-align: start; font: inherit; }
    .rule-toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    .rule-name { font-family: var(--font-mono, ui-monospace, monospace); font-size: 12.5px; flex-shrink: 0; }
    .rule-summary { color: var(--text-muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .rule-body { padding: 4px 10px 10px; display: grid; gap: 8px; }
    .rule-body label { font-size: 12px; color: var(--text-secondary); display: block; margin-block-end: 2px; }
    .rule-text { inline-size: 100%; min-block-size: 64px; font-family: var(--font-mono, ui-monospace, monospace); font-size: 12.5px; resize: vertical; box-sizing: border-box; }
    .rule-message { inline-size: 100%; box-sizing: border-box; }
    .counter { font-size: 11px; color: var(--text-muted); }
    .counter.over { color: var(--error); }
    .kinds { display: flex; flex-wrap: wrap; gap: 4px 14px; border: none; margin: 0; padding: 0; }
    .kinds legend { font-size: 12px; color: var(--text-secondary); padding: 0; }
    .kind { display: inline-flex; align-items: center; gap: 4px; font-size: 12.5px; color: var(--text-primary); }
    .rule-err { margin: 0; font-size: 12px; color: var(--error); }
    [aria-invalid="true"] { border-color: var(--error); }
    .add-row { display: flex; gap: 6px; align-items: center; margin-block-start: 6px; }
    .add-row input { flex: 1; max-inline-size: 280px; font-family: var(--font-mono, ui-monospace, monospace); }
    .hint { font-size: 11.5px; color: var(--text-muted); margin-block-start: 4px; }
    .full { color: var(--warning); }
    @media (forced-colors: active) { [aria-invalid="true"] { border-width: 2px; } .counter.over { text-decoration: underline; } }
  `],
  template: `
    @for (r of rules(); track $index; let i = $index) {
      <div class="rule-row" [attr.data-testid]="space() ? 'space-rule-row' : 'rule-row'" [attr.data-rule-name]="r.name">
        <div class="rule-head">
          <button type="button" class="rule-toggle" data-testid="rule-toggle"
            [attr.aria-expanded]="isOpen(r.name)" [attr.aria-controls]="bodyId(i)" (click)="toggle(r.name)">
            <ph-icon [name]="isOpen(r.name) ? 'caret-down' : 'caret-right'" [size]="12" />
            <span class="rule-name">{{ r.name }}</span>
            <span class="rule-summary">{{ r.message }}</span>
          </button>
          @if (!readOnly()) {
            <button type="button" class="icon-btn danger" (click)="remove(i)"
              [attr.title]="'rules.remove' | transloco: { name: r.name }" [attr.aria-label]="'rules.remove' | transloco: { name: r.name }">
              <ph-icon name="x" [size]="14" />
            </button>
          }
        </div>
        @if (isOpen(r.name)) {
          <div class="rule-body" [id]="bodyId(i)">
            <div>
              <label [for]="ruleId(i)">{{ 'rules.field.rule' | transloco }}</label>
              <textarea class="rule-text" data-testid="rule-text" [id]="ruleId(i)" rows="3" spellcheck="false"
                [ngModel]="r.rule" (ngModelChange)="r.rule = $event; changed.emit()" [ngModelOptions]="{ standalone: true }"
                [readOnly]="readOnly()"
                [attr.aria-invalid]="invalidFor(r.name) === 'rule' ? 'true' : null" [attr.aria-describedby]="invalidFor(r.name) === 'rule' ? errId(i) : null"></textarea>
              <span class="counter" [class.over]="r.rule.length > limits.ruleMax" data-testid="rule-text-counter"
                [attr.data-used]="r.rule.length" [attr.data-limit]="limits.ruleMax">{{ r.rule.length }} / {{ limits.ruleMax }}</span>
            </div>
            <div>
              <label [for]="messageId(i)">{{ 'rules.field.message' | transloco }}</label>
              <input type="text" class="rule-message" data-testid="rule-message" [id]="messageId(i)"
                [ngModel]="r.message" (ngModelChange)="r.message = $event; changed.emit()" [ngModelOptions]="{ standalone: true }"
                [readOnly]="readOnly()"
                [attr.aria-invalid]="invalidFor(r.name) === 'message' ? 'true' : null" [attr.aria-describedby]="invalidFor(r.name) === 'message' ? errId(i) : null" />
              <span class="counter" [class.over]="r.message.length > limits.messageMax" data-testid="rule-message-counter"
                [attr.data-used]="r.message.length" [attr.data-limit]="limits.messageMax">{{ r.message.length }} / {{ limits.messageMax }}</span>
            </div>
            @if (space()) {
              <fieldset class="kinds">
                <legend>{{ 'rules.kinds.legend' | transloco }}</legend>
                @for (kt of KINDS; track kt) {
                  <label class="kind">
                    <input type="checkbox" data-testid="space-rule-kind" [value]="kt" [checked]="hasKind(r, kt)" [disabled]="readOnly()" (change)="toggleKind(r, kt)" />
                    {{ kindKey(kt) | transloco }}
                  </label>
                }
              </fieldset>
              <span class="counter">{{ 'rules.kinds.hint' | transloco }}</span>
            }
            @if (refusal(); as refused) {
              @if (refused.name === r.name) {
                <p class="rule-err" role="alert" [id]="errId(i)">{{ refused.text }}</p>
              }
            }
          </div>
        }
      </div>
    }
    @if (!readOnly()) {
      <div class="add-row">
        <input type="text" [ngModel]="newName()" (ngModelChange)="newName.set($event)" [ngModelOptions]="{ standalone: true }"
          [placeholder]="'rules.add.placeholder' | transloco" [attr.aria-label]="'rules.add.button' | transloco"
          [attr.maxlength]="limits.nameMax" (keydown.enter)="$event.preventDefault(); add()" />
        <button type="button" class="btn btn-secondary btn-sm" [disabled]="!!addProblem()" (click)="add()">{{ 'rules.add.button' | transloco }}</button>
      </div>
      @if (newName().trim() && addProblem(); as problem) { <div class="hint">{{ problem | transloco }}</div> }
      <div class="hint" [class.full]="rules().length >= max()">{{ 'rules.count' | transloco: { count: rules().length, max: max() } }}</div>
    }
  `,
})
export class RuleRowsComponent implements AfterViewChecked {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** The rows, edited in place. */
  readonly rules = input.required<RuleRowModel[]>();
  /** A space rule: its row also carries the kinds it applies to. */
  readonly space = input(false);
  /** Shown, not editable: a linked type's rules (they belong to the library entry), or a token without the right to change them. */
  readonly readOnly = input(false);
  /** The most rules this list may hold (per type, or per space). */
  readonly max = input<number>(RULE_LIMITS.perType);
  /** Unique on the page, for the ids a row's controls and its error are wired by. */
  readonly idPrefix = input('rules');
  /** The rule a refused save named: its row opens, says the sentence, and takes focus. */
  readonly refusal = input<RuleRowRefusal | null>(null);
  readonly changed = output<void>();

  protected readonly limits = RULE_LIMITS;
  protected readonly KINDS = KNOWLEDGE_TYPES;
  protected readonly newName = signal('');
  private readonly openNames = signal<ReadonlySet<string>>(new Set());

  /** Why the typed name cannot be added, as a translation key; null when it can. */
  protected readonly addProblem = computed<string | null>(() => {
    const name = this.newName().trim();
    if (!name) return 'rules.add.nameEmpty';
    if (!isValidRuleName(name)) return 'rules.add.nameInvalid';
    if (this.rules().some(r => r.name === name)) return 'rules.add.nameTaken';
    if (this.rules().length >= this.max()) return 'rules.add.full';
    return null;
  });

  constructor() {
    effect(() => {
      const refused = this.refusal();
      if (!refused) return;
      untracked(() => {
        if (!this.rules().some(r => r.name === refused.name)) return;
        this.openNames.update(set => new Set(set).add(refused.name));
        this.pendingFocus = refused;
      });
    });
  }

  /** Focus waits for the row to exist: it is opened by the same change that asked for the focus. */
  private pendingFocus: RuleRowRefusal | null = null;

  ngAfterViewChecked(): void {
    const refused = this.pendingFocus;
    if (refused && this.focusField(refused)) this.pendingFocus = null;
  }

  isOpen(name: string): boolean { return this.openNames().has(name); }

  toggle(name: string): void {
    this.openNames.update(set => {
      const next = new Set(set);
      if (!next.delete(name)) next.add(name);
      return next;
    });
  }

  /** The control a refused save named (the rule text, or the message), or the row's first control. */
  private focusField(refused: RuleRowRefusal): boolean {
    // By comparison, not by selector: a name is whatever the file or the operator typed, and escaping it is one more thing to get wrong.
    const row = Array.from(this.host.nativeElement.querySelectorAll('[data-rule-name]')).find(r => r.getAttribute('data-rule-name') === refused.name);
    const control = row?.querySelector<HTMLElement>(refused.field === 'message' ? '[data-testid="rule-message"]' : '[data-testid="rule-text"]');
    control?.focus();
    return !!control;
  }

  /** Which text of this rule the refusal is about ('rule' for the expression), or '' when it is about another rule. */
  protected invalidFor(name: string): '' | 'rule' | 'message' {
    const refused = this.refusal();
    return refused && refused.name === name ? refused.field : '';
  }

  protected hasKind(r: RuleRowModel, kt: KnowledgeType): boolean { return r.kinds?.includes(kt) ?? false; }

  protected toggleKind(r: RuleRowModel, kt: KnowledgeType): void {
    const kinds = r.kinds ?? [];
    r.kinds = kinds.includes(kt) ? kinds.filter(k => k !== kt) : [...kinds, kt];
    this.changed.emit();
  }

  protected kindKey(kt: KnowledgeType): string { return KIND_KEYS[kt]; }

  add(): void {
    if (this.addProblem()) return;
    const name = this.newName().trim();
    this.rules().push({ name, rule: '', message: '', ...(this.space() ? { kinds: [] } : {}) });
    this.openNames.update(set => new Set(set).add(name));
    this.newName.set('');
    this.changed.emit();
  }

  remove(i: number): void {
    const [gone] = this.rules().splice(i, 1);
    if (gone) this.openNames.update(set => { const next = new Set(set); next.delete(gone.name); return next; });
    this.changed.emit();
  }

  protected bodyId(i: number): string { return `${this.idPrefix()}-body-${i}`; }
  protected ruleId(i: number): string { return `${this.idPrefix()}-rule-${i}`; }
  protected messageId(i: number): string { return `${this.idPrefix()}-message-${i}`; }
  protected errId(i: number): string { return `${this.idPrefix()}-err-${i}`; }
}
