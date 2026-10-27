import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import type { Network } from '../../core/api.types';
import { NetworksApi } from '../../core/networks-api.service';
import { AuthApi } from '../../core/auth-api.service';
import { ToastService } from '../../core/toast.service';
import { cronIntervalMinutes } from '../../core/cron-interval';
import { refusalText } from '../../core/refusal-text';
import { NetworkRereadDialogComponent } from './network-reread-dialog.component';
import { isAdministeredView, rereadByMember } from './network-reread-view';

/** Spaces shown per member before "and N more": a member can owe every space of a large network. */
const CHIPS_SHOWN = 4;

/**
 * The "Re-read" section of a network card: what is still owed, and the control that starts a re-read (bundle-81, layout B).
 *
 * The control and the state of the last re-read share one section on purpose, so the operator sees where the previous one stands where they
 * would start the next. Each member that still owes one is listed with its spaces: a filled dot is the space being read now, a ring one still to
 * come, and the words travel with the dots for a screen reader. The section is for an instance administrator (the owed marker is served to
 * administrators only); it owns the dialog and the request, so the Networks page carries one tag and one handler for the whole capability.
 */
@Component({
  selector: 'app-network-reread-section',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, NetworkRereadDialogComponent],
  styles: [`
    :host { display: block; }
    .peer-owed { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; padding: 6px 0; border-bottom: 1px solid var(--border-muted); font-size: 13px; }
    .peer-owed:last-child { border-bottom: none; }
    .peer-owed .who { font-weight: 500; min-width: 140px; overflow-wrap: anywhere; }
    .mk { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; flex: none; box-sizing: border-box; }
    .mk.owed { border: 2px solid var(--warning); }
    .mk.catching { background: var(--info); border: 2px solid var(--info); }
    .hint { font-size: 12px; color: var(--text-muted); }
    .hint.block { margin: 0 0 6px; }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  `],
  template: `
    @if (administered()) {
      <div style="margin-bottom:16px;">
        <div class="section-title">{{ 'networks.reread.section' | transloco }}</div>
        @if (owed().length > 0) {
          <p class="hint block">{{ 'networks.reread.underway' | transloco }}</p>
          <div>
            @for (m of owed(); track m.instanceId) {
              <div class="peer-owed">
                <span class="who">{{ m.label }}</span>
                @for (chip of m.shown; track chip.space) {
                  <span class="badge" [class.badge-blue]="chip.state === 'catching'" [class.badge-gray]="chip.state === 'owed'">
                    <span class="mk" [class.owed]="chip.state === 'owed'" [class.catching]="chip.state === 'catching'" aria-hidden="true"></span>
                    <span class="sr-only">{{ (chip.state === 'catching' ? 'networks.reread.member.catchingUp' : 'networks.reread.member.owed') | transloco }}: </span>{{ chip.space }}
                  </span>
                }
                @if (m.more > 0) { <span class="hint" [attr.title]="m.moreSpaces">{{ 'networks.reread.more' | transloco: { more: m.more } }}</span> }
              </div>
            }
          </div>
        } @else {
          <p class="hint block">{{ 'networks.reread.none' | transloco }}</p>
        }
        <div style="margin-top:10px;">
          <button type="button" class="btn-danger btn btn-sm" [disabled]="noSpaces()" [attr.aria-describedby]="noSpaces() ? 'reread-nospaces-' + network().id : null" (click)="openDialog()">{{ 'networks.reread.button' | transloco }}</button>
        </div>
        @if (noSpaces()) {
          <div class="hint" style="margin-top:6px;" [id]="'reread-nospaces-' + network().id">{{ 'networks.reread.noSpaces' | transloco }}</div>
        }
        @if (open()) {
          <app-network-reread-dialog
            [networkName]="network().label"
            [spaces]="dialogSpaces()"
            [cycleMinutes]="cycleMinutes()"
            [schedule]="network().syncSchedule ?? ''"
            [alreadyOwed]="owed().length > 0"
            [mfaAsked]="mfaAsked()"
            [busy]="busy()"
            [error]="error()"
            (confirmed)="start($event.spaces)"
            (closed)="close()" />
        }
      </div>
    }
  `,
})
export class NetworkRereadSectionComponent {
  private readonly networksApi = inject(NetworksApi);
  private readonly authApi = inject(AuthApi);
  private readonly transloco = inject(TranslocoService);
  private readonly toast = inject(ToastService);

  readonly network = input.required<Network>();
  /** A re-read was started: the host reloads the network so the owed marker shows. */
  readonly started = output<void>();

  protected readonly open = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  /** Will the confirm ask for an MFA code? What the instance says when the dialog opens (`asked`); false while it is not known, so no prompt is promised that may not come. */
  protected readonly mfaAsked = signal(false);

  protected readonly administered = computed(() => isAdministeredView(this.network()));
  protected readonly noSpaces = computed(() => this.network().spaces.length === 0);
  /** Each space with what it holds; a count the view does not carry reads as empty, which still takes its cycle. */
  protected readonly dialogSpaces = computed(() => this.network().spaces.map(id => ({ id, records: this.network().spaceRecordCounts?.[id] ?? 0 })));
  protected readonly cycleMinutes = computed(() => cronIntervalMinutes(this.network().syncSchedule));

  /** The members that still owe a re-read, each with the spaces to show and how many more there are. */
  protected readonly owed = computed(() => {
    const net = this.network();
    return [...rereadByMember(net)].map(([instanceId, entries]) => ({
      instanceId,
      label: net.members.find(m => m.instanceId === instanceId)?.label ?? instanceId.slice(0, 8),
      shown: entries.slice(0, CHIPS_SHOWN),
      more: Math.max(0, entries.length - CHIPS_SHOWN),
      moreSpaces: entries.slice(CHIPS_SHOWN).map(e => e.space).join(', '),
    }));
  });

  protected openDialog(): void {
    this.mfaAsked.set(false);
    this.open.set(true);
    this.authApi.getMfaStatus().subscribe({ next: s => this.mfaAsked.set(s.asked === true), error: () => this.mfaAsked.set(false) });
  }

  protected close(): void {
    this.open.set(false);
    this.error.set('');
  }

  protected start(spaces: string[]): void {
    const net = this.network();
    this.busy.set(true);
    this.error.set('');
    // Every space chosen is the whole network, which the route reads as no `spaces` at all.
    this.networksApi.rereadNetwork(net.id, spaces.length === net.spaces.length ? undefined : spaces).subscribe({
      next: () => {
        this.busy.set(false);
        this.open.set(false);
        this.toast.success(this.transloco.translate('networks.reread.started'));
        this.started.emit();
      },
      error: (err) => {
        this.busy.set(false);
        this.error.set(refusalText(this.transloco, err, 'networks.reread.failed'));
      },
    });
  }
}
