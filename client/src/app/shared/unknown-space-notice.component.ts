import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';

/**
 * The line a page shows when a `?space=` named something it cannot open (`core/space-param.ts`): the id that was asked for, and what is
 * shown instead. A status region, so a screen reader hears it on arrival without the focus moving; it is text and not a colour change, so it
 * reads the same without sight.
 */
@Component({
  selector: 'app-unknown-space-notice',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe],
  template: `
    <div class="alert alert-warning" role="status" style="margin-bottom:12px;">
      {{ 'views.notice.unknownSpace' | transloco: { id: requested(), shown: shown() } }}
    </div>
  `,
})
export class UnknownSpaceNoticeComponent {
  /** The id the link asked for. */
  readonly requested = input.required<string>();
  /** The id the page opened instead. */
  readonly shown = input.required<string>();
}
