import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService, Network, Space, SpaceStats } from '../../core/api.service';

@Component({
  selector: 'app-spaces',
  standalone: true,
  imports: [CommonModule, FormsModule],
  styles: [`
    .spaces-toggle-list {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 6px;
    }
    .space-toggle-item {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      cursor: pointer;
      font-size: 12px;
      background: var(--bg-surface);
      transition: background var(--transition), border-color var(--transition);
      user-select: none;
    }
    .space-toggle-item:hover { background: var(--bg-elevated); }
    .space-toggle-item input[type=checkbox] { width: 13px; height: 13px; margin: 0; flex-shrink: 0; }
    .space-toggle-item .space-id { color: var(--text-muted); font-size: 11px; font-family: var(--font-mono); }
  `],
  template: `
    <!-- Create space -->
    <div class="card" style="margin-bottom: 24px;">
      <div class="card-header">
        <div>
          <div class="card-title">Create space</div>
          <div class="card-subtitle">Spaces isolate brain and file storage.</div>
        </div>
      </div>

      @if (createError()) {
        <div class="alert alert-error">{{ createError() }}</div>
      }

      <form (ngSubmit)="createSpace()" style="display:flex; gap:12px; align-items:flex-end; flex-wrap:wrap;">
        <div class="field" style="flex:1; min-width:140px; margin-bottom:0;">
          <label>Label</label>
          <input type="text" [(ngModel)]="form.label" name="label" placeholder="Work" maxlength="200" required />
        </div>
        <div class="field" style="width:140px; margin-bottom:0;">
          <label>ID (optional)</label>
          <input type="text" [(ngModel)]="form.id" name="id" placeholder="work" pattern="[a-z0-9-]+" />
        </div>
        <div class="field" style="width:120px; margin-bottom:0;">
          <label>Min GiB</label>
          <input type="number" [(ngModel)]="form.minGiB" name="minGiB" min="0" step="0.1" placeholder="—" />
        </div>
        <div class="field" style="flex-basis:100%; margin-bottom:0;">
          <label>MCP Description (optional)</label>
          <textarea [(ngModel)]="form.description" name="description" placeholder="Instructions surfaced to MCP-connected AI clients for this space" maxlength="4000" rows="10" style="resize:vertical;"></textarea>
        </div>
        <div class="field" style="flex-basis:100%; margin-bottom:0;">
          <label>Proxy for (optional)</label>
          @if (spaces().length > 0) {
            <div class="spaces-toggle-list">
              @for (s of spaces(); track s.id) {
                <label class="space-toggle-item">
                  <input type="checkbox" [checked]="isProxyForSelected(s.id)" (change)="toggleProxyFor(s.id)" />
                  <span>{{ s.label }}</span>
                  <span class="space-id">{{ s.id }}</span>
                </label>
              }
            </div>
          } @else {
            <div style="font-size:12px; color:var(--text-muted); margin-top:4px;">No existing spaces to select.</div>
          }
        </div>
        <button class="btn-primary btn" type="submit" [disabled]="creating() || !form.label.trim()">
          @if (creating()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }
          Create
        </button>
      </form>
    </div>

    <!-- Space list -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">Spaces</div>
        <button class="btn-secondary btn btn-sm" (click)="load()">Refresh</button>
      </div>

      @if (loading()) {
        <div class="loading-overlay"><span class="spinner"></span></div>
      } @else {
        <div class="table-wrapper">
          <table>
            <thead>
              <tr><th>Label</th><th>ID</th><th>MCP Description</th><th>Min storage</th><th>Networks</th><th>Proxy</th><th>Built-in</th><th></th></tr>
            </thead>
            <tbody>
              @for (s of spaces(); track s.id) {
                <tr>
                  <td style="font-weight:500;">{{ s.label }}</td>
                  <td><span class="badge badge-gray mono">{{ s.id }}</span></td>
                  <td style="color:var(--text-muted); max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" [title]="s.description ?? ''">{{ s.description ?? '—' }}</td>
                  <td style="color:var(--text-muted)">{{ s.minGiB ? s.minGiB + ' GiB' : '—' }}</td>
                  <td>
                    @if (networksForSpace(s.id).length) {
                      @for (n of networksForSpace(s.id); track n.id) {
                        <span class="badge badge-gray" style="margin-right:4px;">{{ n.label }}</span>
                      }
                    } @else { <span style="color:var(--text-muted)">—</span> }
                  </td>
                  <td>
                    @if (s.proxyFor && s.proxyFor.length) {
                      @for (pid of s.proxyFor; track pid) {
                        <span class="badge badge-blue" style="margin-right:4px;">{{ pid }}</span>
                      }
                    } @else { <span style="color:var(--text-muted)">—</span> }
                  </td>
                  <td>
                    @if (s.builtIn) { <span class="badge badge-blue">built-in</span> }
                  </td>
                  <td style="display:flex; gap:6px;">
                    <button class="icon-btn" aria-label="Edit space" (click)="openEdit(s)" title="Edit label/description">✎</button>
                    <button class="icon-btn danger" aria-label="Wipe space" (click)="openWipe(s)" title="Wipe all space data">⊘</button>
                    @if (!s.builtIn) {
                      @if (renaming() === s.id) {
                        <form (ngSubmit)="submitRename(s)" style="display:inline-flex; gap:4px; align-items:center;">
                          <input type="text" [(ngModel)]="renameNewId" name="renameNewId" placeholder="new-id"
                            pattern="[a-z0-9-]+" maxlength="40" style="width:120px; padding:2px 6px; font-size:0.85rem;" required />
                          <button class="btn btn-primary btn-sm" type="submit" style="padding:2px 8px; font-size:0.8rem;">Save</button>
                          <button class="btn btn-secondary btn-sm" type="button" (click)="cancelRename()" style="padding:2px 8px; font-size:0.8rem;">Cancel</button>
                        </form>
                      } @else {
                        <button class="icon-btn" aria-label="Rename space" title="Rename" (click)="startRename(s)" style="margin-right:4px;">✎</button>
                        <button class="icon-btn danger" aria-label="Delete space" (click)="deleteSpace(s)">✕</button>
                      }
                    }
                  </td>
                </tr>
              } @empty {
                <tr><td colspan="8">
                  <div class="empty-state" style="padding:24px;"><h3>No spaces</h3></div>
                </td></tr>
              }
            </tbody>
          </table>
        </div>
      }
    </div>

    <!-- Edit space modal -->
    @if (editTarget()) {
      <div class="modal-backdrop" (click)="closeEdit()">
        <div class="modal" (click)="$event.stopPropagation()" style="min-width:360px; max-width:520px;">
          <div class="modal-header">
            <div class="card-title">Edit space</div>
            <button class="icon-btn" (click)="closeEdit()">✕</button>
          </div>
          @if (editError()) {
            <div class="alert alert-error" style="margin-bottom:12px;">{{ editError() }}</div>
          }
          <form (ngSubmit)="saveEdit()" style="display:flex; flex-direction:column; gap:12px;">
            <div class="field" style="margin-bottom:0;">
              <label>Label</label>
              <input type="text" [(ngModel)]="editForm.label" name="editLabel" maxlength="200" required />
            </div>
            <div class="field" style="margin-bottom:0;">
              <label>Description</label>
              <textarea [(ngModel)]="editForm.description" name="editDescription" maxlength="2000" rows="3" style="resize:vertical;" placeholder="Surfaced to MCP clients as space-level instructions"></textarea>
            </div>
            <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:4px;">
              <button type="button" class="btn btn-secondary" (click)="closeEdit()">Cancel</button>
              <button type="submit" class="btn btn-primary" [disabled]="saving() || !editForm.label.trim()">
                @if (saving()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }
                Save
              </button>
            </div>
          </form>
        </div>
      </div>
    }

    <!-- Wipe space confirmation modal -->
    @if (wipeTarget()) {
      <div class="modal-backdrop" (click)="closeWipe()">
        <div class="modal" (click)="$event.stopPropagation()" style="min-width:360px; max-width:480px;">
          <div class="modal-header">
            <div class="card-title" style="color:var(--danger)">⚠ Wipe space</div>
            <button class="icon-btn" (click)="closeWipe()">✕</button>
          </div>
          @if (wipeError()) {
            <div class="alert alert-error" style="margin-bottom:12px;">{{ wipeError() }}</div>
          }
          <p style="margin-bottom:12px;">
            This will permanently delete <strong>all data</strong> from
            <strong>{{ wipeTarget()!.label }}</strong> (<code>{{ wipeTarget()!.id }}</code>).
            The space itself and its configuration will be preserved.
          </p>
          @if (wipeStats()) {
            <div style="background:var(--bg-elevated); border:1px solid var(--border); border-radius:var(--radius-sm); padding:12px; margin-bottom:16px; font-size:13px;">
              <div style="font-weight:600; margin-bottom:8px; color:var(--text-muted);">Current counts</div>
              <div style="display:grid; grid-template-columns:1fr 1fr; gap:4px 16px;">
                <span>Memories</span><span style="font-family:var(--font-mono); text-align:right;">{{ wipeStats()!.memories }}</span>
                <span>Entities</span><span style="font-family:var(--font-mono); text-align:right;">{{ wipeStats()!.entities }}</span>
                <span>Edges</span><span style="font-family:var(--font-mono); text-align:right;">{{ wipeStats()!.edges }}</span>
                <span>Chrono</span><span style="font-family:var(--font-mono); text-align:right;">{{ wipeStats()!.chrono }}</span>
                <span>Files</span><span style="font-family:var(--font-mono); text-align:right;">{{ wipeStats()!.files }}</span>
              </div>
            </div>
          } @else if (wipeStatsLoading()) {
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:16px; color:var(--text-muted); font-size:13px;">
              <span class="spinner" style="width:14px;height:14px;border-width:2px;"></span> Loading counts…
            </div>
          }
          <div style="display:flex; gap:8px; justify-content:flex-end;">
            <button type="button" class="btn btn-secondary" (click)="closeWipe()" [disabled]="wiping()">Cancel</button>
            <button type="button" class="btn btn-danger" (click)="confirmWipe()" [disabled]="wiping()">
              @if (wiping()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }
              Wipe space
            </button>
          </div>
        </div>
      </div>
    }
  `,
})
export class SpacesComponent implements OnInit {
  private api = inject(ApiService);

