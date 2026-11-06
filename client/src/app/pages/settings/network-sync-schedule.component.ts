import { Component, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { Network } from '../../core/api.types';
import { refusalText } from '../../core/refusal-text';
import { NetworksApi } from '../../core/networks-api.service';
import { ToastService } from '../../core/toast.service';
import { holdUnsavedEdits } from '../../core/unsaved-edits';

/**
 * A network card's sync schedule: the cron box and its Save. It owns the typed schedule until Save sends it, and holds it as a draft,
 * so leaving the page or reloading with a typed schedule asks first (Q-701).
 *
 * Its own component because `networks.component.ts` is on the size ratchet: holding the draft there took the page over its limit, so
 * the schedule moved out along its seam (one input, one save, one draft) instead of the limit moving up. The host renders it inside the
 * card's sync row (`display: contents`), beside the page's own Sync now button, so the row reads as before.
 */
@Component({
  selector: 'app-network-sync-schedule',
  standalone: true,
  imports: [FormsModule, TranslocoPipe],
  host: { style: 'display:contents' },
  template: `
    <input
      type="text"
      [ngModel]="draft() ?? network().syncSchedule ?? ''"
      (ngModelChange)="draft.set($event)"
      [name]="'sched-' + network().id"
      [placeholder]="'networks.network.sync.schedulePlaceholder' | transloco"
      [attr.aria-label]="'networks.network.sync.scheduleAriaLabel' | transloco"
      style="flex:1; min-width:220px;"
    />
    <button class="btn-secondary btn btn-sm" [disabled]="saving()" (click)="save()">
      @if (saving()) { <span class="spinner" style="width:11px;height:11px;border-width:2px;"></span> }
      {{ 'networks.network.sync.saveScheduleButton' | transloco }}
    </button>
  `,
})
export class NetworkSyncScheduleComponent {
  private networksApi = inject(NetworksApi);
  private toast = inject(ToastService);
  private transloco = inject(TranslocoService);

  network = input.required<Network>();
  /** The schedule the server accepted ('' clears it); the page writes it into its list of networks. */
  saved = output<string>();

  /** The typed schedule, or null while nothing was typed since the last save. */
  readonly draft = signal<string | null>(null);
  readonly saving = signal(false);

  constructor() {
    // A typed schedule that differs from the network's saved one. Typing the saved value back is not a draft.
    holdUnsavedEdits(() => { const d = this.draft(); return d !== null && d !== (this.network().syncSchedule ?? ''); });
  }

  save(): void {
    const schedule = this.draft() ?? this.network().syncSchedule ?? '';
    this.saving.set(true);
    this.networksApi.updateNetworkSchedule(this.network().id, schedule).subscribe({
      next: () => { this.saving.set(false); this.draft.set(null); this.saved.emit(schedule); },
      error: (err) => {
        this.saving.set(false);
        this.toast.error(refusalText(this.transloco, err, 'networks.error.saveScheduleFailed'));
      },
    });
  }
}
