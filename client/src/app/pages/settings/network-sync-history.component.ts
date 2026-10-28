import { Component, inject, input, signal } from '@angular/core';
import { NgClass } from '@angular/common';
import { TranslocoPipe } from '@jsverse/transloco';
import { SyncHistoryRecord } from '../../core/api.types';
import { NetworksApi } from '../../core/networks-api.service';
import { httpErrorReason } from '../../core/http-error';
import { PluralPipe } from '../../core/plural.pipe';
import { InstantComponent } from '../../shared/instant.component';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { ErrorStateComponent } from '../../shared/error-state.component';

/**
 * "Sync history" on a network card: the last cycles with this network, what each pulled and pushed, and the errors of
 * one that did not complete. Closed until its title is clicked, and loaded then, for its one network.
 *
 * Its own component because `networks.component.ts` is on the god-file ratchet (`Q-621`), and because the panel was
 * one concern spread through the page: its markup, its styles, five fields of state and four methods, plus a redraw
 * of the whole network list after every load that existed only to show this panel's rows.
 *
 * A load that failed says so with a retry. Showing "no sync history yet" instead would claim the sync never ran.
 */
@Component({
  selector: 'app-network-sync-history',
  standalone: true,
  imports: [NgClass, TranslocoPipe, PluralPipe, InstantComponent, PhIconComponent, ErrorStateComponent],
  styles: [`
    .history-row {
      display: grid;
      grid-template-columns: 140px 70px 1fr auto;
      gap: 8px;
      align-items: center;
      padding: 6px 0;
      border-bottom: 1px solid var(--border-muted);
      font-size: 12px;
    }
    .history-row > span:nth-child(3) { min-width: 0; } /* let the counts cell shrink instead of overflowing */
    /* Narrow iframe: drop the fixed grid and let the cells wrap. */
    @media (max-width: 680px) {
      .history-row { display: flex; flex-wrap: wrap; }
    }

    .history-row:last-child { border-bottom: none; }

    .status-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 11px;
      font-weight: 600;
    }

    .status-success { background: var(--status-success-bg); color: var(--status-success-fg); }
    .status-partial { background: var(--status-warning-bg); color: var(--status-warning-fg); }
    .status-failed  { background: var(--status-error-bg);   color: var(--status-error-fg); }
  `],
  template: `
    <div style="margin-bottom:16px;">
      <div class="section-title" style="cursor:pointer; display:inline-flex; align-items:center; gap:4px;" (click)="toggle()">
        {{ 'networks.network.syncHistory.title' | transloco }} <ph-icon [name]="open() ? 'caret-up' : 'caret-down'" [size]="12" />
      </div>
      @if (open()) {
        @if (loading()) {
          <div style="padding:8px 0; color:var(--text-muted); font-size:12px;">{{ 'networks.network.syncHistory.loading' | transloco }}</div>
        } @else if (error() !== null) {
          <app-error-state [message]="'networks.network.syncHistory.loadError' | transloco"
                           [reason]="error() ?? ''" [icon]="28" (retry)="retry()" />
        } @else if (records().length === 0) {
          <div style="padding:8px 0; color:var(--text-muted); font-size:12px;">{{ 'networks.network.syncHistory.empty' | transloco }}</div>
        } @else {
          @for (rec of records(); track rec._id) {
            <div class="history-row">
              <span style="color:var(--text-muted);"><app-instant [value]="rec.completedAt" variant="datetime"/></span>
              <span class="status-badge" [ngClass]="'status-' + rec.status">{{ rec.status }}</span>
              <span>
                ↓ {{ rec.pulled.facts + rec.pulled.entities + rec.pulled.edges }}
                + {{ rec.pulled.files }} files &nbsp;
                ↑ {{ rec.pushed.facts + rec.pushed.entities + rec.pushed.edges }}
                + {{ rec.pushed.files }} files
              </span>
              @if (rec.errors?.length) {
                <button class="btn-ghost btn btn-sm" style="font-size:11px;"
                  (click)="toggleErrors(rec._id)">
                  @if (expandedError() === rec._id) { {{ 'networks.network.syncHistory.hideErrors' | transloco }} } @else { {{ rec.errors!.length | plural:'networks.network.syncHistory.errorCount' }} }
                </button>
              }
            </div>
            @if (expandedError() === rec._id && rec.errors) {
              <div style="padding:4px 0 8px 8px; font-size:11px; color:var(--error);">
                @for (e of rec.errors; track e) {
                  <div>{{ e }}</div>
                }
              </div>
            }
          }
        }
      }
    </div>
  `,
})
export class NetworkSyncHistoryComponent {
  private readonly networksApi = inject(NetworksApi);

  readonly networkId = input.required<string>();

  readonly open = signal(false);
  readonly loading = signal(false);
  /** Null until the sync history failed to load — else "no sync history yet" claims the sync never ran. */
  readonly error = signal<string | null>(null);
  readonly records = signal<SyncHistoryRecord[]>([]);
  /** The one record whose errors are shown, or '' for none. */
  readonly expandedError = signal('');

  toggle(): void {
    this.open.update(o => !o);
    if (this.open()) this.load();
  }

  retry(): void { this.load(); }

  /** After a manual sync the page asks for the new cycle; a closed panel loads when it is opened instead. */
  refreshIfOpen(): void {
    if (this.open()) this.load();
  }

  toggleErrors(recordId: string): void {
    this.expandedError.update(v => v === recordId ? '' : recordId);
  }

  private load(): void {
    this.loading.set(true);
    this.error.set(null);
    this.networksApi.getSyncHistory(this.networkId()).subscribe({
      next: ({ history }) => { this.records.set(history); this.loading.set(false); },
      error: (err) => { this.error.set(httpErrorReason(err)); this.loading.set(false); },
    });
  }
}
