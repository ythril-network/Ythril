import { Injectable, inject } from '@angular/core';
import { Dialog } from '@angular/cdk/dialog';
import { firstValueFrom } from 'rxjs';
import { RetypeConfirmDialogComponent, type RetypeKey } from '../shared/retype-confirm-dialog.component';

/**
 * Asks whether a type change may remove the properties the new type does not declare (bundle-23, Q-93).
 *
 * A CDK dialog, so role, `aria-modal`, the focus trap, Escape and focus restore come with it. The first tabbable element is
 * Cancel: for an action that deletes data the safe answer is the default one. Anything but an explicit confirm - Cancel,
 * Escape, a click on the backdrop - resolves false: a dismissal is never a yes.
 */
@Injectable({ providedIn: 'root' })
export class RetypeConfirmService {
  private readonly dialog = inject(Dialog);

  /** Resolves true only when the person confirmed removing `keys` (the properties, without the `properties.` prefix, and their values). */
  async confirm(keys: RetypeKey[]): Promise<boolean> {
    const ref = this.dialog.open<boolean>(RetypeConfirmDialogComponent, {
      data: { keys },
      ariaModal: true,
      ariaLabelledBy: 'retype-confirm-title',
      autoFocus: 'first-tabbable',
      restoreFocus: true,
      hasBackdrop: true,
    });
    return (await firstValueFrom(ref.closed)) === true;
  }
}
