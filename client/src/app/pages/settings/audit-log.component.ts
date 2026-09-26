import { ChangeDetectionStrategy, Component, inject, signal, computed, OnInit, OnDestroy, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { type AuditLogEntry, type AuditLogParams, type Space } from '../../core/api.types';
import { AdminApi } from '../../core/admin-api.service';
import { SpacesApi } from '../../core/spaces-api.service';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { StatusPillComponent, type StatusVariant } from '../../shared/status-pill.component';
import { RelativeTimeComponent } from '../../shared/relative-time.component';
import { ModalDirective } from '../../shared/modal.directive';
import { SummaryStripComponent, type SummaryItem } from '../../shared/summary-strip.component';
import { HscrollTopDirective } from '../../shared/hscroll-top.directive';

@Component({
  selector: 'app-audit-log',
  standalone: true,
  // OnPush (P5): every rendered value is a signal set immutably (`entries`, `total`,
  // `selectedEntry`, `serverLogLines` via `.update([...])`, etc.), and the filter fields are
  // ngModel two-way bindings whose input events mark the view dirty. So OnPush re-checks exactly
  // when state changes and skips the whole-tree sweep otherwise — this page renders up to a
  // 100-row table plus a live-streaming server log, both in the CD hot path.
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, TranslocoPipe, StatusPillComponent, RelativeTimeComponent, SummaryStripComponent, ModalDirective, HscrollTopDirective],
  styles: [`
    .audit-toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: flex-end;
      margin-bottom: 16px;
    }
    .audit-toolbar label {
      display: flex;
      flex-direction: column;
      gap: 3px;
      font-size: 12px;
      color: var(--text-secondary);
    }
    /* Geometry comes from the ONE input rule in styles.scss — this block restated it almost exactly, which is
       precisely how a shared control drifts: every copy is defensible on its own and no two agree. */
    .audit-toolbar button {
      padding: 6px 14px;
      font-size: 13px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border);
      background: var(--bg-elevated);
      color: var(--text-primary);
      cursor: pointer;
      font-family: var(--font);
    }
    .audit-toolbar button:hover { background: var(--bg-surface); }

    .audit-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    .audit-table th {
      text-align: left;
      padding: 8px 10px;
      border-bottom: 2px solid var(--border);
      font-weight: 600;
      color: var(--text-secondary);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .audit-table td {
      padding: 7px 10px;
      border-bottom: 1px solid var(--border);
      color: var(--text-primary);
      vertical-align: top;
    }
    .audit-table tr:hover { background: var(--bg-elevated); }

    .mono { font-family: var(--font-mono, monospace); font-size: 12px; }
    .num { font-variant-numeric: tabular-nums; }

    /* Rows worth noticing get a leading severity stripe (semantic colour, not the accent) so an auth
       failure or a 5xx reads at a glance without relying on the status pill alone. */
    .audit-table tr.row-warn td:first-child { box-shadow: inset 3px 0 0 var(--warning); }
    .audit-table tr.row-error td:first-child { box-shadow: inset 3px 0 0 var(--error); }
    .audit-table tr.row-error td:nth-child(3) { color: var(--error); font-weight: 600; }

    /* Structured detail panel — a labelled field grid + a collapsible raw-JSON block. */
    .detail-grid {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 6px 16px;
      align-items: baseline;
      margin: 4px 0 14px;
      font-size: 13px;
    }
    .detail-grid dt {
      color: var(--text-muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .detail-grid dd { margin: 0; color: var(--text-primary); word-break: break-word; }
    /* What the request changed. */
    .changes-block { margin-top: 12px; }
    .changes-block h4 { margin: 0 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); }
    .changes-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .changes-table th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--text-muted); padding: 2px 8px 4px 0; font-weight: 600; }
    .changes-table td { padding: 3px 8px 3px 0; vertical-align: top; word-break: break-word; }
    .changes-table .val-from { color: var(--text-muted); }
    .changes-table .val-to { color: var(--text-primary); font-weight: 550; }
    .changes-none { margin: 12px 0 0; font-size: 11px; color: var(--text-muted); font-style: italic; }

    .detail-raw { margin-top: 8px; }
    .detail-raw summary { cursor: pointer; font-size: 12px; color: var(--text-secondary); }

    .pagination {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-top: 12px;
      font-size: 13px;
      color: var(--text-secondary);
    }
    .pagination button {
      padding: 5px 12px;
      font-size: 13px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border);
      background: var(--bg-elevated);
      color: var(--text-primary);
      cursor: pointer;
      font-family: var(--font);
    }
    .pagination button:disabled { opacity: 0.4; cursor: default; }
    .pagination button:not(:disabled):hover { background: var(--bg-surface); }
    .pagination-btns { display: flex; gap: 8px; }

    .empty { text-align: center; padding: 40px; color: var(--text-muted); }

    .detail-overlay {
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: var(--bg-scrim);
      display: flex; align-items: center; justify-content: center;
      z-index: 100;
    }
    .detail-panel {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: 24px;
      max-width: 600px;
      width: 90%;
      max-height: 80vh;
      overflow-y: auto;
    }
    .detail-panel h3 { margin-top: 0; }
    .detail-panel pre {
      background: var(--bg-primary);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 12px;
      font-size: 12px;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .detail-close {
      margin-top: 12px;
      padding: 6px 16px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border);
      background: var(--bg-elevated);
      color: var(--text-primary);
      cursor: pointer;
      font-family: var(--font);
    }

    /* flex-wrap because "Export all matching (NDJSON)" is 195px and cannot shrink: at 420px these three
       pushed the page pane 72px past its box, so the whole audit log slid sideways. */
    .export-btns { display: flex; gap: 8px; flex-wrap: wrap; }
    /* No button geometry here. These three carried NO class and re-created .btn-sm's metrics locally; they use the
       class now, so the small-button size is defined in one place. */

    .error-msg { color: var(--error); margin: 12px 0; }
  `],
  template: `
    <h2>{{ 'auditLog.title' | transloco }}</h2>

    <!-- Sub-tabs -->
    <div style="display:flex; gap:8px; margin-bottom:16px;">
      <button class="btn btn-sm" [class.btn-primary]="activeLogTab() === 'audit'" [class.btn-secondary]="activeLogTab() !== 'audit'" (click)="activeLogTab.set('audit')">{{ 'auditLog.tab.audit' | transloco }}</button>
      <button class="btn btn-sm" [class.btn-primary]="activeLogTab() === 'server'" [class.btn-secondary]="activeLogTab() !== 'server'" (click)="activeLogTab.set('server')">{{ 'auditLog.tab.server' | transloco }}</button>
    </div>

    @if (activeLogTab() === 'server') {
      <div style="display:flex; gap:8px; align-items:center; margin-bottom:12px;">
        <button class="btn btn-sm btn-secondary" (click)="loadServerLogs()">{{ 'auditLog.server.refreshButton' | transloco }}</button>
        <span style="flex:1;"></span>
        <span style="font-size:12px; color:var(--text-muted);">{{ serverLogLines().length }} {{ 'auditLog.server.lines' | transloco }}@if (serverLogStreaming()) { &nbsp;· {{ 'auditLog.server.live' | transloco }} }</span>
      </div>

      @if (serverLogLoading()) {
        <div class="empty" style="padding:24px;">
          <span class="spinner"></span> {{ 'common.loading' | transloco }}
        </div>
      } @else if (serverLogLines().length === 0) {
        <div class="empty" style="padding:40px;">
          <div style="font-size:24px;">📋</div>
          <h3>{{ 'auditLog.server.empty.title' | transloco }}</h3>
          <p style="color:var(--text-muted);">{{ 'auditLog.server.empty.body' | transloco }}</p>
        </div>
      } @else {
        <div style="background:var(--bg-primary); border:1px solid var(--border); border-radius:var(--radius-sm); overflow:auto; max-height:70vh; font-family:var(--font-mono); font-size:12px; line-height:1.6; padding:12px; white-space:pre-wrap; word-break:break-all;" #serverLogContainer>
          @for (line of serverLogLines(); track $index) {
            <div [style.color]="serverLogColor(line)">{{ line }}</div>
          }
        </div>
      }
    }

    @if (activeLogTab() === 'audit') {

    <!-- Filters -->
    <div class="audit-toolbar">
      <label>
        {{ 'auditLog.filter.after' | transloco }}
        <input type="datetime-local" [(ngModel)]="filterAfter" />
      </label>
      <label>
        {{ 'auditLog.filter.before' | transloco }}
        <input type="datetime-local" [(ngModel)]="filterBefore" />
      </label>
      <label>
        {{ 'auditLog.filter.operation' | transloco }}
        <select [(ngModel)]="filterOperation">
          <option value="">{{ 'common.all' | transloco }}</option>
          @for (op of operations; track op) {
            <option [value]="op">{{ op }}</option>
          }
        </select>
      </label>
      <label>
        {{ 'auditLog.filter.space' | transloco }}
        <select [(ngModel)]="filterSpaceId">
          <option value="">{{ 'common.all' | transloco }}</option>
          @for (s of spaces(); track s.id) {
            <option [value]="s.id">{{ s.label }} ({{ s.id }})</option>
          }
        </select>
      </label>
      <label>
        {{ 'auditLog.filter.status' | transloco }}
        <select [(ngModel)]="filterStatus">
          <option value="">{{ 'common.all' | transloco }}</option>
          @for (s of statusOptions(); track s) {
            <option [value]="s">{{ s }}</option>
          }
        </select>
      </label>
      <label>
        {{ 'auditLog.filter.ip' | transloco }}
        <input type="text" [(ngModel)]="filterIp" [placeholder]="'auditLog.filter.ipPlaceholder' | transloco" style="width:120px" />
      </label>
      <button (click)="applyFilters()">{{ 'auditLog.filter.searchButton' | transloco }}</button>
      <button (click)="resetFilters()">{{ 'auditLog.filter.resetButton' | transloco }}</button>
    </div>

    <!-- Export -->
    <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:8px;">
      <div class="export-btns">
        <button class="btn btn-sm btn-secondary" type="button" (click)="exportJson()">{{ 'auditLog.exportJson' | transloco }}</button>
        <button class="btn btn-sm btn-secondary" type="button" (click)="exportCsv()">{{ 'auditLog.exportCsv' | transloco }}</button>
        <button class="btn btn-sm btn-primary" type="button" (click)="exportAll()" [disabled]="exportingAll()" [attr.title]="'auditLog.exportAllTitle' | transloco">
          {{ (exportingAll() ? 'auditLog.exportAllBusy' : 'auditLog.exportAll') | transloco }}
        </button>
      </div>
      @if (retentionDays() > 0) {
        <span style="font-size:12px; color:var(--text-muted);">{{ 'auditLog.retention' | transloco: { days: retentionDays() } }}</span>
      }
    </div>

    @if (exportError()) {
      <div class="alert alert-error" style="margin-bottom:8px;">{{ exportError() }}</div>
    }

    @if (error()) {
      <p class="error-msg">{{ error() }}</p>
    }

    @if (!loading() && entries().length > 0) {
      <app-summary-strip [items]="summaryItems()" />
    }

    @if (loading()) {
      <p>{{ 'common.loading' | transloco }}</p>
    } @else if (entries().length === 0) {
      <div class="empty">{{ 'auditLog.empty' | transloco }}</div>
    } @else {
      <div class="table-wrapper" hscrollTop>
      <table class="audit-table">
        <thead>
          <tr>
            <th>{{ 'auditLog.table.timestamp' | transloco }}</th>
            <th>{{ 'auditLog.table.tokenUser' | transloco }}</th>
            <th>{{ 'auditLog.table.operation' | transloco }}</th>
            <th>{{ 'auditLog.table.space' | transloco }}</th>
            <th>{{ 'auditLog.table.status' | transloco }}</th>
            <th>{{ 'auditLog.table.ip' | transloco }}</th>
            <th>{{ 'auditLog.table.duration' | transloco }}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          @for (e of entries(); track e._id) {
            <tr [class]="rowClass(e)">
              <td><app-relative-time [value]="e.timestamp" /></td>
              <td>{{ e.tokenLabel ?? e.oidcSubject ?? '—' }}</td>
              <td class="mono">{{ e.operation }}</td>
              <td>{{ e.spaceId ?? '—' }}</td>
              <td><app-status-pill [variant]="statusVariant(e.status)">{{ e.status }}</app-status-pill></td>
              <td class="mono">{{ e.ip }}</td>
              <td class="num">{{ e.durationMs }}ms</td>
              <td><button class="detail-close" style="padding:2px 8px;font-size:11px" (click)="showDetail(e)">{{ 'auditLog.table.detailButton' | transloco }}</button></td>
            </tr>
          }
        </tbody>
      </table>
      </div>

      <div class="pagination">
        <span>{{ 'auditLog.pagination.total' | transloco: { count: total() } }}</span>
        <div class="pagination-btns">
          <button [disabled]="offset() === 0" (click)="prevPage()">{{ 'auditLog.pagination.prev' | transloco }}</button>
          <button [disabled]="!hasMore()" (click)="nextPage()">{{ 'auditLog.pagination.next' | transloco }}</button>
        </div>
      </div>
    }

    <!-- Detail panel -->
    @if (selectedEntry(); as e) {
      <div class="detail-overlay">
        <div class="detail-panel" [appModal]="'auditLog.detail.title' | transloco" appModalCloseOnBackdrop (dismiss)="selectedEntry.set(null)" (click)="$event.stopPropagation()">
          <h3>{{ 'auditLog.detail.title' | transloco }}</h3>
          <dl class="detail-grid">
            <dt>{{ 'auditLog.table.timestamp' | transloco }}</dt>
            <dd><app-relative-time [value]="e.timestamp" /></dd>
            <dt>{{ 'auditLog.table.tokenUser' | transloco }}</dt>
            <dd>{{ e.tokenLabel ?? e.oidcSubject ?? '—' }}<span class="mono" style="color:var(--text-muted)">@if (e.authMethod) { &nbsp;· {{ e.authMethod }} }</span></dd>
            <dt>{{ 'auditLog.table.operation' | transloco }}</dt>
            <dd class="mono">{{ e.operation }}</dd>
            <dt>{{ 'auditLog.detail.request' | transloco }}</dt>
            <dd class="mono">{{ e.method }} {{ e.path }}</dd>
            <dt>{{ 'auditLog.table.status' | transloco }}</dt>
            <dd><app-status-pill [variant]="statusVariant(e.status)">{{ e.status }}</app-status-pill></dd>
            <dt>{{ 'auditLog.table.space' | transloco }}</dt>
            <dd>{{ e.spaceId ?? '—' }}</dd>
            <dt>{{ 'auditLog.table.ip' | transloco }}</dt>
            <dd class="mono">{{ e.ip }}</dd>
            <dt>{{ 'auditLog.table.duration' | transloco }}</dt>
            <dd class="num">{{ e.durationMs }}ms</dd>
            @if (e.entryId) {
              <dt>{{ 'auditLog.detail.entryId' | transloco }}</dt>
              <dd class="mono">{{ e.entryId }}</dd>
            }
            <!-- The request id, and the only row here whose ABSENCE has to be spelled out. Every audited action
                 had a request behind it, so a blank would read as "none" when it means "this row predates the
                 field" — the same trap the changes note below describes. (No backticks in here: this template
                 is a template literal, and one would end it.) -->
            <dt>{{ 'auditLog.detail.requestId' | transloco }}</dt>
            @if (e.requestId) {
              <dd class="mono">
                {{ e.requestId }}
                <button type="button" class="link-btn" (click)="filterByRequestId(e.requestId!)">
                  {{ 'auditLog.detail.requestIdFilter' | transloco }}
                </button>
              </dd>
            } @else {
              <dd style="color:var(--text-muted)">{{ 'auditLog.detail.requestIdAbsent' | transloco }}</dd>
            }
          </dl>
          <!-- What the request actually changed. Only allowlisted operations record this, so its ABSENCE
               means "not recorded for this operation" — never "nothing changed". Saying so explicitly
               matters: an empty detail pane that looks authoritative is how a reader concludes a rename
               never happened. -->
          @if (e.changes?.length) {
            <div class="changes-block">
              <h4>{{ 'auditLog.detail.changes' | transloco }}</h4>
              <table class="changes-table">
                <thead>
                  <tr>
                    <th>{{ 'auditLog.detail.changeField' | transloco }}</th>
                    <th>{{ 'auditLog.detail.changeFrom' | transloco }}</th>
                    <th>{{ 'auditLog.detail.changeTo' | transloco }}</th>
                  </tr>
                </thead>
                <tbody>
                  @for (c of e.changes; track c.field) {
                    <tr>
                      <td class="mono">{{ c.field }}</td>
                      <!-- "not set" and "set to null" are different facts and must not both render as a
                           dash: one means the field did not exist, the other that it existed and was null. -->
                      <td class="mono val-from">{{ c.from === undefined ? ('auditLog.detail.notSet' | transloco) : fmtValue(c.from) }}</td>
                      <td class="mono val-to">{{ c.to === undefined ? ('auditLog.detail.notSet' | transloco) : fmtValue(c.to) }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          } @else {
            <p class="changes-none">{{ 'auditLog.detail.changesNotRecorded' | transloco }}</p>
          }
          <details class="detail-raw">
            <summary>{{ 'auditLog.detail.rawJson' | transloco }}</summary>
            <pre>{{ e | json }}</pre>
          </details>
          <button class="detail-close" (click)="selectedEntry.set(null)">{{ 'auditLog.detail.closeButton' | transloco }}</button>
        </div>
      </div>
    }

    } <!-- end audit tab -->
  `,
})
export class AuditLogComponent implements OnInit, OnDestroy {
  private adminApi = inject(AdminApi);
  private spacesApi = inject(SpacesApi);
  private transloco = inject(TranslocoService);

