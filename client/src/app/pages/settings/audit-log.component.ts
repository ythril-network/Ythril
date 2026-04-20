import { Component, inject, signal, OnInit, OnDestroy, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService, type AuditLogEntry, type AuditLogParams, type Space } from '../../core/api.service';
import { TranslocoPipe } from '@jsverse/transloco';

@Component({
  selector: 'app-audit-log',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslocoPipe],
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
    .audit-toolbar input,
    .audit-toolbar select {
      font-size: 13px;
      padding: 5px 8px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border);
      background: var(--bg-primary);
      color: var(--text-primary);
      font-family: var(--font);
    }
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

    .badge-status {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
    }
    .badge-2xx { background: var(--success-bg);  color: var(--success); }
    .badge-4xx { background: var(--warning-bg);  color: var(--warning); }
    .badge-5xx { background: var(--error-bg);    color: var(--error); }

    .mono { font-family: var(--font-mono, monospace); font-size: 12px; }

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

    .export-btns { display: flex; gap: 8px; }
    .export-btns button { font-size: 12px; padding: 4px 10px; }

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
          <option value="200">200</option>
          <option value="201">201</option>
          <option value="204">204</option>
          <option value="400">400</option>
          <option value="401">401</option>
          <option value="403">403</option>
          <option value="404">404</option>
          <option value="500">500</option>
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
        <button (click)="exportJson()">{{ 'auditLog.exportJson' | transloco }}</button>
        <button (click)="exportCsv()">{{ 'auditLog.exportCsv' | transloco }}</button>
      </div>
      @if (retentionDays() > 0) {
        <span style="font-size:12px; color:var(--text-muted);">{{ 'auditLog.retention' | transloco: { days: retentionDays() } }}</span>
      }
    </div>

    @if (error()) {
      <p class="error-msg">{{ error() }}</p>
    }

    @if (loading()) {
      <p>{{ 'common.loading' | transloco }}</p>
    } @else if (entries().length === 0) {
      <div class="empty">{{ 'auditLog.empty' | transloco }}</div>
    } @else {
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
            <tr>
              <td class="mono">{{ formatTs(e.timestamp) }}</td>
              <td>{{ e.tokenLabel ?? e.oidcSubject ?? '—' }}</td>
              <td class="mono">{{ e.operation }}</td>
              <td>{{ e.spaceId ?? '—' }}</td>
              <td>
                <span class="badge-status"
                      [class.badge-2xx]="e.status >= 200 && e.status < 300"
                      [class.badge-4xx]="e.status >= 400 && e.status < 500"
                      [class.badge-5xx]="e.status >= 500">{{ e.status }}</span>
              </td>
              <td class="mono">{{ e.ip }}</td>
              <td>{{ e.durationMs }}ms</td>
              <td><button class="detail-close" style="padding:2px 8px;font-size:11px" (click)="showDetail(e)">{{ 'auditLog.table.detailButton' | transloco }}</button></td>
            </tr>
          }
        </tbody>
      </table>

      <div class="pagination">
        <span>{{ 'auditLog.pagination.total' | transloco: { count: total() } }}</span>
        <div class="pagination-btns">
          <button [disabled]="offset() === 0" (click)="prevPage()">{{ 'auditLog.pagination.prev' | transloco }}</button>
          <button [disabled]="!hasMore()" (click)="nextPage()">{{ 'auditLog.pagination.next' | transloco }}</button>
        </div>
      </div>
    }

    <!-- Detail panel -->
    @if (selectedEntry()) {
      <div class="detail-overlay" (click)="selectedEntry.set(null)">
        <div class="detail-panel" (click)="$event.stopPropagation()">
          <h3>{{ 'auditLog.detail.title' | transloco }}</h3>
          <pre>{{ selectedEntry() | json }}</pre>
          <button class="detail-close" (click)="selectedEntry.set(null)">{{ 'auditLog.detail.closeButton' | transloco }}</button>
        </div>
      </div>
    }

    } <!-- end audit tab -->
  `,
})
export class AuditLogComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);

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

  filterAfter = '';
  filterBefore = '';
  filterOperation = '';
  filterSpaceId = '';
  filterStatus = '';
  filterIp = '';

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
    'memory.create', 'memory.update', 'memory.delete',
    'entity.create', 'entity.update', 'entity.delete',
    'edge.create', 'edge.update', 'edge.delete',
    'chrono.create', 'chrono.update', 'chrono.delete',
    'file.create', 'file.update', 'file.delete',
    'space.create', 'space.update', 'space.delete', 'space.wipe',
    'token.create', 'token.delete',
    'webhook.create', 'webhook.update', 'webhook.delete',
    'config.reload',
    'auth.failed',
    'brain.recall', 'brain.recall_global', 'brain.query', 'brain.stats',
    'chrono.list', 'memory.list', 'entity.list', 'edge.list',
    'file.read', 'file.list', 'space.list',
  ];

  ngOnInit(): void {
    this.api.listSpaces().subscribe({
      next: (data) => this.spaces.set(data.spaces),
      error: () => { /* non-fatal */ },
    });
    this.load();
  }

  applyFilters(): void {
    this.offset.set(0);
    this.load();
  }

  resetFilters(): void {
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
    return p;
  }

  private load(): void {
    this.loading.set(true);
    this.error.set('');
    this.api.getAuditLog(this.buildParams()).subscribe({
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

  formatTs(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleString();
  }

  exportJson(): void {
    const blob = new Blob([JSON.stringify(this.entries(), null, 2)], { type: 'application/json' });
    this.downloadBlob(blob, 'audit-log.json');
  }

  exportCsv(): void {
    const headers = ['timestamp', 'tokenId', 'tokenLabel', 'authMethod', 'oidcSubject', 'ip', 'method', 'path', 'spaceId', 'operation', 'status', 'entryId', 'durationMs'];
    const rows = this.entries().map(e =>
      headers.map(h => {
        const v = (e as unknown as Record<string, unknown>)[h];
        const s = v === null || v === undefined ? '' : String(v);
        return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(',')
    );
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    this.downloadBlob(blob, 'audit-log.csv');
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
    this.api.getAboutLogs(500).subscribe({
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
    // First load existing lines, then start SSE stream
    this.loadServerLogs();
    const token = localStorage.getItem('ythril_token') ?? '';
    const es = new EventSource(`/api/about/logs/stream?token=${encodeURIComponent(token)}`);
    es.onmessage = (event) => {
      this.serverLogLines.update(lines => {
        const updated = [...lines, event.data];
        return updated.length > 1000 ? updated.slice(-1000) : updated;
      });
    };
    es.onerror = () => {
      // SSE connection lost — stop streaming
      this.stopServerLogStream();
    };
    this.serverLogEventSource = es;
    this.serverLogStreaming.set(true);
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
