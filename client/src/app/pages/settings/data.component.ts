import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service';
import { TranslocoPipe } from '@jsverse/transloco';

type UriSource = 'env' | 'config' | 'default';

interface BackupConfig {
  schedule?: string;
  retention?: { keepLocal?: number };
  offsite?: {
    destPath: string;
    retention?: { keepCount?: number };
  };
}

@Component({
  selector: 'app-data',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslocoPipe],
  template: `
    <div class="page-header" style="margin-bottom:16px;">
      <div class="card-title">{{ 'data.title' | transloco }}</div>
    </div>

    <!-- ── Database info card (read-only) ───────────────────────────── -->
    <div class="card" style="margin-bottom:20px;">
      <div class="card-header">
        <h3 class="card-title">{{ 'data.db.title' | transloco }}</h3>
        @if (uriSource()) {
          <span class="badge" [class]="sourceBadgeClass()">
            {{ ('data.db.source.' + uriSource()) | transloco }}
          </span>
        }
      </div>
      <div class="card-body">
        @if (uriSource()) {
          <p style="margin-bottom:8px;font-size:14px;color:var(--text-secondary);">
            {{ ('data.db.sourceDesc.' + uriSource()) | transloco }}
          </p>
        }
        @if (currentUriRedacted()) {
          <code style="font-size:13px;color:var(--text-secondary);">{{ currentUriRedacted() }}</code>
        }
      </div>
    </div>

    <!-- ── Maintenance mode section ──────────────────────────────────── -->
    <div class="card" style="margin-bottom:20px;">
      <div class="card-header">
        <h3 class="card-title">{{ 'data.maintenance.title' | transloco }}</h3>
        @if (maintenanceActive() !== null) {
          <span class="badge" [class]="maintenanceActive() ? 'badge-error' : 'badge-success'">
            {{ maintenanceActive()
              ? ('data.maintenance.active' | transloco)
              : ('data.maintenance.inactive' | transloco) }}
          </span>
        }
      </div>
      <div class="card-body">
        <button
          class="btn btn-sm"
          [class]="maintenanceActive() ? 'btn-primary' : 'btn-danger'"
          [disabled]="togglingMaintenance()"
          (click)="toggleMaintenance()"
        >
          @if (togglingMaintenance()) { <span class="spinner spinner-sm"></span> }
          {{ maintenanceActive()
            ? ('data.maintenance.deactivate' | transloco)
            : ('data.maintenance.activate' | transloco) }}
        </button>
        @if (maintenanceError()) {
          <div class="alert alert-error" style="margin-top:10px;">{{ maintenanceError() }}</div>
        }
      </div>
    </div>

    <!-- ── Backups card ───────────────────────────────────────── -->
    <div class="card" style="margin-bottom:20px;">
      <div class="card-header">
        <h3 class="card-title">{{ 'data.backup.title' | transloco }}</h3>
      </div>
      <div class="card-body">
        <p style="margin-bottom:12px;color:var(--text-secondary);font-size:14px;">
          {{ 'data.backup.description' | transloco }}
        </p>
        <button
          class="btn btn-secondary btn-sm"
          style="margin-bottom:16px;"
          [disabled]="backingUp()"
          (click)="takeBackup()"
        >
          @if (backingUp()) { <span class="spinner spinner-sm"></span> }
          {{ 'data.backup.takeButton' | transloco }}
        </button>
        @if (backupTaken()) {
          <div class="alert alert-success" style="margin-bottom:12px;">
            {{ 'data.backup.success' | transloco }}
          </div>
        }
        @if (backupError()) {
          <div class="alert alert-error" style="margin-bottom:12px;">{{ backupError() }}</div>
        }
        @if (restoreSuccess()) {
          <div class="alert alert-success" style="margin-bottom:12px;">
            {{ 'data.backup.restoreSuccess' | transloco }}
          </div>
        }
        @if (restoreError()) {
          <div class="alert alert-error" style="margin-bottom:12px;">{{ restoreError() }}</div>
        }
        @if (loadingBackups()) {
          <span class="spinner spinner-sm"></span>
        } @else if (backups().length === 0) {
          <p style="color:var(--text-muted);font-size:14px;">{{ 'data.backup.empty' | transloco }}</p>
        } @else {
          <table class="table" style="font-size:13px;">
            <thead>
              <tr>
                <th>{{ 'data.backup.colDate' | transloco }}</th>
                <th>{{ 'data.backup.colCollections' | transloco }}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              @for (b of backups(); track b.id) {
                <tr>
                  <td style="font-family:monospace;">{{ b.createdAt }}</td>
                  <td>{{ b.collections.length }}</td>
                  <td style="text-align:right;">
                    <button
                      class="btn btn-sm btn-danger"
                      [disabled]="!!restoringId()"
                      (click)="confirmRestore(b.id)"
                    >
                      @if (restoringId() === b.id) { <span class="spinner spinner-sm"></span> }
                      {{ 'data.backup.restoreButton' | transloco }}
                    </button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        }
      </div>
    </div>

    <!-- ── Backup Destination card ───────────────────────────── -->
    <div class="card" style="margin-bottom:20px;">
      <div class="card-header">
        <h3 class="card-title">{{ 'data.dest.title' | transloco }}</h3>
        @if (migrationEnabled()) {
          <span class="badge" [class]="destConfigured() ? 'badge-success' : 'badge-secondary'">
            {{ destConfigured() ? ('data.dest.configured' | transloco) : ('data.dest.notConfigured' | transloco) }}
          </span>
        }
      </div>
      <div class="card-body">
        @if (!migrationEnabled()) {
          <p style="font-size:14px;color:var(--text-secondary);">{{ 'data.dest.featureDisabled' | transloco }}</p>
        } @else {
          <p style="margin-bottom:20px;color:var(--text-secondary);font-size:14px;">
            {{ 'data.dest.description' | transloco }}
          </p>

          <!-- Ythril-internal toggle -->
          <div style="margin-bottom:20px;padding:14px 16px;background:var(--bg-elevated);border-radius:var(--radius-sm);">
            <label style="display:flex;align-items:center;gap:10px;cursor:pointer;">
              <input class="form-check-input" type="checkbox" [(ngModel)]="destForm.ythrilInternal" style="margin:0;" />
              <span style="font-weight:500;font-size:14px;">{{ 'data.dest.internalLabel' | transloco }}</span>
            </label>
            <p style="margin:8px 0 0 26px;font-size:13px;color:var(--text-secondary);">
              {{ 'data.dest.internalHint' | transloco }}
            </p>
          </div>

          <!-- Path field -->
          <div class="form-group" style="margin-bottom:16px;">
            <label class="form-label">{{ 'data.dest.pathLabel' | transloco }}</label>
            <input
              class="form-control"
              type="text"
              [disabled]="destForm.ythrilInternal"
              [(ngModel)]="destForm.customPath"
              [placeholder]="destForm.ythrilInternal
                ? (backupsPath() || ('data.dest.internalPathHint' | transloco))
                : ('data.dest.pathPlaceholder' | transloco)"
              style="font-family:monospace;font-size:13px;"
            />
            @if (!destForm.ythrilInternal) {
              <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">{{ 'data.dest.pathHint' | transloco }}</div>
            }
          </div>

          <!-- How many backups to keep -->
          <div class="form-group" style="margin-bottom:12px;">
            <label class="form-label">{{ 'data.dest.keepLabel' | transloco }}</label>
            <div style="display:flex;align-items:center;gap:8px;">
              <input
                class="form-control"
                type="number"
                [(ngModel)]="destForm.keepLocal"
                min="1"
                style="width:100px;"
                [placeholder]="'data.dest.keepUnlimitedPlaceholder' | transloco"
              />
              <span style="font-size:13px;color:var(--text-secondary);">{{ 'data.dest.keepSuffix' | transloco }}</span>
            </div>
          </div>

          @if (destSaveSuccess()) {
            <div class="alert alert-success" style="margin-bottom:12px;">{{ 'data.dest.saveSuccess' | transloco }}</div>
          }
          @if (destSaveError()) {
            <div class="alert alert-error" style="margin-bottom:12px;">{{ destSaveError() }}</div>
          }
          <button class="btn btn-primary btn-sm" [disabled]="savingDest()" (click)="saveDest()">
            @if (savingDest()) { <span class="spinner spinner-sm"></span> }
            {{ 'data.dest.saveButton' | transloco }}
          </button>
        }
      </div>
    </div>

    <!-- ── Scheduled Backups card ──────────────────────────── -->
    <div class="card" style="margin-bottom:20px;">
      <div class="card-header">
        <h3 class="card-title">{{ 'data.schedule.title' | transloco }}</h3>
        @if (migrationEnabled()) {
          <span class="badge" [class]="scheduleConfigured() ? 'badge-success' : 'badge-secondary'">
            {{ scheduleConfigured() ? ('data.schedule.configured' | transloco) : ('data.schedule.notConfigured' | transloco) }}
          </span>
        }
      </div>
      <div class="card-body">
        @if (!migrationEnabled()) {
          <p style="font-size:14px;color:var(--text-secondary);">{{ 'data.schedule.featureDisabled' | transloco }}</p>
        } @else {
          <p style="margin-bottom:20px;color:var(--text-secondary);font-size:14px;">
            {{ 'data.schedule.howOften' | transloco }}
          </p>

          <!-- Frequency pill-buttons -->
          <div class="form-group" style="margin-bottom:24px;">
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              @for (opt of freqOptions; track opt.value) {
                <label
                  style="display:flex;align-items:center;gap:6px;cursor:pointer;padding:8px 16px;border-radius:var(--radius-sm);border:1px solid;font-size:14px;transition:all 0.15s;"
                  [style.border-color]="scheduleForm.frequency === opt.value ? 'var(--accent)' : 'var(--border-color)'"
                  [style.background]="scheduleForm.frequency === opt.value ? 'var(--nav-active-dim)' : 'transparent'"
                  [style.color]="scheduleForm.frequency === opt.value ? 'var(--text-primary)' : 'var(--text-secondary)'"
                  [style.font-weight]="scheduleForm.frequency === opt.value ? '600' : '400'"
                >
                  <input type="radio" name="freq" [value]="opt.value" [(ngModel)]="scheduleForm.frequency" style="display:none;" />
                  {{ opt.label | transloco }}
                </label>
              }
            </div>
          </div>

          @if (scheduleForm.frequency !== 'never') {
            <!-- Time of day — not shown for hourly -->
            @if (scheduleForm.frequency !== 'hourly') {
              <div class="form-group" style="margin-bottom:16px;">
                <label class="form-label">{{ 'data.schedule.atTime' | transloco }}</label>
                <select class="form-control" [(ngModel)]="scheduleForm.hour" style="max-width:240px;">
                  @for (h of hours; track h.value) {
                    <option [ngValue]="h.value">{{ h.label }}</option>
                  }
                </select>
              </div>
            }

            <!-- Day of week (weekly only) -->
            @if (scheduleForm.frequency === 'weekly') {
              <div class="form-group" style="margin-bottom:16px;">
                <label class="form-label">{{ 'data.schedule.onWeekday' | transloco }}</label>
                <div style="display:flex;gap:8px;flex-wrap:wrap;">
                  @for (d of weekdays; track d.value) {
                    <label
                      style="display:flex;align-items:center;gap:5px;cursor:pointer;padding:6px 12px;border-radius:var(--radius-sm);border:1px solid;font-size:13px;transition:all 0.15s;"
                      [style.border-color]="scheduleForm.weekday === d.value ? 'var(--accent)' : 'var(--border-color)'"
                      [style.background]="scheduleForm.weekday === d.value ? 'var(--nav-active-dim)' : 'transparent'"
                      [style.color]="scheduleForm.weekday === d.value ? 'var(--text-primary)' : 'var(--text-secondary)'"
                      [style.font-weight]="scheduleForm.weekday === d.value ? '600' : '400'"
                    >
                      <input type="radio" name="weekday" [value]="d.value" [(ngModel)]="scheduleForm.weekday" style="display:none;" />
                      {{ d.label | transloco }}
                    </label>
                  }
                </div>
              </div>
            }

            <!-- Day of month (monthly only) -->
            @if (scheduleForm.frequency === 'monthly') {
              <div class="form-group" style="margin-bottom:16px;">
                <label class="form-label">{{ 'data.schedule.onMonthDay' | transloco }}</label>
                <select class="form-control" [(ngModel)]="scheduleForm.monthDay" style="max-width:120px;">
                  @for (d of monthDays; track d) {
                    <option [ngValue]="d">{{ d }}</option>
                  }
                </select>
                <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">{{ 'data.schedule.monthDayHint' | transloco }}</div>
              </div>
            }

            <!-- Human-readable summary -->
            <div style="margin-bottom:16px;padding:10px 14px;background:var(--bg-elevated);border-radius:var(--radius-sm);font-size:13px;color:var(--text-secondary);">
              {{ scheduleSummary() }}
            </div>
          }

          @if (scheduleSaveSuccess()) {
            <div class="alert alert-success" style="margin-bottom:12px;">{{ 'data.schedule.saveSuccess' | transloco }}</div>
          }
          @if (scheduleSaveError()) {
            <div class="alert alert-error" style="margin-bottom:12px;">{{ scheduleSaveError() }}</div>
          }
          <button class="btn btn-primary btn-sm" [disabled]="savingSchedule()" (click)="saveSchedule()">
            @if (savingSchedule()) { <span class="spinner spinner-sm"></span> }
            {{ 'data.schedule.saveButton' | transloco }}
          </button>
        }
      </div>
    </div>

    <!-- ── Migrate Database card ───────────────────────────── -->
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">{{ 'data.migrate.title' | transloco }}</h3>
      </div>
      <div class="card-body">
        @if (uriSource() === 'env') {
          <p style="font-size:14px;color:var(--text-secondary);">
            {{ 'data.migrate.envNote' | transloco }}
          </p>        } @else if (!migrationEnabled()) {
          <p style="font-size:14px;color:var(--text-secondary);">
            {{ 'data.migrate.featureDisabled' | transloco }}
          </p>        } @else {
          <p style="margin-bottom:16px;color:var(--text-secondary);font-size:14px;">
            {{ 'data.migrate.description' | transloco }}
          </p>

          <div class="form-group" style="margin-bottom:12px;">
            <label class="form-label">{{ 'data.migrate.newUriLabel' | transloco }}</label>
            <input
              class="form-control"
              type="text"
              [(ngModel)]="migrateUri"
              placeholder="mongodb://new-host:27017/"
              style="font-family:monospace;font-size:13px;"
            />
          </div>

          @if (testResult()) {
            <div class="alert" [class]="testResult()!.ok ? 'alert-success' : 'alert-error'" style="margin-bottom:12px;">
              {{ testResult()!.ok
                ? ('data.migrate.testOk' | transloco)
                : (('data.migrate.testFail' | transloco) + ': ' + testResult()!.error) }}
            </div>
          }

          @if (migrateSuccess()) {
            <div class="alert alert-success" style="margin-bottom:12px;">
              {{ 'data.migrate.success' | transloco }}
            </div>
          }
          @if (migrateError()) {
            <div class="alert alert-error" style="margin-bottom:12px;">{{ migrateError() }}</div>
          }

          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button
              class="btn btn-secondary btn-sm"
              [disabled]="testing() || !migrateUri.trim()"
              (click)="testMigrateConnection()"
            >
              @if (testing()) { <span class="spinner spinner-sm"></span> }
              {{ 'data.migrate.testButton' | transloco }}
            </button>
            <button
              class="btn btn-danger btn-sm"
              [disabled]="migrating() || !testResult()?.ok"
              (click)="confirmMigrate()"
            >
              @if (migrating()) { <span class="spinner spinner-sm"></span> }
              {{ 'data.migrate.migrateButton' | transloco }}
            </button>
          </div>
        }
      </div>
    </div>
  `,
})
export class DataComponent implements OnInit {
  private api = inject(ApiService);