  activeLogTab = signal<'audit' | 'server'>('audit');
  loading = signal(true);
  error = signal('');
  entries = signal<AuditLogEntry[]>([]);
  total = signal(0);
  hasMore = signal(false);
  offset = signal(0);
  spaces = signal<Space[]>([]);
  selectedEntry = signal<AuditLogEntry | null>(null);
  retentionDays = signal(90);

  /** Status codes present in the current result set — the filter offers only what's actually there
   *  instead of a fixed guess-list. */
  statusOptions = computed(() => [...new Set(this.entries().map(e => e.status))].sort((a, b) => a - b));

  /** At-a-glance rollup of what's currently in view, with warn/error emphasis when non-zero. */
  summaryItems = computed<SummaryItem[]>(() => {
    const tr = (k: string) => this.transloco.translate(k);
    const es = this.entries();
    const c4 = es.filter(e => e.status >= 400 && e.status < 500).length;
    const c5 = es.filter(e => e.status >= 500).length;
    const authFailed = es.filter(e => e.operation === 'auth.failed').length;
    return [
      { label: tr('auditLog.summary.shown'), value: es.length },
      { label: tr('auditLog.summary.clientErrors'), value: c4, variant: c4 ? 'warn' : undefined },
      { label: tr('auditLog.summary.serverErrors'), value: c5, variant: c5 ? 'error' : undefined },
      { label: tr('auditLog.summary.authFailures'), value: authFailed, variant: authFailed ? 'error' : undefined },
    ];
  });

