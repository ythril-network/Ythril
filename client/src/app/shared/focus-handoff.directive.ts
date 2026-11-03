import { Directive, ElementRef, OnDestroy, OnInit, inject, input } from '@angular/core';

/**
 * Keeps the keyboard on the page when the control that has it is replaced by a transient box and then by its answer (Q-209).
 *
 * The graph's Retry button is removed the moment it is pressed (the loading overlay takes its place), and the browser drops the focus to
 * <body>: a keyboard user pressing Enter on Retry lands nowhere and must tab from the top of the page. This directive, set on the box that
 * replaces the control, does what a sighted user's eye does:
 *
 *  - when the box appears while the element that had the focus is being removed by that same change, the box takes the focus (it is
 *    `tabindex="-1"`, so it can hold it without joining the tab order);
 *  - when the box goes and the focus is on <body> (nobody moved it meanwhile), the focus goes to the first element the selector finds in
 *    the box's parent: the error's Retry again, or the canvas on success.
 *
 * It never takes the focus from an element that stays on the page (the depth slider that started a load keeps it), and never overrides a
 * choice the user made while the box showed.
 *
 * What it prevents: focus falling to <body> when the control that held it is replaced by a loading state.
 */
@Directive({ selector: '[appFocusHandoff]', standalone: true })
export class FocusHandoffDirective implements OnInit, OnDestroy {
  /** Where the focus goes when the box is gone: the first match inside the box's parent. */
  readonly appFocusHandoff = input<string>('');

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private zone: HTMLElement | null = null;
  /** The control that had the focus is the one this box replaced. */
  private replaced = false;
  /**
   * Read when the directive is created, not in ngOnInit: the box is created while the change that shows it is still being applied and the
   * control it replaces is still on the page; by ngOnInit that control has been removed and the focus has already fallen to <body>.
   */
  private readonly before = this.host.ownerDocument.activeElement;

  ngOnInit(): void {
    const before = this.before;
    this.replaced = !!before && before !== this.host.ownerDocument.body && !before.isConnected;
    setTimeout(() => {
      this.zone = this.host.parentElement;
      if (this.replaced && this.host.isConnected) this.host.focus();
    });
  }

  ngOnDestroy(): void {
    if (!this.replaced) return;
    const doc = this.host.ownerDocument;
    const zone = this.zone ?? doc.body;
    const selector = this.appFocusHandoff();
    setTimeout(() => {
      if (doc.activeElement && doc.activeElement !== doc.body) return;
      zone.querySelector<HTMLElement>(selector)?.focus();
    });
  }
}
