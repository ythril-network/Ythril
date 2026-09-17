import { ChangeDetectionStrategy, Component, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { PhIconComponent } from '../../shared/ph-icon.component';

/**
 * A declared type's NAME, and the affordance to change it.
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
 * ## The interaction, and the two decisions in it
 *
 * **Committed on blur or Enter, never per keystroke.** A rename re-keys the type map AND rewrites every
 * edge endpoint list that names the type, so doing it per keystroke would walk the whole schema on
 * every letter and leave a trail of one-character type names behind.
 *
 * **A refusal leaves the field OPEN**, holding what was typed. Closing it would discard the rename and
 * the message together, which is the shape of the bug this whole change is about.
 */
@Component({
  selector: 'app-schema-type-name',
  standalone: true,
  imports: [FormsModule, TranslocoPipe, PhIconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (editing()) {
      <input class="dt-edit" type="text" [(ngModel)]="draft"
        (keydown.enter)="commit()" (keydown.escape)="cancel()" (blur)="commit()"
        [attr.aria-label]="'spaces.schema.renameType' | transloco" />
    } @else {
      <span class="dt">{{ name() }}</span>
      <button class="icon-btn" type="button" (click)="start()"
        [attr.title]="'spaces.schema.renameType' | transloco"><ph-icon name="pencil-simple" [size]="13"/></button>
    }
    @if (error()) { <span class="sch-msg error" style="margin-left:6px;">{{ error() }}</span> }
  `,
})
export class SchemaTypeNameComponent {
  private readonly transloco = inject(TranslocoService);

  readonly name = input.required<string>();
  /**
   * Performs the rename and returns an error KEY, or null. Passed in rather than injected: this
   * component knows what the interaction is, and the host knows what a rename means to its own state.
   */
  readonly rename = input.required<(to: string) => 'empty' | 'exists' | 'missing' | null>();

  /** Fired on a successful rename, so a host can follow the selection or mark itself dirty. */
  readonly renamed = output<string>();

  readonly editing = signal(false);
  readonly error = signal('');
  draft = '';

  start(): void {
    this.draft = this.name();
    this.error.set('');
    this.editing.set(true);
  }

  cancel(): void {
    this.error.set('');
    this.editing.set(false);
  }

  commit(): void {
    if (!this.editing()) return;          // already committed, or cancelled by Escape
    if (this.draft === this.name()) { this.cancel(); return; }
    const err = this.rename()(this.draft);
    if (err) {
      this.error.set(this.transloco.translate(`spaces.schema.renameError.${err}`));
      return;
    }
    this.error.set('');
    this.editing.set(false);
    this.renamed.emit(this.draft.trim());
  }
}