  /** True while the full NDJSON export is in flight — it can take a moment on a busy instance. */
  exportingAll = signal(false);
  /** A failed export says so; a download that quietly does nothing looks exactly like an empty result. */
  exportError = signal('');

  filterAfter = '';
  filterBefore = '';
  filterOperation = '';
  filterSpaceId = '';
  filterStatus = '';
  filterIp = '';
  /**
   * Exact request id, set by the detail panel's "find this request" button rather than typed.
   *
   * No input of its own on the filter bar: nobody types a UUID from memory, and a text box for one would be a
   * control that only ever gets pasted into. It arrives from a bug report through the detail panel, which is
   * where somebody actually holds one.
   */
  filterRequestId = '';

  readonly pageSize = 100;

  // Server log state
  serverLogLines = signal<string[]>([]);
  serverLogLoading = signal(false);
  serverLogStreaming = signal(false);
  private serverLogEventSource: EventSource | null = null;

  constructor() {
    effect(() => {
      if (this.activeLogTab() === 'server') {
        if (!this.serverLogStreaming()) {
          this.startServerLogStream();
        }
      } else {
        this.stopServerLogStream();
      }
    });
  }

  readonly operations = [
    'fact.create', 'fact.update', 'fact.delete',
    'entity.create', 'entity.update', 'entity.delete',
    'edge.create', 'edge.update', 'edge.delete',
    'chrono.create', 'chrono.update', 'chrono.delete',
    'file.create', 'file.update', 'file.delete',
    'space.create', 'space.update', 'space.delete', 'space.wipe',
    'space.reload_added', 'space.reload_removed', 'space.reload_kept',
    'token.create', 'token.delete',
    'webhook.create', 'webhook.update', 'webhook.delete',
    'config.reload',
    'auth.failed',
    'brain.recall', 'brain.recall_global', 'brain.query', 'brain.stats',
    'chrono.list', 'fact.list', 'entity.list', 'edge.list',
    'file.read', 'file.list', 'space.list',
  ];

