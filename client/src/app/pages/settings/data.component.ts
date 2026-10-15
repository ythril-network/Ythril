import { Component, inject, signal, computed, OnInit } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs/operators';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AdminApi } from '../../core/admin-api.service';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import { SettingsCardComponent } from '../../shared/settings-card.component';
import { StatusPillComponent, type StatusVariant } from '../../shared/status-pill.component';
import { SummaryStripComponent, type SummaryItem } from '../../shared/summary-strip.component';
import { RelativeTimeComponent } from '../../shared/relative-time.component';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { HscrollTopDirective } from '../../shared/hscroll-top.directive';
import { refusalText } from '../../core/refusal-text';

type UriSource = 'env' | 'config' | 'default';
type Frequency = 'never' | 'hourly' | 'daily' | 'weekly' | 'monthly';

interface BackupConfig {
  schedule?: string;
  encrypt?: boolean;
  retention?: { keepLocal?: number };
  offsite?: {
    destPath: string;
    retention?: { keepCount?: number };
  };
}

@Component({
  selector: 'app-data',
  standalone: true,
  imports: [
    CommonModule, FormsModule, TranslocoPipe,
    SettingsCardComponent, StatusPillComponent, SummaryStripComponent, RelativeTimeComponent, PhIconComponent, HscrollTopDirective],
  styles: [`
    .data-page { display: flex; flex-direction: column; gap: 16px; max-width: 860px; }
    .freq-opt, .day-opt { display: flex; align-items: center; gap: 6px; cursor: pointer; border-radius: var(--radius-sm);
      border: 1px solid var(--border); background: transparent; color: var(--text-secondary); transition: all .15s; }
    .freq-opt { padding: 8px 16px; font-size: 14px; }
    .day-opt { padding: 6px 12px; font-size: 13px; }
    .freq-opt.sel, .day-opt.sel { border-color: var(--accent);
      background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--text-primary); font-weight: 600; }
    .sched-summary { padding: 10px 14px; background: var(--bg-elevated); border-radius: var(--radius-sm);
      font-size: 13px; color: var(--text-secondary); display: inline-flex; align-items: center; gap: 8px; }
    .save-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 4px; }
    /* Danger zone — visually quarantined red region for disruptive / irreversible ops. */
    .dz { border: 1px solid var(--danger); border-radius: 12px; padding: 4px 16px 16px; margin-top: 8px;
      background: color-mix(in srgb, var(--danger) 4%, transparent); }
    .dz-head { display: flex; align-items: center; gap: 8px; padding: 14px 2px 4px; color: var(--danger);
      font-weight: 700; font-size: 14px; }
    .dz-hint { font-size: 12.5px; color: var(--text-secondary); margin: 0 0 12px; }
    .dz-block { padding: 14px 0; border-top: 1px solid var(--border-muted); }
    .dz-block:first-of-type { border-top: none; }
    .dz-block h4 { margin: 0 0 4px; font-size: 14px; font-weight: 620; }
    .dz-block .sub { margin: 0 0 12px; font-size: 13px; color: var(--text-secondary); }
    .mono { font-family: var(--font-mono); font-size: 13px; }
    .muted { color: var(--text-muted); font-size: 14px; }
  `],
  template: `
    <div class="data-page">
      <div class="page-header"><div class="card-title">{{ 'data.title' | transloco }}</div></div>

      <app-summary-strip [items]="summaryItems()"/>

      <!-- ── Database (read-only) ─────────────────────────────── -->
      <app-settings-card icon="database" [heading]="'data.db.title' | transloco" [purpose]="uriSource() ? (('data.db.sourceDesc.' + uriSource()) | transloco) : ''">
        @if (uriSource()) {
          <app-status-pill pill [variant]="sourcePillVariant()" [dot]="true">{{ ('data.db.source.' + uriSource()) | transloco }}</app-status-pill>
        }
        @if (currentUriRedacted()) { <code class="mono" style="color:var(--text-secondary);">{{ currentUriRedacted() }}</code> }
      </app-settings-card>

      <!-- ── Backups ──────────────────────────────────────────── -->
      <app-settings-card icon="floppy-disk" [heading]="'data.backup.title' | transloco" [purpose]="'data.backup.description' | transloco">
        @if (backups().length) { <app-status-pill pill variant="ok" [dot]="true">{{ backups().length }}</app-status-pill> }

        <button class="btn btn-secondary btn-sm" style="margin-bottom:14px;" [disabled]="backingUp()" (click)="takeBackup()">
          @if (backingUp()) { <span class="spinner spinner-sm"></span> }{{ 'data.backup.takeButton' | transloco }}
        </button>

        @if (backupTaken())    { <div class="alert alert-success" style="margin-bottom:12px;">{{ 'data.backup.success' | transloco }}</div> }
        @if (backupError())    { <div class="alert alert-error"   style="margin-bottom:12px;">{{ backupError() }}</div> }
        @if (restoreSuccess()) { <div class="alert alert-success" style="margin-bottom:12px;">{{ 'data.backup.restoreSuccess' | transloco }}</div> }
        @if (restoreError())   { <div class="alert alert-error"   style="margin-bottom:12px;">{{ restoreError() }}</div> }

        @if (loadingBackups()) {
          <span class="spinner spinner-sm"></span>
        } @else if (!backups().length) {
          <p class="muted">{{ 'data.backup.empty' | transloco }}</p>
        } @else {
          <div class="table-wrapper" hscrollTop>
          <table class="table" style="font-size:13px;">
            <thead><tr>
              <th>{{ 'data.backup.colDate' | transloco }}</th>
              <th>{{ 'data.backup.colCollections' | transloco }}</th>
              <th></th>
            </tr></thead>
            <tbody>
              @for (b of backups(); track b.id) {
                <tr>
                  <td>
                    <app-relative-time [value]="b.createdAt"/>
                    @if (b.id === latestBackupId()) { <app-status-pill variant="active" style="margin-left:8px;">{{ 'data.backup.latest' | transloco }}</app-status-pill> }
                  </td>
                  <td class="mono">{{ b.collections.length }}</td>
                  <td style="text-align:right;">
                    <button class="btn btn-sm btn-danger" [disabled]="!!restoringId()" (click)="confirmRestore(b.id)">
                      @if (restoringId() === b.id) { <span class="spinner spinner-sm"></span> }{{ 'data.backup.restoreButton' | transloco }}
                    </button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
          </div>
        }
      </app-settings-card>

      <!-- ── Backup Destination ───────────────────────────────── -->
      <app-settings-card icon="database" [heading]="'data.dest.title' | transloco" [purpose]="migrationEnabled() ? ('data.dest.description' | transloco) : ''">
        @if (migrationEnabled()) {
          <app-status-pill pill [variant]="destConfigured() ? 'active' : 'off'" [dot]="true">{{ destConfigured() ? ('data.dest.configured' | transloco) : ('data.dest.notConfigured' | transloco) }}</app-status-pill>
        }
        @if (!migrationEnabled()) {
          <p class="muted">{{ 'data.dest.featureDisabled' | transloco }}</p>
        } @else {
          <div style="margin-bottom:16px;padding:14px 16px;background:var(--bg-elevated);border-radius:var(--radius-sm);">
            <label style="display:flex;align-items:center;gap:10px;cursor:pointer;">
              <input class="form-check-input" type="checkbox" [(ngModel)]="destForm.ythrilInternal" style="margin:0;" />
              <span style="font-weight:500;font-size:14px;">{{ 'data.dest.internalLabel' | transloco }}</span>
            </label>
            <p style="margin:8px 0 0 26px;font-size:13px;color:var(--text-secondary);">{{ 'data.dest.internalHint' | transloco }}</p>
          </div>

          <div class="form-group" style="margin-bottom:16px;">
            <label class="form-label">{{ 'data.dest.pathLabel' | transloco }}</label>
            <input class="form-control mono" type="text" [disabled]="destForm.ythrilInternal" [(ngModel)]="destForm.customPath"
              [placeholder]="destForm.ythrilInternal ? (backupsPath() || ('data.dest.internalPathHint' | transloco)) : ('data.dest.pathPlaceholder' | transloco)" />
            @if (!destForm.ythrilInternal) { <div class="muted" style="font-size:12px;margin-top:4px;">{{ 'data.dest.pathHint' | transloco }}</div> }
          </div>

          <div class="form-group" style="margin-bottom:12px;">
            <label class="form-label">{{ 'data.dest.keepLabel' | transloco }}</label>
            <div style="display:flex;align-items:center;gap:8px;">
              <input class="form-control" type="number" [(ngModel)]="destForm.keepLocal" min="1" style="width:100px;" [placeholder]="'data.dest.keepUnlimitedPlaceholder' | transloco" />
              <span style="font-size:13px;color:var(--text-secondary);">{{ 'data.dest.keepSuffix' | transloco }}</span>
            </div>
          </div>

          <div class="form-group" style="margin-bottom:12px;">
            <label class="form-label">{{ 'data.dest.encryptLabel' | transloco }}</label>
            <label class="freq-opt" style="display:flex;align-items:flex-start;gap:8px;padding:10px 12px;">
              <input type="checkbox" [(ngModel)]="destForm.encrypt" [attr.aria-describedby]="'data-encrypt-hint'" />
              <span>
                <strong style="font-size:13px;">{{ 'data.dest.encryptToggle' | transloco }}</strong>
                <span id="data-encrypt-hint" class="muted" style="display:block;font-size:12px;margin-top:3px;">
                  {{ 'data.dest.encryptHint' | transloco }}
                </span>
              </span>
            </label>
            @if (destForm.encrypt) {
              <!-- Both consequences, stated where the choice is made rather than in a doc.
                   The key one is not a nicety: an encrypted backup is unrecoverable without the secret, and
                   the operator most likely to enable this is the one least likely to have thought about where
                   that secret lives. The size one is measured - the fixed envelope wrapper dominates small
                   records, so a dump of many small ones can more than double. -->
              <div class="alert alert-warning" style="margin-top:10px;font-size:12.5px;">
                {{ 'data.dest.encryptWarnKey' | transloco }}
              </div>
              <div class="muted" style="font-size:12px;margin-top:6px;">
                {{ 'data.dest.encryptWarnSize' | transloco }}
              </div>
            }
          </div>

          @if (destSaveError()) { <div class="alert alert-error" style="margin-bottom:12px;">{{ destSaveError() }}</div> }
          <div class="save-row">
            <button class="btn btn-primary btn-sm" [disabled]="savingDest()" (click)="saveDest()">
              @if (savingDest()) { <span class="spinner spinner-sm"></span> }{{ 'data.dest.saveButton' | transloco }}
            </button>
            @if (configDirty()) { <app-status-pill variant="warn" [dot]="true">{{ 'common.unsavedChanges' | transloco }}</app-status-pill> }
            @else if (destSaveSuccess()) { <app-status-pill variant="ok" icon="check-circle">{{ 'data.dest.saveSuccess' | transloco }}</app-status-pill> }
          </div>
        }
      </app-settings-card>

      <!-- ── Scheduled Backups ────────────────────────────────── -->
      <app-settings-card icon="timer" [heading]="'data.schedule.title' | transloco" [purpose]="migrationEnabled() ? ('data.schedule.howOften' | transloco) : ''">
        @if (migrationEnabled()) {
          <app-status-pill pill [variant]="scheduleConfigured() ? 'active' : 'off'" [dot]="true">{{ scheduleConfigured() ? ('data.schedule.configured' | transloco) : ('data.schedule.notConfigured' | transloco) }}</app-status-pill>
        }
        @if (!migrationEnabled()) {
          <p class="muted">{{ 'data.schedule.featureDisabled' | transloco }}</p>
        } @else {
          <div class="form-group" style="margin-bottom:20px;">
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              @for (opt of freqOptions; track opt.value) {
                <label class="freq-opt" [class.sel]="scheduleForm.frequency === opt.value">
                  <input type="radio" name="freq" [value]="opt.value" [(ngModel)]="scheduleForm.frequency" style="display:none;" />
                  {{ opt.label | transloco }}
                </label>
              }
            </div>
          </div>

          @if (scheduleForm.frequency !== 'never') {
            @if (scheduleForm.frequency !== 'hourly') {
              <div class="form-group" style="margin-bottom:16px;">
                <label class="form-label">{{ 'data.schedule.atTime' | transloco }}</label>
                <select class="form-control" [(ngModel)]="scheduleForm.hour" style="max-width:240px;">
                  @for (h of hours; track h) { <option [ngValue]="h">{{ formatHour(h) }}</option> }
                </select>
              </div>
            }
            @if (scheduleForm.frequency === 'weekly') {
              <div class="form-group" style="margin-bottom:16px;">
                <label class="form-label">{{ 'data.schedule.onWeekday' | transloco }}</label>
                <div style="display:flex;gap:8px;flex-wrap:wrap;">
                  @for (d of weekdays; track d.value) {
                    <label class="day-opt" [class.sel]="scheduleForm.weekday === d.value">
                      <input type="radio" name="weekday" [value]="d.value" [(ngModel)]="scheduleForm.weekday" style="display:none;" />
                      {{ d.label | transloco }}
                    </label>
                  }
                </div>
              </div>
            }
            @if (scheduleForm.frequency === 'monthly') {
              <div class="form-group" style="margin-bottom:16px;">
                <label class="form-label">{{ 'data.schedule.onMonthDay' | transloco }}</label>
                <select class="form-control" [(ngModel)]="scheduleForm.monthDay" style="max-width:120px;">
                  @for (d of monthDays; track d) { <option [ngValue]="d">{{ d }}</option> }
                </select>
                <div class="muted" style="font-size:12px;margin-top:4px;">{{ 'data.schedule.monthDayHint' | transloco }}</div>
              </div>
            }
            <div class="sched-summary" style="margin-bottom:16px;"><ph-icon name="timer" [size]="14"/>{{ scheduleSummary() }}</div>
          }

          @if (scheduleSaveError()) { <div class="alert alert-error" style="margin-bottom:12px;">{{ scheduleSaveError() }}</div> }
          <div class="save-row">
            <button class="btn btn-primary btn-sm" [disabled]="savingSchedule()" (click)="saveSchedule()">
              @if (savingSchedule()) { <span class="spinner spinner-sm"></span> }{{ 'data.schedule.saveButton' | transloco }}
            </button>
            @if (configDirty()) { <app-status-pill variant="warn" [dot]="true">{{ 'common.unsavedChanges' | transloco }}</app-status-pill> }
            @else if (scheduleSaveSuccess()) { <app-status-pill variant="ok" icon="check-circle">{{ 'data.schedule.saveSuccess' | transloco }}</app-status-pill> }
          </div>
        }
      </app-settings-card>

      <!-- ── Danger Zone: disruptive / irreversible ops ───────── -->
      <div class="dz">
        <div class="dz-head"><ph-icon name="warning" [size]="16"/>{{ 'data.dangerZone.title' | transloco }}</div>
        <p class="dz-hint">{{ 'data.dangerZone.hint' | transloco }}</p>

        <!-- Maintenance mode -->
        <div class="dz-block">
          <h4>{{ 'data.maintenance.title' | transloco }}
            @if (maintenanceActive() !== null) {
              <app-status-pill [variant]="maintenanceActive() ? 'warn' : 'ok'" [dot]="true" style="margin-left:8px;">{{ maintenanceActive() ? ('data.maintenance.active' | transloco) : ('data.maintenance.inactive' | transloco) }}</app-status-pill>
            }
          </h4>
          <button class="btn btn-sm" [class]="maintenanceActive() ? 'btn-primary' : 'btn-danger'" [disabled]="togglingMaintenance()" (click)="toggleMaintenance()">
            @if (togglingMaintenance()) { <span class="spinner spinner-sm"></span> }{{ maintenanceActive() ? ('data.maintenance.deactivate' | transloco) : ('data.maintenance.activate' | transloco) }}
          </button>
          @if (maintenanceError()) { <div class="alert alert-error" style="margin-top:10px;">{{ maintenanceError() }}</div> }
        </div>

        <!-- Migrate database -->
        <div class="dz-block">
          <h4>{{ 'data.migrate.title' | transloco }}</h4>
          @if (uriSource() === 'env') {
            <p class="sub">{{ 'data.migrate.envNote' | transloco }}</p>
          } @else if (!migrationEnabled()) {
            <p class="sub">{{ 'data.migrate.featureDisabled' | transloco }}</p>
          } @else {
            <p class="sub">{{ 'data.migrate.description' | transloco }}</p>
            <div class="form-group" style="margin-bottom:12px;">
              <label class="form-label">{{ 'data.migrate.newUriLabel' | transloco }}</label>
              <input class="form-control mono" type="text" [(ngModel)]="migrateUri" placeholder="mongodb://new-host:27017/" />
            </div>
            @if (testResult()) {
              <div class="alert" [class]="testResult()!.ok ? 'alert-success' : 'alert-error'" style="margin-bottom:12px;">
                {{ testResult()!.ok ? ('data.migrate.testOk' | transloco) : (('data.migrate.testFail' | transloco) + ': ' + testResult()!.error) }}
              </div>
            }
            @if (migrateSuccess()) { <div class="alert alert-success" style="margin-bottom:12px;">{{ 'data.migrate.success' | transloco }}</div> }
            @if (migrateError())   { <div class="alert alert-error"   style="margin-bottom:12px;">{{ migrateError() }}</div> }
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              <button class="btn btn-secondary btn-sm" [disabled]="testing() || !migrateUri.trim()" (click)="testMigrateConnection()">
                @if (testing()) { <span class="spinner spinner-sm"></span> }{{ 'data.migrate.testButton' | transloco }}
              </button>
              <button class="btn btn-danger btn-sm" [disabled]="migrating() || !testResult()?.ok" (click)="confirmMigrate()">
                @if (migrating()) { <span class="spinner spinner-sm"></span> }{{ 'data.migrate.migrateButton' | transloco }}
              </button>
            </div>
          }
        </div>
      </div>
    </div>
  `,
})
export class DataComponent implements OnInit {
  private adminApi = inject(AdminApi);
  private transloco = inject(TranslocoService);
  private confirmDialog = inject(ConfirmDialogService);

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