  uriSource = signal<UriSource | null>(null);
  currentUriRedacted = signal<string>('');
  migrationEnabled = signal<boolean>(false);

  backups = signal<Array<{ id: string; createdAt: string; collections: unknown[] }>>([]);
  loadingBackups = signal(false);
  backingUp = signal(false);
  backupTaken = signal(false);
  backupError = signal<string | null>(null);
  restoringId = signal<string | null>(null);
  restoreSuccess = signal(false);
  restoreError = signal<string | null>(null);
  backupConfig = signal<BackupConfig | null>(null);

  // ─ Schedule form (human-friendly, not raw cron) ─────────────────────────────────────
  scheduleForm = {
    frequency: 'never' as 'never' | 'hourly' | 'daily' | 'weekly' | 'monthly',
    hour: 2,
    minute: 0,
    weekday: 1, // 0 = Sun … 6 = Sat
    monthDay: 1,
  };
  savingSchedule = signal(false);
  scheduleSaveSuccess = signal(false);
  scheduleSaveError = signal<string | null>(null);

  // ─ Destination form ───────────────────────────────────────────────────────────
  destForm = {
    ythrilInternal: true,
    customPath: '',
    keepLocal: null as number | null,
  };
  savingDest = signal(false);
  destSaveSuccess = signal(false);
  destSaveError = signal<string | null>(null);
  backupsPath = signal<string>('');