  ngOnInit(): void {
    this.spacesApi.listSpaces().subscribe({
      next: (data) => this.spaces.set(data.spaces),
      error: () => { /* non-fatal */ },
    });
    this.load();
  }

  applyFilters(): void {
    this.offset.set(0);
    this.load();
  }

  /**
   * Show only this request's row, from the detail panel.
   *
   * Clears the other filters, because a request id identifies ONE row and combining it with a date range or a
   * status that happens to be set would return nothing and read as "there is no such request" — which is the
   * one wrong answer this control can give.
   */
  filterByRequestId(requestId: string): void {
    this.filterAfter = '';
    this.filterBefore = '';
    this.filterOperation = '';
    this.filterSpaceId = '';
    this.filterStatus = '';
    this.filterIp = '';
    this.filterRequestId = requestId;
    this.selectedEntry.set(null);
    this.offset.set(0);
    this.load();
  }

  resetFilters(): void {
    this.filterRequestId = '';
    this.filterAfter = '';
    this.filterBefore = '';
    this.filterOperation = '';
    this.filterSpaceId = '';
    this.filterStatus = '';
    this.filterIp = '';
    this.offset.set(0);
    this.load();
  }

  nextPage(): void {
    this.offset.set(this.offset() + this.pageSize);
    this.load();
  }

