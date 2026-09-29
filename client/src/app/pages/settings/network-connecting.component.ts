import { Component, input } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { Network } from '../../core/api.types';

/**
 * "Connecting" on a club card (`Q-135`): members a peer introduced that this instance has not paired with yet, each
 * with the reason when an attempt failed.
 *
 * A club is a mesh — every member connects to every other, not only to whoever admitted it — and a pairing takes a
 * sync cycle, or fails when the other member cannot be reached. Without this list a member that is not connected yet
 * is simply missing from the card. Its own component because `networks.component.ts` is on the god-file ratchet.
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
            @if (i.lastError) { {{ 'networks.network.connecting.failed' | transloco }} <span class="connecting-reason">{{ i.lastError }}</span> }
            @else { {{ 'networks.network.connecting.pending' | transloco }} }
          </span>
        </div>
      }
    }
  `,
})
export class NetworkConnectingComponent {
  network = input.required<Network>();
}
