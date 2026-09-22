import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { EntityRefPicker } from './entity-ref-picker.service';
import { BRAIN_CHIP_STYLES } from './brain-form.styles';

/** A chrono-linking target: the form object whose `linkChronos` this field mutates. */
export interface ChronoIdTarget { linkChronos: string[]; }

/**
 * The chrono-reference field: linked-chrono chips + an inline title typeahead, in one element.
 *
 * The third sibling of `app-entity-ref-field` / `app-fact-ref-field` (slice 4d). Only file-meta links
 * chrono entries, so this has a single consumer today — but it replaces file-meta's old click-to-open
 * `fm*` chrono flyout with the same always-inline shape the other two fields use, which is the visual-
 * consistency win the composite refactor exists for, and it mirrors the memory field one-for-one.
 *
 * Dumb + OnPush: it owns no state. `target` is the caller's form object; adding/removing mutates
 * `target.linkChronos` by reference and the title cache via the shared `EntityRefPicker`. Search is
 * server-side (`listChrono(?search=)`), unlike the old `fm*` picker's client-side filter.
 */
@Component({
  selector: 'app-chrono-ref-field',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PhIconComponent, TranslocoPipe],
  styles: [BRAIN_CHIP_STYLES],
  template: `
    @if (target().linkChronos.length) {
      <div class="entity-multi">
        @for (id of target().linkChronos; track id) {
          <span class="chip" [title]="id"><span class="chip-name">{{ picker.chronoRefTitle(id) }}</span><button type="button" class="chip-remove" (mousedown)="picker.removeChronoRef(target(), id)"><ph-icon name="x" [size]="12"/></button></span>
        }
      </div>
    }
    <div class="mem-pick">
      <input type="search" [value]="picker.chronoPickQuery()" (input)="picker.onChronoPickInput($any($event.target).value)" [placeholder]="'brain.fileMeta.picker.searchChrono' | transloco" [attr.aria-label]="'brain.fileMeta.picker.searchChrono' | transloco" />
      @if (picker.chronoPickResults().length) {
        <div class="mem-pick-menu">
          @for (c of picker.chronoPickResults(); track c._id) {
            <button type="button" class="mem-pick-item" (mousedown)="picker.addChronoRef(target(), c)">{{ c.title.slice(0, 90) }}{{ c.title.length > 90 ? '…' : '' }}</button>
          }
        </div>
      }
    </div>
  `,
})
export class ChronoRefFieldComponent {
  readonly picker = inject(EntityRefPicker);
  /** The caller's form object; adding/removing edits its `linkChronos`. */
  readonly target = input.required<ChronoIdTarget>();
}