  prevPage(): void {
    this.offset.set(Math.max(0, this.offset() - this.pageSize));
    this.load();
  }

  showDetail(e: AuditLogEntry): void {
    this.selectedEntry.set(e);
  }

  private buildParams(): AuditLogParams {
    const p: AuditLogParams = { limit: this.pageSize, offset: this.offset() };
    if (this.filterAfter) p.after = new Date(this.filterAfter).toISOString();
    if (this.filterBefore) p.before = new Date(this.filterBefore).toISOString();
    if (this.filterOperation) p.operation = this.filterOperation;
    if (this.filterSpaceId) p.spaceId = this.filterSpaceId;
    if (this.filterStatus) p.status = parseInt(this.filterStatus, 10);
    if (this.filterIp) p.ip = this.filterIp;
    if (this.filterRequestId) p.requestId = this.filterRequestId;
    return p;
  }

  private load(): void {
    this.loading.set(true);
    this.error.set('');
    this.adminApi.getAuditLog(this.buildParams()).subscribe({
      next: (data) => {
        this.entries.set(data.entries);
        this.total.set(data.total);
        this.hasMore.set(data.hasMore);
        if (data.retentionDays !== undefined) this.retentionDays.set(data.retentionDays);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(err?.error?.error ?? 'Failed to load audit log');
        this.loading.set(false);
      },
    });
  }

