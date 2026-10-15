import { Component, inject, signal, computed, OnInit } from '@angular/core';
import { type AboutInfo, type HealthSummary, type ComponentHealth } from '../../core/api.types';
import { AdminApi } from '../../core/admin-api.service';
import { TranslocoPipe } from '@jsverse/transloco';
import { RouterLink } from '@angular/router';
import { SettingsCardComponent } from '../../shared/settings-card.component';
import { StatusPillComponent, type StatusVariant } from '../../shared/status-pill.component';
import { UsageBarComponent, usageLevel } from '../../shared/usage-bar.component';
import { ErrorStateComponent } from '../../shared/error-state.component';
import { refusalText } from '../../core/refusal-text';
import { TranslocoService } from '@jsverse/transloco';

@Component({
  selector: 'app-about',
  standalone: true,
  imports: [TranslocoPipe, RouterLink, SettingsCardComponent, StatusPillComponent, UsageBarComponent, ErrorStateComponent],
  styles: `
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 16px;
      align-items: stretch;
    }
    /* Uniform card size: stretch each card to fill its (equal-height) grid row. The host becomes a
       grid so its single .card child fills the row height — scoped to About, the shared SettingsCard
       is untouched. */
    .grid app-settings-card { display: grid; }
    .kv { display: grid; grid-template-columns: minmax(84px, 132px) 1fr; gap: 7px 14px; font-size: 13px; }
    .kv .k { color: var(--text-secondary); }
    .kv .v { color: var(--text-primary); word-break: break-word; }
    .mono { font-family: var(--font-mono, monospace); font-size: 0.9em; }

    .disk { margin-top: 14px; }
    .disk-fig {
      display: flex; justify-content: space-between; align-items: baseline;
      font-size: 12px; color: var(--text-secondary); margin-bottom: 6px;
    }
    .disk-fig .pct { font-weight: 600; color: var(--text-primary); font-variant-numeric: tabular-nums; }

    .components { display: flex; flex-direction: column; gap: 10px; }
    .component-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .component-label { font-size: 13px; color: var(--text-primary); }
    .component-impact {
      margin: 4px 0 0; font-size: 12px; line-height: 1.45; color: var(--text-secondary);
      border-left: 2px solid var(--danger, #f85149); padding-left: 8px;
    }
  `,
  template: `
    @if (loading()) {
      <p>{{ 'common.loading' | transloco }}</p>
    } @else if (error()) {
      <app-error-state
        [message]="'about.error.load' | transloco"
        [reason]="error()"
        (retry)="reload()" />
    } @else if (info(); as i) {
      <div class="grid">
        <app-settings-card icon="info"
                           [heading]="'about.card.instance' | transloco"
                           [purpose]="'about.card.instanceDesc' | transloco">
          <app-status-pill pill variant="active" [dot]="true">{{ 'about.status.online' | transloco }}</app-status-pill>
          <div class="kv">
            <span class="k">{{ 'about.instanceLabel' | transloco }}</span>
            <span class="v">{{ i.instanceLabel }}</span>

            <span class="k">{{ 'about.instanceId' | transloco }}</span>
            <span class="v mono">{{ i.instanceId }}</span>

            <span class="k">{{ 'about.version' | transloco }}</span>
            <span class="v mono">{{ i.version }}</span>

            @if (i.publicUrl) {
              <span class="k">{{ 'about.publicUrl' | transloco }}</span>
              <span class="v mono">{{ i.publicUrl }}</span>
            }
          </div>
        </app-settings-card>

        <app-settings-card icon="database"
                           [heading]="'about.card.system' | transloco"
                           [purpose]="'about.card.systemDesc' | transloco">
          <app-status-pill pill [variant]="diskHealth().variant" [dot]="true">{{ diskHealth().label | transloco }}</app-status-pill>
          <div class="kv">
            <span class="k">{{ 'about.mongoVersion' | transloco }}</span>
            <span class="v mono">{{ i.mongoVersion }}</span>

            <span class="k">{{ 'about.uptime' | transloco }}</span>
            <span class="v">{{ i.uptime }}</span>
          </div>

          <div class="disk">
            <div class="disk-fig">
              <span>{{ 'about.dataUsage' | transloco }}</span>
              <span>{{ formatBytes(i.diskInfo.dataUsed) }}</span>
            </div>
            <div class="disk-fig">
              <span>{{ 'about.diskUsage' | transloco }}</span>
              <span><span class="pct">{{ diskPercent().toFixed(1) }}%</span> · {{ formatBytes(i.diskInfo.used) }} / {{ formatBytes(i.diskInfo.total) }}</span>
            </div>
            <app-usage-bar [used]="i.diskInfo.used" [total]="i.diskInfo.total" [warnAtPercent]="80" />
          </div>
        </app-settings-card>

        <!-- Optional components.
             This used to render nothing at all until the probe answered, for a stated reason that was
             half right: an empty card filling in a moment later reads as "nothing configured", which is
             a different claim entirely. True — but the remedy was wrong. Rendering NOTHING makes the
             card appear out of nowhere seconds after the page settles, and the owner reported exactly
             that. A pending state claims neither: the card is there, and it says it is still looking. -->
        @if (!health()) {
          <app-settings-card icon="broadcast"
                             [heading]="'about.card.components' | transloco"
                             [purpose]="'about.card.componentsDesc' | transloco">
            <app-status-pill pill variant="warn" [dot]="true">{{ 'about.components.pending' | transloco }}</app-status-pill>
          </app-settings-card>
        }
        @if (health(); as h) {
          <app-settings-card icon="broadcast"
                             [heading]="'about.card.components' | transloco"
                             [purpose]="'about.card.componentsDesc' | transloco">
            <app-status-pill pill [variant]="healthPill().variant" [dot]="true">{{ healthPill().label | transloco }}</app-status-pill>
            <div class="components">
              @for (c of h.components; track c.id) {
                <div class="component" [class.is-down]="c.configured && c.reachable === false">
                  <div class="component-head">
                    <span class="component-label">{{ c.label }}</span>
                    <app-status-pill [variant]="componentVariant(c)" [dot]="true">
                      {{ componentLabel(c) | transloco }}
                    </app-status-pill>
                  </div>
                  <!-- The impact line is shown ONLY when something is actually broken. Printing it for a
                       healthy component turns the panel into a wall of warnings nobody reads. -->
                  @if (c.configured && c.reachable === false) {
                    <p class="component-impact">{{ c.impact }}</p>
                  }
                </div>
              }
            </div>
          </app-settings-card>
        }

        <!-- The guides ship WITH the instance, so About — the page people already open when they want to
             know what this thing is — is where the pointer to them belongs. -->
        <app-settings-card icon="question"
                           [heading]="'about.card.help' | transloco"
                           [purpose]="'about.card.helpDesc' | transloco">
          <a class="btn btn-sm btn-secondary" routerLink="/settings/help">{{ 'about.openHelp' | transloco }}</a>
        </app-settings-card>
      </div>
    }
  `,
})
export class AboutComponent implements OnInit {
  private adminApi = inject(AdminApi);
  private transloco = inject(TranslocoService);

