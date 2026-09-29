import { ChangeDetectionStrategy, Component, ElementRef, inject, input, model, output, viewChild } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { FilePreviewComponent } from './file-preview.component';
import { FileExtractViewComponent } from './file-extract-view.component';
import { FileMetaEditorComponent } from './file-meta-editor.component';
import { FilePreviewStore } from './file-preview.store';
import { FileMetaStore } from './file-meta.store';
import { FileExtractStore } from './file-extract.store';
import { FILE_DETAIL_PANE_STYLES } from './file-manager.styles';

/** Which face of the pane is showing. Meta and Extract are only reachable when embedded in the Brain. */
export type DetailMode = 'preview' | 'meta' | 'extract';

/**
 * The docked detail pane: one open file, seen three ways.
 *
 * `G-3.4`. The header with its tab strip, the preview body and its description, and the three faces —
 * preview, the Extract view, and the file-meta editor.
 *
 * ## This one READS the stores, and every other child on this page takes inputs
 *
 * That is a deliberate exception and worth the paragraph. The pane renders from three stores at once, so as
 * a dumb component it would take about fifteen inputs — and `file-preview.component.ts` argues against
 * exactly that shape in its own docblock: *"eight inputs on a presentational component is a class definition
 * wearing a template's clothes."* Fifteen bindings is also fifteen places one can be dropped, silently.
 *
 * The stores are `providers` on the page, so a child in its template gets the same instances the page has.
 * Nothing is shared more widely than it was, and nothing is duplicated: this reads what the page reads.
 *
 * **What it does NOT do is decide.** Every gesture is an output, because what a click MEANS belongs to the
 * page: switching to Meta re-seeds the edit model, switching to Extract fetches on the FIRST open and not on
 * every switch back, closing releases a blob URL and unhooks a key listener, and saving reloads a listing
 * that belongs to a fourth store. A component that owned any of those would be reaching past its own
 * template.
 *
 * `mode` is two-way rather than owned here for the same reason the toolbar's folder form is: the page sets
 * it when a file is opened, and the tab strip sets it when a tab is clicked.
 */