  spaces = signal<Space[]>([]);
  networks = signal<Network[]>([]);
  loading = signal(true);
  creating = signal(false);
  createError = signal('');
  renaming = signal<string | null>(null);
  renameNewId = '';
  static readonly DEFAULT_MCP_DESC = [
    'MCP endpoint for this space. Available tools:',
    '',
    'Knowledge Graph — Memory:',
    '  remember(fact, entities?, tags?)        — store a fact with semantic embedding',
    '  recall(query, topK?)                    — semantic search in this space',
    '  recall_global(query, topK?)             — semantic search across all accessible spaces',
    '  update_memory(id, fact?, tags?, entityIds?) — update memory (re-embeds on fact change)',
    '  delete_memory(id)                       — delete memory (tombstone for sync)',
    '  query(collection, filter, projection?, limit?) — structured MongoDB query',
    '',
    'Knowledge Graph — Entities & Edges:',
    '  upsert_entity(name, type, tags?, properties?) — create/update named entity',
    '  upsert_edge(from, to, label, type?, weight?)  — create/update relationship edge',
    '',
    'Knowledge Graph — Chrono:',
    '  create_chrono(title, kind, startsAt, ...)  — create event/deadline/plan/prediction/milestone',
    '  update_chrono(id, ...)                     — update chronological entry',
    '  list_chrono(status?, kind?, limit?)         — list chrono entries',
    '',
    'Files:',
    '  read_file(path)             — read file contents',
    '  write_file(path, content)   — write file contents',
    '  list_dir(path?)             — list directory contents',
    '  delete_file(path)           — delete a file',
    '  create_dir(path)            — create directory tree',
    '  move_file(src, dst)         — move or rename file/directory',
    '',
    'Stats & Sync:',
    '  get_stats()                 — counts of memories, entities, edges, chrono',
    '  list_peers()                — list connected peer instances',
    '  sync_now(peerId?)           — trigger immediate sync cycle',
  ].join('\n');

