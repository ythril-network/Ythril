import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { EntitySearchComponent } from '../../shared/entity-search.component';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { EntityRefPicker, EntityIdTarget } from './entity-ref-picker.service';
import { BRAIN_CHIP_STYLES } from './brain-form.styles';

/**
 * The entity-chip field: linked-entity chips + an inline entity autocomplete, in one element.
 *
 * Extracted (slice 3-refactor) from the ~6 hand-written copies of this exact block — memories/chrono
 * create + inline-edit forms and the detail drawer (memory + chrono). Each copy was chips + an inline
 * `app-entity-search` wired to the shared `EntityRefPicker`; drift between them is what the visual/UX
 * lens keeps flagging, so it lives once here. Label-less by design: the caller supplies its own
 * `<label>` / `.drawer-label` and field wrapper, so the component drops into both the form and the
 * drawer contexts unchanged.
 *
 * Dumb + OnPush: it owns no state. `target` is the caller's form object (any `{ linkEntities: string }`);
 * picking mutates `target.linkEntities` and the shared name cache via the picker, exactly as the inline
 * copies did — `pickEntity`/`removeEntityId`/`entityChips` are unchanged, so behaviour is preserved.
 */
@Component({
  selector: 'app-entity-ref-field',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [EntitySearchComponent, PhIconComponent],
  styles: [BRAIN_CHIP_STYLES],
  template: `
    @if (picker.entityChips(target().linkEntities).length) {
      <div class="entity-multi">
        @for (chip of picker.entityChips(target().linkEntities); track chip.id) {
          <span class="chip" [title]="chip.id"><span class="chip-name">{{ chip.name }}</span><button type="button" class="chip-remove" (mousedown)="picker.removeEntityId(target(), chip.id)"><ph-icon name="x" [size]="12"/></button></span>
        }
      </div>
    }
    <app-entity-search mode="picker" [spaceId]="spaceId()" placeholder="common.searchEntitiesPlaceholder" (selected)="picker.pickEntity($event, target())" />
  `,
})
export class EntityRefFieldComponent {
  readonly picker = inject(EntityRefPicker);
  /** The caller's form object; picking appends to its `linkEntities`. */
  readonly target = input.required<EntityIdTarget>();
  readonly spaceId = input.required<string>();
}
