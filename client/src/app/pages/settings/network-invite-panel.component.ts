import { Component, inject, input, signal } from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { NetworksApi } from '../../core/networks-api.service';
import { ToastService } from '../../core/toast.service';
import { InviteBundle, inviteTextOf } from '../../core/invite-code';
import { refusalText } from '../../core/refusal-text';

/**
 * The invite panel on a network card: generate one, show it, copy it.
 *
 * ## Why it is its own component
 *
 * `networks.component.ts` is on the god-file ratchet, and its entry there says the growth is STRUCTURAL:
 * every new per-network fact lands in the same markup because that is where the markup is. `F-18` gave the
 * invite three more facts — a one-line code, a fallback for an instance that has no code, and a warning
 * that the code is a credential — and the honest answer to a ratchet is to take something out rather than
 * raise the number.
 *
 * What moved is self-contained: one API call, one clipboard write, and the copy that goes with them.
 *
 * ## The warning is not decoration
 *
 * The code carries the handshake credential, so anyone holding it can complete the join. It looks like
 * gibberish, which is exactly what makes people paste it into a group channel. It sits INSIDE the block
 * with the code rather than beside it, because a caption under a wall of base64 is not read.
 */
@Component({
  selector: 'app-network-invite-panel',
  standalone: true,
  imports: [TranslocoPipe],
  template: `
    <div style="margin-bottom:16px; margin-top:12px;">
      <div class="section-title">{{ 'networks.network.invite.title' | transloco }}</div>
      <p style="font-size:12px; color:var(--text-muted); margin:0 0 8px;">
        @if (networkType() === 'pubsub') {
          {{ 'networks.network.invite.pubsubDescription' | transloco }}
        } @else {
          {{ 'networks.network.invite.description' | transloco }}
        }
      </p>
      @if (bundle(); as b) {
        <div class="code-block" style="margin-bottom:8px; font-size:11px; white-space:pre-wrap; word-break:break-all;">{{ inviteText(b) }}<br><br>{{ 'networks.network.invite.secretWarning' | transloco }}</div>
        <button class="btn-ghost btn btn-sm" (click)="copy()">
          {{ copied() ? ('common.copied' | transloco) : ('networks.network.invite.copyBundle' | transloco) }}
        </button>
      } @else {
        <button class="btn-secondary btn btn-sm" [disabled]="generating()" (click)="generate()">
          @if (generating()) { <span class="spinner" style="width:11px;height:11px;border-width:2px;"></span> }
          {{ 'networks.network.invite.generateButton' | transloco }}
        </button>
      }
    </div>
  `,
})
export class NetworkInvitePanelComponent {
  private networksApi = inject(NetworksApi);
  private toast = inject(ToastService);
  private transloco = inject(TranslocoService);

  networkId = input.required<string>();
  networkType = input<string>('');

  bundle = signal<InviteBundle | null>(null);
  generating = signal(false);
  copied = signal(false);

  /** One line when the instance produced a code, the JSON bundle when it did not. */
  inviteText = inviteTextOf;

  generate(): void {
    this.generating.set(true);
    this.networksApi.generateInvite(this.networkId()).subscribe({
      next: (bundle) => { this.generating.set(false); this.bundle.set(bundle); },
      error: (err) => {
        this.generating.set(false);
        this.toast.error(refusalText(this.transloco, err, 'networks.error.generateInviteFailed'));
      },
    });
  }

  copy(): void {
    const b = this.bundle();
    if (!b) return;
    navigator.clipboard.writeText(this.inviteText(b)).then(() => {
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    });
  }
}