  /** The most-recent backup id, for the "Latest" marker (backups come newest-first from the API). */
  latestBackupId = computed(() => this.backups()[0]?.id ?? null);

  /**
   * Flips whenever a translation file finishes loading.
   *
   * `computed` memoises on its SIGNAL dependencies, and `transloco.translate()` is not one — it is a
   * plain method call. So a computed that translates imperatively evaluates once during the first
   * render, BEFORE the language file has resolved, gets the raw key back (Transloco logs
   * "Missing translation key"), and then never re-runs to pick up the real string.
   *
   * That was not visible here only by luck: `backups()` and `backupConfig()` land after their HTTP
   * calls, which happens to be after translations load, so the strip re-evaluated and looked correct.
   * Remove or reorder those loads and the labels would read `data.summary.backups` permanently.
   *
   * Reading this signal inside the computed makes "translations arrived" a real dependency.
   */
  private translationLoad = toSignal(
    this.transloco.events$.pipe(filter(e => e.type === 'translationLoadSuccess')),
    { initialValue: null },
  );

  /**
   * Are translations actually available to `translate()` right now?
   *
   * Both halves are needed. `events$` does NOT replay, so a component mounted after the language file
   * already loaded would never see the event and — if that were the only check — would render an empty
   * strip forever, which is a worse bug than the one being fixed. `getTranslation()` is synchronous and
   * covers exactly that case; the signal covers the first-load case and supplies the reactivity.
   */
  private translationsReady = computed<boolean>(() => {
    this.translationLoad();   // dependency, not a value
    // Ask whether the active language has been LOADED, not whether it has content. An empty-but-loaded
    // dictionary is a legitimate state — the spec harness uses exactly that, and so would a minimal
    // locale — and treating it as "not ready" would blank the strip permanently.
    return this.transloco.getTranslation().has(this.transloco.getActiveLang());
  });

