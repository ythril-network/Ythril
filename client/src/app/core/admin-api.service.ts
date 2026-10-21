import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import type {
  AboutInfo, HealthSummary, AuditLogParams, AuditLogResponse, BackupConfigData,
  WebhookSubscription, WebhookUpsert, WebhookDelivery,
} from './api.types';
import type {
  MaintenanceState, MigrateReportAnswer, MigrateStarted, RestoreAbandoned, RestoreReportAnswer, RestoreStarted,
} from './admin-data.types';

/** Instance administration — about/logs, audit log, and data/backup/migration/maintenance. */
@Injectable({ providedIn: 'root' })
export class AdminApi {
  private http = inject(HttpClient);

  // ── About ───────────────────────────────────────────────────────────────

  getAbout(): Observable<AboutInfo> {
    return this.http.get<AboutInfo>('/api/about');
  }

  /** Optional-component liveness for the Instance panel. Admin-only. */
  getAboutHealth(): Observable<HealthSummary> {
    return this.http.get<HealthSummary>('/api/about/health');
  }

  getAboutLogs(lines: number = 200): Observable<{ lines: string[] }> {
    return this.http.get<{ lines: string[] }>(`/api/about/logs?lines=${lines}`);
  }

  /** Mint a single-use ticket to open the log-stream SSE (keeps the admin token out of the URL). */
  mintLogsTicket(): Observable<{ ticket: string; expiresInMs: number }> {
    return this.http.post<{ ticket: string; expiresInMs: number }>('/api/about/logs/ticket', {});
  }

  // ── Audit Log ───────────────────────────────────────────────────────────

  getAuditLog(params: AuditLogParams = {}): Observable<AuditLogResponse> {
    let p = new HttpParams();
    if (params.after) p = p.set('after', params.after);
    if (params.before) p = p.set('before', params.before);
    if (params.tokenId) p = p.set('tokenId', params.tokenId);
    if (params.oidcSubject) p = p.set('oidcSubject', params.oidcSubject);
    if (params.spaceId) p = p.set('spaceId', params.spaceId);
    if (params.operation) p = p.set('operation', params.operation);
    if (params.status !== undefined) p = p.set('status', String(params.status));
    if (params.ip) p = p.set('ip', params.ip);
    if (params.limit !== undefined) p = p.set('limit', String(params.limit));
    if (params.offset !== undefined) p = p.set('offset', String(params.offset));
    return this.http.get<AuditLogResponse>('/api/admin/audit-log', { params: p });
  }

  /**
   * Every entry matching the filters, as NDJSON — not just the page on screen.
   *
   * Fetched through `HttpClient` rather than an `<a download>` or `window.open`, deliberately: this endpoint
   * requires the second factor, and `mfaInterceptor` can only prompt-and-retry for requests that pass through
   * Angular's HTTP stack. A plain link would simply 403 on any instance with MFA enabled.
   *
   * That means the body is buffered in the browser before it is saved. Acceptable for a text record and
   * unavoidable given the above — a very large export is better done with `curl`, which the API docs show.
   *
   * `limit`/`offset` are not sent: the server ignores them, and passing them would suggest they narrowed the file.
   */
  exportAuditLog(params: AuditLogParams = {}): Observable<Blob> {
    let p = new HttpParams();
    if (params.after) p = p.set('after', params.after);
    if (params.before) p = p.set('before', params.before);
    if (params.tokenId) p = p.set('tokenId', params.tokenId);
    if (params.oidcSubject) p = p.set('oidcSubject', params.oidcSubject);
    if (params.spaceId) p = p.set('spaceId', params.spaceId);
    if (params.operation) p = p.set('operation', params.operation);
    if (params.status !== undefined) p = p.set('status', String(params.status));
    if (params.ip) p = p.set('ip', params.ip);
    return this.http.get('/api/admin/audit-log/export', { params: p, responseType: 'blob' });
  }

  // ── Data management ───────────────────────────────────────────────────────

  getDataConfig(): Observable<{ source: 'env' | 'config' | 'default'; mongoUriRedacted: string; migrationEnabled: boolean }> {
    return this.http.get<{ source: 'env' | 'config' | 'default'; mongoUriRedacted: string; migrationEnabled: boolean }>('/api/admin/data/config');
  }

  testMongoConnection(uri: string): Observable<{ ok: boolean; error?: string }> {
    return this.http.post<{ ok: boolean; error?: string }>('/api/admin/data/config/test', { uri });
  }

  /** Maintenance and its two halves: the manual toggle, and the instance-wide set (a restore, a migrate) that holds it. */
  getMaintenanceStatus(): Observable<MaintenanceState> {
    return this.http.get<MaintenanceState>('/api/admin/data/maintenance');
  }

