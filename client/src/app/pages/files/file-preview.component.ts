import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { InstantComponent } from '../../shared/instant.component';
import { TranslocoPipe } from '@jsverse/transloco';
import { SafeHtml, SafeResourceUrl } from '@angular/platform-browser';
import { FileEntry } from '../../core/api.types';
import { FILE_PREVIEW_STYLES } from './file-manager.styles';
import { formatSize } from './file-format';

/**
 * What a preview can be showing. `unknown` is a real state: the metadata card, for a file we cannot render.
 *
 * Declared HERE and imported by the page, rather than the other way round. The page detects the kind and the
 * component renders it, so the vocabulary belongs to the renderer — and a second copy on the page is how the
 * two would come to disagree about what `xlsx` means.
 */
export type PreviewKind = 'text' | 'markdown' | 'image' | 'pdf' | 'xlsx' | 'unknown';

/**
 * The note above a capped spreadsheet grid, as a translation KEY rather than a sentence.
 *
 * The parse is what knows the numbers and it happens in a store, and no store on this page holds
 * translations — the wording of anything a person reads belongs to the renderer, which is this file. So the
 * facts travel and the words are made here. Same rule as the listing store failure KEYS, from the other end.
 */
export interface XlsxNote { key: string; params?: Record<string, unknown>; }

/** A parsed spreadsheet preview: the first sheet as a capped grid, with a note when truncated. */
export interface XlsxPreview { sheet: string; header: string[]; rows: string[][]; note: XlsxNote | null; }

/**
 * Everything this component needs, as ONE input.
 *
 * The alternative was eight — loading, error, kind, html, mediaUrl, safeUrl, table, file — and eight inputs on
 * a presentational component is a class definition wearing a template's clothes. A view model also makes the
 * states mutually exclusive by construction: `loading` and `error` and a rendered body cannot all be true at
 * once here, which is a thing the old markup had to keep straight by hand in two places.
 */
export interface FilePreview {
  file: FileEntry;
  loading: boolean;
  error: string | null;
  kind: PreviewKind;
  html: string | SafeHtml;
  mediaUrl: string;
  safeUrl: SafeResourceUrl;
  table: XlsxPreview | null;
}

/**
 * The body of a file preview — markdown, text, an image, a PDF, a spreadsheet grid, or a metadata card.
 *
 * ## Why this is the first cut of G-3
 *
 * `file-manager.component.ts` is the largest file in the repo and its split has to start somewhere. This is
 * the seam with the clearest boundary: it renders and does nothing else. **It does not fetch, and it does not
 * own the object URL** — the page does both, because the page is what knows when a preview is replaced or
 * closed, and a component that revoked a URL on destroy would revoke it during the very re-render that
 * replaces it.
 *
 * ## It was already a template, used twice
 *
 * The markup lived in an `ng-template` rendered through `ngTemplateOutlet` from the docked pane and again
 * from the full-screen overlay. That is the same instinct as a component, one Angular version early: it kept
 * the two in step but left the whole thing inside a 1 618-line file, where its styles sat 500 lines away from
 * the markup they applied to.
 *
 * The `::ng-deep` rules for rendered markdown moved with it and have to stay `::ng-deep`: the HTML comes from
 * `[innerHTML]`, so those elements are not in this component's template and carry none of its scoping
 * attributes.
 */
@Component({
  selector: 'app-file-preview',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, InstantComponent, TranslocoPipe],
  styles: [FILE_PREVIEW_STYLES],
  template: `
    @if (preview(); as p) {
      @if (p.loading) {
        <div class="loading-overlay"><span class="spinner"></span></div>
      } @else if (p.error !== null) {
        <div class="alert alert-error" role="alert">{{ 'files.preview.failed' | transloco }} {{ p.error }}</div>
      } @else {
        @switch (p.kind) {
          @case ('markdown') { <div class="md-rendered" [innerHTML]="p.html"></div> }
          @case ('text') { <pre class="preview-code"><code [innerHTML]="p.html"></code></pre> }
          @case ('image') { <img [src]="p.mediaUrl" [alt]="p.file.name" /> }
          @case ('pdf') { <iframe [src]="p.safeUrl"></iframe> }
          @case ('xlsx') {
            @if (p.table; as t) {
              @if (t.note) { <div class="xlsx-note">{{ t.note.key | transloco: t.note.params }}</div> }
              <div class="xlsx-wrap">
                <table class="xlsx-grid">
                  @if (t.header.length) {
                    <thead><tr>@for (h of t.header; track $index) { <th>{{ h }}</th> }</tr></thead>
                  }
                  <tbody>
                    @for (row of t.rows; track $index) {
                      <tr>@for (cell of row; track $index) { <td>{{ cell }}</td> }</tr>
                    }
                  </tbody>
                </table>
              </div>
            }
          }
          @default {
            <dl class="preview-meta">
              <dt>{{ 'files.preview.name' | transloco }}</dt><dd>{{ p.file.name }}</dd>
              <dt>{{ 'files.preview.size' | transloco }}</dt><dd>{{ formatSize(p.file.size) }}</dd>
              <dt>{{ 'files.preview.modified' | transloco }}</dt><dd><app-instant [value]="p.file.modified" variant="datetime"/></dd>
            </dl>
          }
        }
      }
    }
  `,
})
export class FilePreviewComponent {
  readonly preview = input<FilePreview | null>(null);

  /** The page's own rule, imported rather than copied — see `file-format.ts` for why that matters here. */
  protected readonly formatSize = formatSize;
}
