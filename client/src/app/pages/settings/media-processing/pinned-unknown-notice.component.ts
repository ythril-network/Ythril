import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { PluralText } from '../../../core/plural-text.service';

/**
 * "These pinned field names matched nothing, so they are not locked."
 *
 * ## Why this is worth a component
 *
 * `YTHRIL_PINNED_FIELDS` lets an operator fix a field at whatever it resolves to, including nothing. Its one
 * dangerous failure is a typo: the operator believes a control is locked and it is not. The server reports those
 * entries as `pinnedUnknown` rather than only logging them, and **this screen is where somebody checking their pin
 * actually looks** — a warning in the server log is the one place they are not reading.
 *
 * ## Why it is a separate file rather than eleven lines in the Models tab
 *
 * `no-new-god-files.test.js` refused it inside `models-tab.component.ts`, which is frozen at its current size, and
 * its reason is the right one: *"the failure mode of a god-file is not its size on any given day — it is that every
 * change lands in the same place because that is where the code already is."* That tab is already 678 lines of
 * provider cards; a notice about environment pins has no reason to live inside it.
 *
 * It also earns the separation on its own terms — it has one input, no state, and nothing to do with any provider
 * card, so a reader looking for why an unrecognised pin is surfaced finds one file that says so.
 *
 * Rendered ABOVE the cards by its host. Below them it would be found only by somebody who had already scrolled
 * past the control they thought was locked, which is the wrong conclusion this exists to prevent.
 */
@Component({
  selector: 'app-pinned-unknown-notice',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe],
  template: `
    @if (paths().length) {
      <div class="alert alert-warning">
        <div><strong>{{ titleText() }}</strong></div>
        <div data-mono style="font-size:12px; margin-top:4px;">{{ paths().join(', ') }}</div>
        <div style="font-size:12px; margin-top:4px;">{{ 'mediaProcessing.pinnedUnknown.body' | transloco }}</div>
      </div>
    }
  `,
})
export class PinnedUnknownNoticeComponent {
  private readonly plural = inject(PluralText);

  /** "N pinned field names were not recognised ...", in the plural form the reader's language uses for N. */
  protected titleText(): string {
    return this.plural.text('mediaProcessing.pinnedUnknown.title', this.paths().length);
  }

  /** The unrecognised entries, verbatim from the config response. Empty renders nothing at all. */
  paths = input.required<string[]>();
}
