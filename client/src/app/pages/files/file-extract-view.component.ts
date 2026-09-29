import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { ErrorStateComponent } from '../../shared/error-state.component';
import { FileExtract } from '../../core/api.types';
import { FILE_EXTRACT_STYLES } from './file-manager.styles';
import { msRange } from './file-format';

/**
 * What retrieval actually sees for one file: its chunks, their provenance, and the converted markdown.
 *
 * ## Why this view exists at all
 *
 * `_converted/` and `_extracted/` are hidden from file browsing, which is right — they are machine output, not
 * documents anyone filed. Hiding them removed the only way to answer *"what did the pipeline get out of this
 * file?"*, which is the first question when a document answers queries badly. Hidden from browsing, not from
 * inspection: nothing here is new data, these are records conversion already wrote.
 *
 * ## What stayed on the page
 *
 * Fetching, paging and retry. `more` and `retry` are reported rather than performed, for the reason the upload
 * queue and the meta editor both record: the request is the page's, and a component that owned it would drop
 * an in-flight page load when the pane switched tabs.
 *
 * The largest single block of the file manager's template (G-3), and the last of its detail pane.
 */
@Component({
  selector: 'app-file-extract-view',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, ErrorStateComponent],
  styles: [FILE_EXTRACT_STYLES],
  template: `
  <div class="detail-extract">
    @if (loading()) {
      <div class="muted">{{ 'files.extract.loading' | transloco }}</div>
    } @else if (error()) {
      <app-error-state [message]="'files.extract.error' | transloco" [reason]="error() ?? ''" (retry)="retry.emit()" />
    } @else if (extract(); as x) {
      @if (x.conversionError) {
        <div class="alert alert-error" role="alert">{{ x.conversionError }}</div>
      }

      <!-- Chunks first, deliberately: they ARE what retrieval matches on. The converted
           Markdown is the input to chunking, and the images are a side product. -->
      <section>
        <h4>{{ 'files.extract.chunks' | transloco: { shown: x.chunks.length, total: x.chunkTotal } }}</h4>
        @if (x.chunks.length === 0) {
          <p class="muted">{{ 'files.extract.noChunks' | transloco }}</p>
        }
        @for (c of x.chunks; track c.id) {
          <div class="chunk">
            <div class="chunk-head">
              <span class="chunk-ix">#{{ c.index }}</span>
              <!-- One provenance line, whichever kind of provenance this chunk has: a
                   timestamp for audio, the heading it opened for a document. -->
              @if (c.chunkOffsetMs !== null) {
                <span class="chunk-prov">{{ msRange(c.chunkOffsetMs, c.chunkDurationMs) }}</span>
              } @else if (c.headingText) {
                <span class="chunk-prov">{{ c.headingText }}</span>
              }
              @if (c.embeddingStatus && c.embeddingStatus !== 'complete') {
                <span class="chunk-warn">{{ c.embeddingStatus }}</span>
              }
            </div>
            <p class="chunk-body">{{ c.content }}</p>
          </div>
        }
        @if (x.chunkTotal > x.chunks.length + x.skip) {
          <button class="btn btn-sm btn-secondary" type="button" (click)="more.emit()">{{ 'files.extract.more' | transloco }}</button>
        }
      </section>

      @if (x.images.length > 0) {
        <section>
          <h4>{{ 'files.extract.images' | transloco: { count: x.images.length } }}</h4>
          @if (x.imagesTruncated) {
            <div class="muted xtr-images-cut">{{ 'files.extract.imagesCut' | transloco: { shown: x.images.length, total: x.imagesTotal } }}</div>
          }
          @for (img of x.images; track img.path) {
            <div class="xtr-image">
              <span class="xtr-path">{{ img.path }}</span>
              @if (img.description) {
                <p>
                  {{ img.description }}
                  @if (img.descriptionSource) {
                    <span class="desc-src" [attr.title]="'files.detail.descriptionSource.' + img.descriptionSource + 'Hint' | transloco">{{ 'files.detail.descriptionSource.' + img.descriptionSource | transloco }}</span>
                  }
                </p>
              } @else {
                <p class="muted">{{ 'files.extract.noCaption' | transloco }}</p>
              }
            </div>
          }
        </section>
      }

      @if (x.converted; as conv) {
        <section>
          <h4>{{ 'files.extract.converted' | transloco }}</h4>
          <div class="muted xtr-path">{{ conv.path }}</div>
          @if (conv.truncated) {
            <div class="muted">{{ 'files.extract.truncatedAt' | transloco: { shown: conv.markdown.length, total: conv.markdownChars ?? conv.markdown.length } }}</div>
          }
          @if (conv.unreadable) {
            <div class="muted">{{ 'files.extract.unreadable' | transloco: { reason: conv.unreadable } }}</div>
          }
          <pre class="xtr-md">{{ conv.markdown }}</pre>
          @if (conv.markdownNextSkip !== undefined) {
            <button class="btn btn-sm btn-secondary xtr-md-more" type="button" (click)="moreMarkdown.emit()">{{ 'files.extract.moreMarkdown' | transloco }}</button>
          }
        </section>
      }
    }
  </div>
  `,
})
export class FileExtractViewComponent {
  readonly extract = input<FileExtract | null>(null);
  readonly loading = input<boolean>(false);
  readonly error = input<string | null>(null);

  /** Load the next page of chunks. The page owns the cursor, so this only says the button was pressed. */
  readonly more = output<void>();
  /** The next window of the converted Markdown (Q-128). */
  readonly moreMarkdown = output<void>();
  readonly retry = output<void>();

  /**
   * A chunk's clock range, for media provenance.
   *
   * It came off the page with this markup: an audio or video file is chunked by TIME, so "where did this text
   * come from" is a clock range — and the page had no other use for it. It lives in `file-format.ts` beside
   * `formatSize` rather than here, so there is one definition and its three test cases exercise the function
   * instead of reaching through a 1 400-line component for it.
   */
  protected readonly msRange = msRange;
}
