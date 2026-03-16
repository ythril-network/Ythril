import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService, Space, FileEntry } from '../../core/api.service';

interface BreadcrumbSegment { label: string; path: string; }

@Component({
  selector: 'app-file-manager',
  standalone: true,
  imports: [CommonModule, FormsModule],
  styles: [`
    .toolbar {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 16px;
      flex-wrap: wrap;
    }

    .breadcrumb {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 13px;
      flex: 1;
      flex-wrap: wrap;
    }

    .breadcrumb-sep { color: var(--text-muted); }

    .breadcrumb-item {
      color: var(--accent);
      cursor: pointer;
      border: none;
      background: none;
      font-size: 13px;
      font-family: var(--font);
      padding: 0;
    }
    .breadcrumb-item:hover { text-decoration: underline; }
    .breadcrumb-item.current { color: var(--text-primary); cursor: default; }
    .breadcrumb-item.current:hover { text-decoration: none; }

    .file-icon { width: 20px; text-align: center; flex-shrink: 0; }

    .file-name-btn {
      background: none;
      border: none;
      color: var(--text-primary);
      cursor: pointer;
      font-size: 13px;
      font-family: var(--font);
      text-align: left;
      padding: 0;
    }
    .file-name-btn.dir { color: var(--info); font-weight: 500; }
    .file-name-btn:hover { text-decoration: underline; }

    .upload-zone {
      border: 2px dashed var(--border);
      border-radius: var(--radius-md);
      padding: 24px;
      text-align: center;
      color: var(--text-muted);
      margin-bottom: 16px;
      transition: border-color var(--transition);
      cursor: pointer;
    }
    .upload-zone:hover, .upload-zone.drag-over {
      border-color: var(--accent);
      color: var(--text-secondary);
    }

    .rename-form { display: flex; gap: 6px; align-items: center; }

    .space-selector {
      display: flex;
      gap: 8px;
      margin-bottom: 20px;
      flex-wrap: wrap;
    }
  `],
  template: `
    <div class="page-header">
      <h1 class="page-title">Files</h1>
      <p class="page-subtitle">Browse and manage files across your spaces.</p>
    </div>

    @if (loadingSpaces()) {
      <div class="loading-overlay"><span class="spinner"></span></div>
    } @else {

      <!-- Space selector -->
      <div class="space-selector">
        @for (s of spaces(); track s.id) {
          <button
            class="btn"
            [class.btn-primary]="activeSpaceId() === s.id"
            [class.btn-secondary]="activeSpaceId() !== s.id"
            (click)="selectSpace(s.id)"
          >{{ s.label }}</button>
        }
      </div>

      @if (activeSpaceId()) {
        <!-- Toolbar -->
        <div class="toolbar">
          <div class="breadcrumb">
            @for (seg of breadcrumbs(); track seg.path; let last = $last) {
              <button
                class="breadcrumb-item"
                [class.current]="last"
                (click)="navigate(seg.path)"
              >{{ seg.label }}</button>
              @if (!last) { <span class="breadcrumb-sep">/</span> }
            }
          </div>

          <!-- New folder -->
          @if (!showNewFolder()) {
            <button class="btn-secondary btn btn-sm" (click)="showNewFolder.set(true)">+ New folder</button>
          } @else {
            <form class="rename-form" (ngSubmit)="createFolder()">
              <input type="text" [(ngModel)]="newFolderName" name="fn" placeholder="Folder name" style="width:160px" />
              <button class="btn-primary btn btn-sm" type="submit">Create</button>
              <button class="btn-ghost btn btn-sm" type="button" (click)="showNewFolder.set(false)">Cancel</button>
            </form>
          }

          <!-- Upload -->
          <label class="btn-secondary btn btn-sm" style="cursor:pointer">
            ↑ Upload
            <input type="file" multiple hidden (change)="onFileInput($event)" />
          </label>
        </div>

        <!-- Upload progress -->
        @if (uploading()) {
          <div class="alert alert-info">Uploading…</div>
        }
        @if (uploadError()) {
          <div class="alert alert-error">{{ uploadError() }}</div>
        }

        <!-- File listing -->
        @if (loading()) {
          <div class="loading-overlay"><span class="spinner"></span></div>
        } @else {
          <div class="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th style="width:24px"></th>
                  <th>Name</th>
                  <th>Size</th>
                  <th>Modified</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                @for (entry of entries(); track entry.name) {
                  <tr>
                    <td><span class="file-icon">{{ entry.isDirectory ? '📁' : '📄' }}</span></td>
                    <td>
                      @if (renamingEntry() === entry.name) {
                        <form class="rename-form" (ngSubmit)="confirmRename(entry)">
                          <input type="text" [(ngModel)]="renameValue" name="rn" style="width:200px" />
                          <button class="btn-primary btn btn-sm" type="submit">Save</button>
                          <button class="btn-ghost btn btn-sm" type="button" (click)="renamingEntry.set('')">Cancel</button>
                        </form>
                      } @else {
                        <button
                          class="file-name-btn"
                          [class.dir]="entry.isDirectory"
                          (click)="open(entry)"
                        >{{ entry.name }}</button>
                      }
                    </td>
                    <td style="color:var(--text-muted)">
                      {{ entry.isDirectory ? '—' : formatSize(entry.size) }}
                    </td>
                    <td style="color:var(--text-muted)">{{ entry.modified | date:'MMM d, y HH:mm' }}</td>
                    <td style="display:flex; gap:6px; align-items:center;">
                      @if (entry.isFile) {
                        <a
                          class="btn-ghost btn btn-sm"
                          [href]="downloadUrl(entry)"
                          download
                        >↓</a>
                      }
                      <button class="btn-ghost btn btn-sm" (click)="startRename(entry)">Rename</button>
                      <button class="icon-btn danger" (click)="deleteEntry(entry)">✕</button>
                    </td>
                  </tr>
                } @empty {
                  <tr><td colspan="5">
                    <div class="empty-state" style="padding:32px">
                      <div class="empty-state-icon">📂</div>
                      <h3>Empty folder</h3>
                      <p>Upload files or create a folder.</p>
                    </div>
                  </td></tr>
                }
              </tbody>
            </table>
          </div>
        }
      }
    }
  `,
})
export class FileManagerComponent implements OnInit {
  private api = inject(ApiService);

