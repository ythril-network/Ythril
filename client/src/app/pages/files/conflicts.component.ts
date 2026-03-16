import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ApiService, ConflictRecord } from '../../core/api.service';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-conflicts',
  standalone: true,
  imports: [CommonModule, RouterLink],
  template: `
    <div class="page-header" style="display:flex; align-items:center; gap:12px;">
      <div>
        <h1 class="page-title">File Conflicts</h1>
        <p class="page-subtitle">Resolve files that diverged during sync.</p>
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
      <div class="alert alert-warning">
        {{ conflicts().length }} conflict{{ conflicts().length === 1 ? '' : 's' }} detected.
        Download both versions, decide which to keep, then dismiss the conflict record.
      </div>

      <div class="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>Original path</th>
              <th>Conflict copy</th>
              <th>Peer</th>
              <th>Detected</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            @for (c of conflicts(); track c.id) {
              <tr>
                <td class="mono" style="font-size:12px">{{ c.originalPath }}</td>
                <td class="mono" style="font-size:12px">{{ c.conflictPath }}</td>
                <td><span class="badge badge-blue mono">{{ c.peerInstanceId.slice(0, 8) }}</span></td>
                <td style="color:var(--text-muted)">{{ c.detectedAt | date:'MMM d, y HH:mm' }}</td>
                <td>
                  <button class="btn-secondary btn btn-sm" (click)="dismiss(c)">Dismiss</button>
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    }
  `,
})
export class ConflictsComponent implements OnInit {
  private api = inject(ApiService);

  loading = signal(true);
  conflicts = signal<ConflictRecord[]>([]);

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
    if (!confirm('Dismiss this conflict record?')) return;
    this.api.resolveConflict(c.id).subscribe({
      next: () => this.conflicts.update(list => list.filter(x => x.id !== c.id)),
    });
  }
}