  /**
   * Render an audited value for display.
   *
   * `null` is printed as `null` rather than a dash, because the template already uses "not set" for a
   * field that did not exist — collapsing the two would lose the difference between "this field was
   * introduced" and "this field was cleared", which is exactly the kind of distinction someone reads an
   * audit log to recover. Strings are quoted so a value of `"null"` cannot be mistaken for the literal.
   */
  fmtValue(v: string | number | boolean | null | undefined): string {
    if (v === null) return 'null';
    if (typeof v === 'string') return `"${v}"`;
    return String(v);
  }

  /** Map an HTTP status to the shared status-pill vocabulary. */
  statusVariant(status: number): StatusVariant {
    if (status >= 500) return 'error';
    if (status >= 400) return 'warn';
    if (status >= 300) return 'off';
    return 'ok';
  }

  /** Leading severity stripe for rows worth noticing: 5xx → error, 4xx / auth failure → warn. */
  rowClass(e: AuditLogEntry): string {
    if (e.status >= 500) return 'row-error';
    if (e.status >= 400 || e.operation === 'auth.failed') return 'row-warn';
    return '';
  }

  /**
   * The page on screen, as JSON.
   *
   * Both of these export `entries()` — **one page**, at most `pageSize` rows out of `total()`. That was not wrong,
   * but the buttons used to say only "Export JSON" / "Export CSV", so an operator asked to produce someone's
   * activity record could hand over a 100-row file believing it was the whole thing. The labels now say `page`, and
   * `exportAll()` below is the one that means everything.
   */
  exportJson(): void {
    const blob = new Blob([JSON.stringify(this.entries(), null, 2)], { type: 'application/json' });
    this.downloadBlob(blob, 'audit-log-page.json');
  }