  // ─ Static option lists ──────────────────────────────────────────────────────────
  readonly freqOptions = [
    { value: 'never',   label: 'data.schedule.freq.never'   },
    { value: 'hourly',  label: 'data.schedule.freq.hourly'  },
    { value: 'daily',   label: 'data.schedule.freq.daily'   },
    { value: 'weekly',  label: 'data.schedule.freq.weekly'  },
    { value: 'monthly', label: 'data.schedule.freq.monthly' },
  ] as const;

  readonly weekdays = [
    { value: 0, label: 'data.schedule.weekday.0' },
    { value: 1, label: 'data.schedule.weekday.1' },
    { value: 2, label: 'data.schedule.weekday.2' },
    { value: 3, label: 'data.schedule.weekday.3' },
    { value: 4, label: 'data.schedule.weekday.4' },
    { value: 5, label: 'data.schedule.weekday.5' },
    { value: 6, label: 'data.schedule.weekday.6' },
  ];

  readonly hours = Array.from({ length: 24 }, (_, i) => {
    const ampm = i < 12 ? 'AM' : 'PM';
    const h12 = i === 0 ? 12 : i > 12 ? i - 12 : i;
    const label =
      i === 0  ? '12:00 midnight' :
      i === 12 ? '12:00 noon' :
      `${h12}:00 ${ampm}`;
    return { value: i, label };
  });

