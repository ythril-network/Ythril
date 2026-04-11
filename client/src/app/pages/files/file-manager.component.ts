import { Component, inject, signal, OnInit, OnDestroy, HostListener, ElementRef, viewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { ApiService, Space, FileEntry, UploadProgress } from '../../core/api.service';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import json from 'highlight.js/lib/languages/json';
import yaml from 'highlight.js/lib/languages/yaml';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import plaintext from 'highlight.js/lib/languages/plaintext';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('python', python);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('plaintext', plaintext);

interface BreadcrumbSegment { label: string; path: string; }

interface TreeNode {
  name: string;
  path: string;
  expanded: boolean;
  loading: boolean;
  children: TreeNode[] | null;  // null = not yet loaded
}

type PreviewKind = 'text' | 'image' | 'pdf' | 'unknown';

const TEXT_EXTS = new Set([
  '.txt', '.md', '.json', '.yaml', '.yml', '.ts', '.js', '.py', '.sh',
  '.csv', '.xml', '.html', '.css', '.log', '.env', '.toml',
]);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp']);
const PDF_EXTS = new Set(['.pdf']);

const EXT_LANG: Record<string, string> = {
  '.js': 'javascript', '.ts': 'typescript', '.json': 'json',
  '.yaml': 'yaml', '.yml': 'yaml', '.xml': 'xml', '.html': 'xml',
  '.css': 'css', '.md': 'markdown', '.py': 'python',
  '.sh': 'bash', '.bash': 'bash',
};

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i).toLowerCase() : '';
}

