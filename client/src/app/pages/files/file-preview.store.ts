import { Injectable, inject, signal, computed } from '@angular/core';
import { DomSanitizer, SafeResourceUrl, SafeHtml } from '@angular/platform-browser';
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
import { AuthenticatedDownload } from '../../core/authenticated-download';
import { MarkdownRenderService } from '../../shared/markdown-render.service';
import { httpErrorReason } from '../../core/http-error';
import type { FileEntry } from '../../core/api.types';
import { PreviewObjectUrl } from './preview-object-url';
// The view model and its vocabulary live with the component that RENDERS them, as `FileMetaModel` lives
// with the editor that binds to it and `UploadItem` with the panel that draws a row.
import type { FilePreview, PreviewKind, XlsxPreview } from './file-preview.component';

/*
 * The languages, registered where `hljs.highlight` is CALLED.
 *
 * `highlight.js/lib/core` is a module singleton with an empty registry, so a call for an unregistered
 * language throws — and these registrations sat in `file-manager.component.ts` while the call moved here.
 * That works only for as long as something still imports that file first, which is a dependency nothing
 * states and no test would notice: the page imports this store, so the order happens to hold today.
 *
 * The set is deliberately narrow. Every language is a chunk in the bundle, and these are the extensions
 * `TEXT_EXTS` actually offers a source preview for. Adding an extension there without a language here
 * renders it as `plaintext`, which is the honest fallback rather than a failure.
 */
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

const XLSX_MAX_ROWS = 200;
const XLSX_MAX_COLS = 40;

const TEXT_EXTS = new Set([
  '.txt', '.json', '.yaml', '.yml', '.ts', '.js', '.py', '.sh',
  '.csv', '.xml', '.html', '.css', '.log', '.env', '.toml',
]);
// Markdown renders formatted (via marked) rather than as highlighted source.
const MARKDOWN_EXTS = new Set(['.md', '.markdown']);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp']);
const PDF_EXTS = new Set(['.pdf']);
// exceljs reads the OOXML formats (.xlsx/.xlsm), not the legacy binary .xls — don't promise what won't parse.
const XLSX_EXTS = new Set(['.xlsx', '.xlsm']);

const EXT_LANG: Record<string, string> = {
  '.js': 'javascript', '.ts': 'typescript', '.json': 'json',
  '.yaml': 'yaml', '.yml': 'yaml', '.xml': 'xml', '.html': 'xml',
  '.css': 'css', '.md': 'markdown', '.py': 'python',
  '.sh': 'bash', '.bash': 'bash',
};

/**
 * A file's extension, lower-cased, or `''`.
 *
 * `i > 0` and not `i >= 0`: a leading dot is part of the NAME. `.gitignore` has no extension, and neither
 * does a file someone called `.md`.
 */
export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i).toLowerCase() : '';
}

/** Which preview a filename gets. `unknown` is not an error — it offers a download and starts no request. */
export function previewKindOf(name: string): PreviewKind {
  const ext = extOf(name);
  if (MARKDOWN_EXTS.has(ext)) return 'markdown';
  if (TEXT_EXTS.has(ext)) return 'text';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (PDF_EXTS.has(ext)) return 'pdf';
  if (XLSX_EXTS.has(ext)) return 'xlsx';
  return 'unknown';
}

/**
 * Coerce an exceljs cell value to display text.
 *
 * A cell is a string, a number, a Date, or one of FOUR objects — a formula with its cached result, a
 * hyperlink with its label, rich text as runs, or an error. Six branches, and getting one wrong renders
 * `[object Object]` down a whole column without erroring, which looks like a sheet nobody filled in.
 */
export function xlsxCellText(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toLocaleDateString();
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o['richText'])) return (o['richText'] as Array<{ text?: string }>).map(t => t.text ?? '').join('');
    if ('result' in o) return o['result'] == null ? '' : String(o['result']);   // formula → computed result
    if ('text' in o) return String(o['text']);                                   // hyperlink label
    if ('error' in o) return String(o['error']);
    return '';
  }
  return String(v);
}

/**
 * The docked preview: which kind a file is, the fetch that gets it, and what the renderer is handed.
 *
 * `G-3.2`. Provided by the PAGE, for the reason every store on this page is: the pane renders inside an
 * `@if`, and a component owning the fetch would abort it on every remount.
 *
 * ## It holds no translations, so the xlsx note is a KEY
 *
 * Five stores on this page and not one of them translates — the wording of anything a person reads is the
 * renderer's, and this file cannot see the locale. The spreadsheet note is the only prose the preview
 * produces, and it is produced by the parse, which is what knows the numbers. So the parse returns the key
 * and its parameters, and `file-preview.component.ts` renders them. Same rule as the listing store's
 * failure KEYS, from the other end.
 *
 * ## One seam for every fetch, because four rules were written out per branch
 *
 * The auth header, the `!r.ok` throw, the failure path, and the staleness check — three copies each, except
 * the staleness check, which had only three of its four: the plain-text branch never got one, so a source
 * preview could show one file's contents under another file's name. See `fetchInto`.
 */
