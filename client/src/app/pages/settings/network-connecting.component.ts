import { Component, inject, input, output, signal } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { Network } from '../../core/api.types';
import { NetworksApi } from '../../core/networks-api.service';
import { ToastService } from '../../core/toast.service';

/**
 * "Connecting" on a club card (`Q-135`): members a peer introduced that this instance has not paired with yet, each
 * with the reason when an attempt failed.
 *
 * A club is a mesh — every member connects to every other, not only to whoever admitted it — and a pairing takes a
 * sync cycle, or fails when the other member cannot be reached. Without this list a member that is not connected yet
 * is simply missing from the card. Its own component because `networks.component.ts` is on the god-file ratchet.
 *
 * On a closed or democratic network a member another member's list only proposed waits for the operator's OK
 * (`Q-154`): a member of a voted network votes, so one member's word must not let it in. Accept is here.
 */
@Component({
  selector: 'app-network-connecting',
  standalone: true,
  imports: [TranslocoPipe],
  template: `
    @if (network().introductions?.length) {
      <div class="section-title">{{ 'networks.network.connecting.title' | transloco }}</div>
      @for (i of network().introductions; track i.instanceId) {
        <div class="connecting-row" style="padding:4px 0; font-size:13px;">
          <span>{{ i.label }}</span>
          <span style="color:var(--text-muted);"> ·
            @if (i.needsApproval) { {{ 'networks.network.connecting.waitingOk' | transloco }} }
            @else if (i.lastError) { {{ 'networks.network.connecting.failed' | transloco }} <span class="connecting-reason">{{ i.lastError }}</span> }
            @else { {{ 'networks.network.connecting.pending' | transloco }} }
          </span>
          @if (i.needsApproval) {
            <button class="btn btn-sm btn-secondary connecting-accept" type="button" style="margin-left:8px;"
                    [disabled]="accepting() === i.instanceId" (click)="accept(i.instanceId)">{{ 'networks.network.connecting.accept' | transloco }}</button>
          }
        </div>
      }
    }
  `,
})
export class NetworkConnectingComponent {
  network = input.required<Network>();
  /** Emitted after an Accept succeeded, so the page reloads the network. */
  accepted = output<void>();
  accepting = signal<string | null>(null);
  private api = inject(NetworksApi);
  private toast = inject(ToastService);

  accept(instanceId: string): void {
    this.accepting.set(instanceId);
    this.api.acceptIntroduction(this.network().id, instanceId).subscribe({
      next: () => { this.accepting.set(null); this.accepted.emit(); },
      error: (e) => { this.accepting.set(null); this.toast.error(e?.error?.error ?? 'Accept failed'); },
    });
  }
}
