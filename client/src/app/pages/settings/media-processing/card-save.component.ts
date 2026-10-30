import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { MediaProcessingStateService, type ModelCardId } from './media-processing-state.service';

/**
 * One model card's Save button — shown only while that card has an unsaved change.
 *
 * ## Why this is a component and not five lines in the tab
 *
 * It was five lines in the tab, ten times over, differing only in the card id. Adding the three document
 * cards took the file 27 lines past the freeze in `no-new-god-files.test.js`, which is that gate working:
 * the answer to a file that keeps growing is to stop putting things in it. Ten copies of one rule is also
 * the defect the y-flows convention `convention-find-every-instance` names (one rule, several copies), arriving as markup.
 *
 * ## `display: contents`, deliberately
 *
 * The button lives inside the card's footer row, which is a flex container that orders Test, Verify and Save
 * by CSS — `.testrow .card-save { order: 2; margin-left: auto }` is what pins Save to the far end. A custom
 * element is `display: inline` by default, so wrapping the button in one would have made it a single inline
 * flex item and the ordering would have silently stopped applying. `display: contents` removes this element's
 * own box, so the button is the flex item it always was and every existing rule keeps matching.
 *
 * ## The state service is required here, unlike on the card
 *
 * `app-model-provider-card` injects it optionally because it is rendered in specs that provide no page. This
 * is only ever rendered inside the page, and a Save with nowhere to save to is not a thing worth rendering.
 */
@Component({
  selector: 'app-card-save',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe],
  styles: [`
    /* See the note above on why the host has no box of its own. */
    :host { display: contents; }
    /* The ordering rule LIVES HERE, and that is not a stylistic preference.
       It was .testrow .card-save in the tab, and emulated view encapsulation scopes a component's styles to
       elements written in that component's own template. The button moved into this one, so the tab's rule
       stopped matching it and Save rendered between Verify and the hint instead of at the far end of the
       row -- the class was still on the element, the CSS was still in the file, and nothing errored. */
    .card-save { order: 2; margin-left: auto; }
  `],
  template: `
    @if (s.cardDirty(card())) {
      <button class="btn btn-sm btn-primary card-save" type="button"
        [disabled]="s.saving()" (click)="s.saveCard(card())">
        {{ (s.saving() ? 'common.saving' : 'common.save') | transloco }}
      </button>
    }
  `,
})
export class CardSaveComponent {
  readonly s = inject(MediaProcessingStateService);
  card = input.required<ModelCardId>();
}
