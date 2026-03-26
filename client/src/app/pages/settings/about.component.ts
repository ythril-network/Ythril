import { Component, inject, signal, OnInit, OnDestroy, ElementRef, viewChild } from '@angular/core';
import { ApiService, type AboutInfo } from '../../core/api.service';

@Component({
  selector: 'app-about',
  standalone: true,
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
      background: var(--bg-muted, #333);
      border-radius: 4px;
      overflow: hidden;
      position: relative;
    }
    .disk-bar-fill {
      height: 100%;
      background: var(--color-accent, #4fc3f7);
      transition: width 0.3s;
    }
    .disk-bar-fill.warn { background: #ff9800; }
    .disk-bar-fill.critical { background: #f44336; }
    .disk-bar-text {
      position: absolute;
      top: 0; left: 8px; right: 0; bottom: 0;
      display: flex;
      align-items: center;
      font-size: 0.75em;
      font-weight: 600;
      color: #fff;
    }

    .log-viewer {
      background: var(--bg-muted, #1e1e1e);
      border: 1px solid var(--border-color, #444);
      border-radius: 6px;
      padding: 12px;
      font-family: var(--font-mono, monospace);
      font-size: 0.8em;
      line-height: 1.5;
      max-height: 400px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .log-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
    }
    .log-header h3 { margin: 0; }
    .refresh-btn {
      background: none;
      border: 1px solid var(--border-color, #555);
      color: var(--text-color);
      padding: 4px 10px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.85em;
    }
    .refresh-btn:hover { background: var(--bg-hover, #333); }

    .error-msg { color: var(--color-error, #f44336); margin-top: 12px; }
  `,
  template: `
    @if (loading()) {
      <p>Loading…</p>
    } @else if (error()) {
      <p class="error-msg">{{ error() }}</p>
    } @else if (info(); as i) {
      <div class="about-grid">
        <span class="about-label">Instance Label</span>
        <span class="about-value">{{ i.instanceLabel }}</span>

        <span class="about-label">Instance ID</span>
        <span class="about-value mono">{{ i.instanceId }}</span>

        <span class="about-label">Version</span>
        <span class="about-value mono">{{ i.version }}</span>

        <span class="about-label">Uptime</span>
        <span class="about-value">{{ i.uptime }}</span>

        <span class="about-label">MongoDB Version</span>
        <span class="about-value mono">{{ i.mongoVersion }}</span>

        <span class="about-label">Disk Usage</span>
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

      <div class="log-header">
        <h3>Server Log</h3>
        <button class="refresh-btn" (click)="loadLogs()">Refresh</button>
      </div>
      <div class="log-viewer" #logViewer>{{ logText() }}</div>
    }
  `,
})
export class AboutComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);
  private logViewerRef = viewChild<ElementRef<HTMLDivElement>>('logViewer');

  loading = signal(true);
  error = signal('');
  info = signal<AboutInfo | null>(null);
  logText = signal('');
  diskPercent = signal(0);

  private refreshInterval: ReturnType<typeof setInterval> | undefined;

  ngOnInit(): void {
    this.load();
    this.refreshInterval = setInterval(() => this.loadLogs(), 15_000);
  }

  ngOnDestroy(): void {
    if (this.refreshInterval) clearInterval(this.refreshInterval);
  }

  private load(): void {
    this.loading.set(true);
    this.api.getAbout().subscribe({
      next: (data) => {
        this.info.set(data);
        const d = data.diskInfo;
        this.diskPercent.set(d.total > 0 ? (d.used / d.total) * 100 : 0);
        this.loading.set(false);
        this.loadLogs();
      },
      error: (err) => {
        this.error.set(err?.error?.error ?? 'Failed to load about info');
        this.loading.set(false);
      },
    });
  }

  loadLogs(): void {
    this.api.getAboutLogs(200).subscribe({
      next: (data) => {
        this.logText.set(data.lines.join('\n'));
        setTimeout(() => {
          const el = this.logViewerRef()?.nativeElement;
          if (el) el.scrollTop = el.scrollHeight;
        });
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
