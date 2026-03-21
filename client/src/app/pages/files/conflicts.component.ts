import { Component, inject, signal, OnInit } from '@angular/core';
import { DatePipe, SlicePipe } from '@angular/common';
import { ApiService, ConflictRecord } from '../../core/api.service';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-conflicts',
  standalone: true,
  imports: [DatePipe, SlicePipe, RouterLink],
  template: `
    <div class="page-header" style="display:flex; align-items:center; gap:12px;">
      <div>
        <h1 class="page-title">File Conflicts</h1>
        <p class="page-subtitle">Files that diverged during sync. Download both versions, then dismiss.</p>
      </div>
      <span style="flex:1"></span>
      <a routerLink="/files" class="btn-secondary btn btn-sm">← Back to Files</a>
    </div>

    @if (loading()) {
      <div class="loading-overlay"><span class="spinner"></span></div>
    } @else if (conflicts().length === 0) {
      <div class="empty-state">
        <div class="empty-state-icon">✅</div>
        <h3>No conflicts</h3>
        <p>All synced files are in agreement.</p>
      </div>
    } @else {
      <div class="alert alert-warning" style="margin-bottom:16px;">
        {{ conflicts().length }} unresolved conflict{{ conflicts().length === 1 ? '' : 's' }}.
        Each conflict preserves both versions — your local copy is unchanged.
        Download the conflict copy if needed, then dismiss the record.
      </div>

      <div class="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>Space</th>
              <th>Your file (original)</th>
              <th>Incoming copy (conflict)</th>
              <th>From peer</th>
              <th>Detected</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            @for (c of conflicts(); track c.id) {
              <tr>
                <td><span class="badge badge-blue mono">{{ c.spaceId }}</span></td>
                <td class="mono" style="font-size:12px">{{ c.originalPath }}</td>
                <td class="mono" style="font-size:12px; color:var(--text-muted)">{{ c.conflictPath }}</td>
                <td>
                  <span title="{{ c.peerInstanceId }}" class="mono" style="font-size:12px">
                    {{ c.peerInstanceLabel || (c.peerInstanceId | slice:0:8) }}
                  </span>
                </td>
                <td style="color:var(--text-muted); white-space:nowrap">
                  {{ c.detectedAt | date:'MMM d, y HH:mm' }}
                </td>
                <td style="white-space:nowrap">
                  <button class="btn-secondary btn btn-sm" (click)="dismiss(c)"
                          [disabled]="dismissing() === c.id">
                    {{ dismissing() === c.id ? '…' : 'Dismiss' }}
                  </button>
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>

      @if (conflicts().length > 1) {
        <div style="margin-top:16px; display:flex; justify-content:flex-end;">
          <button class="btn-secondary btn btn-sm" (click)="dismissAll()"
                  [disabled]="dismissingAll()">
            {{ dismissingAll() ? 'Dismissing…' : 'Dismiss all' }}
          </button>
        </div>
      }
    }
  `,
})
export class ConflictsComponent implements OnInit {
  private api = inject(ApiService);

  loading = signal(true);
  conflicts = signal<ConflictRecord[]>([]);
  dismissing = signal<string | null>(null);
  dismissingAll = signal(false);

  ngOnInit(): void {
    this.load();
  }

  private load(): void {
    this.loading.set(true);
    this.api.listConflicts().subscribe({
      next: ({ conflicts }) => { this.conflicts.set(conflicts); this.loading.set(false); },
      error: () => this.loading.set(false),
    });
  }

  dismiss(c: ConflictRecord): void {
    this.dismissing.set(c.id);
    this.api.resolveConflict(c.id).subscribe({
      next: () => {
        this.conflicts.update(list => list.filter(x => x.id !== c.id));
        this.dismissing.set(null);
      },
      error: () => this.dismissing.set(null),
    });
  }

  dismissAll(): void {
    if (!confirm(`Dismiss all ${this.conflicts().length} conflict records?`)) return;
    this.dismissingAll.set(true);
    const ids = this.conflicts().map(c => c.id);
    let remaining = ids.length;
    for (const id of ids) {
      this.api.resolveConflict(id).subscribe({
        next: () => {
          this.conflicts.update(list => list.filter(x => x.id !== id));
          if (--remaining === 0) this.dismissingAll.set(false);
        },
        error: () => { if (--remaining === 0) this.dismissingAll.set(false); },
      });
    }
  }
}