@Injectable()
export class FilePreviewStore {
  private readonly download = inject(AuthenticatedDownload);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly markdown = inject(MarkdownRenderService);

  /** The file the pane is showing, or `null` when nothing is open. */
  readonly file = signal<FileEntry | null>(null);
  readonly kind = signal<PreviewKind>('unknown');
  /**
   * A string for highlighted source (Angular sanitizes on bind); a trusted `SafeHtml` for rendered
   * markdown, because it may contain inlined mermaid SVG that Angular's own sanitizer would strip.
   */
  readonly html = signal<string | SafeHtml>('');
  readonly loading = signal(false);
  readonly mediaUrl = signal('');
  readonly safeUrl = signal<SafeResourceUrl>('');
  /** Set when the fetch fails, so the pane shows a reason rather than going blank. */
  readonly error = signal<string | null>(null);
  readonly table = signal<XlsxPreview | null>(null);
  /** True while the pane is expanded to a full-screen overlay. Escape collapses this before closing. */
  readonly fullscreen = signal(false);

  /** The blob URL backing an image or PDF, and its lifetime — see `preview-object-url.ts`. */
  readonly objectUrl = new PreviewObjectUrl();

  /**
   * The eight signals as the one object the renderer takes.
   *
   * Computed here rather than passed as eight inputs: the states are mutually exclusive and saying so once,
   * in a place that can see all of them, is what stops the child re-deriving "am I loading or erroring"
   * from flags it receives separately. Null when nothing is open, which is the child's own empty case.
   */
  readonly model = computed<FilePreview | null>(() => {
    const file = this.file();
    if (!file) return null;
    return {
      file,
      loading: this.loading(),
      error: this.error(),
      kind: this.kind(),
      html: this.html(),
      mediaUrl: this.mediaUrl(),
      safeUrl: this.safeUrl(),
      table: this.table(),
    };
  });

  /**
   * Show `entry`, fetching its bytes from `url`.
   *
   * The URL is passed in rather than built here: it comes from the listing store, and one store reaching
   * into another is how the two would start disagreeing about what a path is.
   */
  open(entry: FileEntry, url: string): void {
    const kind = previewKindOf(entry.name);
    this.file.set(entry);
    this.kind.set(kind);
    this.html.set('');
    this.error.set(null);
    this.objectUrl.release();
    this.mediaUrl.set('');
    this.safeUrl.set('');
    this.table.set(null);
    this.fullscreen.set(false);

    if (kind === 'text') {
      this.fetchInto(entry, url,
        async r => hljs.highlight(await r.text(), { language: EXT_LANG[extOf(entry.name)] ?? 'plaintext' }).value,
        html => this.html.set(html));
    } else if (kind === 'markdown') {
      // marked → HTML, with any ```mermaid fences rendered to inline SVG; the whole thing is sanitized
      // with DOMPurify and marked trusted (Angular's own sanitizer would strip the SVG).
      this.fetchInto(entry, url,
        async r => this.sanitizer.bypassSecurityTrustHtml(await this.markdown.render(await r.text())),
        html => this.html.set(html));
    } else if (kind === 'image' || kind === 'pdf') {
      // The object URL is allocated in `show`, not while producing: created before the staleness check it
      // would be created for a file nobody is looking at, and dropping it there is the leak this page had.
      this.fetchInto(entry, url,
        r => r.blob(),
        blob => this.bindBlobUrl(entry, kind, URL.createObjectURL(blob)));
    } else if (kind === 'xlsx') {
      this.fetchInto(entry, url,
        async r => this.parseXlsx(await r.arrayBuffer()),
        table => this.table.set(table));
    }
    // No fifth branch, deliberately: an unknown type offers a download and never starts a request, so it
    // shows the pane with no spinner. A spinner left spinning cannot be told from a request that hung.
  }

  /** Close the pane and release the blob URL. Idempotent, so closing twice cannot double-revoke. */
  close(): void {
    this.file.set(null);
    this.objectUrl.release();
    this.fullscreen.set(false);
  }

  /**
   * Bind a freshly fetched image or PDF, unless the selection moved on while it was in flight.
   *
   * Public because the characterization suite drives this seam directly: a test that stubbed `fetch` twice
   * would be asserting on the stub's ordering rather than on the guard.
   */
  bindBlobUrl(entry: FileEntry, kind: string, objUrl: string): void {
    // Not a second copy of `fetchInto`'s check. `PreviewObjectUrl` owns a resource that must be RELEASED,
    // and its safety cannot depend on every caller having looked first — so it takes the predicate and
    // revokes what it refuses to bind. That is the class's precondition; the other is the fetch's.
    const bound = this.objectUrl.bindIfCurrent(objUrl, () => this.stillShowing(entry));
    if (!bound) return;
    if (kind === 'image') this.mediaUrl.set(bound);
    else this.safeUrl.set(this.sanitizer.bypassSecurityTrustResourceUrl(bound));
  }

