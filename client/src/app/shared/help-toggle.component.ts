import { ChangeDetectionStrategy, Component, input, signal } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { HELP_TOGGLE_STYLES } from './help-toggle.styles';

let helpSeq = 0;

/**
 * The "?" toggle and the box it opens, closed by default (r4 §7.5): the button owns its `aria-expanded`, `aria-controls` and the box's
 * id and `hidden`, so no site can pair a button with the wrong box or forget to announce the state. The explanation is the content.
 *
 * The host is `display: contents`, so in a wrapping flex row the button sits beside its owner and the box (`flex-basis: 100%`,
 * `order: 1`) takes a line of its own beneath the row.
 */
@Component({
  selector: 'app-help-toggle',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe],
  styles: [HELP_TOGGLE_STYLES, `
    :host { display: contents; }
    /* order: 1 puts the box after everything else in its owner's row (a dialog head's Close), on its own line. */
    .explain { flex-basis: 100%; order: 1; font-size: 12px; color: var(--text-secondary); }
  `],
  template: `<button class="area-info" type="button" [attr.title]="label() | transloco" [attr.aria-label]="label() | transloco"
      [attr.aria-expanded]="open()" [attr.aria-controls]="boxId" [attr.data-testid]="testId() || null" (click)="open.set(!open())">?</button>
    <div class="explain" [id]="boxId" [hidden]="!open()"><ng-content /></div>`,
})
export class HelpToggleComponent {
  /** The key of the button's accessible name and title ("About this history"). */
  readonly label = input.required<string>();
  /** A test id for the button, where a spec names it. */
  readonly testId = input<string>('');
  protected readonly open = signal(false);
  protected readonly boxId = `help-box-${++helpSeq}`;
}
