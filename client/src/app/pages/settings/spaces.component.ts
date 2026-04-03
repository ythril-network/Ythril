import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService, Space } from '../../core/api.service';

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
          <label>Description (optional)</label>
          <textarea [(ngModel)]="form.description" name="description" placeholder="Surfaced to MCP clients as space-level instructions" maxlength="2000" rows="2" style="resize:vertical;"></textarea>
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
              <tr><th>Label</th><th>ID</th><th>Description</th><th>Min storage</th><th>Proxy</th><th>Built-in</th><th></th></tr>
            </thead>
            <tbody>
              @for (s of spaces(); track s.id) {
                <tr>
                  <td style="font-weight:500;">{{ s.label }}</td>
                  <td><span class="badge badge-gray mono">{{ s.id }}</span></td>
                  <td style="color:var(--text-muted); max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" [title]="s.description ?? ''">{{ s.description ?? '—' }}</td>
                  <td style="color:var(--text-muted)">{{ s.minGiB ? s.minGiB + ' GiB' : '—' }}</td>
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
                      <button class="icon-btn danger" aria-label="Delete space" (click)="deleteSpace(s)">✕</button>
                    }
                  </td>
                </tr>
              } @empty {
                <tr><td colspan="7">
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
  loading = signal(true);
  creating = signal(false);
  createError = signal('');
  form = { label: '', id: '', minGiB: null as number | null, description: '' };
  proxyForSelected: string[] = [];

  ngOnInit(): void { this.load(); }

  load(): void {
    this.loading.set(true);
    this.api.listSpaces().subscribe({
      next: ({ spaces }) => { this.spaces.set(spaces); this.loading.set(false); },
      error: () => this.loading.set(false),
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
        this.form = { label: '', id: '', minGiB: null, description: '' };
        this.proxyForSelected = [];
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
}