  form = { label: '', id: '', minGiB: null as number | null, description: SpacesComponent.DEFAULT_MCP_DESC };
  proxyForSelected: string[] = [];

  editTarget = signal<Space | null>(null);
  editForm = { label: '', description: '' };
  saving = signal(false);
  editError = signal('');

  wipeTarget = signal<Space | null>(null);
  wipeStats = signal<SpaceStats | null>(null);
  wipeStatsLoading = signal(false);
  wiping = signal(false);
  wipeError = signal('');

  ngOnInit(): void { this.load(); }

  networksForSpace(spaceId: string): Network[] {
    return this.networks().filter(n => n.spaces.includes(spaceId));
  }

  load(): void {
    this.loading.set(true);
    this.api.listSpaces().subscribe({
      next: ({ spaces }) => { this.spaces.set(spaces); this.loading.set(false); },
      error: () => this.loading.set(false),
    });
    this.api.listNetworks().subscribe({
      next: ({ networks }) => this.networks.set(networks),
      error: () => {},
    });
  }

  isProxyForSelected(id: string): boolean {
    return this.proxyForSelected.includes(id);
  }

  toggleProxyFor(id: string): void {
    if (this.proxyForSelected.includes(id)) {
      this.proxyForSelected = this.proxyForSelected.filter(s => s !== id);
    } else {
      this.proxyForSelected = [...this.proxyForSelected, id];
    }
  }

