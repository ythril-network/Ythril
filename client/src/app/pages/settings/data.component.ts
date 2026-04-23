import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service';
import { TranslocoPipe } from '@jsverse/transloco';

type UriSource = 'env' | 'config' | 'default';

@Component({
  selector: 'app-data',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslocoPipe],
  template: `
    <div class="page-header" style="margin-bottom:16px;">
      <div class="card-title">{{ 'data.title' | transloco }}</div>
    </div>

    <!-- ── Database section ─────────────────────────────────────────── -->
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

        @if (uriSource() === 'env') {
          <div class="alert alert-info" style="margin-bottom:12px;">
            {{ 'data.db.envNote' | transloco }}
          </div>
        }

        <div class="form-group" style="margin-bottom:12px;">
          <label class="form-label">{{ 'data.db.uriLabel' | transloco }}</label>
          <div style="display:flex;gap:8px;align-items:center;">
            <input
              class="form-control"
              [type]="showUri() ? 'text' : 'password'"
              [(ngModel)]="newUri"
              [placeholder]="'data.db.uriPlaceholder' | transloco"
              [disabled]="uriSource() === 'env'"
              style="flex:1;font-family:monospace;font-size:13px;"
            />
            <button class="btn btn-secondary btn-sm" type="button" (click)="showUri.set(!showUri())">
              {{ showUri() ? '🙈' : '👁' }}
            </button>
          </div>
          @if (currentUriRedacted()) {
            <div class="form-hint" style="margin-top:4px;font-family:monospace;font-size:12px;color:var(--text-secondary);">
              {{ currentUriRedacted() }}
            </div>
          }
        </div>

        @if (testResult()) {
          <div class="alert" [class]="testResult()!.ok ? 'alert-success' : 'alert-error'" style="margin-bottom:12px;">
            {{ testResult()!.ok
              ? ('data.db.testOk' | transloco)
              : (('data.db.testFail' | transloco) + ': ' + testResult()!.error) }}
          </div>
        }

        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button
            class="btn btn-secondary btn-sm"
            [disabled]="testing() || !newUri.trim() || uriSource() === 'env'"
            (click)="testConnection()"
          >
            @if (testing()) { <span class="spinner spinner-sm"></span> }
            {{ 'data.db.testButton' | transloco }}
          </button>

          <button
            class="btn btn-primary btn-sm"
            [disabled]="saving() || !newUri.trim() || uriSource() === 'env'"
            (click)="saveUri()"
          >
            @if (saving()) { <span class="spinner spinner-sm"></span> }
            {{ 'data.db.saveButton' | transloco }}
          </button>
        </div>

        @if (saveWarning()) {
          <div class="alert alert-warning" style="margin-top:12px;">
            {{ 'data.db.restartWarning' | transloco }}
          </div>
        }
        @if (saveError()) {
          <div class="alert alert-error" style="margin-top:12px;">{{ saveError() }}</div>
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

    <!-- ── Live migration section ────────────────────────────────────── -->
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">{{ 'data.migrate.title' | transloco }}</h3>
      </div>
      <div class="card-body">
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

        @if (migrateSuccess()) {
          <div class="alert alert-success" style="margin-bottom:10px;">
            {{ 'data.migrate.success' | transloco }}
          </div>
        }
        @if (migrateError()) {
          <div class="alert alert-error" style="margin-bottom:10px;">{{ migrateError() }}</div>
        }

        <button
          class="btn btn-danger btn-sm"
          [disabled]="migrating() || !migrateUri.trim()"
          (click)="confirmMigrate()"
        >
          @if (migrating()) { <span class="spinner spinner-sm"></span> }
          {{ 'data.migrate.migrateButton' | transloco }}
        </button>
      </div>
    </div>
  `,
})
export class DataComponent implements OnInit {
  private api = inject(ApiService);

  // DB config state
  uriSource = signal<UriSource | null>(null);
  currentUriRedacted = signal<string>('');
  newUri = '';
  showUri = signal(false);

  testing = signal(false);
  testResult = signal<{ ok: boolean; error?: string } | null>(null);

  saving = signal(false);
  saveWarning = signal(false);
  saveError = signal<string | null>(null);

  // Maintenance state
  maintenanceActive = signal<boolean | null>(null);
  togglingMaintenance = signal(false);
  maintenanceError = signal<string | null>(null);

  // Migration state
  migrateUri = '';
  migrating = signal(false);
  migrateSuccess = signal(false);
  migrateError = signal<string | null>(null);

  ngOnInit(): void {
    this.loadConfig();
    this.loadMaintenance();
  }

  sourceBadgeClass(): string {
    const s = this.uriSource();
    if (s === 'env') return 'badge-warning';
    if (s === 'config') return 'badge-info';
    return 'badge-secondary';
  }

  private loadConfig(): void {
    this.api.getDataConfig().subscribe({
      next: ({ source, mongoUriRedacted }) => {
        this.uriSource.set(source);
        this.currentUriRedacted.set(mongoUriRedacted);
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

  testConnection(): void {
    const uri = this.newUri.trim();
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

  saveUri(): void {
    const uri = this.newUri.trim();
    if (!uri) return;
    this.saving.set(true);
    this.saveError.set(null);
    this.saveWarning.set(false);
    this.api.startMigration(uri).subscribe({
      next: () => {
        this.saving.set(false);
        this.saveWarning.set(true);
        this.loadConfig();
      },
      error: err => {
        this.saving.set(false);
        this.saveError.set(err?.error?.error ?? 'Save failed');
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
    const msg = (window as Window & { transloco?: unknown }).transloco
      ? 'This will put the server into maintenance mode, dump all data, switch to the new database, and restart. Proceed?'
      : 'Proceed with migration?';
    if (!window.confirm(msg)) return;
    this.migrating.set(true);
    this.migrateSuccess.set(false);
    this.migrateError.set(null);
    this.api.startMigration(uri).subscribe({
      next: () => {
        this.migrating.set(false);
        this.migrateSuccess.set(true);
      },
      error: err => {
        this.migrating.set(false);
        this.migrateError.set(err?.error?.error ?? 'Migration failed');
      },
    });
  }
}
