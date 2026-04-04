import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService, Network, Space } from '../../core/api.service';

@Component({
  selector: 'app-spaces',
  standalone: true,
  imports: [CommonModule, FormsModule],
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
        <div class="field" style="flex:1; min-width:200px; margin-bottom:0;">
          <label>Proxy for (optional, comma-separated space IDs)</label>
          <input type="text" [(ngModel)]="form.proxyFor" name="proxyFor" placeholder="eng-kb, research" />
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
                  <td>
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

  form = { label: '', id: '', minGiB: null as number | null, description: SpacesComponent.DEFAULT_MCP_DESC, proxyFor: '' };

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

  createSpace(): void {
    if (!this.form.label.trim()) return;
    this.creating.set(true);
    this.createError.set('');

    const body: { label: string; id?: string; minGiB?: number; description?: string; proxyFor?: string[] } = { label: this.form.label.trim() };
    if (this.form.id.trim()) body.id = this.form.id.trim();
    if (this.form.minGiB) body.minGiB = this.form.minGiB;
    if (this.form.description.trim()) body.description = this.form.description.trim();
    const proxyIds = this.form.proxyFor.split(',').map(s => s.trim()).filter(Boolean);
    if (proxyIds.length) body.proxyFor = proxyIds;

    this.api.createSpace(body).subscribe({
      next: ({ space }) => {
        this.creating.set(false);
        this.spaces.update(list => [...list, space]);
        this.form = { label: '', id: '', minGiB: null, description: SpacesComponent.DEFAULT_MCP_DESC, proxyFor: '' };
      },
      error: (err) => {
        this.creating.set(false);
        this.createError.set(err.error?.error ?? 'Failed to create space');
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
}