  /** Operator overview strip: DB source, maintenance state, backup count, and the saved schedule. */
  summaryItems = computed<SummaryItem[]>(() => {
    // Render nothing rather than translate too early. Calling `translate()` before the language file
    // resolves logs "Missing translation key" and bakes the raw key into the label; an empty strip for
    // one frame is honest, since the data behind it has not loaded either.
    if (!this.translationsReady()) return [];
    const t = (k: string) => this.transloco.translate(k);
    const items: SummaryItem[] = [];
    const src = this.uriSource();
    if (src) items.push({ label: t('data.summary.database'), value: t('data.db.source.' + src), variant: this.sourcePillVariant() });
    const maint = this.maintenanceActive();
    if (maint !== null) items.push({ label: t('data.summary.maintenance'), value: maint ? t('data.summary.maintenanceOn') : t('data.summary.maintenanceOff'), variant: maint ? 'warn' : 'ok' });
    items.push({ label: t('data.summary.backups'), value: this.backups().length });
    const freq = this.freqFromCron(this.backupConfig()?.schedule);
    items.push({ label: t('data.summary.schedule'), value: freq === 'never' ? t('data.schedule.notConfigured') : t('data.schedule.freq.' + freq), variant: freq === 'never' ? 'off' : 'active' });
    return items;
  });

