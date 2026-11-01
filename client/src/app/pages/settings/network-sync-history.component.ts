import { Component, inject, input, signal } from '@angular/core';
import { NgClass } from '@angular/common';
import { TranslocoPipe } from '@jsverse/transloco';
import { SyncCounts, SyncHistoryRecord } from '../../core/api.types';
import { ActiveLanguage } from '../../core/active-language';
import { formatCount } from '../../core/plural-text';
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
 *
 * A row's status is the server's word, shown in the reader's language (`sync.status.<word>`; a word this client does not know is shown as it came,
 * never as a missing key), and its counts are every family the server counts: the records are the sum of every count key but `files`, each read
 * `?? 0` (a row written before chrono, links and file metadata were counted lacks them), and `files` is the number of files moved, shown apart as a
 * plural (`Q-220`, `Q-265`, bundle-39).
 */
const KNOWN_STATUS = ['success', 'partial', 'failed', 'refused'];

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
    /* Only too-old peers: nothing failed and nothing synced, so it is neither the warning nor the error colour. */
    .status-refused { background: var(--bg-muted, var(--border-muted)); color: var(--text-muted); }
    .title-button { cursor: pointer; display: inline-flex; align-items: center; gap: 4px; background: none; border: 0; padding: 0; font: inherit; color: inherit; }
  `],
  template: `
    <div style="margin-bottom:16px;">
      <div class="section-title">
        <button type="button" class="title-button" [attr.aria-expanded]="open()" (click)="toggle()">
          {{ 'networks.network.syncHistory.title' | transloco }} <ph-icon [name]="open() ? 'caret-up' : 'caret-down'" [size]="12" />
        </button>
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
              <span class="status-badge" [ngClass]="'status-' + rec.status">@if (isKnownStatus(rec.status)) { {{ 'sync.status.' + rec.status | transloco }} } @else { {{ rec.status }} }</span>
              <span>
                ↓ {{ moved(rec.pulled) }}
                + {{ rec.pulled.files | plural:'networks.network.syncHistory.files' }} &nbsp;
                ↑ {{ moved(rec.pushed) }}
                + {{ rec.pushed.files | plural:'networks.network.syncHistory.files' }}
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
  private readonly language = inject(ActiveLanguage);

  readonly networkId = input.required<string>();

  readonly open = signal(false);
  readonly loading = signal(false);
  /** Null until the sync history failed to load — else "no sync history yet" claims the sync never ran. */
  readonly error = signal<string | null>(null);
  readonly records = signal<SyncHistoryRecord[]>([]);
  /** The one record whose errors are shown, or '' for none. */
  readonly expandedError = signal('');

  protected isKnownStatus(status: string): boolean { return KNOWN_STATUS.includes(status); }

  /** The records a cycle moved: every count key but `files` (files moved, shown apart), each `?? 0`, as the reader's language writes the number. */
  protected moved(counts: SyncCounts): string {
    let sum = 0;
    for (const [key, n] of Object.entries(counts)) if (key !== 'files' && typeof n === 'number' && Number.isFinite(n)) sum += n;
    return formatCount(this.language.language() || 'en', sum);
  }

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