  readonly monthDays = Array.from({ length: 28 }, (_, i) => i + 1);

  maintenanceActive = signal<boolean | null>(null);
  togglingMaintenance = signal(false);
  maintenanceError = signal<string | null>(null);

  migrateUri = '';
  testing = signal(false);
  testResult = signal<{ ok: boolean; error?: string } | null>(null);
  migrating = signal(false);
  migrateSuccess = signal(false);
  migrateError = signal<string | null>(null);

  ngOnInit(): void {
    this.loadConfig();
    this.loadMaintenance();
    this.refreshBackups();
  }

  sourceBadgeClass(): string {
    const s = this.uriSource();
    if (s === 'env') return 'badge-warning';
    if (s === 'config') return 'badge-info';
    return 'badge-secondary';
  }

  private loadConfig(): void {
    this.api.getDataConfig().subscribe({
      next: ({ source, mongoUriRedacted, migrationEnabled }) => {
        this.uriSource.set(source);
        this.currentUriRedacted.set(mongoUriRedacted);
        this.migrationEnabled.set(migrationEnabled);
        if (migrationEnabled) this.loadBackupConfig();
      },
      error: () => {},
    });
  }

  private loadMaintenance(): void {
    this.api.getMaintenanceStatus().subscribe({
      next: ({ active }) => this.maintenanceActive.set(active),
      error: () => {},
    });
  }

