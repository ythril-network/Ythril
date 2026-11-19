import { ChangeDetectionStrategy, Component, ElementRef, Injector, afterNextRender, inject, input, output, signal, viewChild } from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { holdUnsavedEdits } from '../../core/unsaved-edits';

/** Where a type rename's refusal sentences live (`.empty`, `.exists`, `.missing`). A prefix, not a key: the key is built from it. */
const TYPE_REFUSAL_PREFIX = 'spaces.schema.renameError';

/**
 * A declared type's NAME, or a property's KEY, and the affordance to change it.
 *
 * ## Why this is a component rather than four lines in the Schema tab
 *
 * Owner-reported, `B-18`: *"i created an entity with full property definitions but made a spelling
 * mistake in the entity name — had to redo all"*. A type's name is a map key, so the editor offered add
 * and delete and nothing between, and the only route from `Prsson` to `Person` was to rebuild every
 * property, every enum value, every pattern. Every knowledge type, not only entities.
 *
 * It lives here because the Schema tab is already one of the largest files in the client and the
 * god-file ceiling refused it — correctly. "The name, and editing it" is one question, and the tab is
 * better for holding one less.
 *
 * ## One control for a type's name and a property's key
 *
 * A property key is renamed the same way a type name is (a pencil, an inline field, a refusal that leaves it open), so the property
 * row uses this component with its own words: `labelKey` (+ `labelParams`) names the pencil and the field, `titleKey` the tooltip,
 * `errorKeyPrefix` the refusal sentences, `nameClass` the class of the name. Nothing else differs, and a second copy of the
 * interaction would drift from this one the first time either was fixed.
 *
 * ## "was <old name>"
 *
 * A rename waits for Save, and the pane says so: `was` is the name the thing is STORED under (null when it was not renamed), shown
 * after the pencil as a plain note. The host knows it; this component only says it.
 *
 * ## The interaction, and the decisions in it
 *
 * **Committed on blur or Enter, never per keystroke.** A rename re-keys the type map AND rewrites every
 * edge endpoint list that names the type, so doing it per keystroke would walk the whole schema on
 * every letter and leave a trail of one-character type names behind.
 *
 * **A refusal leaves the field OPEN**, holding what was typed. Closing it would discard the rename and
 * the message together, which is the shape of the bug this whole change is about.
 *
 * **The keyboard keeps its place.** Opening the field puts the cursor in it with the name selected; Enter and Escape return to the
 * pencil, so a keyboard user does not fall to the top of the page. Escape stops here: the dialog around this control also closes on
 * Escape, and the reader asked to undo a rename, not to leave the settings. A click on the pencil or in the field stays here too,
 * because a property row around it opens its detail card on click.
 */
@Component({
  selector: 'app-schema-type-name',
  standalone: true,
  imports: [TranslocoPipe, PhIconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  // `.sch-hint` and `.sch-msg` are the tab's classes, and the tab's styles do not reach into a child's template: the note and the
  // refusal are styled here, from the same tokens, so both themes read them.
  styles: [`
    .nm-text { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .sch-hint { font-size:11px; font-weight:400; color:var(--text-muted); margin-inline-start:6px; white-space:nowrap; }
    .sch-msg { font-size:12px; }
    .sch-msg.err { color:var(--error); }
  `],
  template: `
    @if (editing()) {
      <input #field class="dt-edit" type="text" [value]="draft" (input)="draft = $any($event.target).value"
        (keydown.enter)="onEnter()" (keydown.escape)="onEscape($event)" (blur)="commit()" (click)="$event.stopPropagation()"
        [attr.aria-label]="labelKey() | transloco: labelParams()" />
    } @else {
      <span class="nm-text" [class]="nameClass()">{{ name() }}</span>
      <button #pencil class="icon-btn" type="button" (click)="$event.stopPropagation(); start()"
        [attr.title]="titleKey() | transloco" [attr.aria-label]="labelKey() | transloco: labelParams()"><ph-icon name="pencil-simple" [size]="13"/></button>
    }
    @if (was(); as old) { <span class="sch-hint">{{ 'spaces.schema.was' | transloco: { name: old } }}</span> }
    @if (error()) { <span class="sch-msg err" role="alert" style="margin-inline-start:6px;">{{ error() }}</span> }
  `,
})
export class SchemaTypeNameComponent {
  private readonly transloco = inject(TranslocoService);
  private readonly injector = inject(Injector);

  readonly name = input.required<string>();
  /**
   * Performs the rename and returns an error KEY, or null. Passed in rather than injected: this
   * component knows what the interaction is, and the host knows what a rename means to its own state.
   */
  readonly rename = input.required<(to: string) => 'empty' | 'exists' | 'missing' | null>();

  /** The name this is stored under, when it has been renamed since: said as "was <name>" and nothing else. */
  readonly was = input<string | null>(null);
  /** The words naming the pencil and the field for assistive technology; `labelParams` fills its placeholders (a property says which). */
  readonly labelKey = input<string>('spaces.schema.renameType');
  readonly labelParams = input<Record<string, string>>({});
  /** The words of the pencil's tooltip. */
  readonly titleKey = input<string>('spaces.schema.renameType');
  /** Where the refusal sentences live: `<prefix>.empty`, `.exists`, `.missing`. */
  readonly errorKeyPrefix = input<string>(TYPE_REFUSAL_PREFIX);
  /** The class of the name beside the pencil. */
  readonly nameClass = input<string>('dt');

  /** Fired on a successful rename, so a host can follow the selection or mark itself dirty. */
  readonly renamed = output<string>();

  readonly editing = signal(false);
  readonly error = signal('');
  draft = '';

  private readonly field = viewChild<ElementRef<HTMLInputElement>>('field');
  private readonly pencil = viewChild<ElementRef<HTMLButtonElement>>('pencil');

  constructor() {
    // A name typed in the open rename field that differs from the type's own; a commit or a cancel closes the field.
    holdUnsavedEdits(() => this.editing() && this.draft !== this.name());
  }

  start(): void {
    this.draft = this.name();
    this.error.set('');
    this.editing.set(true);
    afterNextRender(() => { const input = this.field()?.nativeElement; input?.focus(); input?.select(); }, { injector: this.injector });
  }

  cancel(): void {
    this.error.set('');
    this.editing.set(false);
  }

  /** Enter: commit, and when the field closed, hand the keyboard back to the pencil. A refusal keeps the field and the cursor. */
  onEnter(): void {
    if (this.commit()) this.focusPencil();
  }

  /** Escape: revert and keep the keyboard here. It stops at this control, which sits in a dialog that closes on Escape. */
  onEscape(event: Event): void {
    event.stopPropagation();
    this.cancel();
    this.focusPencil();
  }

  /** Close the field with the typed name. True when it closed (renamed, or nothing to rename), false when refused or already closed. */
  commit(): boolean {
    if (!this.editing()) return false;       // already committed, or cancelled by Escape
    if (this.draft === this.name()) { this.cancel(); return true; }
    const err = this.rename()(this.draft);
    if (err) {
      this.error.set(this.transloco.translate(`${this.errorKeyPrefix()}.${err}`));
      return false;
    }
    this.error.set('');
    this.editing.set(false);
    this.renamed.emit(this.draft.trim());
    return true;
  }

  private focusPencil(): void {
    afterNextRender(() => this.pencil()?.nativeElement.focus(), { injector: this.injector });
  }
}
