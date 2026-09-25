import { FileExtractStore } from './file-extract.store';
import { FileMetaStore } from './file-meta.store';
import { FileUploadStore } from './file-upload.store';
import { FilePreviewStore } from './file-preview.store';
import { ChangeDetectionStrategy, Component, inject, signal, computed, effect, untracked, OnInit, OnDestroy, HostListener, viewChild, Input, Output, EventEmitter } from '@angular/core';
import { FilePreviewComponent } from './file-preview.component';
import { UploadQueueComponent, type UploadItem } from './upload-queue.component';
import { FileMetaEditorComponent, type FileMetaModel } from './file-meta-editor.component';
import { FileExtractViewComponent } from './file-extract-view.component';
import { FileListingComponent, type FileRow } from './file-listing.component';
import { joinPath } from './file-format';
import { FileTreeComponent, type TreeNode } from './file-tree.component';
import { FileToolbarComponent, type BreadcrumbSegment } from './file-toolbar.component';
import { FileDetailPaneComponent, type DetailMode } from './file-detail-pane.component';
import { FileTreeStore } from './file-tree.store';
import { FileListingStore, LISTING_FAILURE_KEYS } from './file-listing.store';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { Space, FileEntry } from '../../core/api.types';
import { SpacesApi } from '../../core/spaces-api.service';
import { AuthService } from '../../core/auth.service';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ToastService } from '../../core/toast.service';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import { ErrorStateComponent } from '../../shared/error-state.component';
import { httpErrorReason } from '../../core/http-error';
// The docked detail pane reuses the Brain's file-metadata edit fields. These are dumb, shared
// ref-field widgets; they resolve chip labels via EntityRefPicker, which the Brain provides — so the
// "File meta" edit mode is available only when embedded in the Brain (embeddedSpaceId set).
import { EntityRefPicker } from '../brain/entity-ref-picker.service';
import { BrainStore } from '../brain/brain-store.service';
import { ModalDirective } from '../../shared/modal.directive';




