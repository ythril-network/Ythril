import { Component, inject, input, output } from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { Network } from '../../core/api.types';
import { NetworksApi } from '../../core/networks-api.service';
import { ToastService } from '../../core/toast.service';

/**
 * "Announced, waiting for you" on a network card (S-9): the spaces an upstream announced that this instance did not
 * add on its own, each with why, and Accept / Dismiss.
 *
 * An announcement is a proposal: a space is added by itself only when the token that joined or created the network
 * here could have joined it, so a same-named local space, a joiner that lacked the right, and a network with no
 * recorded joiner all land here. Accept optionally takes a local id to carry the space under. Its own component
 * because `networks.component.ts` is on the god-file ratchet.
 */
@Component({
  selector: 'app-network-pending-spaces',
  standalone: true,
  imports: [TranslocoPipe],
  template: `
    @if (network().pendingSpaces?.length) {
      <div style="margin-top:16px;">
        <div class="section-title">{{ 'networks.network.pending.title' | transloco }}</div>
        <p style="font-size:12px; color:var(--text-muted); margin:4px 0 8px;">{{ 'networks.network.pending.hint' | transloco }}</p>
        @for (p of network().pendingSpaces; track p.networkId) {
          <div class="vote-row">
            <span style="flex:1; min-width:0;">
              <strong>{{ p.networkId }}</strong>
              <span style="display:block; font-size:11px; color:var(--text-muted);">{{ p.why }}</span>
            </span>
            <input class="input" style="width:140px;" [placeholder]="'networks.network.pending.mapTo' | transloco"
                   [attr.aria-label]="'networks.network.pending.mapTo' | transloco"
                   [value]="mapTo[p.networkId] ?? ''"
                   (input)="mapTo[p.networkId] = $any($event.target).value" />
            <button class="btn-primary btn btn-sm" [disabled]="resolving[p.networkId]" (click)="resolve(p.networkId, 'accept')">
              @if (resolving[p.networkId]) { <span class="spinner" style="width:11px;height:11px;border-width:2px;"></span> }
              {{ 'networks.network.pending.accept' | transloco }}
            </button>
            <button class="btn btn-sm" [disabled]="resolving[p.networkId]" (click)="resolve(p.networkId, 'dismiss')">{{ 'networks.network.pending.dismiss' | transloco }}</button>
          </div>
        }
      </div>
    }
  `,
})
export class NetworkPendingSpacesComponent {
  private networksApi = inject(NetworksApi);
  private toast = inject(ToastService);
  private transloco = inject(TranslocoService);

  network = input.required<Network>();
  /** The network as the server answered after an accept or dismiss, for the page to put in place of its copy. */
  resolved = output<Network>();

  /** In-flight accept/dismiss per space, and the optional local id typed for an accept. */
  resolving: Record<string, boolean> = {};
  mapTo: Record<string, string> = {};

  resolve(spaceId: string, action: 'accept' | 'dismiss'): void {
    const mapTo = action === 'accept' ? (this.mapTo[spaceId] ?? '').trim() : '';
    this.resolving[spaceId] = true;
    this.networksApi.resolvePendingSpace(this.network().id, { spaceId, action, ...(mapTo ? { mapTo } : {}) }).subscribe({
      next: (updated) => {
        delete this.resolving[spaceId];
        delete this.mapTo[spaceId];
        this.toast.success(this.transloco.translate(action === 'accept' ? 'networks.network.pending.accepted' : 'networks.network.pending.dismissed', { space: spaceId }));
        this.resolved.emit(updated);
      },
      error: (err) => {
        delete this.resolving[spaceId];
        this.toast.error(err.error?.error ?? this.transloco.translate('networks.error.pendingFailed'));
      },
    });
  }
}