  createSpace(): void {
    if (!this.form.label.trim()) return;
    this.creating.set(true);
    this.createError.set('');

    const body: { label: string; id?: string; minGiB?: number; description?: string; proxyFor?: string[] } = { label: this.form.label.trim() };
    if (this.form.id.trim()) body.id = this.form.id.trim();
    if (this.form.minGiB) body.minGiB = this.form.minGiB;
    if (this.form.description.trim()) body.description = this.form.description.trim();
    if (this.proxyForSelected.length) body.proxyFor = [...this.proxyForSelected];

    this.api.createSpace(body).subscribe({
      next: ({ space }) => {
        this.creating.set(false);
        this.spaces.update(list => [...list, space]);
        this.form = { label: '', id: '', minGiB: null, description: SpacesComponent.DEFAULT_MCP_DESC };
        this.proxyForSelected = [];
      },
      error: (err) => {
        this.creating.set(false);
        this.createError.set(err.error?.error ?? 'Failed to create space');
      },
    });
  }

  openEdit(s: Space): void {
    this.editTarget.set(s);
    this.editForm = { label: s.label, description: s.description ?? '' };
    this.editError.set('');
  }

  closeEdit(): void {
    this.editTarget.set(null);
    this.editError.set('');
  }

  saveEdit(): void {
    const target = this.editTarget();
    if (!target || !this.editForm.label.trim()) return;
    this.saving.set(true);
    this.editError.set('');

    const body: { label?: string; description?: string } = {};
    if (this.editForm.label.trim() !== target.label) body.label = this.editForm.label.trim();
    const newDesc = this.editForm.description.trim();
    const oldDesc = target.description ?? '';
    if (newDesc !== oldDesc) body.description = newDesc;

    if (Object.keys(body).length === 0) {
      this.saving.set(false);
      this.closeEdit();
      return;
    }

    this.api.updateSpace(target.id, body).subscribe({
      next: ({ space }) => {
        this.saving.set(false);
        this.spaces.update(list => list.map(s => s.id === space.id ? { ...s, ...space } : s));
        this.closeEdit();
      },
      error: (err) => {
        this.saving.set(false);
        this.editError.set(err.error?.error ?? 'Failed to update space');
      },
    });
  }

  deleteSpace(s: Space): void {
    if (!confirm(`Delete space "${s.label}" (${s.id})? All brain data and files in this space will be permanently removed.`)) return;
    this.api.deleteSpace(s.id).subscribe({
      next: () => this.spaces.update(list => list.filter(x => x.id !== s.id)),
      error: () => alert('Failed to delete space.'),
    });
  }

  startRename(s: Space): void {
    this.renaming.set(s.id);
    this.renameNewId = s.id;
  }

  cancelRename(): void {
    this.renaming.set(null);
    this.renameNewId = '';
  }

  submitRename(s: Space): void {
    const newId = this.renameNewId.trim();
    if (!newId || newId === s.id) { this.cancelRename(); return; }
    if (!confirm(`Rename space "${s.label}" from "${s.id}" to "${newId}"? All data and network references will be updated.`)) return;

    this.api.renameSpace(s.id, newId).subscribe({
      next: ({ space }) => {
        this.spaces.update(list => list.map(x => x.id === s.id ? space : x));
        this.renaming.set(null);
        this.renameNewId = '';
        // Refresh networks to pick up updated references
        this.api.listNetworks().subscribe({
          next: ({ networks }) => this.networks.set(networks),
          error: () => {},
        });
      },
      error: (err) => {
        alert(err.error?.error ?? 'Failed to rename space.');
      },
    });
  }

  openWipe(s: Space): void {
    this.wipeTarget.set(s);
    this.wipeStats.set(null);
    this.wipeError.set('');
    this.wipeStatsLoading.set(true);
    this.api.getSpaceStats(s.id).subscribe({
      next: (stats) => { this.wipeStats.set(stats); this.wipeStatsLoading.set(false); },
      error: () => this.wipeStatsLoading.set(false),
    });
  }

  closeWipe(): void {
    if (this.wiping()) return;
    this.wipeTarget.set(null);
    this.wipeStats.set(null);
    this.wipeError.set('');
  }

  confirmWipe(): void {
    const target = this.wipeTarget();
    if (!target) return;
    this.wiping.set(true);
    this.wipeError.set('');
    this.api.wipeSpace(target.id).subscribe({
      next: () => {
        this.wiping.set(false);
        this.closeWipe();
      },
      error: (err) => {
        this.wiping.set(false);
        this.wipeError.set(err.error?.error ?? 'Failed to wipe space');
      },
    });
  }
}