  // ─ Schedule form (human-friendly, not raw cron) ─────────────────────────────────────
  scheduleForm = {
    frequency: 'never' as Frequency,
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
    encrypt: false,
  };
  savingDest = signal(false);
  destSaveSuccess = signal(false);
  destSaveError = signal<string | null>(null);
  backupsPath = signal<string>('');

  /** Snapshot of the last-saved config, so the UI can flag unsaved edits and auto-dismiss "Saved". */
  private savedSnapshot = signal<string>('');

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

  readonly hours = Array.from({ length: 24 }, (_, i) => i);
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

  /** StatusPill variant for the DB-source pill (env is flagged — it can't be changed from the UI). */
  sourcePillVariant(): StatusVariant {
    const s = this.uriSource();
    if (s === 'env') return 'warn';
    if (s === 'config') return 'active';
    return 'off';
  }

  private loadConfig(): void {
    this.adminApi.getDataConfig().subscribe({
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
    this.adminApi.getMaintenanceStatus().subscribe({
      next: ({ active }) => this.maintenanceActive.set(active),
      error: () => {},
    });
  }

  private loadBackupConfig(): void {
    this.adminApi.getBackupConfig().subscribe({
      next: ({ config, backupsPath }) => {
        this.backupConfig.set(config);
        if (backupsPath) this.backupsPath.set(backupsPath);
        // Populate destination form
        this.destForm.ythrilInternal = !config?.offsite;
        this.destForm.customPath     = config?.offsite?.destPath ?? '';
        this.destForm.keepLocal      = config?.offsite?.retention?.keepCount ?? config?.retention?.keepLocal ?? null;
        // Absent means plaintext, matching the server: the schema leaves `encrypt` optional on purpose.
        this.destForm.encrypt        = config?.encrypt === true;
        // Populate schedule form
        this.parseCron(config?.schedule);
        this.savedSnapshot.set(JSON.stringify(this.buildConfig()));
      },
      error: () => {},
    });
  }

  private refreshBackups(): void {
    this.loadingBackups.set(true);
    this.adminApi.listBackups().subscribe({
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
    this.adminApi.triggerBackup().subscribe({
      next: () => {
        this.backingUp.set(false);
        this.backupTaken.set(true);
        this.refreshBackups();
      },
      error: err => {
        this.backingUp.set(false);
        this.backupError.set(refusalText(this.transloco, err, 'data.backup.error'));
      },
    });
  }

  async confirmRestore(backupId: string): Promise<void> {
    // Irreversible: replaces ALL data. Require typing the backup id to proceed.
    const ok = await this.confirmDialog.confirm({
      title: this.transloco.translate('data.restore.confirmTitle'),
      message: this.transloco.translate('data.restore.confirmMessage'),
      confirmLabel: this.transloco.translate('data.restore.confirmButton'),
      danger: true,
      requireText: backupId,
      requireTextLabel: this.transloco.translate('data.restore.typeIdToConfirm', { id: backupId }),
    });
    if (!ok) return;
    this.restoringId.set(backupId);
    this.restoreSuccess.set(false);
    this.restoreError.set(null);
    this.adminApi.restoreBackup(backupId).subscribe({
      next: () => {
        this.restoringId.set(null);
        this.restoreSuccess.set(true);
        this.refreshBackups();
      },
      error: err => {
        this.restoringId.set(null);
        this.restoreError.set(refusalText(this.transloco, err, 'data.backup.restoreError'));
      },
    });
  }

  saveSchedule(): void {
    this.savingSchedule.set(true);
    this.scheduleSaveSuccess.set(false);
    this.scheduleSaveError.set(null);
    this.adminApi.saveBackupConfig(this.buildConfig()).subscribe({
      next: ({ config }) => {
        this.backupConfig.set(config);
        this.savingSchedule.set(false);
        this.scheduleSaveSuccess.set(true);
        this.savedSnapshot.set(JSON.stringify(this.buildConfig()));
      },
      error: err => {
        this.savingSchedule.set(false);
        this.scheduleSaveError.set(refusalText(this.transloco, err, 'data.schedule.saveError'));
      },
    });
  }

  saveDest(): void {
    this.savingDest.set(true);
    this.destSaveSuccess.set(false);
    this.destSaveError.set(null);
    this.adminApi.saveBackupConfig(this.buildConfig()).subscribe({
      next: ({ config }) => {
        this.backupConfig.set(config);
        this.savingDest.set(false);
        this.destSaveSuccess.set(true);
        this.savedSnapshot.set(JSON.stringify(this.buildConfig()));
      },
      error: err => {
        this.savingDest.set(false);
        this.destSaveError.set(refusalText(this.transloco, err, 'data.dest.saveError'));
      },
    });
  }

  // ─ Config builders / parsers ───────────────────────────────────────────────────────

  private buildConfig(): BackupConfig {
    const cfg: BackupConfig = {};

    // Schedule
    const cron = this.buildCron();
    if (cron) cfg.schedule = cron;
    // Emitted only when ON, so turning it off removes the key rather than writing `false`. Keeps an
    // untouched backup.json byte-identical and keeps `absent === plaintext` the single source of truth.
    if (this.destForm.encrypt) cfg.encrypt = true;
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

  /** Pure classification of a cron string into a frequency bucket (for the summary strip, no side effects). */
  private freqFromCron(cron: string | undefined): Frequency {
    if (!cron?.trim()) return 'never';
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) return 'never';
    const [, hr, dom, , dow] = parts;
    if (hr === '*' && dom === '*' && dow === '*') return 'hourly';
    if (dom !== '*' && dow === '*') return 'monthly';
    if (dom === '*' && dow !== '*') return 'weekly';
    return 'daily';
  }

  // ─ Computed state helpers ──────────────────────────────────────────────────────────

  destConfigured(): boolean {
    return !this.destForm.ythrilInternal && !!this.destForm.customPath.trim();
  }

  scheduleConfigured(): boolean {
    return this.scheduleForm.frequency !== 'never';
  }

  /** True when the schedule/destination forms differ from what was last saved. */
  configDirty(): boolean {
    return this.migrationEnabled() && JSON.stringify(this.buildConfig()) !== this.savedSnapshot();
  }

  /** Localised clock label for an hour (0–23), shared by the time dropdown and the schedule summary. */
  formatHour(h: number): string {
    if (h === 0)  return this.transloco.translate('data.time.midnight');
    if (h === 12) return this.transloco.translate('data.time.noon');
    const h12 = h > 12 ? h - 12 : h;
    const ampm = this.transloco.translate(h < 12 ? 'data.time.am' : 'data.time.pm');
    return `${h12}:00 ${ampm}`;
  }

  scheduleSummary(): string {
    const f = this.scheduleForm.frequency;
    if (f === 'never')  return '';
    if (f === 'hourly') return this.transloco.translate('data.schedule.summary.hourly');
    const time = this.formatHour(this.scheduleForm.hour);
    if (f === 'daily')   return this.transloco.translate('data.schedule.summary.daily', { time });
    if (f === 'weekly')  return this.transloco.translate('data.schedule.summary.weekly', { day: this.transloco.translate('data.schedule.weekday.' + this.scheduleForm.weekday), time });
    if (f === 'monthly') return this.transloco.translate('data.schedule.summary.monthly', { day: this.scheduleForm.monthDay, time });
    return '';
  }

  testMigrateConnection(): void {
    const uri = this.migrateUri.trim();
    if (!uri) return;
    this.testing.set(true);
    this.testResult.set(null);
    this.adminApi.testMongoConnection(uri).subscribe({
      next: result => {
        this.testResult.set(result);
        this.testing.set(false);
      },
      error: err => {
        this.testResult.set({ ok: false, error: refusalText(this.transloco, err, 'data.migrate.requestFailed') });
        this.testing.set(false);
      },
    });
  }

  toggleMaintenance(): void {
    const next = !this.maintenanceActive();
    this.togglingMaintenance.set(true);
    this.maintenanceError.set(null);
    this.adminApi.setMaintenance(next).subscribe({
      next: ({ active }) => {
        this.maintenanceActive.set(active);
        this.togglingMaintenance.set(false);
      },
      error: err => {
        this.maintenanceError.set(refusalText(this.transloco, err, 'data.maintenance.requestFailed'));
        this.togglingMaintenance.set(false);
      },
    });
  }

  async confirmMigrate(): Promise<void> {
    const uri = this.migrateUri.trim();
    if (!uri) return;
    // Irreversible: dumps, switches DB, and restarts. Require the MIGRATE ritual.
    const ok = await this.confirmDialog.confirm({
      title: this.transloco.translate('data.migrate.confirmTitle'),
      message: this.transloco.translate('data.migrate.confirmMessage'),
      confirmLabel: this.transloco.translate('data.migrate.confirmButton'),
      danger: true,
      requireText: 'MIGRATE',
      requireTextLabel: this.transloco.translate('data.migrate.typeToConfirm'),
    });
    if (!ok) return;
    this.migrating.set(true);
    this.migrateSuccess.set(false);
    this.migrateError.set(null);
    this.testResult.set(null);
    this.adminApi.startMigration(uri).subscribe({
      next: () => {
        this.migrating.set(false);
        this.migrateSuccess.set(true);
      },
      error: err => {
        this.migrating.set(false);
        const code = err?.error?.code;
        if (code === 'FEATURE_DISABLED') {
          this.migrateError.set(this.transloco.translate('data.migrate.errorFeatureDisabled'));
        } else if (code === 'INFRA_MANAGED') {
          this.migrateError.set(this.transloco.translate('data.migrate.errorInfraManaged'));
        } else {
          this.migrateError.set(refusalText(this.transloco, err, 'data.migrate.error'));
        }
      },
    });
  }
}