@Component({
  selector: 'app-file-manager',
  standalone: true,
  // OnPush (P5): all rendered state is signal-backed (`entries`, `treeRoot`, `breadcrumbs`,
  // `previewFile`/`previewHtml`, upload progress, …). Every tree expansion mutates a node in place
  // but always follows with `treeRoot.set([...])` — a fresh reference that marks the view dirty —
  // and the async preview/upload callbacks update via signal `.set()`, which notifies OnPush
  // regardless of zone. Text fields (`newFolderName`, `renameValue`) are ngModel two-way bindings
  // whose input events mark the view dirty. So OnPush re-checks exactly when state changes.
  changeDetection: ChangeDetectionStrategy.OnPush,
  /*
   * Per PAGE, not per application. The tree belongs to the space this page is showing, so a singleton would
   * carry one space's directories into the next — and leaving the page must forget them, which a page-scoped
   * provider does for free.
   */
  providers: [FileTreeStore, FileListingStore, FileExtractStore, FileMetaStore, FileUploadStore, FilePreviewStore],
  imports: [CommonModule, FormsModule, PhIconComponent, TranslocoPipe, ErrorStateComponent, ModalDirective, FilePreviewComponent, UploadQueueComponent, FileMetaEditorComponent, FileExtractViewComponent, FileListingComponent, FileTreeComponent, FileToolbarComponent, FileDetailPaneComponent],
  styles: [`
    /* A background refresh, as a 2px indeterminate hairline above the table. Deliberately NOT a spinner and
       deliberately not an overlay: the whole point is that nothing on screen moves or disappears while a poll
       is in flight. It reserves its own 2px so the table does not shift when it appears.
       NO BACKTICKS anywhere in this block — it is one template string. */
    .fm-refreshing {
      height: 2px;
      margin-bottom: 6px;
      border-radius: 2px;
      overflow: hidden;
      background: color-mix(in srgb, var(--accent) 14%, transparent);
    }
    .fm-refreshing::after {
      content: '';
      display: block;
      width: 34%;
      height: 100%;
      border-radius: 2px;
      background: var(--accent);
      animation: fm-slide 1.1s ease-in-out infinite;
    }
    @keyframes fm-slide {
      0%   { transform: translateX(-100%); }
      100% { transform: translateX(300%); }
    }
    /* Honesty when a poll fails: the rows stay, but they are no longer claimed to be current. */
    .fm-stale {
      font-size: 12px;
      color: var(--warning, var(--text-muted));
      margin-bottom: 6px;
    }
    @media (prefers-reduced-motion: reduce) {
      .fm-refreshing::after { animation: none; width: 100%; opacity: .5; }
    }

    /* .upload-zone was here and matched NOTHING: no element in the client carries the class, and the drop
       target is .fm-main with a drag-over class binding. The #1099 commit message called it "the drop target
       on the page" as the reason for leaving it behind, which was wrong twice over — it is not the drop target
       and it was not doing anything. Deleted rather than moved. */

    /* ── Upload queue panel (U12) ─────────────────────────────── */

    /* THE MERMAID RULE IS NOT HERE ANY MORE, and it never worked here.
       A diagram is inline SVG inside markdown bound with [innerHTML] in file-preview.component.ts, so a
       rule declared on this page could not reach it — no error, just a diagram that was never centred and
       never width-capped. It is now .md-rendered ::ng-deep .mermaid-diagram in FILE_PREVIEW_STYLES,
       beside the other rules that have to reach the same content. */

    /* Full-screen preview overlay */
    .preview-fs-overlay {
      position: fixed; inset: 0; z-index: 1200;
      background: var(--bg-surface); display: flex; flex-direction: column;
    }
    .preview-fs-bar {
      display: flex; align-items: center; gap: 10px;
      padding: 12px 16px; border-bottom: 1px solid var(--border); flex-shrink: 0;
    }
    .preview-fs-bar .file-title { flex: 1; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .preview-fs-body { flex: 1; overflow: auto; padding: 20px; max-width: 1100px; width: 100%; margin: 0 auto; }
    /* The overlay's body wears .preview-body too, and the DOCKED pane's copy of this rule lives in
       FILE_DETAIL_PANE_STYLES. Two elements, one class, so the rule exists in both places — the same
       arrangement .rename-form has with the listing. */
    .preview-body {
      flex: 1;
      overflow: auto;
      padding: 16px;
    }

    /* ── Sidebar + layout ─────────────────────────────────────── */
    .fm-layout {
      display: flex;
      gap: 0;
    }
    .fm-main { flex: 1; min-width: 0; }


  `],
  template: `
    @if (loadingSpaces()) {
      <div class="loading-overlay"><span class="spinner"></span></div>
    } @else if (spacesError() !== null) {
      <!-- Reachable only when this component is routed standalone, which it currently is not: the sole call
           site passes embeddedSpaceId, so ngOnInit returns before loadSpaces(). Kept correct rather than
           deleted because the standalone /files route existed until recently and the branch is five lines;
           without it a failed space list renders an empty selector and NO body, which reads as a broken
           page rather than a failed request. -->
      <app-error-state [message]="'files.loadSpacesError' | transloco" [reason]="spacesError() ?? ''" (retry)="retrySpaces()" />
    } @else {

      <app-file-toolbar
        [spaces]="spaces()"
        [activeSpaceId]="activeSpaceId()"
        [embedded]="!!embeddedSpaceId"
        [breadcrumbs]="breadcrumbs()"
        [sidebarOpen]="tree.sidebarOpen()"
        [(folderFormOpen)]="showNewFolder"
        [(newFolderName)]="newFolderName"
        (selectSpace)="selectSpace($event)"
        (navigate)="navigate($event)"
        (createFolder)="createFolder()"
        (filesPicked)="onFilesPicked($event)"
        (toggleSidebar)="tree.toggleSidebar(activeSpaceId())" />

      @if (activeSpaceId()) {

        <!-- Upload queue — one row per file (U12) -->
        @if (uploads.items().length) {
          <app-upload-queue
            [uploads]="uploads.items()"
            [hasFinished]="hasFinishedUploads()"
            (retry)="retryUpload($event)"
            (cancel)="cancelUpload($event)"
            (dismiss)="dismissUpload($event)"
            (clearFinished)="clearFinishedUploads()" />
        }

        <div class="fm-layout">
          <!-- Directory tree sidebar -->
          @if (tree.sidebarOpen()) {
            <app-file-tree
              [nodes]="tree.treeRoot()"
              [currentPath]="currentPath()"
              [rootError]="tree.rootError()"
              (nodeClick)="onTreeClick($event)" />
          }

          <!-- Main file listing -->
          <div class="fm-main" [class.drag-over]="dragOver()">
            @if (listing.loading()) {
              <div class="loading-overlay"><span class="spinner"></span></div>
            } @else {
          <!-- A background refresh is a HAIRLINE, not an unmount. The table below stays exactly where it is and
               its rows update in place, so the per-row progress bars advance instead of the screen blinking. -->
          @if (listing.refreshing()) { <div class="fm-refreshing" role="status" [attr.aria-label]="'files.refreshing' | transloco"></div> }
          @if (listing.refreshFailed()) {
            <div class="fm-stale">{{ 'files.refreshFailed' | transloco }}</div>
          }
          <app-file-listing
            [rows]="fileRows()"
            [sortField]="sortField()"
            [sortDir]="sortDir()"
            [error]="listing.loadError()"
            [(renameValue)]="renameValue"
            (sort)="setSort($event)"
            (open)="open($event)"
            (download)="downloadFile($event)"
            (requeue)="requeueEmbedding($event)"
            (renameStart)="startRename($event)"
            (renameConfirm)="confirmRename($event)"
            (renameCancel)="renamingEntry.set('')"
            (remove)="deleteEntry($event)"
            (retryLoad)="reloadDir()" />
        }
          </div><!-- .fm-main -->

          <!-- Docked detail pane: preview + description ⇄ file-meta record (the merged File Meta view).
               The list runs full width until a file is opened; opening one adds this column. -->
          <app-file-detail-pane
            [embedded]="!!embeddedSpaceId"
            [spaceId]="activeSpaceId()"
            [relPath]="preview.file() ? relPath(preview.file()!) : ''"
            [hasExtract]="hasExtract()"
            [(mode)]="detailMode"
            (close)="closePreview()"
            (showMeta)="showMetaMode()"
            (showExtract)="showExtractMode()"
            (more)="moreChunks(preview.file()!)"
            (retryExtract)="loadExtract(preview.file()!)"
            (save)="saveMeta(preview.file()!)"
            (cancelEdit)="cancelMeta()"
            (retryEmbedding)="requeueEmbedding(preview.file()!)" />
        </div><!-- .fm-layout -->
      }
    }

    <!-- Preview content, shared by the docked pane and the full-screen overlay. -->

    <!-- Full-screen preview overlay (the one intentional fixed overlay — for the full-screen button).
         NO BACKTICKS IN THIS TEMPLATE: one ends the string and the error points at @Component, never at the comment.
         appModal supplies role=dialog, aria-modal, a CDK focus trap and focus restore on close. Escape was already
         handled by this component's document keydown listener (full-screen collapses first, then the pane closes),
         but the TRAP was not: Tab walked out of a full-screen overlay into the page behind it, which is covered and
         invisible. The fsOverlay template ref that used to sit here was never referenced from TypeScript —
         evidence that focus had been thought about and never wired.
         No backdrop dismissal: this overlay IS the backdrop, and Escape or the close button already dismiss it. -->
    @if (preview.fullscreen() && preview.file(); as pf) {
      <div class="preview-fs-overlay" tabindex="0" [appModal]="'files.preview.fullscreenDialog' | transloco">
        <div class="preview-fs-bar">
          <span class="file-title" [title]="pf.name">{{ pf.name }}</span>
          <button class="icon-btn" (click)="preview.fullscreen.set(false)" [attr.aria-label]="'files.preview.exitFullscreen' | transloco"><ph-icon name="x" [size]="18"/></button>
        </div>
        <div class="preview-fs-body preview-body">
          <app-file-preview [preview]="preview.model()" />
        </div>
      </div>
    }
  `,
})
export class FileManagerComponent implements OnInit, OnDestroy {
  private spacesApi = inject(SpacesApi);
  private auth = inject(AuthService);
  private route = inject(ActivatedRoute);
  private transloco = inject(TranslocoService);
  private toast = inject(ToastService);
  private confirmDialog = inject(ConfirmDialogService);
  private detailPaneRef = viewChild(FileDetailPaneComponent);
  // Brain-provided (only present when embedded in the Brain). Optional so the standalone /files route,
  // where the Brain injector isn't in the tree, still constructs — there the meta edit mode is hidden.
  private picker = inject(EntityRefPicker, { optional: true });
  /** Optional for the same reason as `picker`: this component also runs outside the Brain shell. */
  private store = inject(BrainStore, { optional: true });