  spaces = signal<Space[]>([]);
  activeSpaceId = signal('');
  currentPath = signal('/');
  entries = signal<FileEntry[]>([]);
  loading = signal(false);
  loadingSpaces = signal(true);
  uploading = signal(false);
  uploadError = signal('');

  showNewFolder = signal(false);
  newFolderName = '';

  renamingEntry = signal('');
  renameValue = '';

  breadcrumbs = signal<BreadcrumbSegment[]>([{ label: 'root', path: '/' }]);

  ngOnInit(): void {
    this.api.listSpaces().subscribe({
      next: ({ spaces }) => {
        this.spaces.set(spaces);
        this.loadingSpaces.set(false);
        if (spaces.length > 0) this.selectSpace(spaces[0].id);
      },
      error: () => this.loadingSpaces.set(false),
    });
  }

  selectSpace(id: string): void {
    this.activeSpaceId.set(id);
    this.currentPath.set('/');
    this.updateBreadcrumbs('/');
    this.loadDir('/');
  }

  navigate(path: string): void {
    this.currentPath.set(path);
    this.updateBreadcrumbs(path);
    this.loadDir(path);
  }

  open(entry: FileEntry): void {
    if (entry.isDirectory) {
      const next = this.join(this.currentPath(), entry.name);
      this.navigate(next);
    }
    // Files: download handled via anchor link
  }

  private loadDir(path: string): void {
    this.loading.set(true);
    this.api.listFiles(this.activeSpaceId(), path).subscribe({
      next: ({ entries }) => {
        this.entries.set(entries);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  onFileInput(event: Event): void {
    const files = (event.target as HTMLInputElement).files;
    if (!files || files.length === 0) return;

    this.uploading.set(true);
    this.uploadError.set('');

    const formData = new FormData();
    for (let i = 0; i < files.length; i++) {
      formData.append('files', files[i]);
    }

    this.api.uploadFile(this.activeSpaceId(), this.currentPath(), formData).subscribe({
      next: () => {
        this.uploading.set(false);
        this.loadDir(this.currentPath());
      },
      error: (err) => {
        this.uploading.set(false);
        this.uploadError.set(err.error?.error ?? 'Upload failed');
      },
    });
  }

  createFolder(): void {
    if (!this.newFolderName.trim()) return;
    const path = this.join(this.currentPath(), this.newFolderName.trim());
    this.api.createDir(this.activeSpaceId(), path).subscribe({
      next: () => {
        this.newFolderName = '';
        this.showNewFolder.set(false);
        this.loadDir(this.currentPath());
      },
    });
  }

  startRename(entry: FileEntry): void {
    this.renamingEntry.set(entry.name);
    this.renameValue = entry.name;
  }

  confirmRename(entry: FileEntry): void {
    const from = this.join(this.currentPath(), entry.name);
    const parentDir = this.currentPath();
    const to = this.join(parentDir, this.renameValue.trim());
    this.api.moveFile(this.activeSpaceId(), from, to).subscribe({
      next: () => {
        this.renamingEntry.set('');
        this.loadDir(this.currentPath());
      },
    });
  }

  deleteEntry(entry: FileEntry): void {
    if (!confirm(`Delete "${entry.name}"?`)) return;
    const path = this.join(this.currentPath(), entry.name);
    this.api.deleteFile(this.activeSpaceId(), path).subscribe({
      next: () => this.loadDir(this.currentPath()),
    });
  }

  downloadUrl(entry: FileEntry): string {
    const path = this.join(this.currentPath(), entry.name);
    return this.api.getFileDownloadUrl(this.activeSpaceId(), path);
  }

  formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  private join(base: string, name: string): string {
    return base.endsWith('/') ? `${base}${name}` : `${base}/${name}`;
  }

  private updateBreadcrumbs(path: string): void {
    const parts = path.split('/').filter(Boolean);
    const crumbs: BreadcrumbSegment[] = [{ label: 'root', path: '/' }];
    let accumulated = '/';
    for (const p of parts) {
      accumulated = accumulated.endsWith('/') ? `${accumulated}${p}` : `${accumulated}/${p}`;
      crumbs.push({ label: p, path: accumulated });
    }
    this.breadcrumbs.set(crumbs);
  }
}
