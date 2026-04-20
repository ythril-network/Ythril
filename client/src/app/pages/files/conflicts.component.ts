import { Component, inject, signal, OnInit } from '@angular/core';
import { DatePipe, SlicePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService, ConflictRecord } from '../../core/api.service';
import { RouterLink } from '@angular/router';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';

type ResolveAction = 'keep-local' | 'keep-incoming' | 'keep-both' | 'save-to-space';

@Component({
  selector: 'app-conflicts',
  standalone: true,
  imports: [DatePipe, SlicePipe, RouterLink, FormsModule, PhIconComponent, TranslocoPipe],
  template: `
    <div style="display:flex; justify-content:flex-end; margin-bottom:12px;">
      <a routerLink="/files" class="btn-secondary btn btn-sm"><ph-icon name="arrow-left" [size]="14"/> {{ 'conflicts.backToFiles' | transloco }}</a>
    </div>

    @if (loading()) {
      <div class="loading-overlay"><span class="spinner"></span></div>
    } @else if (conflicts().length === 0) {
      <div class="empty-state">
        <div class="empty-state-icon"><ph-icon name="check-circle" [size]="48"/></div>
          <h3>{{ 'conflicts.empty.title' | transloco }}</h3>
          <p>{{ 'conflicts.empty.body' | transloco }}</p>
      </div>
    } @else {
      <div class="alert alert-warning" style="margin-bottom:16px;">
        {{ 'conflicts.unresolvedCount' | transloco: { count: conflicts().length } }}
      </div>

      <!-- Bulk action bar -->
      @if (conflicts().length > 1) {
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:12px; padding:8px 12px; background:var(--bg-secondary); border-radius:8px;">
          <label style="display:flex; align-items:center; gap:4px; cursor:pointer;">
            <input type="checkbox" [checked]="allSelected()" (change)="toggleSelectAll()"/>
            <span style="font-size:13px">{{ 'conflicts.selectAll' | transloco }}</span>
          </label>
          <span style="flex:1"></span>
          @if (selectedIds().length > 0) {
            <select [(ngModel)]="bulkAction" [attr.aria-label]="'conflicts.bulkActionAriaLabel' | transloco" style="font-size:13px; padding:4px 8px; border:1px solid var(--border-color); border-radius:4px; background:var(--bg-primary);">
              <option value="keep-local">{{ 'conflicts.action.keepLocal' | transloco }}</option>
              <option value="keep-incoming">{{ 'conflicts.action.keepIncoming' | transloco }}</option>
              <option value="keep-both">{{ 'conflicts.action.keepBoth' | transloco }}</option>
            </select>
            <button class="btn btn-sm btn-primary" (click)="bulkResolve()"
                    [disabled]="bulkResolving()">
              {{ bulkResolving() ? ('conflicts.resolving' | transloco) : ('conflicts.resolveSelected' | transloco: { count: selectedIds().length }) }}
            </button>
          }
        </div>
      }

      <div class="table-wrapper">
        <table>
          <thead>
            <tr>
              <th style="width:30px"></th>
              <th>{{ 'conflicts.table.space' | transloco }}</th>
              <th>{{ 'conflicts.table.localFile' | transloco }}</th>
              <th>{{ 'conflicts.table.incomingFile' | transloco }}</th>
              <th>{{ 'conflicts.table.fromPeer' | transloco }}</th>
              <th>{{ 'conflicts.table.detected' | transloco }}</th>
              <th>{{ 'conflicts.table.action' | transloco }}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            @for (c of conflicts(); track c.id) {
              <tr>
                <td>
                  <input type="checkbox" [checked]="selectedIds().includes(c.id)"
                         (change)="toggleSelect(c.id)"/>
                </td>
                <td><span class="badge badge-blue mono">{{ c.spaceId }}</span></td>
                <td class="mono" style="font-size:12px">{{ c.originalPath }}</td>
                <td class="mono" style="font-size:12px; color:var(--text-muted)">{{ c.conflictPath }}</td>
                <td>
                  <span title="{{ c.peerInstanceId }}" class="mono" style="font-size:12px">
                    {{ c.peerInstanceLabel || (c.peerInstanceId | slice:0:8) }}
                  </span>
                </td>
                <td style="color:var(--text-muted); white-space:nowrap">
                  {{ c.detectedAt | date:'dd.MM.yyyy HH:mm' }}
                </td>
                <td>
                  <select [(ngModel)]="conflictActions[c.id]"
                          [attr.aria-label]="'conflicts.resolveActionAriaLabel' | transloco"
                          style="font-size:12px; padding:2px 6px; border:1px solid var(--border-color); border-radius:4px; background:var(--bg-primary);">
                    <option value="keep-local">{{ 'conflicts.action.keepLocal' | transloco }}</option>
                    <option value="keep-incoming">{{ 'conflicts.action.keepIncoming' | transloco }}</option>
                    <option value="keep-both">{{ 'conflicts.action.keepBoth' | transloco }}</option>
                    <option value="save-to-space">{{ 'conflicts.action.saveToSpace' | transloco }}</option>
                  </select>
                  @if (conflictActions[c.id] === 'save-to-space') {
                    <select [(ngModel)]="conflictTargetSpace[c.id]"
                            [attr.aria-label]="'conflicts.targetSpaceAriaLabel' | transloco"
                            style="margin-left:4px; font-size:12px; padding:2px 6px; border:1px solid var(--border-color); border-radius:4px; background:var(--bg-primary);">
                      @for (s of spaces(); track s.id) {
                        @if (s.id !== c.spaceId) {
                          <option [value]="s.id">{{ s.label || s.id }}</option>
                        }
                      }
                    </select>
                  }
                </td>
                <td style="white-space:nowrap">
                  <button class="btn-primary btn btn-sm" (click)="resolve(c)"
                          [disabled]="resolving() === c.id">
                    {{ resolving() === c.id ? ('conflicts.resolving' | transloco) : ('conflicts.resolveButton' | transloco) }}
                  </button>
                  <button class="btn-secondary btn btn-sm" style="margin-left:4px"
                          (click)="dismiss(c)" [disabled]="resolving() === c.id"
                      [attr.title]="'conflicts.dismissTitle' | transloco" [attr.aria-label]="'conflicts.dismissAriaLabel' | transloco"><ph-icon name="x" [size]="16"/></button>
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
  private transloco = inject(TranslocoService);

  loading = signal(true);
  conflicts = signal<ConflictRecord[]>([]);
  resolving = signal<string | null>(null);
  bulkResolving = signal(false);
  selectedIds = signal<string[]>([]);
  spaces = signal<{ id: string; label: string }[]>([]);

  conflictActions: Record<string, ResolveAction> = {};
  conflictTargetSpace: Record<string, string> = {};
  bulkAction: ResolveAction = 'keep-local';

  ngOnInit(): void {
    this.load();
    this.api.listSpaces().subscribe({
      next: (r) => this.spaces.set(r.spaces || []),
      error: () => {},
    });
  }

  allSelected(): boolean {
    return this.conflicts().length > 0 && this.selectedIds().length === this.conflicts().length;
  }

  toggleSelectAll(): void {
    if (this.allSelected()) {
      this.selectedIds.set([]);
    } else {
      this.selectedIds.set(this.conflicts().map(c => c.id));
    }
  }

  toggleSelect(id: string): void {
    this.selectedIds.update(ids =>
      ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]
    );
  }

  private load(): void {
    this.loading.set(true);
    this.api.listConflicts().subscribe({
      next: ({ conflicts }) => {
        this.conflicts.set(conflicts);
        for (const c of conflicts) {
          if (!this.conflictActions[c.id]) this.conflictActions[c.id] = 'keep-local';
        }
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  resolve(c: ConflictRecord): void {
    const action = this.conflictActions[c.id] || 'keep-local';
    const opts: { targetSpaceId?: string } = {};
    if (action === 'save-to-space') {
      opts.targetSpaceId = this.conflictTargetSpace[c.id];
      if (!opts.targetSpaceId) {
        alert(this.transloco.translate('conflicts.error.selectTargetSpace'));
        return;
      }
    }
    this.resolving.set(c.id);
    this.api.resolveConflict(c.id, action, opts).subscribe({
      next: () => {
        this.conflicts.update(list => list.filter(x => x.id !== c.id));
        this.selectedIds.update(ids => ids.filter(x => x !== c.id));
        this.resolving.set(null);
      },
      error: () => this.resolving.set(null),
    });
  }

  dismiss(c: ConflictRecord): void {
    this.resolving.set(c.id);
    this.api.dismissConflict(c.id).subscribe({
      next: () => {
        this.conflicts.update(list => list.filter(x => x.id !== c.id));
        this.selectedIds.update(ids => ids.filter(x => x !== c.id));
        this.resolving.set(null);
      },
      error: () => this.resolving.set(null),
    });
  }

  bulkResolve(): void {
    const ids = this.selectedIds();
    if (ids.length === 0) return;
    const confirmMsg = this.transloco.translate('conflicts.confirm.bulkResolve', {
      count: ids.length,
      action: this.bulkAction,
    });
    if (!confirm(confirmMsg)) return;
    this.bulkResolving.set(true);
    this.api.bulkResolveConflicts(ids, this.bulkAction).subscribe({
      next: (r) => {
        const resolvedSet = new Set(ids.filter(id => !r.failed.some(f => f.id === id)));
        this.conflicts.update(list => list.filter(x => !resolvedSet.has(x.id)));
        this.selectedIds.update(sel => sel.filter(x => !resolvedSet.has(x)));
        this.bulkResolving.set(false);
        if (r.failed.length > 0) {
          const details = r.failed.map(f => `${f.id}: ${f.error}`).join('\n');
          const summary = this.transloco.translate('conflicts.error.bulkResolveFailedSummary', {
            resolved: r.resolved,
            failed: r.failed.length,
          });
          alert(`${summary}\n${details}`);
        }
      },
      error: () => this.bulkResolving.set(false),
    });
  }
}