  /** Moves the MANUAL half only: a standing set keeps maintenance on whatever this sets, and the answer says so. */
  setMaintenance(active: boolean): Observable<MaintenanceState> {
    return this.http.post<MaintenanceState>('/api/admin/data/maintenance', { active });
  }

  triggerBackup(): Observable<{ backup: { id: string; dir: string; manifest: unknown } }> {
    return this.http.post<{ backup: { id: string; dir: string; manifest: unknown } }>('/api/admin/data/backup', {});
  }

  listBackups(): Observable<{ backups: Array<{ id: string; createdAt: string; collections: unknown[] }> }> {
    return this.http.get<{ backups: Array<{ id: string; createdAt: string; collections: unknown[] }> }>('/api/admin/data/backups');
  }

  /**
   * Start a restore: 202 with the set registered, which runs one act per space after the answer (`getRestoreReport` follows it). A
   * success is ACCEPTED, never completed. `leaveOut` names spaces the backup holds that this instance no longer serves, after the server
   * refused with `backup_names_unserved_spaces`.
   */
  restoreBackup(backupId: string, leaveOut?: readonly string[]): Observable<RestoreStarted> {
    return this.http.post<RestoreStarted>('/api/admin/data/restore', { backupId, ...(leaveOut?.length ? { leaveOut } : {}) });
  }

  /** The restore standing, or the last one, per space; `{ restore: null }` when none ever ran here. */
  getRestoreReport(): Observable<RestoreReportAnswer> {
    return this.http.get<RestoreReportAnswer>('/api/admin/data/restore');
  }

  /** Release the standing restore's spaces whose acts have not completed: they keep whatever their acts reached. */
  abandonRestore(): Observable<RestoreAbandoned> {
    return this.http.post<RestoreAbandoned>('/api/admin/data/restore/abandon', {});
  }

  /** Start a migrate: 202 with the set registered. The copy runs online; the process exits when it completes. */
  startMigration(uri: string): Observable<MigrateStarted> {
    return this.http.post<MigrateStarted>('/api/admin/data/migrate', { uri });
  }

  /** The migrate standing, or the last one (slice I4a; its shape is guessed from the restore report's, see `MigrateReport`). */
  getMigrateReport(): Observable<MigrateReportAnswer> {
    return this.http.get<MigrateReportAnswer>('/api/admin/data/migrate');
  }

  getBackupConfig(): Observable<{ config: BackupConfigData | null; backupsPath?: string }> {
    return this.http.get<{ config: BackupConfigData | null; backupsPath?: string }>('/api/admin/data/backup-config');
  }

  saveBackupConfig(config: BackupConfigData): Observable<{ ok: boolean; config: BackupConfigData }> {
    return this.http.put<{ ok: boolean; config: BackupConfigData }>('/api/admin/data/backup-config', config);
  }

  browseDirs(dirPath: string): Observable<{ path: string; dirs: string[] }> {
    return this.http.get<{ path: string; dirs: string[] }>('/api/admin/data/browse-dirs', {
      params: { path: dirPath },
    });
  }

  // ── Webhooks (C1) ─────────────────────────────────────────────────────────
  // All routes require admin + MFA server-side; the mfa.interceptor handles the challenge/retry.

  listWebhooks(): Observable<{ webhooks: WebhookSubscription[] }> {
    return this.http.get<{ webhooks: WebhookSubscription[] }>('/api/admin/webhooks');
  }

  createWebhook(body: WebhookUpsert): Observable<WebhookSubscription> {
    return this.http.post<WebhookSubscription>('/api/admin/webhooks', body);
  }

  updateWebhook(id: string, patch: WebhookUpsert): Observable<WebhookSubscription> {
    return this.http.patch<WebhookSubscription>(`/api/admin/webhooks/${encodeURIComponent(id)}`, patch);
  }

  deleteWebhook(id: string): Observable<void> {
    return this.http.delete<void>(`/api/admin/webhooks/${encodeURIComponent(id)}`);
  }

  testWebhook(id: string): Observable<{ ok: boolean; message: string }> {
    return this.http.post<{ ok: boolean; message: string }>(`/api/admin/webhooks/${encodeURIComponent(id)}/test`, {});
  }

  getWebhookDeliveries(id: string): Observable<{ deliveries: WebhookDelivery[] }> {
    return this.http.get<{ deliveries: WebhookDelivery[] }>(`/api/admin/webhooks/${encodeURIComponent(id)}/deliveries`);
  }
}