  private loadBackupConfig(): void {
    this.api.getBackupConfig().subscribe({
      next: ({ config, backupsPath }) => {
        this.backupConfig.set(config);
        if (backupsPath) this.backupsPath.set(backupsPath);
        // Populate destination form
        this.destForm.ythrilInternal = !config?.offsite;
        this.destForm.customPath     = config?.offsite?.destPath ?? '';
        this.destForm.keepLocal      = config?.offsite?.retention?.keepCount ?? config?.retention?.keepLocal ?? null;
        // Populate schedule form
        this.parseCron(config?.schedule);
      },
      error: () => {},
    });
  }

  private refreshBackups(): void {
    this.loadingBackups.set(true);
    this.api.listBackups().subscribe({
      next: ({ backups }) => {
        this.backups.set(backups);
        this.loadingBackups.set(false);
      },
      error: () => this.loadingBackups.set(false),
    });
  }

  takeBackup(): void {
    this.backingUp.set(true);
    this.backupTaken.set(false);
    this.backupError.set(null);
    this.api.triggerBackup().subscribe({
      next: () => {
        this.backingUp.set(false);
        this.backupTaken.set(true);
        this.refreshBackups();
      },
      error: err => {
        this.backingUp.set(false);
        this.backupError.set(err?.error?.error ?? 'Backup failed');
      },
    });
  }