  loading = signal(true);
  error = signal('');
  info = signal<AboutInfo | null>(null);
  diskPercent = signal(0);

  /**
   * Disk health for the System-card pill. Derived from the SAME `usageLevel` classifier the shared
   * UsageBar uses (warn ≥ 80%, danger ≥ 95%), so the pill and the bar can never disagree and the
   * signal reads identically to the Storage page.
   */
  diskHealth = computed<{ variant: StatusVariant; label: string }>(() => {
    switch (usageLevel(this.diskPercent(), 80)) {
      case 'danger': return { variant: 'error', label: 'about.disk.critical' };
      case 'warn':   return { variant: 'warn',  label: 'about.disk.high' };
      default:       return { variant: 'ok',    label: 'about.disk.healthy' };
    }
  });

  health = signal<HealthSummary | null>(null);

  /**
   * Pill for the components card.
   *
   * `unknown` is warn, not error: it means a probe could not run, which is a different thing from a
   * component that answered and failed. Showing it as an error would train people to ignore the colour.
   */
  healthPill = computed<{ variant: StatusVariant; label: string }>(() => {
    switch (this.health()?.level) {
      case 'degraded': return { variant: 'error', label: 'about.health.degraded' };
      case 'unknown':  return { variant: 'warn',  label: 'about.health.unknown' };
      default:         return { variant: 'ok',    label: 'about.health.ok' };
    }
  });

  /** Per-component pill. An unconfigured component reads as `off` — not a fault, it was never asked for. */
  componentVariant(c: ComponentHealth): StatusVariant {
    if (!c.configured) return 'off';
    if (c.reachable === false) return 'error';
    if (c.reachable === null) return 'warn';
    return 'ok';
  }

  componentLabel(c: ComponentHealth): string {
    if (!c.configured) return 'about.health.notConfigured';
    if (c.reachable === false) return 'about.health.unreachable';
    if (c.reachable === null) return 'about.health.unknown';
    return 'about.health.reachable';
  }

  ngOnInit(): void { this.load(); }

  reload(): void { this.load(); }

  private load(): void {
    this.loading.set(true);
    this.error.set('');
    this.adminApi.getAbout().subscribe({
      next: (data) => {
        this.info.set(data);
        const d = data.diskInfo;
        this.diskPercent.set(d.total > 0 ? (d.used / d.total) * 100 : 0);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(refusalText(this.transloco, err, 'about.error.load'));
        this.loading.set(false);
      },
    });

    // Separate request, deliberately not awaited with the one above: component probes can take a
    // moment, and the whole page should not wait on them. A failure here leaves the card unrendered
    // rather than erroring the page — the rest of About is still worth showing.
    this.adminApi.getAboutHealth().subscribe({
      next: (h) => this.health.set(h),
      error: () => this.health.set(null),
    });
  }

  formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
  }
}