@Component({
  selector: 'app-file-detail-pane',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, PhIconComponent, FilePreviewComponent, FileExtractViewComponent, FileMetaEditorComponent],
  styles: [FILE_DETAIL_PANE_STYLES],
  template: `
    @if (preview.file(); as pf) {
      <div class="fm-detail" tabindex="0" #pane>
        <div class="detail-header">
          @if (embedded()) {
            <div class="seg-toggle" role="tablist" [attr.aria-label]="'files.detail.tabsAriaLabel' | transloco">
              <button type="button" role="tab" [class.active]="mode() === 'preview'" [attr.aria-selected]="mode() === 'preview'" (click)="mode.set('preview')">{{ 'files.detail.previewTab' | transloco }}</button>
              <button type="button" role="tab" [class.active]="mode() === 'meta'" [attr.aria-selected]="mode() === 'meta'" (click)="showMeta.emit()">{{ 'files.detail.metaTab' | transloco }}</button>
              <!-- Extract: what retrieval actually sees. Only for files that HAVE been through the
                   pipeline — offering it on a file with no chunks and no conversion would be a tab
                   that always says "nothing here". -->
              @if (hasExtract()) {
                <button type="button" role="tab" [class.active]="mode() === 'extract'" [attr.aria-selected]="mode() === 'extract'" (click)="showExtract.emit()">{{ 'files.detail.extractTab' | transloco }}</button>
              }
            </div>
          } @else {
            <span class="file-title" [title]="pf.name">{{ pf.name }}</span>
          }
          <button class="icon-btn" (click)="close.emit()" [attr.aria-label]="'files.closePreviewAriaLabel' | transloco"><ph-icon name="x" [size]="16"/></button>
        </div>

        <div class="detail-body">
          @if (mode() === 'preview' || !embedded()) {
            <div class="preview-body">
              <!-- Full-screen toggle: shown once there's rendered content (not while loading / on error). -->
              @if (!preview.loading() && preview.error() === null && preview.kind() !== 'unknown') {
                <button class="btn-ghost btn btn-sm preview-fs-btn" type="button" (click)="preview.fullscreen.set(true)" [attr.title]="'files.preview.fullscreen' | transloco" [attr.aria-label]="'files.preview.fullscreen' | transloco"><ph-icon name="corners-out" [size]="16"/></button>
              }
              <app-file-preview [preview]="preview.model()" />
            </div>
            @if (meta.selectedMeta()?.description) {
              <div class="detail-desc">
                <h4>
                  {{ 'files.detail.description' | transloco }}
                  <!-- Whose words these are. The release note said "generated" while the value was
                       the head of the document's own text, and nothing on screen could tell them
                       apart; a description a person typed carries no badge at all. -->
                  @if (meta.selectedMeta()!.descriptionSource; as src) {
                    <span class="desc-src" [attr.title]="'files.detail.descriptionSource.' + src + 'Hint' | transloco">{{ 'files.detail.descriptionSource.' + src | transloco }}</span>
                  }
                </h4>
                <p>{{ meta.selectedMeta()!.description }}</p>
              </div>
            }
          } @else if (mode() === 'extract') {
            <!-- Extract: what retrieval actually sees.
                 The _converted/ and _extracted/ folders are hidden from browsing, which is right and
                 which removed the only way to answer "what did the pipeline get out of this file?" —
                 the first question when a document answers queries badly. Hidden from browsing, not
                 from inspection. Nothing here is new data; these are records conversion already wrote. -->
            <app-file-extract-view
              [extract]="extract.extract()"
              [loading]="extract.loading()"
              [error]="extract.error()"
              (more)="more.emit()"
              (moreMarkdown)="moreMarkdown.emit()"
              (retry)="retryExtract.emit()" />
          } @else {
            <!-- File-meta edit form (embedded only — reuses the Brain ref-field widgets). -->
            <app-file-meta-editor
              [model]="meta.model"
              [spaceId]="spaceId()"
              [error]="meta.error()"
              [saving]="meta.saving()"
              [canRetryEmbedding]="pf.embeddingStatus === 'failed' || pf.embeddingStatus === 'partial'"
              [retryPending]="meta.requeueingPath() === relPath()"
              (save)="save.emit()"
              (cancel)="cancelEdit.emit()"
              (retryEmbedding)="retryEmbedding.emit()" />
          }
        </div>
      </div>
    }
  `,
})
export class FileDetailPaneComponent {
  readonly preview = inject(FilePreviewStore);
  readonly meta = inject(FileMetaStore);
  readonly extract = inject(FileExtractStore);

  /** Embedded in the Brain: the tab strip replaces the filename, and Meta/Extract become reachable. */
  readonly embedded = input(false);
  readonly spaceId = input('');
  /** The open file's space-relative path. Built by the page, which owns the only two path builders. */
  readonly relPath = input('');
  readonly hasExtract = input(false);

  readonly mode = model<DetailMode>('preview');

  readonly close = output<void>();
  readonly showMeta = output<void>();
  readonly showExtract = output<void>();
  readonly more = output<void>();
  readonly moreMarkdown = output<void>();
  readonly retryExtract = output<void>();
  readonly save = output<void>();
  readonly cancelEdit = output<void>();
  readonly retryEmbedding = output<void>();

  private readonly pane = viewChild<ElementRef<HTMLDivElement>>('pane');

  /**
   * Move keyboard focus to the pane, so Escape reaches it.
   *
   * Called by the page after it opens a file, because WHEN to focus is the page's — it is part of what
   * opening means, alongside clearing the extract and loading the metadata record. The element is here, so
   * the reaching-into-the-DOM half is here.
   */
  focusPane(): void {
    this.pane()?.nativeElement?.focus();
  }
}
