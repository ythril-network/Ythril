import { Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { Network, Space } from '../../core/api.types';
import { NetworksApi } from '../../core/networks-api.service';
import { ToastService } from '../../core/toast.service';

/**
 * "Add a space" on a network card (`F-38.3`): pick one of this instance's spaces the network does not carry yet.
 *
 * Shown only where the server accepts it: the publisher of a pub/sub network, the root of a tree, a club's organiser,
 * and any member of a closed or democratic network — where it opens a vote rather than adding at once (`F-38.4`).
 * Offering it anywhere else would be a button that always fails. Its own component because `networks.component.ts` is on the god-file ratchet.
 *
 * The hint says the change is ADDITIVE on the receiving side, which is the question an operator asks before
 * pressing it: the instances below get the space created, or merged into one they already have, and nothing
 * there is overwritten or deleted.
 */
@Component({
  selector: 'app-network-add-space',
  standalone: true,
  imports: [FormsModule, TranslocoPipe],
  template: `
    @if (governs() && candidates().length) {
      <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap; margin-top:8px;">
        <select class="input" style="max-width:220px;" [(ngModel)]="picked" [attr.aria-label]="'networks.network.spaces.addLabel' | transloco">
          <option value="" disabled>{{ 'networks.network.spaces.addLabel' | transloco }}</option>
          @for (s of candidates(); track s.id) { <option [value]="s.id">{{ s.label || s.id }}</option> }
        </select>
        <button class="btn-secondary btn btn-sm" [disabled]="!picked || adding()" (click)="add()">
          @if (adding()) { <span class="spinner" style="width:11px;height:11px;border-width:2px;"></span> }
          {{ 'networks.network.spaces.addButton' | transloco }}
        </button>
      </div>
      <p style="font-size:12px; color:var(--text-muted); margin:6px 0 0;">{{ (voted() ? 'networks.network.spaces.addHintVote' : 'networks.network.spaces.addHint') | transloco }}</p>
    }
  `,
})
export class NetworkAddSpaceComponent {
  private networksApi = inject(NetworksApi);
  private toast = inject(ToastService);
  private transloco = inject(TranslocoService);

  network = input.required<Network>();
  spaces = input<Space[]>([]);
  added = output<Network>();

  adding = signal(false);
  picked = '';

  /** The server accepts the add only from these positions; see `ADD_SPACE_POSITION` in `network-acts.ts`. */
  governs = computed(() => ['publisher', 'root', 'organiser'].includes(this.network().myRole?.role ?? '') || this.voted());
  /** Closed and democratic networks decide an added space by vote, so the add opens a round (F-38.4). */
  voted = computed(() => ['closed', 'democratic'].includes(this.network().type));
  candidates = computed(() => this.spaces().filter(s => !this.network().spaces.includes(s.id)));

  add(): void {
    if (!this.picked) return;
    this.adding.set(true);
    this.networksApi.addNetworkSpace(this.network().id, this.picked).subscribe({
      next: (res) => {
        this.adding.set(false); this.picked = '';
        if ('status' in res && res.status === 'vote_pending') this.toast.success(this.transloco.translate('networks.network.spaces.voteOpened'));
        this.added.emit(this.network());
      },
      error: (err) => {
        this.adding.set(false);
        this.toast.error(err.error?.error ?? this.transloco.translate('networks.error.addSpaceFailed'));
      },
    });
  }
}
