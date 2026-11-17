import { Component, inject, signal, computed, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SpacesApi } from '../../core/spaces-api.service';
import { TranslocoPipe } from '@jsverse/transloco';
import { UsageBarComponent, usageLevel } from '../../shared/usage-bar.component';
import { StatusPillComponent, type StatusVariant } from '../../shared/status-pill.component';
import type { StorageLimits } from '../../core/api.types';

interface StorageData {
  usageGiB: { files: number; brain: number; total: number };
  limits?: StorageLimits;
}

@Component({
  selector: 'app-storage',
  standalone: true,
  imports: [CommonModule, TranslocoPipe, UsageBarComponent, StatusPillComponent],
  styles: [`

    .row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 13px;
      margin-bottom: 4px;
    }

    .row .label { color: var(--text-secondary); }
    .row .value { font-weight: 500; color: var(--text-primary); }
  `],
  template: `
    <div class="page-header" style="margin-bottom:16px;">
      <div class="card-title">{{ 'metrics.title' | transloco }}</div>
    </div>

    <button class="btn-secondary btn btn-sm" style="margin-bottom:20px;" [disabled]="loading()" (click)="load()">
      @if (loading()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }
      {{ 'metrics.refreshButton' | transloco }}
    </button>

    @if (error()) {
      <div class="alert alert-error">{{ 'metrics.error.load' | transloco }}</div>
    } @else if (!data()) {
      @if (loading()) {
        <div class="loading-overlay"><span class="spinner"></span></div>
      } @else {
        <div class="alert alert-info">{{ 'metrics.empty' | transloco }}</div>
      }
    } @else {
      @let pct = usagePct();
      <div class="stat-grid">
        <div class="stat-card">
          <div class="stat-label">{{ 'metrics.stat.totalUsed' | transloco }}</div>
          <div class="stat-value">{{ fmt(data()!.usageGiB.total) }}</div>
          <div class="stat-sub">{{ 'metrics.stat.unit' | transloco }}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">{{ 'metrics.stat.brain' | transloco }}</div>
          <div class="stat-value">{{ fmt(data()!.usageGiB.brain) }}</div>
          <div class="stat-sub">{{ 'metrics.stat.unit' | transloco }}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">{{ 'metrics.stat.files' | transloco }}</div>
          <div class="stat-value">{{ fmt(data()!.usageGiB.files) }}</div>
          <div class="stat-sub">{{ 'metrics.stat.unit' | transloco }}</div>
        </div>
        @if (totalHard(); as limit) {
          <div class="stat-card">
            <div class="stat-label">{{ 'metrics.stat.limit' | transloco }}</div>
            <div class="stat-value">{{ limit }}</div>
            <div class="stat-sub">{{ 'metrics.stat.unit' | transloco }}</div>
          </div>
        }
      </div>

      @if (totalHard(); as limit) {
        <div class="card" style="margin-bottom:20px;">
          <div class="row">
            <span class="label" style="display:inline-flex; align-items:center; gap:8px;">
              {{ 'metrics.bar.usage' | transloco }}
              @if (healthPill(); as h) { <app-status-pill [variant]="h.variant">{{ h.key | transloco }}</app-status-pill> }
            </span>
            <span class="value">{{ pct.toFixed(1) }}%</span>
          </div>
          <app-usage-bar
            [used]="data()!.usageGiB.total"
            [total]="limit"
            [warnAtPercent]="warnAtPercent()"
            style="display:block; margin:8px 0 6px;"
          />
          <div style="font-size:11px; color:var(--text-muted);">
            {{ fmt(data()!.usageGiB.total) }} of {{ limit }} GiB
          </div>
        </div>
      }

      <!-- Every configured limit, per area, with a pill on the ones the host has pinned. Previously
           only a single "total" number was even attempted, and it was read from a field that does not
           exist — so files/brain limits were invisible whether pinned or not. -->
      @if (limitRows().length > 0) {
        <div class="card" style="margin-bottom:20px;">
          @for (r of limitRows(); track r.area) {
            <div class="row">
              <span class="label" style="display:inline-flex; align-items:center; gap:8px;">
                {{ 'metrics.stat.' + r.area | transloco }}
                @if (r.pinned) {
                  <app-status-pill variant="env">{{ 'mediaProcessing.pill.env' | transloco }}</app-status-pill>
                }
              </span>
              <span class="value">{{ r.text }}</span>
            </div>
          }
        </div>
      }

      @if (totalHard()) {
        @if (pct >= 95) {
          <div class="alert alert-error">
            {{ 'metrics.alert.full' | transloco }}
          </div>
        } @else if (pct >= warnAtPercent()) {
          <div class="alert alert-warning">
            {{ 'metrics.alert.warning' | transloco }}
          </div>
        }
      }
    }
  `,
})
export class StorageComponent implements OnInit {
  private spacesApi = inject(SpacesApi);