  /**
   * Every entry matching the current filters, streamed from the server as NDJSON.
   *
   * The filters are the ones already on screen, so what comes down is what the operator was looking at — without
   * the 1,000-row ceiling the paged endpoint has to impose on a table.
   */
  exportAll(): void {
    if (this.exportingAll()) return;
    this.exportingAll.set(true);
    this.exportError.set('');
    const params = this.buildParams();
    delete params.limit;
    delete params.offset;
    this.adminApi.exportAuditLog(params).subscribe({
      next: (blob) => {
        const stamp = new Date().toISOString().slice(0, 10);
        this.downloadBlob(blob, `audit-log-${stamp}.ndjson`);
        this.exportingAll.set(false);
      },
      error: (err) => {
        // Surfaced rather than swallowed: a download that silently does nothing is indistinguishable from an
        // empty result, and for an audit export those two must never look the same.
        this.exportError.set(err?.error?.error ?? this.transloco.translate('auditLog.exportAllFailed'));
        this.exportingAll.set(false);
      },
    });
  }

  exportCsv(): void {
    // `requestId` included: a CSV of an activity record is exactly where somebody correlates a row with the
    // server log afterwards, and a column that exists in the API but not the export is one the reader of the
    // file cannot know to ask for.
    const headers = ['timestamp', 'requestId', 'tokenId', 'tokenLabel', 'authMethod', 'oidcSubject', 'ip', 'method', 'path', 'spaceId', 'operation', 'status', 'entryId', 'durationMs'];
    const rows = this.entries().map(e =>
      headers.map(h => {
        const v = (e as unknown as Record<string, unknown>)[h];
        const s = v === null || v === undefined ? '' : String(v);
        return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(',')
    );
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    this.downloadBlob(blob, 'audit-log-page.csv');
  }

  private downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Server Log ─────────────────────────────────────────────────────────────

  loadServerLogs(): void {
    this.serverLogLoading.set(true);
    this.adminApi.getAboutLogs(500).subscribe({
      next: ({ lines }) => {
        this.serverLogLines.set(lines);
        this.serverLogLoading.set(false);
      },
      error: () => this.serverLogLoading.set(false),
    });
  }

  toggleServerLogStream(): void {
    if (this.serverLogStreaming()) {
      this.stopServerLogStream();
    } else {
      this.startServerLogStream();
    }
  }

  private startServerLogStream(): void {
    // First load existing lines, then start the SSE stream. EventSource can't send an Authorization
    // header and a raw token in the URL leaks into logs/history, so mint a single-use ticket first, then
    // open the stream with ?ticket=.
    this.loadServerLogs();
    this.serverLogStreaming.set(true); // optimistic so the toggle button reflects intent immediately
    this.adminApi.mintLogsTicket().subscribe({
      next: ({ ticket }) => {
        if (typeof EventSource === 'undefined' || !this.serverLogStreaming()) return; // stopped while minting
        const es = new EventSource(`/api/about/logs/stream?ticket=${encodeURIComponent(ticket)}`);
        es.onmessage = (event) => {
          this.serverLogLines.update(lines => {
            const updated = [...lines, event.data];
            return updated.length > 1000 ? updated.slice(-1000) : updated;
          });
        };
        es.onerror = () => {
          // SSE connection lost — stop streaming (the ticket is single-use; the user can restart).
          this.stopServerLogStream();
        };
        this.serverLogEventSource = es;
      },
      error: () => this.stopServerLogStream(), // mint failed (auth / rate limit)
    });
  }

  private stopServerLogStream(): void {
    if (this.serverLogEventSource) {
      this.serverLogEventSource.close();
      this.serverLogEventSource = null;
    }
    this.serverLogStreaming.set(false);
  }

  serverLogColor(line: string): string {
    if (line.includes('[ERROR]')) return 'var(--error)';
    if (line.includes('[WARN ')) return 'var(--warning)';
    if (line.includes('[DEBUG]')) return 'var(--text-muted)';
    return 'var(--text-primary)';
  }

  ngOnDestroy(): void {
    this.stopServerLogStream();
  }
}