function previewKind(name: string): PreviewKind {
  const ext = extOf(name);
  if (TEXT_EXTS.has(ext)) return 'text';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (PDF_EXTS.has(ext)) return 'pdf';
  return 'unknown';
}

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

    /* ── Preview pane ─────────────────────────────────────────── */
    .preview-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.5);
      z-index: 1000;
      display: flex;
      justify-content: flex-end;
    }
    .preview-pane {
      width: min(700px, 90vw);
      height: 100vh;
      background: var(--bg-surface, #1e1e1e);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      box-shadow: -4px 0 16px rgba(0,0,0,0.3);
    }
    .preview-header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 16px;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }
    .preview-header .file-title { flex: 1; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .preview-body {
      flex: 1;
      overflow: auto;
      padding: 16px;
    }
    .preview-body img {
      max-width: 100%;
      max-height: 80vh;
      object-fit: contain;
    }
    .preview-body iframe {
      width: 100%;
      height: 100%;
      border: none;
    }
    .preview-code {
      background: var(--bg-muted, #111);
      border-radius: 6px;
      padding: 16px;
      overflow: auto;
      font-family: var(--font-mono, monospace);
      font-size: 0.85em;
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .preview-code code { background: none; }
    .preview-meta { display: grid; grid-template-columns: 100px 1fr; gap: 6px 12px; }
    .preview-meta dt { color: var(--text-muted); font-weight: 500; }
    .preview-meta dd { margin: 0; }

    /* ── Sidebar + layout ─────────────────────────────────────── */
    .fm-layout {
      display: flex;
      gap: 0;
    }
    .fm-sidebar {
      width: 220px;
      flex-shrink: 0;
      border-right: 1px solid var(--border);
      padding: 8px 0;
      overflow-y: auto;
      max-height: calc(100vh - 180px);
    }
    .fm-main { flex: 1; min-width: 0; }
    .sidebar-toggle {
      background: none;
      border: 1px solid var(--border);
      color: var(--text-muted);
      padding: 2px 8px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      margin-left: auto;
    }
    .sidebar-toggle:hover { background: var(--bg-hover, #333); }

    .tree-node {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 3px 8px;
      cursor: pointer;
      font-size: 13px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      border-radius: 4px;
      margin: 0 4px;
    }
    .tree-node:hover { background: var(--bg-hover, #2a2a2a); }
    .tree-node.active { background: var(--accent-bg, rgba(79,195,247,0.15)); color: var(--accent); font-weight: 500; }
    .tree-caret {
      width: 16px;
      text-align: center;
      flex-shrink: 0;
      font-size: 10px;
      color: var(--text-muted);
      transition: transform 0.15s;
    }
    .tree-caret.expanded { transform: rotate(90deg); }
    .tree-children { padding-left: 12px; }
    .tree-spinner { font-size: 10px; color: var(--text-muted); padding: 2px 8px 2px 28px; }
  `],
  template: `
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
              <input type="text" [(ngModel)]="newFolderName" name="fn" placeholder="Folder name" aria-label="New folder name" style="width:160px" />
              <button class="btn-primary btn btn-sm" type="submit">Create</button>
              <button class="btn-ghost btn btn-sm" type="button" (click)="showNewFolder.set(false)">Cancel</button>
            </form>
          }

          <!-- Upload -->
          <label class="btn-secondary btn btn-sm" style="cursor:pointer">
            ↑ Upload
            <input type="file" multiple hidden (change)="onFileInput($event)" />
          </label>

          <button class="sidebar-toggle" (click)="toggleSidebar()">
            {{ sidebarOpen() ? '◀ Hide tree' : '▶ Show tree' }}
          </button>
        </div>

        <!-- Upload progress -->
        @if (uploading()) {
          <div class="alert alert-info" style="display:flex; align-items:center; gap:12px;">
            <span class="spinner"></span>
            <span>Uploading… {{ uploadPercent() }}%</span>
            <div style="flex:1; height:6px; background:var(--border); border-radius:3px; overflow:hidden;">
              <div [style.width.%]="uploadPercent()" style="height:100%; background:var(--accent); transition:width 0.2s;"></div>
            </div>
          </div>
        }
        @if (uploadError()) {
          <div class="alert alert-error">{{ uploadError() }}</div>
        }

        <div class="fm-layout">
          <!-- Directory tree sidebar -->
          @if (sidebarOpen()) {
            <div class="fm-sidebar">
              <ng-container *ngTemplateOutlet="treeTemplate; context: { $implicit: treeRoot() }"></ng-container>
            </div>
          }

          <!-- Main file listing -->
          <div class="fm-main" [class.drag-over]="dragOver()">
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
                          <input type="text" [(ngModel)]="renameValue" name="rn" aria-label="Rename entry" style="width:200px" />
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
                        <button class="btn-ghost btn btn-sm" (click)="openPreview(entry)" aria-label="Preview file" title="Preview">👁</button>
                        <a
                          class="btn-ghost btn btn-sm"
                          [href]="downloadUrl(entry)"
                          download
                          aria-label="Download file"
                        >↓</a>
                      }
                      <button class="btn-ghost btn btn-sm" (click)="startRename(entry)">Rename</button>
                      <button class="icon-btn danger" (click)="deleteEntry(entry)" aria-label="Delete entry">✕</button>
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
          </div><!-- .fm-main -->
        </div><!-- .fm-layout -->
      }
    }

    <!-- Recursive tree template -->
    <ng-template #treeTemplate let-nodes>
      @for (node of nodes; track node.path) {
        <div class="tree-node"
             [class.active]="currentPath() === node.path"
             (click)="onTreeClick(node)">
          <span class="tree-caret" [class.expanded]="node.expanded">▶</span>
          <span>📁 {{ node.name }}</span>
        </div>
        @if (node.loading) {
          <div class="tree-spinner">Loading…</div>
        }
        @if (node.expanded && node.children) {
          <div class="tree-children">
            <ng-container *ngTemplateOutlet="treeTemplate; context: { $implicit: node.children }"></ng-container>
          </div>
        }
      }
    </ng-template>

    <!-- Preview pane -->
    @if (previewFile(); as pf) {
      <div class="preview-overlay" (click)="closePreview()" (keydown)="onPreviewKey($event)" tabindex="0" #previewOverlay>
        <div class="preview-pane" (click)="$event.stopPropagation()">
          <div class="preview-header">
            <span class="file-title" [title]="pf.name">{{ pf.name }}</span>
            <a class="btn-secondary btn btn-sm" [href]="downloadUrl(pf)" download>↓ Download</a>
            <button class="icon-btn" (click)="closePreview()" aria-label="Close preview">✕</button>
          </div>
          <div class="preview-body">
            @switch (previewKind()) {
              @case ('text') {
                @if (previewLoading()) {
                  <div class="loading-overlay"><span class="spinner"></span></div>
                } @else {
                  <pre class="preview-code"><code [innerHTML]="previewHtml()"></code></pre>
                }
              }
              @case ('image') {
                <img [src]="previewMediaUrl()" [alt]="pf.name" />
              }
              @case ('pdf') {
                <iframe [src]="previewSafeUrl()"></iframe>
              }
              @default {
                <dl class="preview-meta">
                  <dt>Name</dt><dd>{{ pf.name }}</dd>
                  <dt>Size</dt><dd>{{ formatSize(pf.size) }}</dd>
                  <dt>Modified</dt><dd>{{ pf.modified | date:'MMM d, y HH:mm' }}</dd>
                </dl>
              }
            }
          </div>
        </div>
      </div>
    }
  `,
})
export class FileManagerComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);
  private sanitizer = inject(DomSanitizer);
  private route = inject(ActivatedRoute);
  private previewOverlayRef = viewChild<ElementRef<HTMLDivElement>>('previewOverlay');

  spaces = signal<Space[]>([]);
  activeSpaceId = signal('');
  currentPath = signal('/');
  entries = signal<FileEntry[]>([]);
  loading = signal(false);
  loadingSpaces = signal(true);
  uploading = signal(false);
  uploadError = signal('');
  uploadPercent = signal(0);

  dragOver = signal(false);

  showNewFolder = signal(false);
  newFolderName = '';

  renamingEntry = signal('');
  renameValue = '';

  breadcrumbs = signal<BreadcrumbSegment[]>([{ label: 'root', path: '/' }]);

  // ── Preview state ────────────────────────────────────────────────────────
  previewFile = signal<FileEntry | null>(null);
  previewKind = signal<PreviewKind>('unknown');
  previewHtml = signal('');
  previewLoading = signal(false);
  previewMediaUrl = signal('');
  previewSafeUrl = signal<SafeResourceUrl>('');

  // ── Tree sidebar state ───────────────────────────────────────────────────
  sidebarOpen = signal(localStorage.getItem('ythril.sidebar') !== 'closed');
  treeRoot = signal<TreeNode[]>([]);

  private _keyHandler = (e: KeyboardEvent) => this.onPreviewKey(e);

  ngOnInit(): void {
    const requestedSpace = this.route.snapshot.queryParamMap.get('space') ?? '';
    this.api.listSpaces().subscribe({
      next: ({ spaces }) => {
        this.spaces.set(spaces);
        this.loadingSpaces.set(false);
        if (spaces.length > 0) {
          const target = requestedSpace
            ? (spaces.find(s => s.id === requestedSpace) ?? spaces[0])
            : spaces[0];
          this.selectSpace(target.id);
        }
      },
      error: () => this.loadingSpaces.set(false),
    });
  }

  selectSpace(id: string): void {
    this.activeSpaceId.set(id);
    this.currentPath.set('/');
    this.updateBreadcrumbs('/');
    this.loadDir('/');
    this.loadTreeRoot();
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
    } else {
      this.openPreview(entry);
    }
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

  @HostListener('dragover', ['$event'])
  onDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.dragOver.set(true);
  }

  @HostListener('dragleave', ['$event'])
  onDragLeave(event: DragEvent): void {
    // Only clear when leaving the component boundary
    if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node)) {
      this.dragOver.set(false);
    }
  }

  @HostListener('drop', ['$event'])
  onDrop(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.dragOver.set(false);
    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) return;
    this.uploadFiles(files);
  }

  onFileInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = input.files;
    if (!files || files.length === 0) return;
    this.uploadFiles(files);
    input.value = '';
  }

  private uploadFiles(files: FileList): void {

    this.uploading.set(true);
    this.uploadError.set('');
    this.uploadPercent.set(0);

    let completed = 0;
    const total = files.length;

    const uploadNext = (index: number): void => {
      if (index >= total) {
        this.uploading.set(false);
        this.loadDir(this.currentPath());
        return;
      }
      const file = files[index];
      this.api.uploadFileChunked(this.activeSpaceId(), this.currentPath(), file).subscribe({
        next: (progress) => {
          const overallPercent = Math.round((completed * 100 + progress.percent) / total);
          this.uploadPercent.set(overallPercent);
        },
        error: (err) => {
          this.uploading.set(false);
          this.uploadError.set(err.error?.error ?? 'Upload failed');
        },
        complete: () => {
          completed++;
          if (completed >= total) {
            this.uploading.set(false);
            this.uploadPercent.set(100);
            this.loadDir(this.currentPath());
          } else {
            uploadNext(index + 1);
          }
        },
      });
    };

    uploadNext(0);
  }

  createFolder(): void {
    if (!this.newFolderName.trim()) return;
    const path = this.join(this.currentPath(), this.newFolderName.trim());
    this.api.createDir(this.activeSpaceId(), path).subscribe({
      next: () => {
        this.newFolderName = '';
        this.showNewFolder.set(false);
        this.loadDir(this.currentPath());
        this.loadTreeRoot();
      },
      error: () => alert('Failed to create folder.'),
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
      error: () => alert('Failed to rename file.'),
    });
  }

  deleteEntry(entry: FileEntry): void {
    if (!confirm(`Delete "${entry.name}"?`)) return;
    const path = this.join(this.currentPath(), entry.name);
    this.api.deleteFile(this.activeSpaceId(), path).subscribe({
      next: () => this.loadDir(this.currentPath()),
      error: () => alert('Failed to delete file.'),
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

  // ── Tree sidebar ─────────────────────────────────────────────────────────

  toggleSidebar(): void {
    const open = !this.sidebarOpen();
    this.sidebarOpen.set(open);
    localStorage.setItem('ythril.sidebar', open ? 'open' : 'closed');
    if (open && this.treeRoot().length === 0) this.loadTreeRoot();
  }

  private loadTreeRoot(): void {
    const spaceId = this.activeSpaceId();
    if (!spaceId) return;
    this.api.listFiles(spaceId, '/').subscribe({
      next: ({ entries }) => {
        this.treeRoot.set(
          entries
            .filter(e => e.isDirectory)
            .map(e => ({ name: e.name, path: this.join('/', e.name), expanded: false, loading: false, children: null })),
        );
      },
      error: () => {},
    });
  }

  onTreeClick(node: TreeNode): void {
    this.navigate(node.path);
    if (!node.expanded) {
      this.expandTreeNode(node);
    } else {
      node.expanded = false;
      this.treeRoot.set([...this.treeRoot()]);
    }
  }

  private expandTreeNode(node: TreeNode): void {
    if (node.children !== null) {
      node.expanded = true;
      this.treeRoot.set([...this.treeRoot()]);
      return;
    }
    node.loading = true;
    this.treeRoot.set([...this.treeRoot()]);
    this.api.listFiles(this.activeSpaceId(), node.path).subscribe({
      next: ({ entries }) => {
        node.children = entries
          .filter(e => e.isDirectory)
          .map(e => ({ name: e.name, path: this.join(node.path, e.name), expanded: false, loading: false, children: null }));
        node.loading = false;
        node.expanded = true;
        this.treeRoot.set([...this.treeRoot()]);
      },
      error: () => {
        node.loading = false;
        this.treeRoot.set([...this.treeRoot()]);
      },
    });
  }

  // ── Preview ──────────────────────────────────────────────────────────────

  openPreview(entry: FileEntry): void {
    const kind = previewKind(entry.name);
    this.previewFile.set(entry);
    this.previewKind.set(kind);
    this.previewHtml.set('');
    this.previewMediaUrl.set('');
    this.previewSafeUrl.set('');

    const url = this.downloadUrl(entry);

    if (kind === 'text') {
      this.previewLoading.set(true);
      fetch(url).then(r => r.text()).then(text => {
        const ext = extOf(entry.name);
        const lang = EXT_LANG[ext];
        let highlighted: string;
        if (lang) {
          highlighted = hljs.highlight(text, { language: lang }).value;
        } else {
          highlighted = hljs.highlight(text, { language: 'plaintext' }).value;
        }
        this.previewHtml.set(highlighted);
        this.previewLoading.set(false);
      }).catch(() => this.previewLoading.set(false));
    } else if (kind === 'image') {
      this.previewMediaUrl.set(url);
    } else if (kind === 'pdf') {
      this.previewSafeUrl.set(this.sanitizer.bypassSecurityTrustResourceUrl(url));
    }

    document.addEventListener('keydown', this._keyHandler);
    setTimeout(() => this.previewOverlayRef()?.nativeElement?.focus());
  }

  closePreview(): void {
    this.previewFile.set(null);
    document.removeEventListener('keydown', this._keyHandler);
  }

  onPreviewKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      this.closePreview();
      return;
    }
    const files = this.entries().filter(f => f.isFile);
    const current = this.previewFile();
    if (!current || files.length === 0) return;

    const idx = files.findIndex(f => f.name === current.name);
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      const next = files[(idx + 1) % files.length];
      this.openPreview(next);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const prev = files[(idx - 1 + files.length) % files.length];
      this.openPreview(prev);
    }
  }

  ngOnDestroy(): void {
    document.removeEventListener('keydown', this._keyHandler);
  }
}
