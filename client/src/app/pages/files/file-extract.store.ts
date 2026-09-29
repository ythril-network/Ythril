import { Injectable, inject, signal } from '@angular/core';
import { FilesApi } from '../../core/files-api.service';
import { httpErrorReason } from '../../core/http-error';
import type { FileExtract } from '../../core/api.types';

/** One page of chunks. The server's own limit for this endpoint, and the only place it is stated. */
const PAGE = 100;

/**
 * The Extract face: its three signals, its one request, and the two paging rules that go with it.
 *
 * `G-3`'s ninth cut. Small — a quarter the size of the listing store — and the reason it is worth its own
 * file is not the line count but that three of its four rules had no test until the change before this one,
 * and each is the kind a rewrite gets subtly wrong while every assertion it kept still passes.
 *
 * ## The two rules that are easy to get almost right
 *
 * **Paging APPENDS, and keeps the FIRST response's `skip`.** Appending is obvious once stated — "show more"
 * on a diagnostic must not throw away what the reader has already scrolled through. The `skip` is not: it
 * records where this VIEW started, which is what the footer reads to say how far in you are. A version that
 * let the newest response's `skip` win gets the chunks right and the position wrong, and nothing on screen
 * contradicts it.
 *
 * **The next page is asked for from what is ON SCREEN**, not from the last response. Those two are the same
 * number only on the first page, and they diverge immediately afterwards precisely because the first `skip`
 * is the one preserved — so reading it back would ask for the same page for ever.
 *
 * ## Why the lazy-open rule stayed on the page
 *
 * The component decides WHEN to open the tab; this store answers whether there is anything to show. Fetching
 * on the first open and not on every switch back is a judgement about a gesture, and the gesture belongs to
 * whoever owns the detail pane. What moved here is the state that judgement reads (`hasNothing`), so the page
 * no longer has to know that "nothing" means two signals rather than one.
 *
 * ## Provided by the page, not application-wide
 *
 * Same reason as the tree store: its lifetime is the page's. An extract belongs to the file that is open, and
 * an instance surviving navigation would hand the next visit one file's chunks under another file's name —
 * which is the defect `clear()` exists to prevent within a single visit.
 */
@Injectable()
export class FileExtractStore {
  private readonly filesApi = inject(FilesApi);

  /** The chunks on screen, or `null` for "nothing has been asked for" — which is NOT the same as none found. */
  readonly extract = signal<FileExtract | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  /**
   * Whether there is nothing to show and nothing on the way.
   *
   * Two signals, one question, asked by the page's lazy-open rule. Exposed as a predicate so the page cannot
   * get the conjunction wrong — reading `!extract()` alone would re-fetch while a request was already in
   * flight, which is one of the four rules pinned before this cut.
   */
  hasNothing(): boolean {
    return !this.extract() && !this.loading();
  }

  /**
   * Forget the current extract.
   *
   * Called when a new file is selected. The extract is fetched lazily, so a stale value here would show one
   * file's chunks under another file's name until the tab was opened again.
   */
  clear(): void {
    this.extract.set(null);
    this.error.set(null);
  }

  /** Load a page. `skip = 0` replaces; anything else appends to what is already on screen. */
  load(spaceId: string, path: string, skip = 0): void {
    this.loading.set(true);
    this.error.set(null);
    this.filesApi.getFileExtract(spaceId, path, PAGE, skip).subscribe({
      next: (x) => {
        const prev = skip > 0 ? this.extract() : null;
        this.extract.set(prev ? { ...x, chunks: [...prev.chunks, ...x.chunks], skip: prev.skip } : x);
        this.loading.set(false);
      },
      error: (e) => {
        // The extract is left as it was rather than blanked: on a failed "show more" the chunks already read
        // are still true, and clearing them would punish the reader for a request they did not make.
        this.error.set(httpErrorReason(e));
        this.loading.set(false);
      },
    });
  }

  /** The next page, counted from what is on screen. */
  more(spaceId: string, path: string): void {
    this.load(spaceId, path, this.extract()?.chunks.length ?? 0);
  }

  /**
   * The next window of the converted Markdown, appended to what is on screen (Q-128). A window is whole paragraphs,
   * so the text shown is always text the document contains, and reading on reaches the end.
   */
  moreMarkdown(spaceId: string, path: string): void {
    const x = this.extract();
    const next = x?.converted?.markdownNextSkip;
    if (!x?.converted || next === undefined) return;
    this.loading.set(true);
    this.error.set(null);
    this.filesApi.getFileExtract(spaceId, path, PAGE, 0, next).subscribe({
      next: (y) => {
        const cur = this.extract();
        if (cur?.converted && y.converted) {
          this.extract.set({ ...cur, converted: { ...y.converted, markdown: cur.converted.markdown + y.converted.markdown, markdownSkip: cur.converted.markdownSkip } });
        }
        this.loading.set(false);
      },
      error: (e) => { this.error.set(httpErrorReason(e)); this.loading.set(false); },
    });
  }
}
