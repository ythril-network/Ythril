import { Component, inject, signal, OnInit } from '@angular/core';
import { ApiService, type AboutInfo } from '../../core/api.service';
import { TranslocoPipe } from '@jsverse/transloco';

@Component({
  selector: 'app-about',
  standalone: true,
  imports: [TranslocoPipe],
  styles: `
    .about-grid {
      display: grid;
      grid-template-columns: 160px 1fr;
      gap: 8px 16px;
      margin-bottom: 24px;
    }
    .about-label { color: var(--text-muted); font-weight: 500; }
    .about-value { font-weight: 400; }
    .mono { font-family: var(--font-mono, monospace); font-size: 0.9em; }

    .disk-bar-container {
      width: 100%;
      max-width: 400px;
      height: 20px;
      background: var(--bg-muted);
      border-radius: 4px;
      overflow: hidden;
      position: relative;
    }
    .disk-bar-fill {
      height: 100%;
      background: var(--accent);
      transition: width 0.3s;
    }
    .disk-bar-fill.warn { background: var(--warning); }
    .disk-bar-fill.critical { background: var(--error); }
    .disk-bar-text {
      position: absolute;
      top: 0; left: 8px; right: 0; bottom: 0;
      display: flex;
      align-items: center;
      font-size: 0.75em;
      font-weight: 600;
      color: var(--text-on-accent);
    }

    .error-msg { color: var(--error); margin-top: 12px; }
  `,
  template: `
    @if (loading()) {
      <p>{{ 'common.loading' | transloco }}</p>
    } @else if (error()) {
      <p class="error-msg">{{ error() }}</p>
    } @else if (info(); as i) {
      <div class="about-grid">
        <span class="about-label">{{ 'about.instanceLabel' | transloco }}</span>
        <span class="about-value">{{ i.instanceLabel }}</span>

        <span class="about-label">{{ 'about.instanceId' | transloco }}</span>
        <span class="about-value mono">{{ i.instanceId }}</span>

        <span class="about-label">{{ 'about.version' | transloco }}</span>
        <span class="about-value mono">{{ i.version }}</span>

        <span class="about-label">{{ 'about.uptime' | transloco }}</span>
        <span class="about-value">{{ i.uptime }}</span>

        <span class="about-label">{{ 'about.mongoVersion' | transloco }}</span>
        <span class="about-value mono">{{ i.mongoVersion }}</span>

        <span class="about-label">{{ 'about.diskUsage' | transloco }}</span>
        <span class="about-value">
          <div class="disk-bar-container">
            <div class="disk-bar-fill"
                 [class.warn]="diskPercent() >= 75 && diskPercent() < 90"
                 [class.critical]="diskPercent() >= 90"
                 [style.width.%]="diskPercent()"></div>
            <span class="disk-bar-text">
              {{ formatBytes(i.diskInfo.used) }} / {{ formatBytes(i.diskInfo.total) }}
              ({{ diskPercent().toFixed(1) }}%)
            </span>
          </div>
        </span>
      </div>
    }
  `,
})
export class AboutComponent implements OnInit {
  private api = inject(ApiService);

  loading = signal(true);
  error = signal('');
  info = signal<AboutInfo | null>(null);
  diskPercent = signal(0);

  ngOnInit(): void { this.load(); }

  private load(): void {
    this.loading.set(true);
    this.api.getAbout().subscribe({
      next: (data) => {
        this.info.set(data);
        const d = data.diskInfo;
        this.diskPercent.set(d.total > 0 ? (d.used / d.total) * 100 : 0);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(err?.error?.error ?? 'Failed to load about info');
        this.loading.set(false);
      },
    });
  }

  formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
  }
}