  confirmRestore(backupId: string): void {
    if (!window.confirm('This will replace all current data with the selected backup. The server will enter maintenance mode during restore. Proceed?')) return;
    this.restoringId.set(backupId);
    this.restoreSuccess.set(false);
    this.restoreError.set(null);
    this.api.restoreBackup(backupId).subscribe({
      next: () => {
        this.restoringId.set(null);
        this.restoreSuccess.set(true);
        this.refreshBackups();
      },
      error: err => {
        this.restoringId.set(null);
        this.restoreError.set(err?.error?.error ?? 'Restore failed');
      },
    });
  }

  saveSchedule(): void {
    this.savingSchedule.set(true);
    this.scheduleSaveSuccess.set(false);
    this.scheduleSaveError.set(null);
    this.api.saveBackupConfig(this.buildConfig()).subscribe({
      next: ({ config }) => {
        this.backupConfig.set(config);
        this.savingSchedule.set(false);
        this.scheduleSaveSuccess.set(true);
      },
      error: err => {
        this.savingSchedule.set(false);
        this.scheduleSaveError.set(err?.error?.error ?? 'Save failed');
      },
    });
  }

  saveDest(): void {
    this.savingDest.set(true);
    this.destSaveSuccess.set(false);
    this.destSaveError.set(null);
    this.api.saveBackupConfig(this.buildConfig()).subscribe({
      next: ({ config }) => {
        this.backupConfig.set(config);
        this.savingDest.set(false);
        this.destSaveSuccess.set(true);
      },
      error: err => {
        this.savingDest.set(false);
        this.destSaveError.set(err?.error?.error ?? 'Save failed');
      },
    });
  }

  // ─ Config builders / parsers ───────────────────────────────────────────────────────

  private buildConfig(): BackupConfig {
    const cfg: BackupConfig = {};

    // Schedule
    const cron = this.buildCron();
    if (cron) cfg.schedule = cron;
    const keep = this.destForm.keepLocal;
    if (keep != null && keep > 0) {
      cfg.retention = { keepLocal: keep };
    }

    // Destination / offsite
    if (!this.destForm.ythrilInternal && this.destForm.customPath.trim()) {
      cfg.offsite = {
        destPath: this.destForm.customPath.trim(),
        ...(keep && keep > 0 ? { retention: { keepCount: keep } } : {}),
      };
    }

    return cfg;
  }

  private buildCron(): string | undefined {
    const { frequency, hour, minute, weekday, monthDay } = this.scheduleForm;
    if (frequency === 'never')   return undefined;
    if (frequency === 'hourly')  return `0 * * * *`;
    if (frequency === 'daily')   return `${minute} ${hour} * * *`;
    if (frequency === 'weekly')  return `${minute} ${hour} * * ${weekday}`;
    if (frequency === 'monthly') return `${minute} ${hour} ${monthDay} * *`;
    return undefined;
  }