  /**
   * The directory listing's state and its five requests (`G-3`, eighth cut).
   *
   * Public because the template binds four of its signals and the characterization spec reads them. The page
   * keeps what a listing is not: the breadcrumb, the space selector, the sort, the forms and the dialogs.
   */
  readonly listing = inject(FileListingStore);

  constructor() {
    /**
     * Live refresh while a file is processing.
     *
     * The shell already opens an SSE stream and bumps `liveRefreshTick` on a `file.*` event — that is how
     * every record tab stays current. This list never read it. The status pill and the processing stage
     * bar are both built from the DIRECTORY LISTING, so with no reload they sat at whatever they were
     * when the folder was first opened: a file could finish and still read "Embedding" until you clicked
     * away and back. Nothing errored, which is why it looked like a slow pipeline rather than a stale view.
     *
     * `untracked` around the reload so the effect depends on the tick ALONE — the reload reads
     * `currentPath()`, and tracking that would reload the directory on every navigation as well.
     */
    let firstTick = true;
    effect(() => {
      this.store?.liveRefreshTick();
      if (firstTick) { firstTick = false; return; }
      untracked(() => this.reloadDir());
    });

    /*
     * What a landed listing MEANS, wired here because the store does not know either of these exists.
     *
     * The tree is fed from this listing rather than fetching the same path a second time (`G-13`), and the
     * progress poll is started or stopped to match what is now on screen. Both are the page's business: it
     * owns the sidebar and the poll, and the store owns the request.
     */
    this.listing.listed.pipe(takeUntilDestroyed()).subscribe(({ path, entries }) => {
      this.tree.fillFrom(path, entries);
      this.syncProgressPolling();
    });
    this.listing.listingFailed.pipe(takeUntilDestroyed()).subscribe(({ path, reason }) => {
      this.tree.failFrom(path, reason);
    });

    /*
     * And what a WRITE means beyond the reload the store has already done. A new folder changes the tree's
     * root; a delete changes the file set the host is counting. Neither is something a listing store could
     * decide for the page.
     */
    this.listing.mutated.pipe(takeUntilDestroyed()).subscribe(kind => {
      if (kind === 'created') {
        // The form closes on the ANSWER, not on the attempt: a refused create keeps what was typed, so the
        // name can be corrected rather than retyped. Same for the rename below.
        this.newFolderName.set('');
        this.showNewFolder.set(false);
        this.tree.loadRoot(this.activeSpaceId());
      }
      if (kind === 'moved') this.renamingEntry.set('');
      if (kind === 'removed') this.filesChanged.emit();
    });
    this.listing.mutationFailed.pipe(takeUntilDestroyed()).subscribe(kind => {
      this.toast.error(this.transloco.translate(LISTING_FAILURE_KEYS[kind]));
    });

    /*
     * What the META store publishes, and why each of these three stayed on the page.
     *
     * **The picker.** `seeded` hands over the model that was just built, and priming the entity, memory and
     * chrono chip labels reads a `ViewChild` — a store reaching for one would couple it to the template.
     *
     * **The toasts.** The wording is the page's; the store holds no translations, same rule as the listing
     * store's failure KEYS.
     *
     * **The directory reload.** Tags and embedding status are shown on the list ROW, so both writes have to
     * refresh it — and the listing belongs to a different store. Neither write could decide that for itself
     * without one store reaching into another.
     */
    /*
     * A finished upload is two things to the rest of the page and neither is the queue's to decide: the new
     * file has to appear in the listing, which is another store's data, and the host's record counts have
     * moved, which is an `@Output`. The store publishes that one landed.
     */
    this.uploads.completed.pipe(takeUntilDestroyed()).subscribe(() => {
      this.reloadDir();
      this.filesChanged.emit();
    });

    this.metaStore.seeded.pipe(takeUntilDestroyed()).subscribe(model => this.primePickerFrom(model));
    this.metaStore.saved.pipe(takeUntilDestroyed()).subscribe(() => {
      // The edit face closes on the ANSWER, not on the attempt — same rule as the new-folder form above: a
      // refused save keeps what was typed so it can be corrected rather than retyped.
      this.detailMode.set('preview');
      this.toast.success(this.transloco.translate('files.detail.metaSaved'));
      this.reloadDir();
    });
    this.metaStore.requeued.pipe(takeUntilDestroyed()).subscribe(() => {
      this.toast.success(this.transloco.translate('files.detail.retryQueued'));
      this.reloadDir();
    });
    this.metaStore.failed.pipe(takeUntilDestroyed()).subscribe(which => {
      // A failed SAVE already shows its reason inside the edit form, which is where the reader is looking —
      // a toast as well would say the same thing twice. A failed REQUEUE has no form to show it in.
      if (which === 'requeue') {
        this.toast.error(
          `${this.transloco.translate('files.detail.retryFailed')} ${this.metaStore.error() ?? ''}`.trim());
      }
    });
  }