  /** Is the pane still showing the file this fetch was started for? One definition of "not stale". */
  private stillShowing(entry: FileEntry): boolean {
    return this.file()?.name === entry.name;
  }

  /**
   * Fetch one file's bytes with auth, render them, and show the result only if it is still wanted.
   *
   * ## Why this exists rather than four branches that each do it
   *
   * Every preview fetch must carry the auth header — the file endpoint requires it, and a browser-native
   * `<img src>`/`<iframe src>` cannot send one, which is what regressed image and PDF previews when the
   * `?token=` fallback was scoped to SSE-only (#134). So the bytes are fetched with the token and the view
   * is handed a same-origin `blob:` URL instead.
   *
   * That much was written out three times, once per branch, and so were three more rules with it: the
   * `!r.ok` throw, the failure path, and the staleness check. **Four rules, three copies each — and the
   * staleness check had only THREE copies, because the plain-text branch never got one.** Arrow from a
   * large source file to a small one and the order is: start A, start B, B resolves and shows B, A resolves
   * and overwrites it. The pane then shows A's source under B's name and stays that way, with nothing
   * erroring. Markdown, xlsx and the blob binder each guarded against exactly that; text did not.
   *
   * ## The two halves, and why the split is where it is
   *
   * `produce` turns the response into something displayable and **must not touch store state** — it may
   * await (mermaid rendering, an exceljs parse), so by the time it returns the selection may have moved on.
   * `show` is the only half that writes, and it runs only while the pane still holds `entry`.
   *
   * **The spinner is cleared in `show`'s branch, not after it.** A stale response clearing it would hide the
   * spinner belonging to the fetch that is still running for the file actually on screen — leaving a pane
   * with no spinner and no content.
   *
   * **A stale FAILURE is dropped too.** Reporting it would put one file's error on a different file's pane,
   * and the file it is about is not the one being looked at.
   */
  private fetchInto<V>(
    entry: FileEntry,
    url: string,
    produce: (r: Response) => Promise<V> | V,
    show: (value: V) => void,
  ): void {
    this.loading.set(true);
    // The bearer, the same-origin rule and the `HTTP <status>` throw live in the shared download module.
    this.download.fetch(url, produce)
      .then(value => {
        if (!this.stillShowing(entry)) return;
        show(value);
        this.loading.set(false);
      })
      .catch((e) => {
        if (!this.stillShowing(entry)) return;
        this.error.set(httpErrorReason(e));
        this.loading.set(false);
      });
  }

  /**
   * Parse an .xlsx/.xlsm buffer into a capped first-sheet grid.
   *
   * exceljs is heavy, so it is lazy-imported only when a spreadsheet is actually opened. Rows and columns
   * are capped WITH a visible note rather than silently, so a huge sheet cannot lock the tab and nobody is
   * left believing they saw all of it.
   */
  private async parseXlsx(buf: ArrayBuffer): Promise<XlsxPreview> {
    const mod = await import('exceljs') as unknown as { default?: unknown };
    // exceljs ships a UMD browser build; the workbook factory is the module default (or the namespace).
    const ExcelJS = (mod.default ?? mod) as { Workbook: new () => { xlsx: { load(b: ArrayBuffer): Promise<unknown> }; worksheets: Array<{ name: string; rowCount: number; columnCount: number; getRow(r: number): { getCell(c: number): { value: unknown } } }> } };
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws = wb.worksheets[0];
    if (!ws) return { sheet: '', header: [], rows: [], note: { key: 'files.preview.xlsxEmpty' } };

    const totalRows = ws.rowCount, totalCols = ws.columnCount;
    const capRows = Math.min(totalRows, XLSX_MAX_ROWS), capCols = Math.min(totalCols, XLSX_MAX_COLS);
    const grid: string[][] = [];
    for (let r = 1; r <= capRows; r++) {
      const row = ws.getRow(r);
      const cells: string[] = [];
      for (let c = 1; c <= capCols; c++) cells.push(xlsxCellText(row.getCell(c).value));
      grid.push(cells);
    }
    const note = (totalRows > capRows || totalCols > capCols)
      ? { key: 'files.preview.xlsxTruncated', params: { rows: capRows, totalRows, cols: capCols, totalCols } }
      : null;
    // First row as a header band — the near-universal spreadsheet convention for a quick-look preview.
    return { sheet: ws.name, header: grid[0] ?? [], rows: grid.slice(1), note };
  }
}
