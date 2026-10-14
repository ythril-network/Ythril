import { Component, inject, signal, OnInit } from '@angular/core';
import { SlicePipe } from '@angular/common';
import { InstantComponent } from '../../shared/instant.component';
import { FormsModule } from '@angular/forms';
import { ConflictRecord } from '../../core/api.types';
import { FilesApi } from '../../core/files-api.service';
import { SpacesApi } from '../../core/spaces-api.service';
import { RouterLink } from '@angular/router';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { ToastService } from '../../core/toast.service';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import { HscrollTopDirective } from '../../shared/hscroll-top.directive';
import { ErrorStateComponent } from '../../shared/error-state.component';
import { httpErrorReason } from '../../core/http-error';
import { refusalText } from '../../core/refusal-text';

type ResolveAction = 'keep-local' | 'keep-incoming' | 'keep-both' | 'save-to-space';

/**
 * The family of translation keys a refused conflict resolution names: `conflicts.refusal.<code>`. A prefix, not a key: the code
 * arrives with the answer. Its own family and not `files.refusal`, because its sentences are about a CONFLICT ("nothing was
 * moved", "choose another name or space") and the Files page's are about a file the operator moved.
 */
export const CONFLICT_REFUSAL_PREFIX = 'conflicts.refusal';

/** The label of each action, so a sentence that names the action the operator chose says the label and never the code. */
const ACTION_LABEL_KEYS: Record<ResolveAction, string> = {
  'keep-local': 'conflicts.action.keepLocal',
  'keep-incoming': 'conflicts.action.keepIncoming',
  'keep-both': 'conflicts.action.keepBoth',
  'save-to-space': 'conflicts.action.saveToSpace',
};