  /** When set (embedded in brain), skip space loading and use this space. */
  @Input() embeddedSpaceId = '';

  /** Fires whenever the file set in this space changes (delete or upload complete) so the host can refresh counts. */
  @Output() filesChanged = new EventEmitter<void>();

  spaces = signal<Space[]>([]);
  activeSpaceId = signal('');
  currentPath = signal('/');

  // ── Column sort (restores what #421 dropped) ───────────────────────────────
  // Sorted CLIENT-side, which is honest here and only here: `listFiles` returns a whole directory in one
  // response (no limit/skip), so this reorders the complete set. The paginated record tabs must sort
  // server-side for exactly the opposite reason — there, a client sort would reorder one page and lie
  // about the rest.
  sortField = signal<'' | 'name' | 'status' | 'size' | 'modified'>('');
  sortDir = signal<'asc' | 'desc'>('asc');

  /** desc -> asc -> unsorted, matching the record tabs' shared header primitive. */
  setSort(field: string): void {
    const f = field as '' | 'name' | 'status' | 'size' | 'modified';
    if (this.sortField() !== f) { this.sortField.set(f); this.sortDir.set('asc'); return; }
    if (this.sortDir() === 'asc') { this.sortDir.set('desc'); return; }
    this.sortField.set('');            // third click clears back to the server's own order
    this.sortDir.set('asc');
  }

  /**
   * Folders always come first — this is a file explorer, and interleaving directories with files by size
   * or date makes the tree unnavigable. The chosen column orders WITHIN each group.
   */
  /**
   * The listing rows, with the three per-row questions answered before they leave this page.
   *
   * `canRequeue`, "is this row renaming" and "is a re-embed already in flight for it" were evaluated inside
   * the table's loop, which meant the table needed the requeue policy, the rename state and `relPath` just to
   * decide which buttons to draw. Answering them here is what kept the extracted component to nine bindings
   * instead of sixteen.
   */
  fileRows = computed<FileRow[]>(() => {
    const renaming = this.renamingEntry();
    const requeueing = this.metaStore.requeueingPath();
    return this.sortedEntries().map(entry => ({
      entry,
      renaming: renaming === entry.name,
      requeueing: requeueing === this.relPath(entry),
      canRequeue: this.canRequeue(entry),
    }));
  });