  data = signal<StorageData | null>(null);
  loading = signal(true);
  /** Distinct from `!data()`: a load *failure*, so a successful-but-empty response isn't shown as an error. */
  error = signal(false);

  /**
   * The ceiling the usage bar is drawn against: the HARD total limit, falling back to the soft one.
   *
   * Hard is what actually refuses a write, so it is the honest denominator. Falling back to soft matters
   * because an operator may set a warning threshold and no hard cap, and drawing no bar at all in that
   * case is how this page ended up looking unconfigured in the first place.
   */
  totalHard = computed<number | undefined>(() => {
    const t = this.data()?.limits?.total;
    return t?.hardLimitGiB ?? t?.softLimitGiB;
  });

  /**
   * Where the bar turns amber: the soft limit expressed as a percentage of the hard one.
   *
   * Derived rather than configured. The old code read `limits.warnAtPercent`, which the server has never
   * sent — so it always fell through to a hard-coded 80% that had nothing to do with the operator's
   * actual soft limit. If soft is 80 GiB of a 100 GiB hard cap, the warning belongs at 80%, not at
   * whatever 80 happens to mean.
   */
  warnAtPercent = computed<number>(() => {
    const t = this.data()?.limits?.total;
    if (!t?.softLimitGiB || !t?.hardLimitGiB || t.hardLimitGiB <= 0) return 80;
    return Math.min(100, (t.softLimitGiB / t.hardLimitGiB) * 100);
  });

  /** One row per configured area, with whether the host pinned it from the environment. */
  limitRows = computed<{ area: string; text: string; pinned: boolean }[]>(() => {
    const lim = this.data()?.limits;
    if (!lim) return [];
    const locked = new Set(lim.lockedByInfra ?? []);
    const rows: { area: string; text: string; pinned: boolean }[] = [];
    for (const area of ['total', 'files', 'brain'] as const) {
      const v = lim[area];
      if (!v || (v.softLimitGiB === undefined && v.hardLimitGiB === undefined)) continue;
      const parts: string[] = [];
      if (v.softLimitGiB !== undefined) parts.push(`${v.softLimitGiB} GiB soft`);
      if (v.hardLimitGiB !== undefined) parts.push(`${v.hardLimitGiB} GiB hard`);
      rows.push({
        area,
        text: parts.join(' · '),
        pinned: locked.has(`${area}.softLimitGiB`) || locked.has(`${area}.hardLimitGiB`),
      });
    }
    return rows;
  });

  /** Derived from `data()` so it can never render a stale percentage against a prior/absent load. */
  usagePct = computed(() => {
    const limit = this.totalHard();
    const d = this.data();
    return limit && d ? (d.usageGiB.total / limit) * 100 : 0;
  });

  /** Storage health as a status pill — only meaningful when a limit is configured. */
  healthPill = computed<{ variant: StatusVariant; key: string } | null>(() => {
    if (!this.totalHard()) return null;
    const level = usageLevel(this.usagePct(), this.warnAtPercent());
    return {
      ok:     { variant: 'ok' as StatusVariant,    key: 'metrics.health.ok' },
      warn:   { variant: 'warn' as StatusVariant,  key: 'metrics.health.warn' },
      danger: { variant: 'error' as StatusVariant, key: 'metrics.health.full' },
    }[level];
  });

  ngOnInit(): void { this.load(); }

  load(): void {
    this.loading.set(true);
    this.error.set(false);
    this.spacesApi.listSpaces().subscribe({
      next: ({ storage }) => {
        this.data.set(storage ? (storage as StorageData) : null);
        this.loading.set(false);
      },
      error: () => { this.error.set(true); this.loading.set(false); },
    });
  }

  fmt(v: number): string { return v.toFixed(2); }
}
