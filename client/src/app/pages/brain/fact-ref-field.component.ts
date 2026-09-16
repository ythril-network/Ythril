import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { EntityRefPicker } from './entity-ref-picker.service';
import { BRAIN_CHIP_STYLES } from './brain-form.styles';

/** A memory-linking target: the create/drawer form object whose `memoryIds` this field mutates. */
export interface MemoryIdTarget { memoryIds: string[]; }

/**
 * The memory-reference field: linked-memory chips + an inline title typeahead, in one element.
 *
 * The sibling of `app-entity-ref-field` (slice 3-refactor). The identical "chips + `.mem-pick` search
 * dropdown" block (slice 3c) was hand-written at the chrono create form and the detail drawer's chrono
 * section; drift between the two is the visual/UX snag the composite refactor exists to kill, so it
 * lives once here. Label-less by design: the caller supplies its own `<label>` / `.drawer-label`.
 *
 * Dumb + OnPush: it owns no state. `target` is the caller's form object; adding/removing mutates
 * `target.memoryIds` by reference and the title cache via the shared `EntityRefPicker`, exactly as the
 * inline copies did — `addMemoryRef`/`removeMemoryRef`/`memoryRefTitle` are unchanged. The picker's
 * `memPickQuery`/`memPickResults` are a single shared set (only one memory field is ever visible at a
 * time — create form OR drawer), preserving the pre-extraction behaviour.
 *
 * NOT converted: file-meta's memory picker uses the separate `fm*` picker signals; it folds into the
 * slice-4d File Meta rebuild rather than switching here.
 */
@Component({
  selector: 'app-memory-ref-field',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PhIconComponent, TranslocoPipe],
  styles: [BRAIN_CHIP_STYLES],
  template: `
    @if (target().memoryIds.length) {
      <div class="entity-multi">
        @for (id of target().memoryIds; track id) {
          <span class="chip" [title]="id"><span class="chip-name">{{ picker.memoryRefTitle(id) }}</span><button type="button" class="chip-remove" (mousedown)="picker.removeMemoryRef(target(), id)"><ph-icon name="x" [size]="12"/></button></span>
        }
      </div>
    }
    <div class="mem-pick">
      <input type="search" [value]="picker.memPickQuery()" (input)="picker.onMemPickInput($any($event.target).value)" [placeholder]="'brain.chrono.form.searchFacts' | transloco" [attr.aria-label]="'brain.chrono.form.searchFacts' | transloco" />
      @if (picker.memPickResults().length) {
        <div class="mem-pick-menu">
          @for (mem of picker.memPickResults(); track mem._id) {
            <button type="button" class="mem-pick-item" (mousedown)="picker.addMemoryRef(target(), mem)">{{ mem.fact.slice(0, 90) }}{{ mem.fact.length > 90 ? '…' : '' }}</button>
          }
        </div>
      }
    </div>
  `,
})
export class FactRefFieldComponent {
  readonly picker = inject(EntityRefPicker);
  /** The caller's form object; adding/removing edits its `memoryIds`. */
  readonly target = input.required<MemoryIdTarget>();
}