  sortedEntries = computed<FileEntry[]>(() => {
    const list = this.listing.entries();
    const field = this.sortField();
    if (!field) return list;
    const sign = this.sortDir() === 'asc' ? 1 : -1;
    const key = (e: FileEntry): string | number => {
      switch (field) {
        case 'size': return e.size ?? 0;
        case 'modified': return e.modified ?? '';
        case 'status': return e.embeddingStatus ?? '';
        default: return e.name.toLowerCase();
      }
    };
    return [...list].sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      const ka = key(a), kb = key(b);
      if (ka === kb) return a.name.localeCompare(b.name);   // stable, human tiebreak
      return (typeof ka === 'number' && typeof kb === 'number')
        ? (ka - kb) * sign
        : String(ka).localeCompare(String(kb)) * sign;
    });
  });
  loadingSpaces = signal(true);
  /** Null until the space list failed to load — else the page renders with no selector and no body. */
  spacesError = signal<string | null>(null);

  /** The upload queue, its ordering and its one request — see `file-upload.store.ts`. */
  readonly uploads = inject(FileUploadStore);

  dragOver = signal(false);

  showNewFolder = signal(false);
  /**
   * A SIGNAL now, because the toolbar binds it two-way.
   *
   * It was a plain field with `ngModel` writing straight into it. A `model()` input needs something it can
   * `.set()`, and the page still has to read it — `createFolder` trims it and clears it on success only,
   * which is the rule that keeps a refused name on screen.
   */
  newFolderName = signal('');

  renamingEntry = signal('');
  renameValue = '';

  breadcrumbs = signal<BreadcrumbSegment[]>([{ label: 'root', path: '/' }]);

  /** The docked preview: its state, its renderers and its one fetch — see `file-preview.store.ts`. */
  readonly preview = inject(FilePreviewStore);

  // ── Docked detail-pane state (preview+description ⇄ file-meta record) ──────
  /** Which face of the detail pane is showing. Meta editing is only reachable when embedded. */
  detailMode = signal<DetailMode>('preview');
  /** The FileMeta record for the open file (its description + links); null until the fetch lands. */
  /** The file's metadata record, its edit model and its three requests — see `file-meta.store.ts`. */
  readonly metaStore = inject(FileMetaStore);

  // ── Extract face: what retrieval actually sees ─────────────────────────────
  /** The Extract face's state and its request — see `file-extract.store.ts`. */
  readonly extractStore = inject(FileExtractStore);

  /**
   * Whether this file HAS an extract to show.
   *
   * Offered only for a file that went through the pipeline: chunks, a converted sidecar, or a media type
   * that produces either. A tab that is always present and always says "nothing here" teaches people to
   * ignore it, which is the same lesson as a health dot that is always red.
   */
  hasExtract(): boolean {
    const m = this.metaStore.selectedMeta();
    if (!m) return false;
    return (m.chunkCount ?? 0) > 0 || !!m.convertedFileId || !!m.mediaType;
  }

  /** Switch to the Extract face, fetching the first time it is opened rather than on every file open. */
  showExtractMode(): void {
    this.detailMode.set('extract');
    const pf = this.preview.file();
    if (pf && this.extractStore.hasNothing()) this.loadExtract(pf);
  }

  /**
   * Load the extract for one file.
   *
   * The page keeps these two methods because they are what the template calls and they resolve the space and
   * the path — `activeSpaceId()` and `relPath()` are the page's, and threading them into the store's
   * constructor would give it two things to be wrong about instead of none.
   */
  loadExtract(entry: FileEntry, skip = 0): void {
    this.extractStore.load(this.activeSpaceId(), this.relPath(entry), skip);
  }

  /** Next page of chunks. The store counts from what is on screen, not from the last response's own skip. */
  moreChunks(entry: FileEntry): void {
    this.extractStore.more(this.activeSpaceId(), this.relPath(entry));
  }

  /**
   * A chunk's position in a recording, as mm:ss or mm:ss-mm:ss.
   *
   * Audio and video chunks carry `chunkOffsetMs`; documents do not, and get their heading instead. Rendered
   * here rather than server-side because it is a display choice, and the raw milliseconds are what an API
   * consumer wants.
   */

  /** Edit model for the meta form — same shape the Brain File Meta tab uses (linkEntities is comma-joined
   *  for app-entity-ref-field; memory/chrono are id arrays). Mutated in place by the ref-field widgets. */
  /**
   * The edit model, held as a PLAIN object because the reference widgets write into it.
   *
   * Typed by the editor that renders it, so there is one definition of the shape rather than a structural
   * literal here and an interface there — the two drifting is how `linkEntities` would quietly become an array
   * on one side.
   */

  /**
   * The path whose re-embed request is in flight, or '' when none is.
   *
   * A path rather than a boolean because the action is now on every row as well as in the detail pane: one
   * shared boolean would grey out every row's button while a single file was being re-queued, which reads as
   * "the whole list is busy".
   */


  // ── Tree sidebar state ───────────────────────────────────────────────────
  /**
   * The tree's state and its two requests live in `FileTreeStore`, provided by this page.
   *
   * A store rather than a component, because the sidebar renders inside an `@if (sidebarOpen())` and a
   * component owning `listFiles` would cancel it on destroy and lose the loaded tree. A store injected here has
   * this page's lifetime, which is what the requests need.
   */
  readonly tree = inject(FileTreeStore);

  private _keyHandler = (e: KeyboardEvent) => this.onPreviewKey(e);

  ngOnInit(): void {
    if (this.embeddedSpaceId) {
      // Embedded in brain — use the provided space directly
      this.loadingSpaces.set(false);
      this.selectSpace(this.embeddedSpaceId);
      return;
    }
    this.loadSpaces();
  }

  /** Public so the error state's Retry re-runs the space list without a page reload. */
  retrySpaces(): void {
    this.loadSpaces();
  }

  private loadSpaces(): void {
    const requestedSpace = this.route.snapshot.queryParamMap.get('space') ?? '';
    this.loadingSpaces.set(true);
    this.spacesError.set(null);
    this.spacesApi.listSpaces().subscribe({
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
      error: (err) => { this.spacesError.set(httpErrorReason(err)); this.loadingSpaces.set(false); },
    });
  }

  selectSpace(id: string): void {
    this.activeSpaceId.set(id);
    this.currentPath.set('/');
    this.updateBreadcrumbs('/');
    this.listing.load(id, '/');
    this.tree.loadRoot(id);
  }

  navigate(path: string): void {
    this.currentPath.set(path);
    this.updateBreadcrumbs(path);
    this.listing.load(this.activeSpaceId(), path);
  }

  open(entry: FileEntry): void {
    if (entry.isDirectory) {
      const next = this.join(this.currentPath(), entry.name);
      this.navigate(next);
    } else {
      this.openPreview(entry);
    }
  }

  /** Re-load the current directory — bound to the error state's Retry button, and to five other callers. */
  reloadDir(): void { this.listing.load(this.activeSpaceId(), this.currentPath()); }

  // ── The processing stage bar has to ADVANCE (B.5) ──────────────────────────
  //
  // The live-refresh tick above covers status CHANGES: the shell's SSE stream fires on `file.*`, which is
  // a brain write, and a file finishing is one. Per-page progress is not. `touchJobProgress` writes a
  // heartbeat on the media job record as each page lands and publishes nothing — deliberately, since
  // fanning one event per page per file out to every open tab is not a trade worth making.
  //
  // So the stage bar was drawn once, from the listing that was current when the folder was opened, and sat
  // there: "page 12 of 40" for the whole conversion. Nothing errored, which is why it read as a wedged
  // pipeline rather than a stale view — the reporter took it for the former.
  //
  // A poll is the honest mechanism for a value with no event behind it, and this one is bounded on both
  // sides: it exists only while a row on screen is actually in flight, and it skips a tick when the tab is
  // hidden. An idle folder polls nothing.

  /** 4 s: progress moves a page at a time, so faster only costs requests. `progressAt` shows staleness. */
  private static readonly PROGRESS_POLL_MS = 4_000;
  private progressPoll: ReturnType<typeof setInterval> | null = null;

  /** True while any row on screen is still being processed — the only condition that justifies polling. */
  anyInFlight(): boolean {
    return this.listing.entries().some(e =>
      !!e.progress || e.embeddingStatus === 'pending' || e.embeddingStatus === 'processing');
  }

  /** Start or stop the poll to match what is on screen. Called after every listing load. */
  private syncProgressPolling(): void {
    if (this.anyInFlight()) {
      if (this.progressPoll !== null) return;                    // already running — never stack timers
      this.progressPoll = setInterval(() => {
        // A background tab does not need a stage bar. Skipping the tick rather than stopping the timer
        // means it resumes the moment the tab is looked at again, with no visibility listener to leak.
        if (typeof document !== 'undefined' && document.hidden) return;
        this.reloadDir();
        // The open file's own record goes stale in exactly the same way: the description a document gets
        // is written when its job finishes, so a detail pane opened during processing showed none until
        // the file was closed and reopened.
        const open = this.preview.file();
        if (open) this.loadSelectedMeta(open);
      }, FileManagerComponent.PROGRESS_POLL_MS);
    } else {
      this.stopProgressPolling();
    }
  }

  private stopProgressPolling(): void {
    if (this.progressPoll !== null) { clearInterval(this.progressPoll); this.progressPoll = null; }
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
    void this.enqueueUploads(files);
  }

  /** The toolbar owns the picker and clears it; what the files MEAN is ours. */
  onFilesPicked(files: FileList): void {
    void this.enqueueUploads(files);
  }

  // ── Upload queue (U12) ──────────────────────────────────────────────────────

  /**
   * Add the picked/dropped files as queued rows and kick the processor.
   *
   * Uploading over an existing path is a REPLACE, and it takes the derived records with it: the
   * conversion chunks, the converted Markdown, the extracted images, and any description generated from
   * them are all dropped and rebuilt. That is the correct behaviour — stale chunks for a document that
   * no longer exists would be worse — but it happened silently, and a drag-and-drop onto the wrong
   * folder is an easy accident with no undo. Reported against 2.1.1.
   *
   * Asked once for the whole batch rather than once per file: a drop of twenty files where three
   * collide should be one question, not three.
   */
  private async enqueueUploads(files: FileList): Promise<void> {
    const picked = Array.from(files);
    const existing = new Set(this.listing.entries().filter(e => e.isFile).map(e => e.name));
    const clashes = picked.filter(f => existing.has(f.name)).map(f => f.name);

    if (clashes.length > 0) {
      const ok = await this.confirmDialog.confirm({
        title: this.transloco.translate('files.confirm.overwriteTitle'),
        message: this.transloco.translate(
          clashes.length === 1 ? 'files.confirm.overwriteOne' : 'files.confirm.overwriteMany',
          { name: clashes[0], count: clashes.length, names: clashes.slice(0, 5).join(', ') },
        ),
        confirmLabel: this.transloco.translate('files.confirm.overwriteConfirm'),
        danger: true,
      });
      if (!ok) return;
    }

    // The destination is fixed HERE, not when each row's turn comes: the queue is serialised, so a batch
    // dropped on this folder must land on this folder however long it waits.
    this.uploads.enqueue(this.activeSpaceId(), this.currentPath(), picked);
  }

  retryUpload(item: UploadItem): void { this.uploads.retry(item); }

  cancelUpload(item: UploadItem): void { this.uploads.cancel(item); }

  dismissUpload(item: UploadItem): void { this.uploads.dismiss(item); }

  hasFinishedUploads(): boolean { return this.uploads.hasFinished(); }

  clearFinishedUploads(): void { this.uploads.clearFinished(); }

  createFolder(): void {
    if (!this.newFolderName().trim()) return;
    const path = this.join(this.currentPath(), this.newFolderName().trim());
    this.listing.createDir(this.activeSpaceId(), path, this.currentPath());
  }

  startRename(entry: FileEntry): void {
    this.renamingEntry.set(entry.name);
    this.renameValue = entry.name;
  }

  confirmRename(entry: FileEntry): void {
    const from = this.join(this.currentPath(), entry.name);
    const parentDir = this.currentPath();
    const to = this.join(parentDir, this.renameValue.trim());
    this.listing.move(this.activeSpaceId(), from, to, parentDir);
  }

  async deleteEntry(entry: FileEntry): Promise<void> {
    const ok = await this.confirmDialog.confirm({
      title: this.transloco.translate('files.confirm.deleteFileTitle'),
      message: this.transloco.translate('files.confirm.deleteFile', { name: entry.name }),
      confirmLabel: this.transloco.translate('common.delete'),
      danger: true,
    });
    if (!ok) return;
    const path = this.join(this.currentPath(), entry.name);
    this.listing.remove(this.activeSpaceId(), path, this.currentPath());
  }

  /** The file GET URL (no token — auth goes in the fetch header, never the URL). */
  private fileApiUrl(entry: FileEntry): string {
    return this.listing.downloadUrl(this.activeSpaceId(), this.join(this.currentPath(), entry.name));
  }

  /**
   * Download a file. A plain `<a href download>` can't send the auth header, and
   * the file endpoint no longer honours a `?token=` query param (#134), so fetch
   * the bytes with the token and save them via a temporary blob URL.
   */
  async downloadFile(entry: FileEntry): Promise<void> {
    const token = this.auth.token();
    try {
      const res = await fetch(this.fileApiUrl(entry), {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const objUrl = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = entry.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objUrl), 10_000);
    } catch (e) {
      this.toast.error(`${this.transloco.translate('files.downloadFailed')} ${httpErrorReason(e)}`.trim());
    }
  }



  /**
   * Shared with the tree store, which builds every node's path with it.
   *
   * Exposed as a member rather than called directly at the six sites below only because it is reached that way
   * throughout this file; the definition is `file-format.ts`, so the tree and the breadcrumb cannot drift apart
   * about what a path is — the divergence this page's characterization spec warned about before there was a
   * second builder.
   */
  readonly join = joinPath;

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

  /**
   * One gesture, TWO effects, and both are the behaviour: the listing follows the tree, and the folder opens.
   *
   * Kept on the page rather than folded into the store because the store must not decide what a click means —
   * and because the two calls sitting side by side is what keeps `G-10` findable. Clicking a folder currently
   * lists that directory twice, once here and once for the children, and a characterization case pins it at
   * two so the count cannot drift up unnoticed.
   */
  onTreeClick(node: TreeNode): void {
    /*
     * ONE listing per click, not two.
     *
     * This used to call `navigate(path)` and then the tree's own `toggle`, which listed the same path again
     * for the children — same URL, same moment, every time a folder was opened. The listing `navigate` starts
     * already contains the directories the tree wants, so the node is fed from it when it lands.
     *
     * The collapse and the already-loaded expand are still the store's own business: neither needs a request,
     * and routing them through the listing would make a free toggle wait on one.
     */
    const needsListing = !node.expanded && node.children === null;
    if (needsListing) {
      // The spinner has to appear on the CLICK, not when the listing lands, or the click looks ignored.
      this.tree.awaitFrom(node);
    } else {
      this.tree.toggle(node, this.activeSpaceId());
    }
    this.navigate(node.path);
  }

  // ── Preview ──────────────────────────────────────────────────────────────

  openPreview(entry: FileEntry): void {
    // Selecting a file always shows the preview face first; the meta record loads alongside so the
    // description shows here and the (embedded-only) edit form is ready when the toggle is used.
    this.detailMode.set('preview');
    // The previous file's extract must not survive into this one — it is fetched lazily, so a stale value
    // here would show one file's chunks under another file's name until the tab was opened again.
    this.extractStore.clear();
    this.loadSelectedMeta(entry);
    this.preview.open(entry, this.fileApiUrl(entry));

    document.addEventListener('keydown', this._keyHandler);
    // WHEN to focus is part of what opening means, so it stays here; the element is in the pane.
    setTimeout(() => this.detailPaneRef()?.focusPane());
  }

  /** Space-relative path of an entry (matches the FileMeta `_id`/`path`; leading slashes stripped). */
  /** Public because the template compares it against `requeueingPath()` to disable one row's button. */
  relPath(entry: FileEntry): string {
    return this.join(this.currentPath(), entry.name).replace(/^\/+/, '');
  }

  /** Fetch the file's metadata record so the pane can show its description and (embedded) edit its links. */
  private loadSelectedMeta(entry: FileEntry): void {
    this.metaStore.load(this.activeSpaceId(), this.relPath(entry));
  }

  /**
   * Prime the picker's chip labels from a freshly seeded model.
   *
   * This is the half the store cannot do: `picker` is a `ViewChild`, so a store reaching for one would
   * couple it to the template's shape. The store publishes the model it built; this subscribes.
   */
  private primePickerFrom(model: FileMetaModel): void {
    this.picker?.resolveEntityNamesFor(model.linkEntities);
    this.picker?.resolveMemoryTitles(model.linkFacts);
    this.picker?.resolveChronoTitles(model.linkChronos);
  }

  /** Switch the pane to the file-meta edit face, re-seeding the form from the loaded record. */
  showMetaMode(): void {
    this.metaStore.reseed();
    this.detailMode.set('meta');
  }

  /** Discard edits and return to the preview face. */
  cancelMeta(): void {
    this.metaStore.reseed();
    this.detailMode.set('preview');
  }

  /** Persist the edited metadata for the open file. The store writes; the toast and the reload are ours. */
  saveMeta(entry: FileEntry): void {
    this.metaStore.save(this.activeSpaceId(), this.relPath(entry));
  }

  /**
   * Can this entry's embedding be re-queued from its row?
   *
   * Not while a job is `pending` or `processing`: the server answers those with a `409`, and an action whose
   * only outcome is a refusal is worse than one that is not offered. A file with no status at all has no job
   * to retry — an upload still in flight, or a type this instance does not embed.
   */
  canRequeue(entry: FileEntry): boolean {
    if (!entry.isFile || !entry.embeddingStatus) return false;
    return entry.embeddingStatus !== 'pending' && entry.embeddingStatus !== 'processing';
  }

  /**
   * Re-queue embedding for one file, from its row or from the open detail pane.
   *
   * One method for both, because they are the same request with the same three outcomes; two copies is how
   * the row would end up with a different toast, or without the list refresh that makes the new status show.
   */
  requeueEmbedding(entry: FileEntry): void {
    this.metaStore.requeue(this.activeSpaceId(), this.relPath(entry));
  }

  closePreview(): void {
    this.preview.close();
    document.removeEventListener('keydown', this._keyHandler);
  }

  onPreviewKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      // Full-screen collapses back to the docked pane first; a second Escape closes the pane.
      if (this.preview.fullscreen()) { this.preview.fullscreen.set(false); return; }
      this.closePreview();
      return;
    }
    const files = this.listing.entries().filter(f => f.isFile);
    const current = this.preview.file();
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
    this.preview.objectUrl.release();
    // Abort any in-flight/queued uploads so their requests don't outlive the view. The store cannot do
    // this itself: being page-provided is the whole reason an upload survives the panel remounting.
    this.uploads.abortAll();
    // A poll left running would keep requesting a directory listing for a view nobody is looking at —
    // and, because it reloads through the component's own signals, on a destroyed component.
    this.stopProgressPolling();
  }
}
