import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ApiService } from '../../core/api.service';
import { TranslocoPipe } from '@jsverse/transloco';

interface StorageData {
  usageGiB: { files: number; brain: number; total: number };
  limits?: { totalLimitGiB?: number; warnAtPercent?: number };
}

@Component({
  selector: 'app-storage',
  standalone: true,
  imports: [CommonModule, TranslocoPipe],
  styles: [`
    .usage-bar-track {
      height: 8px;
      background: var(--bg-elevated);
      border-radius: 4px;
      overflow: hidden;
      margin-top: 6px;
    }

    .usage-bar-fill {
      height: 100%;
      background: var(--accent);
      border-radius: 4px;
      transition: width 0.4s ease;
    }

    .usage-bar-fill.warn { background: var(--warning); }
    .usage-bar-fill.danger { background: var(--error); }

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

    <button class="btn-secondary btn btn-sm" style="margin-bottom:20px;" (click)="load()">{{ 'metrics.refreshButton' | transloco }}</button>

    @if (loading()) {
      <div class="loading-overlay"><span class="spinner"></span></div>
    } @else if (!data()) {
      <div class="alert alert-error">{{ 'metrics.error.load' | transloco }}</div>
    } @else {
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
        @if (data()!.limits?.totalLimitGiB) {
          <div class="stat-card">
            <div class="stat-label">{{ 'metrics.stat.limit' | transloco }}</div>
            <div class="stat-value">{{ data()!.limits!.totalLimitGiB }}</div>
            <div class="stat-sub">{{ 'metrics.stat.unit' | transloco }}</div>
          </div>
        }
      </div>

      @if (data()!.limits?.totalLimitGiB) {
        @let pct = usagePct();
        <div class="card" style="margin-bottom:20px;">
          <div class="row">
            <span class="label">{{ 'metrics.bar.usage' | transloco }}</span>
            <span class="value">{{ pct.toFixed(1) }}%</span>
          </div>
          <div class="usage-bar-track">
            <div
              class="usage-bar-fill"
              [class.warn]="pct >= (data()!.limits?.warnAtPercent ?? 80)"
              [class.danger]="pct >= 95"
              [style.width.%]="Math.min(pct, 100)"
            ></div>
          </div>
          <div style="font-size:11px; color:var(--text-muted); margin-top:6px;">
            {{ fmt(data()!.usageGiB.total) }} of {{ data()!.limits!.totalLimitGiB }} GiB
          </div>
        </div>
      }

      @if (pct >= 95) {
        <div class="alert alert-error">
          {{ 'metrics.alert.full' | transloco }}
        </div>
      } @else if (pct >= (data()?.limits?.warnAtPercent ?? 80)) {
        <div class="alert alert-warning">
          {{ 'metrics.alert.warning' | transloco }}
        </div>
      }
    }
  `,
})
export class StorageComponent implements OnInit {
  private api = inject(ApiService);
  protected Math = Math;

  data = signal<StorageData | null>(null);
  loading = signal(true);
  pct = 0;

  ngOnInit(): void { this.load(); }

  load(): void {
    this.loading.set(true);
    this.api.listSpaces().subscribe({
      next: ({ storage }) => {
        if (storage) {
          this.data.set(storage as StorageData);
          const limit = storage.limits?.totalLimitGiB;
          this.pct = limit ? (storage.usageGiB.total / limit) * 100 : 0;
        }
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  usagePct(): number { return this.pct; }

  fmt(v: number): string { return v.toFixed(2); }
}