  private parseCron(cron: string | undefined): void {
    if (!cron?.trim()) { this.scheduleForm.frequency = 'never'; return; }
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) { this.scheduleForm.frequency = 'never'; return; }
    const [min, hr, dom, , dow] = parts;
    // hourly: minute field is a number, hour is '*'
    if (hr === '*' && dom === '*' && dow === '*') {
      this.scheduleForm.frequency = 'hourly';
      return;
    }
    this.scheduleForm.minute   = Math.max(0, Math.min(59, parseInt(min, 10) || 0));
    this.scheduleForm.hour     = Math.max(0, Math.min(23, parseInt(hr,  10) || 2));
    if (dom !== '*' && dow === '*') {
      this.scheduleForm.frequency = 'monthly';
      this.scheduleForm.monthDay  = Math.max(1, Math.min(28, parseInt(dom, 10) || 1));
    } else if (dom === '*' && dow !== '*') {
      this.scheduleForm.frequency = 'weekly';
      this.scheduleForm.weekday   = Math.max(0, Math.min(6, parseInt(dow, 10) || 1));
    } else {
      this.scheduleForm.frequency = 'daily';
    }
  }

  // ─ Computed state helpers ──────────────────────────────────────────────────────────

  destConfigured(): boolean {
    return !this.destForm.ythrilInternal && !!this.destForm.customPath.trim();
  }

  scheduleConfigured(): boolean {
    return this.scheduleForm.frequency !== 'never';
  }

  scheduleSummary(): string {
    const f = this.scheduleForm.frequency;
    if (f === 'never')  return '';
    if (f === 'hourly') return 'Every hour, on the hour';
    const h = this.scheduleForm.hour;
    const ampm = h < 12 ? 'AM' : 'PM';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    const t = `${h12}:00 ${ampm}`;
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    if (f === 'daily')   return `Every day at ${t}`;
    if (f === 'weekly')  return `Every ${days[this.scheduleForm.weekday]} at ${t}`;
    if (f === 'monthly') {
      const n = this.scheduleForm.monthDay;
      const ord = n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`;
      return `On the ${ord} of every month at ${t}`;
    }
    return '';
  }

  // ─ Directory browser (server-side, works in workstation mode; in Docker exposes mounted paths) ──

  testMigrateConnection(): void {
    const uri = this.migrateUri.trim();
    if (!uri) return;
    this.testing.set(true);
    this.testResult.set(null);
    this.api.testMongoConnection(uri).subscribe({
      next: result => {
        this.testResult.set(result);
        this.testing.set(false);
      },
      error: err => {
        this.testResult.set({ ok: false, error: err?.error?.error ?? 'Request failed' });
        this.testing.set(false);
      },
    });
  }

  toggleMaintenance(): void {
    const next = !this.maintenanceActive();
    this.togglingMaintenance.set(true);
    this.maintenanceError.set(null);
    this.api.setMaintenance(next).subscribe({
      next: ({ active }) => {
        this.maintenanceActive.set(active);
        this.togglingMaintenance.set(false);
      },
      error: err => {
        this.maintenanceError.set(err?.error?.error ?? 'Request failed');
        this.togglingMaintenance.set(false);
      },
    });
  }

  confirmMigrate(): void {
    const uri = this.migrateUri.trim();
    if (!uri) return;
    if (!window.confirm('This will put the server into maintenance mode, dump all data, switch to the new database, and restart. Proceed?')) return;
    this.migrating.set(true);
    this.migrateSuccess.set(false);
    this.migrateError.set(null);
    this.testResult.set(null);
    this.api.startMigration(uri).subscribe({
      next: () => {
        this.migrating.set(false);
        this.migrateSuccess.set(true);
      },
      error: err => {
        this.migrating.set(false);
        const code = err?.error?.code;
        if (code === 'FEATURE_DISABLED') {
          this.migrateError.set('Migration must be enabled by the administrator (YTHRIL_DB_MIGRATION_ENABLED=true).');
        } else if (code === 'INFRA_MANAGED') {
          this.migrateError.set('Database connection is managed via environment variable. Update MONGO_URI in your infrastructure configuration instead.');
        } else {
          this.migrateError.set(err?.error?.error ?? 'Migration failed');
        }
      },
    });
  }
}