@Component({
  selector: 'app-conflicts',
  standalone: true,
  imports: [InstantComponent, SlicePipe, RouterLink, FormsModule, PhIconComponent, TranslocoPipe, HscrollTopDirective, ErrorStateComponent],
  template: `
    <div style="display:flex; justify-content:flex-end; margin-bottom:12px;">
      <!-- The Files tab of the Brain: there is no /files route any more, and the old link led to a page that no longer shows the files. -->
      <a routerLink="/brain" [queryParams]="{ tab: 'files' }" class="btn-secondary btn btn-sm"><ph-icon name="arrow-left" [size]="14"/> {{ 'conflicts.backToFiles' | transloco }}</a>
    </div>

    @if (loading()) {
      <div class="loading-overlay"><span class="spinner"></span></div>
    } @else if (loadError() !== null) {
      <!-- Before the empty state, and deliberately: that empty state is a green "All clear", which is the
           worst possible thing to show when we do not actually know whether there are conflicts. -->
      <app-error-state [message]="'conflicts.loadError' | transloco" [reason]="loadError() ?? ''" (retry)="reload()" />
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
      @if (truncated()) {
        <div class="alert alert-info" style="margin-bottom:16px;">
          {{ 'conflicts.truncated' | transloco: { count: conflicts().length } }}
        </div>
      }

      <!-- Bulk action bar -->
      @if (conflicts().length > 1) {
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:12px; padding:8px 12px; background:var(--bg-secondary); border-radius:8px;">
          <label style="display:flex; align-items:center; gap:4px; cursor:pointer;">
            <input type="checkbox" [checked]="allSelected()" (change)="toggleSelectAll()"/>
            <span style="font-size:13px">{{ 'conflicts.selectAll' | transloco }}</span>
          </label>
          <span style="flex:1"></span>
          @if (selectedIds().length > 0) {
            <select [(ngModel)]="bulkAction" [attr.aria-label]="'conflicts.bulkActionAriaLabel' | transloco" style="width:auto;">
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

      <div class="table-wrapper" hscrollTop>
        <table>
          <thead>
            <tr>
              <th style="width:30px"><span class="sr-only">{{ 'conflicts.table.selectColumn' | transloco }}</span></th>
              <th>{{ 'conflicts.table.space' | transloco }}</th>
              <th>{{ 'conflicts.table.localFile' | transloco }}</th>
              <th>{{ 'conflicts.table.incomingFile' | transloco }}</th>
              <th>{{ 'conflicts.table.fromPeer' | transloco }}</th>
              <th>{{ 'conflicts.table.detected' | transloco }}</th>
              <th>{{ 'conflicts.table.action' | transloco }}</th>
              <th><span class="sr-only">{{ 'conflicts.resolveButton' | transloco }}</span></th>
            </tr>
          </thead>
          <tbody>
            @for (c of conflicts(); track c.id) {
              <tr>
                <td>
                  <input type="checkbox" [checked]="selectedIds().includes(c.id)"
                         [attr.aria-label]="'conflicts.table.select' | transloco: { path: c.originalPath, peer: peerName(c) }"
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
                  <app-instant [value]="c.detectedAt" variant="datetime"/>
                </td>
                <td>
                  <select [(ngModel)]="conflictActions[c.id]"
                          [attr.aria-label]="'conflicts.resolveActionAriaLabel' | transloco"
                          style="width:auto;">
                    <option value="keep-local">{{ 'conflicts.action.keepLocal' | transloco }}</option>
                    <option value="keep-incoming">{{ 'conflicts.action.keepIncoming' | transloco }}</option>
                    <option value="keep-both">{{ 'conflicts.action.keepBoth' | transloco }}</option>
                    <option value="save-to-space">{{ 'conflicts.action.saveToSpace' | transloco }}</option>
                  </select>
                  @if (conflictActions[c.id] === 'save-to-space') {
                    <select [(ngModel)]="conflictTargetSpace[c.id]"
                            [attr.aria-label]="'conflicts.targetSpaceAriaLabel' | transloco"
                            style="width:auto; margin-left:4px;">
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
  private filesApi = inject(FilesApi);
  private spacesApi = inject(SpacesApi);
  private transloco = inject(TranslocoService);
  private toast = inject(ToastService);
  private confirmDialog = inject(ConfirmDialogService);

  loading = signal(true);
  /** Null until the last load failed — checked before the empty state, so a failure never reads as "All clear". */
  loadError = signal<string | null>(null);
  conflicts = signal<ConflictRecord[]>([]);
  /** True when the server capped the list — the user is NOT seeing every conflict (resolve some to see more). */
  truncated = signal(false);
  resolving = signal<string | null>(null);
  bulkResolving = signal(false);
  selectedIds = signal<string[]>([]);
  spaces = signal<{ id: string; label: string }[]>([]);

  conflictActions: Record<string, ResolveAction> = {};
  conflictTargetSpace: Record<string, string> = {};
  bulkAction: ResolveAction = 'keep-local';

  ngOnInit(): void {
    this.load();
    this.spacesApi.listSpaces().subscribe({
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

  /** Public so the error state's Retry can re-run the load. */
  reload(): void {
    this.load();
  }

  private load(): void {
    this.loading.set(true);
    this.loadError.set(null);
    this.filesApi.listConflicts().subscribe({
      next: ({ conflicts, truncated }) => {
        this.conflicts.set(conflicts);
        this.truncated.set(truncated === true);
        for (const c of conflicts) {
          if (!this.conflictActions[c.id]) this.conflictActions[c.id] = 'keep-local';
        }
        this.loading.set(false);
      },
      error: (err) => { this.loadError.set(httpErrorReason(err)); this.loading.set(false); },
    });
  }

  /** The peer a conflict came from, as a reader knows it: its label, or the start of its id. */
  peerName(c: ConflictRecord): string {
    return c.peerInstanceLabel || c.peerInstanceId.slice(0, 8);
  }

  async resolve(c: ConflictRecord): Promise<void> {
    const action = this.conflictActions[c.id] || 'keep-local';
    const opts: { targetSpaceId?: string } = {};
    if (action === 'save-to-space') {
      opts.targetSpaceId = this.conflictTargetSpace[c.id];
      if (!opts.targetSpaceId) {
        this.toast.error(this.transloco.translate('conflicts.error.selectTargetSpace'));
        return;
      }
    }
    // Keep-incoming replaces the local file with the other copy and nothing brings it back: asked about, like a delete.
    if (action === 'keep-incoming') {
      const ok = await this.confirmDialog.confirm({
        title: this.transloco.translate('conflicts.confirm.keepIncomingTitle'),
        message: this.transloco.translate('conflicts.confirm.keepIncoming', { path: c.originalPath }),
        confirmLabel: this.transloco.translate(ACTION_LABEL_KEYS[action]),
        danger: true,
      });
      if (!ok) return;
    }
    this.resolving.set(c.id);
    this.filesApi.resolveConflict(c.id, action, opts).subscribe({
      next: (answer) => {
        this.conflicts.update(list => list.filter(x => x.id !== c.id));
        this.selectedIds.update(ids => ids.filter(x => x !== c.id));
        this.resolving.set(null);
        if (answer.resolved === 'nothing-to-place') {
          this.toast.info(this.transloco.translate('conflicts.resolved.gone'));
        } else if (action === 'save-to-space') {
          const target = this.spaces().find(s => s.id === opts.targetSpaceId);
          this.toast.success(this.transloco.translate('conflicts.resolved.movedToSpace', {
            space: target?.label || opts.targetSpaceId, path: c.originalPath,
          }));
        }
      },
      // A refusal says why and stays: it tells the operator what to do, and a toast that expires takes that with it. The record
      // stays in the list, because nothing was resolved.
      error: (err) => {
        this.resolving.set(null);
        this.toast.error(refusalText(this.transloco, err, 'conflicts.error.resolveFailed', CONFLICT_REFUSAL_PREFIX), 0);
      },
    });
  }

  async bulkResolve(): Promise<void> {
    const ids = this.selectedIds();
    if (ids.length === 0) return;
    const ok = await this.confirmDialog.confirm({
      title: this.transloco.translate('conflicts.confirm.bulkResolveTitle'),
      message: this.transloco.translate('conflicts.confirm.bulkResolve', {
        count: ids.length,
        action: this.transloco.translate(ACTION_LABEL_KEYS[this.bulkAction]),
      }),
    });
    if (!ok) return;
    this.bulkResolving.set(true);
    this.filesApi.bulkResolveConflicts(ids, this.bulkAction).subscribe({
      next: (r) => {
        // One line per failed record, written BEFORE the list drops the resolved ones: a failed item names its record by path
        // (the answer's own, else the conflict's), because an operator knows files and never a uuid.
        const details = r.failed.map(f => {
          const path = f.path ?? this.conflicts().find(c => c.id === f.id)?.originalPath ?? f.id;
          return `${path}: ${refusalText(this.transloco, { error: f }, 'conflicts.error.resolveFailed', CONFLICT_REFUSAL_PREFIX)}`;
        }).join('\n');
        const resolvedSet = new Set(ids.filter(id => !r.failed.some(f => f.id === id)));
        this.conflicts.update(list => list.filter(x => !resolvedSet.has(x.id)));
        this.selectedIds.update(sel => sel.filter(x => !resolvedSet.has(x)));
        this.bulkResolving.set(false);
        if (r.failed.length > 0) {
          const summary = this.transloco.translate('conflicts.error.bulkResolveFailedSummary', {
            resolved: r.resolved,
            failed: r.failed.length,
          });
          this.toast.error(`${summary}\n${details}`, 0);
        }
      },
      error: () => this.bulkResolving.set(false),
    });
  }
}
