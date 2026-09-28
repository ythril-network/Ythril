/**
 * FileManagerComponent — verifies the OnPush conversion (P5, slice 3).
 *
 * All rendered state here is signal-backed: the file listing (`entries`), the directory tree
 * (`treeRoot`), breadcrumbs, and the preview pane (`previewFile`/`previewKind`). The tree code
 * mutates a node in place on expand but always follows with `treeRoot.set([...])`, and the async
 * preview/upload callbacks use signal `.set()` — both of which mark an OnPush view dirty. These
 * tests are the regression guard: after switching to OnPush, each signal-driven view must still
 * refresh. The harness's negative control (change-detection-harness.spec.ts) separately proves the
 * harness can see a stale OnPush view, so a passing assertion here means a real refresh occurred.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { of, Observable, Subject, throwError } from 'rxjs';
import { ActivatedRoute } from '@angular/router';
import { type FileEntry, type FileMeta, type UploadProgress } from '../../core/api.types';
import { FilesApi } from '../../core/files-api.service';
import { SpacesApi } from '../../core/spaces-api.service';
import { AuthService } from '../../core/auth.service';
import { BrainStore } from '../brain/brain-store.service';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { FileManagerComponent } from './file-manager.component';
import { isOnPush } from '../../testing/onpush';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import { ToastService } from '../../core/toast.service';

function fileEntry(name: string, isDir = false): FileEntry {
  return {
    name,
    isDirectory: isDir,
    isFile: !isDir,
    size: isDir ? 0 : 123,
    modified: '2026-07-14T10:00:00.000Z',
  } as FileEntry;
}

function makeApi(entries: FileEntry[]) {
  return {
    listSpaces: () => of({ spaces: [] }),
    listFiles: () => of({ entries }),
    getFileDownloadUrl: (spaceId: string, path: string) => `/api/files/${spaceId}${path}`,
    getFileMeta: () => of(null), // opening a file fetches its meta record; no record in these fixtures
  } as any;
}

/**
 * B.6 — the Extract tab: what retrieval actually sees.
 *
 * Hiding `_converted/` and `_extracted/` was right and took away the only way to answer "what did the
 * pipeline get out of this file?". These pin the two things that decide whether the tab is trustworthy: it
 * is only offered for a file that HAS an extract, and it fetches once, when opened — not on every file open.
 */
describe('FileManagerComponent — the Extract tab', () => {
  const EXTRACT = {
    path: 'a/report.pdf', chunkTotal: 3, limit: 100, skip: 0,
    converted: { path: '_converted/a/report.pdf.md', markdown: '# Report', truncated: false, sizeBytes: 8 },
    chunks: [
      { id: 'a/report.pdf#chunk0', index: 0, headingText: 'Overview', content: 'first chunk', chunkOffsetMs: null, chunkDurationMs: null },
      { id: 'a/report.pdf#chunk1', index: 1, headingText: null, content: 'second chunk', chunkOffsetMs: 65_000, chunkDurationMs: 30_000 },
    ],
    images: [{ path: '_extracted/a/report.pdf/image-0.png', description: 'A signature block.', descriptionSource: 'generated', sizeBytes: 10 }],
  };

  function open(meta: Partial<FileMeta> | null, extract: unknown = EXTRACT) {
    const entries = [{ name: 'report.pdf', isFile: true, isDirectory: false, size: 10, modified: '2026-01-01' } as FileEntry];
    const getFileExtract = vi.fn().mockReturnValue(of(extract));
    const api = {
      listSpaces: () => of({ spaces: [] }),
      listFiles: () => of({ entries }),
      getFileDownloadUrl: () => '/x',
      getFileMeta: () => of(meta),
      getFileExtract,
    } as any;
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [FileManagerComponent, getTranslocoModule()],
      providers: [
        { provide: FilesApi, useValue: api },
        { provide: SpacesApi, useValue: api },
        { provide: AuthService, useValue: { token: () => '' } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: () => '' } } } },
        { provide: BrainStore, useValue: new BrainStore() },
      ],
    });
    const fixture = TestBed.createComponent(FileManagerComponent);
    fixture.componentRef.setInput('embeddedSpaceId', 'work');
    fixture.detectChanges();
    const c = fixture.componentInstance;
    c.openPreview(entries[0]!);
    fixture.detectChanges();
    return { fixture, c, getFileExtract };
  }

  it('is offered for a file that went through the pipeline', () => {
    expect(open({ chunkCount: 3 } as FileMeta).c.hasExtract()).toBe(true);
    expect(open({ convertedFileId: '_converted/x.md' } as FileMeta).c.hasExtract()).toBe(true);
    expect(open({ mediaType: 'audio' } as FileMeta).c.hasExtract()).toBe(true);
  });

  it('is NOT offered for a file that has none', () => {
    // A tab that is always there and always says "nothing here" teaches people to ignore it.
    expect(open({ chunkCount: 0 } as FileMeta).c.hasExtract()).toBe(false);
    expect(open(null).c.hasExtract()).toBe(false);
  });

  it('fetches only when opened, and only once', () => {
    const { c, getFileExtract, fixture } = open({ chunkCount: 3 } as FileMeta);
    expect(getFileExtract, 'opening a file must not fetch the extract').not.toHaveBeenCalled();
    c.showExtractMode();
    fixture.detectChanges();
    expect(getFileExtract).toHaveBeenCalledTimes(1);
    c.detailMode.set('preview');
    c.showExtractMode();
    expect(getFileExtract, 'switching back must not refetch').toHaveBeenCalledTimes(1);
  });

  it('renders the chunks, their provenance, and the caption', () => {
    const { c, fixture } = open({ chunkCount: 3 } as FileMeta);
    c.showExtractMode();
    fixture.detectChanges();
    const t = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(t).toContain('first chunk');
    expect(t).toContain('Overview');          // document provenance: the heading it opened
    expect(t).toContain('1:05-1:35');         // audio provenance: its position in the recording
    expect(t).toContain('A signature block.');
  });

  it('does not carry one file\'s extract onto another', () => {
    // It is fetched lazily, so a stale value would show one file's chunks under another file's name.
    const { c, fixture } = open({ chunkCount: 3 } as FileMeta);
    c.showExtractMode();
    fixture.detectChanges();
    expect(c.extractStore.extract()).not.toBeNull();
    c.openPreview({ name: 'other.pdf', isFile: true, isDirectory: false, size: 1, modified: '2026-01-01' } as FileEntry);
    expect(c.extractStore.extract()).toBeNull();
  });

  // The chunk-offset clock moved to `file-format.spec.ts` when `msRange` became a shared function (G-3).
  // It was reaching through this component to exercise six lines of arithmetic, and the extract view needs
  // the same function — so the cases now test it directly, with the rounding and padding they could not
  // reasonably assert from here.

  it('appends the next page instead of replacing what is on screen', () => {
    const { c, fixture, getFileExtract } = open({ chunkCount: 3 } as FileMeta);
    c.showExtractMode();
    fixture.detectChanges();
    getFileExtract.mockReturnValue(of({
      ...EXTRACT, skip: 2,
      chunks: [{ id: 'a/report.pdf#chunk2', index: 2, headingText: null, content: 'third chunk', chunkOffsetMs: null, chunkDurationMs: null }],
    }));
    c.moreChunks({ name: 'report.pdf', isFile: true, isDirectory: false, size: 10, modified: '2026-01-01' } as FileEntry);
    fixture.detectChanges();
    expect(c.extractStore.extract()!.chunks.map(x => x.content)).toEqual(['first chunk', 'second chunk', 'third chunk']);
  });
});

describe('FileManagerComponent (OnPush)', () => {
  const text = (f: { nativeElement: HTMLElement }) => f.nativeElement.textContent ?? '';

  function create(entries: FileEntry[]) {
    TestBed.configureTestingModule({
      imports: [FileManagerComponent, getTranslocoModule()],
      providers: [
        { provide: FilesApi, useValue: makeApi(entries) },
        { provide: SpacesApi, useValue: makeApi(entries) },
        { provide: AuthService, useValue: { token: () => '' } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: () => '' } } } },
      ],
    });
    const fixture = TestBed.createComponent(FileManagerComponent);
    // Embedded path: skips space loading and drives straight to selectSpace → loadDir + loadTreeRoot.
    fixture.componentRef.setInput('embeddedSpaceId', 'work');
    fixture.detectChanges();
    return fixture;
  }

  beforeEach(() => TestBed.resetTestingModule());

  it('is compiled as OnPush', () => {
    expect(isOnPush(FileManagerComponent)).toBe(true);
  });

  // ── Live processing stage (replaces the generic "embedding" + spinner) ───────────────────────
  // The bar component and the server-side stage data both already existed; nothing joined them, so
  // every in-flight file said "embedding" for the whole job and looked the same working or wedged.
  describe('live processing stage', () => {
    const withProgress = (name: string, progress: FileEntry['progress'], status: FileEntry['embeddingStatus'] = 'processing') =>
      ({ ...fileEntry(name), embeddingStatus: status, progress, progressAt: new Date().toISOString() }) as FileEntry;

    it('draws the stage bar for a file whose job has reported a step', () => {
      const fixture = create([withProgress('scan.pdf', { step: 'vlm', steps: ['render', 'vlm'], done: 2, total: 9 })]);
      const row = fixture.nativeElement.querySelector('table tbody tr') as HTMLElement;
      expect(row.querySelector('app-step-progress-bar')).toBeTruthy();
      // The pill is REPLACED, not accompanied — two status indicators on one row is worse than either.
      expect(row.querySelector('.emb-pill')).toBeNull();
    });

    it('keeps the plain status pill when there is no stage to show', () => {
      // A finished file, and a claimed job that has not reported yet, both fall back here. Drawing an
      // empty bar for the latter would read as "zero progress" rather than "not known yet".
      const fixture = create([
        { ...fileEntry('done.pdf'), embeddingStatus: 'complete' } as FileEntry,
        { ...fileEntry('queued.pdf'), embeddingStatus: 'pending' } as FileEntry,
      ]);
      const rows = fixture.nativeElement.querySelectorAll('table tbody tr');
      expect(rows.length).toBe(2);
      expect(fixture.nativeElement.querySelectorAll('app-step-progress-bar').length).toBe(0);
      expect(fixture.nativeElement.querySelectorAll('.emb-pill').length).toBe(2);
    });
  });

  it('renders a row per file entry after load (signal-driven view updates under OnPush)', () => {
    const fixture = create([fileEntry('readme.md'), fileEntry('notes.txt'), fileEntry('sub', true)]);
    const names = Array.from(fixture.nativeElement.querySelectorAll('table tbody .file-name-btn')).map(
      (b) => (b as HTMLElement).textContent?.trim(),
    );
    expect(names).toContain('readme.md');
    expect(names).toContain('notes.txt');
    expect(names).toContain('sub');
  });

  // ── Column sort — restores what #421 dropped when File Meta merged into this tab ─────────────
  // Sorting is client-side ON PURPOSE here: listFiles returns a whole directory in one response, so
  // reordering it reorders the complete set (unlike the paginated record tabs, where a client sort
  // would reorder one page and misrepresent the rest).
  it('sorts entries by a column, keeps folders first, and clears back to server order', () => {
    const rowNames = (f: { nativeElement: HTMLElement }) =>
      Array.from(f.nativeElement.querySelectorAll('table tbody .file-name-btn'))
        .map(b => (b as HTMLElement).textContent?.trim());

    const big = { ...fileEntry('big.bin'), size: 9000 } as FileEntry;
    const small = { ...fileEntry('small.txt'), size: 10 } as FileEntry;
    const dir = fileEntry('zzz-folder', true);
    const fixture = create([big, small, dir]);   // server order: big, small, folder
    const c = fixture.componentInstance;

    expect(rowNames(fixture)).toEqual(['big.bin', 'small.txt', 'zzz-folder']); // untouched by default

    c.setSort('size');                            // 1st click → ascending
    fixture.detectChanges();
    // The folder leads despite its name sorting last and size 0 — folders always come first.
    expect(rowNames(fixture)).toEqual(['zzz-folder', 'small.txt', 'big.bin']);

    c.setSort('size');                            // 2nd click → descending
    fixture.detectChanges();
    expect(rowNames(fixture)).toEqual(['zzz-folder', 'big.bin', 'small.txt']);

    c.setSort('size');                            // 3rd click → cleared, server order returns
    fixture.detectChanges();
    expect(c.sortField()).toBe('');
    expect(rowNames(fixture)).toEqual(['big.bin', 'small.txt', 'zzz-folder']);
  });

  it('renders sortable headers for name, status, size and modified', () => {
    const fixture = create([fileEntry('a.txt')]);
    const sortable = fixture.nativeElement.querySelectorAll('table thead th[app-sort-th]');
    expect(sortable.length).toBe(4);
  });

  it('renders a tree node for each subdirectory (treeRoot signal)', () => {
    const fixture = create([fileEntry('docs', true), fileEntry('src', true), fileEntry('readme.md')]);
    const treeText = Array.from(fixture.nativeElement.querySelectorAll('.tree-node')).map(
      (n) => (n as HTMLElement).textContent?.trim(),
    );
    // Only directories become tree nodes; the file must not.
    expect(treeText.some((t) => t?.includes('docs'))).toBe(true);
    expect(treeText.some((t) => t?.includes('src'))).toBe(true);
    expect(treeText.some((t) => t?.includes('readme.md'))).toBe(false);
  });

  it('opens the docked detail pane when the previewFile signal is set (OnPush re-checks the signal)', () => {
    const fixture = create([fileEntry('photo.bin')]);
    // The list runs full width until a file is opened — no detail column yet.
    expect(fixture.nativeElement.querySelector('.fm-detail')).toBeNull();

    fixture.componentInstance.preview.kind.set('unknown');
    fixture.componentInstance.preview.file.set(fileEntry('photo.bin'));
    fixture.detectChanges();

    const detail = fixture.nativeElement.querySelector('.fm-detail');
    expect(detail).toBeTruthy();
    expect(text(fixture)).toContain('photo.bin');
    // Opening a file shows the preview face first.
    expect(fixture.componentInstance.detailMode()).toBe('preview');
    // Embedded in the Brain (create() sets embeddedSpaceId) → the [Preview | File meta] toggle is offered.
    expect(fixture.nativeElement.querySelector('.seg-toggle')).toBeTruthy();
  });

  it('hides the File-meta toggle when NOT embedded (meta editing needs the Brain-provided picker)', () => {
    const fixture = create([fileEntry('photo.bin')]);
    // Standalone /files route: no Brain injector, so meta editing is unavailable — preview only.
    fixture.componentInstance.embeddedSpaceId = '';
    fixture.componentInstance.preview.kind.set('unknown');
    fixture.componentInstance.preview.file.set(fileEntry('photo.bin'));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.fm-detail')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.seg-toggle')).toBeNull();
  });

  it('renders markdown FORMATTED (not as highlighted source) in the preview face', () => {
    const fixture = create([fileEntry('doc.md')]);
    fixture.componentInstance.preview.file.set(fileEntry('doc.md'));
    fixture.componentInstance.preview.kind.set('markdown');
    fixture.componentInstance.preview.html.set('<h1>Hello</h1><p>world</p>');
    fixture.detectChanges();
    const md = fixture.nativeElement.querySelector('.md-rendered') as HTMLElement | null;
    expect(md).toBeTruthy();
    expect(md!.querySelector('h1')?.textContent).toContain('Hello');
    // A .md must NOT fall through to the source-code (<pre class="preview-code">) branch.
    expect(fixture.nativeElement.querySelector('.preview-code')).toBeNull();
  });

  it('sanitizes rendered markdown — scripts/handlers are stripped before the trusted bind', async () => {
    // The markdown HTML is bound with bypassSecurityTrustHtml (it may carry inlined mermaid SVG), so it
    // must be sanitized before that bind. This pins that a <script> and an inline handler don't survive.
    //
    // Driven through the SERVICE the preview store calls, not through a wrapper on the component. There
    // used to be a one-line `renderMarkdown` here whose own docblock said it existed "because the
    // preview's tests drive it directly" — a method kept alive by its own test, which is the thing
    // `preview-object-url.ts` warns about in as many words. `G-3.2` deleted it and this follows the path
    // production takes.
    const fixture = create([fileEntry('x.md')]);
    const html = await (fixture.componentInstance as unknown as {
      preview: { markdown: { render(t: string): Promise<string> } };
    }).preview.markdown.render('# Title\n\n<img src=x onerror="alert(1)">\n\n<script>alert(2)</script>\n');
    expect(html).toContain('<h1'); // prose still renders
    expect(html.toLowerCase()).not.toContain('onerror');
    expect(html.toLowerCase()).not.toContain('<script');
  });

  it('parses an .xlsx into a capped first-sheet grid (header + rows, no note when small)', async () => {
    const mod = await import('exceljs');
    const ExcelJS = (mod as unknown as { default?: unknown }).default ?? mod;
    const wb = new (ExcelJS as { Workbook: new () => any }).Workbook();
    const ws = wb.addWorksheet('Data');
    ws.addRow(['Name', 'Age']);
    ws.addRow(['Alice', 30]);
    ws.addRow(['Bob', 25]);
    const buf = await wb.xlsx.writeBuffer();

    const fixture = create([fileEntry('sheet.xlsx')]);
    const table = await (fixture.componentInstance as unknown as {
      preview: { parseXlsx(b: ArrayBuffer): Promise<{ sheet: string; header: string[]; rows: string[][]; note: { key: string } | null }> };
    }).preview.parseXlsx(buf as ArrayBuffer);

    expect(table.sheet).toBe('Data');
    expect(table.header).toEqual(['Name', 'Age']);
    expect(table.rows[0]).toEqual(['Alice', '30']); // values coerced to display text
    expect(table.rows[1]).toEqual(['Bob', '25']);
    expect(table.note).toBeNull(); // small sheet → not truncated
  });
  // ^ One of the two specs that exposed the suite-wide timeout ceiling: it imports `exceljs` twice
  // (here for the fixture workbook, and again inside `parseXlsx`), so it runs long under a full
  // parallel run. No per-test override needed — `testTimeout` in vitest.config.ts covers the class.

  it('toggles the full-screen preview overlay; Escape collapses it before closing the pane', () => {
    const fixture = create([fileEntry('doc.md')]);
    fixture.componentInstance.preview.file.set(fileEntry('doc.md'));
    fixture.componentInstance.preview.kind.set('markdown');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.preview-fs-overlay')).toBeNull();

    fixture.componentInstance.preview.fullscreen.set(true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.preview-fs-overlay')).toBeTruthy();

    // First Escape collapses full-screen but leaves the docked pane open.
    fixture.componentInstance.onPreviewKey(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
    expect(fixture.componentInstance.preview.fullscreen()).toBe(false);
    expect(fixture.componentInstance.preview.file()).toBeTruthy();
  });

  it('re-renders the listing when the entries signal is replaced (not just on first load)', () => {
    const fixture = create([fileEntry('first.md')]);
    const body = () => (fixture.nativeElement.querySelector('table tbody') as HTMLElement).textContent ?? '';
    expect(body()).toContain('first.md');
    expect(body()).not.toContain('second.md');

    fixture.componentInstance.listing.entries.set([fileEntry('second.md')]);
    fixture.detectChanges();

    expect(body()).toContain('second.md');
    expect(body()).not.toContain('first.md');
  });
});

// ── Upload queue (U12) ────────────────────────────────────────────────────────

/** Build an api whose uploadFileChunked hands back a controllable Subject per call. */
function makeUploadApi(entries: FileEntry[] = []) {
  const streams: Subject<UploadProgress>[] = [];
  const calls: { spaceId: string; path: string; file: File }[] = [];
  const uploadFileChunked = vi.fn((spaceId: string, path: string, file: File): Observable<UploadProgress> => {
    const subj = new Subject<UploadProgress>();
    streams.push(subj);
    calls.push({ spaceId, path, file });
    return subj.asObservable();
  });
  /** A spy, so "did finishing an upload refresh the directory?" can be asked of a call count. */
  const listFiles = vi.fn(() => of({ entries }));
  const api = {
    listSpaces: () => of({ spaces: [] }),
    listFiles,
    getFileDownloadUrl: (s: string, p: string) => `/api/files/${s}${p}`,
    uploadFileChunked,
  } as any;
  return { api, streams, calls, uploadFileChunked, listFiles };
}

function fakeFileList(names: string[]): FileList {
  const files = names.map(n => new File(['x'], n));
  return { ...files, length: files.length, item: (i: number) => files[i] } as unknown as FileList;
}

/**
 * A refresh must never re-enter the empty state a first load uses (canary B).
 *
 * `loadDir` set `loading` on every call, and the template is `@if (loading()) { spinner } @else { table }` — so
 * the 4-second progress poll unmounted the entire file listing and replaced it with a spinner, every four
 * seconds, for the whole of an ingest. Their operator, verbatim: *"i only want to see progress bars move while
 * waiting and not a screenflickering."*
 *
 * These assert the DOM, not the flag: a spinner instead of the table is the symptom, and asserting `loading()`
 * alone would pass on a template that unmounts for some other reason.
 */
describe('FileManagerComponent — a refresh keeps the view (canary B)', () => {
  /** A listing API whose responses are controllable per call, so a refresh can be observed mid-flight. */
  function create(entries: FileEntry[], listFiles?: () => Observable<{ entries: FileEntry[] }>) {
    TestBed.configureTestingModule({
      imports: [FileManagerComponent, getTranslocoModule()],
      providers: [
        { provide: FilesApi, useValue: { ...makeApi(entries), ...(listFiles ? { listFiles } : {}) } },
        { provide: SpacesApi, useValue: makeApi(entries) },
        { provide: AuthService, useValue: { token: () => '' } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: () => '' } } } },
      ],
    });
    const fixture = TestBed.createComponent(FileManagerComponent);
    fixture.componentRef.setInput('embeddedSpaceId', 'work');
    fixture.detectChanges();
    return fixture;
  }

  const rows = (f: { nativeElement: HTMLElement }) => f.nativeElement.querySelectorAll('table tbody tr').length;
  const spinner = (f: { nativeElement: HTMLElement }) => f.nativeElement.querySelector('.loading-overlay');

  beforeEach(() => TestBed.resetTestingModule());

  it('does not unmount the table while a reload of the SAME directory is in flight', () => {
    const gate = new Subject<{ entries: FileEntry[] }>();
    let calls = 0;
    const fixture = create([fileEntry('a.pdf'), fileEntry('b.pdf')], () => {
      calls++;
      return calls === 1 ? of({ entries: [fileEntry('a.pdf'), fileEntry('b.pdf')] }) : gate.asObservable();
    });
    expect(rows(fixture)).toBe(2);

    fixture.componentInstance.reloadDir();          // the poll's call
    fixture.detectChanges();

    // Mid-flight: the rows are still there and the overlay has NOT appeared. This is the whole fix.
    expect(spinner(fixture)).toBeNull();
    expect(rows(fixture)).toBe(2);
    expect(fixture.componentInstance.listing.loading()).toBe(false);
    expect(fixture.componentInstance.listing.refreshing()).toBe(true);

    gate.next({ entries: [fileEntry('a.pdf'), fileEntry('b.pdf'), fileEntry('c.pdf')] });
    fixture.detectChanges();
    expect(rows(fixture)).toBe(3);                  // updated in place
    expect(fixture.componentInstance.listing.refreshing()).toBe(false);
  });

  it('shows the hairline while refreshing, and nothing when idle', () => {
    const gate = new Subject<{ entries: FileEntry[] }>();
    let calls = 0;
    const fixture = create([fileEntry('a.pdf')], () => {
      calls++;
      return calls === 1 ? of({ entries: [fileEntry('a.pdf')] }) : gate.asObservable();
    });
    expect(fixture.nativeElement.querySelector('.fm-refreshing')).toBeNull();

    fixture.componentInstance.reloadDir();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.fm-refreshing')).toBeTruthy();

    gate.next({ entries: [fileEntry('a.pdf')] });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.fm-refreshing')).toBeNull();
  });

  it('a failed refresh keeps the rows and says they are not current', () => {
    // A transient failure during an ingest is exactly when this happens, and throwing away good rows for it is
    // the same defect in another dress.
    let calls = 0;
    const fixture = create([fileEntry('a.pdf')], () => {
      calls++;
      return calls === 1
        ? of({ entries: [fileEntry('a.pdf')] })
        : new Observable<{ entries: FileEntry[] }>(sub => sub.error(new Error('boom')));
    });
    expect(rows(fixture)).toBe(1);

    fixture.componentInstance.reloadDir();
    fixture.detectChanges();

    expect(rows(fixture)).toBe(1);                                       // rows survive
    expect(spinner(fixture)).toBeNull();
    expect(fixture.componentInstance.listing.loadError()).toBeNull();            // NOT the first-load error state
    expect(fixture.componentInstance.listing.refreshFailed()).toBe(true);
    expect(fixture.nativeElement.querySelector('.fm-stale')).toBeTruthy();
  });

  it('a FIRST load still shows the spinner — the empty state is not what changed', () => {
    const gate = new Subject<{ entries: FileEntry[] }>();
    const fixture = create([], () => gate.asObservable());
    expect(spinner(fixture)).toBeTruthy();
    expect(fixture.componentInstance.listing.loading()).toBe(true);
    gate.next({ entries: [fileEntry('a.pdf')] });
    fixture.detectChanges();
    expect(spinner(fixture)).toBeNull();
  });

  it('a failed FIRST load still reaches the error state, not an empty folder', () => {
    const fixture = create([], () => new Observable<{ entries: FileEntry[] }>(sub => sub.error(new Error('nope'))));
    expect(fixture.componentInstance.listing.loadError()).not.toBeNull();
    expect(fixture.componentInstance.listing.refreshFailed()).toBe(false);
  });

  it('navigating to a DIFFERENT directory is a load, not a refresh', () => {
    // Rows from the directory being left must not be shown under the name of the one being entered — which is
    // why the classification compares the path rather than trusting the caller.
    const gate = new Subject<{ entries: FileEntry[] }>();
    let calls = 0;
    const fixture = create([fileEntry('a.pdf')], () => {
      calls++;
      return calls === 1 ? of({ entries: [fileEntry('a.pdf')] }) : gate.asObservable();
    });
    expect(rows(fixture)).toBe(1);

    fixture.componentInstance.navigate('/sub');
    fixture.detectChanges();

    expect(fixture.componentInstance.listing.loading()).toBe(true);
    expect(spinner(fixture)).toBeTruthy();
  });
});

describe('FileManagerComponent — upload queue (U12)', () => {
  let mock: ReturnType<typeof makeUploadApi>;

  function create() {
    mock = makeUploadApi();
    TestBed.configureTestingModule({
      imports: [FileManagerComponent, getTranslocoModule()],
      providers: [
        { provide: FilesApi, useValue: mock.api },
        { provide: SpacesApi, useValue: mock.api },
        { provide: AuthService, useValue: { token: () => '' } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: () => '' } } } },
      ],
    });
    const fixture = TestBed.createComponent(FileManagerComponent);
    fixture.componentRef.setInput('embeddedSpaceId', 'work');
    fixture.detectChanges();
    return fixture;
  }

  beforeEach(() => TestBed.resetTestingModule());

  const rows = (fx: { nativeElement: HTMLElement }) =>
    Array.from(fx.nativeElement.querySelectorAll('.upload-row'));

  it('shows one row per file and uploads them one at a time', () => {
    const fx = create();
    const comp = fx.componentInstance;
    (comp as any).enqueueUploads(fakeFileList(['a.txt', 'b.txt']));
    fx.detectChanges();

    // Two rows; only the first upload has started (serialised queue).
    expect(rows(fx).length).toBe(2);
    expect(mock.uploadFileChunked).toHaveBeenCalledTimes(1);
    expect(comp.uploads.items()[0].status).toBe('uploading');
    expect(comp.uploads.items()[1].status).toBe('queued');

    // Finish the first → second starts.
    mock.streams[0].next({ percent: 100, done: true });
    mock.streams[0].complete();
    fx.detectChanges();
    expect(comp.uploads.items()[0].status).toBe('done');
    expect(mock.uploadFileChunked).toHaveBeenCalledTimes(2);
    expect(comp.uploads.items()[1].status).toBe('uploading');

    mock.streams[1].next({ percent: 100, done: true });
    mock.streams[1].complete();
    fx.detectChanges();
    expect(comp.uploads.items()[1].status).toBe('done');
  });

  it('marks a failed upload and re-queues it on retry', () => {
    const fx = create();
    const comp = fx.componentInstance;
    (comp as any).enqueueUploads(fakeFileList(['a.txt']));
    fx.detectChanges();

    mock.streams[0].error({ error: { error: 'disk full' } });
    fx.detectChanges();
    expect(comp.uploads.items()[0].status).toBe('failed');
    expect(comp.uploads.items()[0].error).toBe('disk full');
    // A Retry button is offered (test transloco renders the raw key).
    expect(fx.nativeElement.textContent).toContain('common.retry');

    comp.retryUpload(comp.uploads.items()[0]);
    fx.detectChanges();
    expect(comp.uploads.items()[0].status).toBe('uploading');
    expect(mock.uploadFileChunked).toHaveBeenCalledTimes(2);
  });

  it('cancel drops the row and advances the queue (abort is covered in the api.service spec)', () => {
    const fx = create();
    const comp = fx.componentInstance;
    (comp as any).enqueueUploads(fakeFileList(['a.txt', 'b.txt']));
    fx.detectChanges();

    comp.cancelUpload(comp.uploads.items()[0]);
    fx.detectChanges();

    // Row a.txt is gone; b.txt takes over.
    expect(comp.uploads.items().length).toBe(1);
    expect(comp.uploads.items()[0].name).toBe('b.txt');
    expect(comp.uploads.items()[0].status).toBe('uploading');
    expect(mock.uploadFileChunked).toHaveBeenCalledTimes(2);
  });

  it('clears finished rows but keeps active/queued ones', () => {
    const fx = create();
    const comp = fx.componentInstance;
    (comp as any).enqueueUploads(fakeFileList(['a.txt', 'b.txt']));
    // Finish the first.
    mock.streams[0].next({ percent: 100, done: true });
    mock.streams[0].complete();
    fx.detectChanges();

    expect(comp.hasFinishedUploads()).toBe(true);
    comp.clearFinishedUploads();
    fx.detectChanges();
    // Only the still-uploading b.txt remains.
    expect(comp.uploads.items().map(u => u.name)).toEqual(['b.txt']);
  });
});

/**
 * The upload queue's other half — the parts with no test at all (`G-3` characterization).
 *
 * Four cases already stand over the queue itself: it serialises, a failure can be retried, a cancel advances
 * it, and finished rows clear. What none of them touch is everything AROUND the queue, and that is the half a
 * refactor drops silently:
 *
 * **The overwrite question.** Uploading over an existing path is a REPLACE and it takes the derived records
 * with it — conversion chunks, the converted Markdown, extracted images, and any description generated from
 * them. That is correct, it happened silently, and it was reported against 2.1.1. The question is asked ONCE
 * for the whole batch, and declining queues nothing at all.
 *
 * **The two side effects of finishing.** A completed upload refreshes the directory and emits
 * `filesChanged`, which is how the Brain shell's tab badge learns its count moved. Both belong to something
 * other than the queue — the listing store and the host — so both are exactly what a move would leave behind.
 *
 * These are pinned BEFORE the queue becomes its own store, against the code as it stands, so the move has
 * something to be measured against rather than a promise that it behaved the same.
 */
describe('FileManagerComponent — what surrounds the upload queue', () => {
  let mock: ReturnType<typeof makeUploadApi>;
  let confirmCalls: number;
  let confirmAnswer: boolean;

  function create(entries: FileEntry[] = []) {
    mock = makeUploadApi(entries);
    confirmCalls = 0;
    TestBed.configureTestingModule({
      imports: [FileManagerComponent, getTranslocoModule()],
      providers: [
        { provide: FilesApi, useValue: mock.api },
        { provide: SpacesApi, useValue: mock.api },
        { provide: AuthService, useValue: { token: () => '' } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: () => '' } } } },
        {
          provide: ConfirmDialogService,
          useValue: { confirm: () => { confirmCalls++; return Promise.resolve(confirmAnswer); } },
        },
      ],
    });
    const fixture = TestBed.createComponent(FileManagerComponent);
    fixture.componentRef.setInput('embeddedSpaceId', 'work');
    fixture.detectChanges();
    return fixture;
  }

  beforeEach(() => TestBed.resetTestingModule());

  it('asks ONCE for a batch where several files collide, and queues nothing when declined', async () => {
    confirmAnswer = false;
    const fx = create([fileEntry('a.txt'), fileEntry('b.txt')]);
    const comp = fx.componentInstance;

    await (comp as any).enqueueUploads(fakeFileList(['a.txt', 'b.txt', 'new.txt']));
    fx.detectChanges();

    // One question for two collisions — a drop of twenty files where three collide is one question.
    expect(confirmCalls).toBe(1);
    // Declining takes the WHOLE batch with it, including new.txt: the alternative is a partial upload
    // nobody asked for, from a dialog that only mentioned the files that clashed.
    expect(comp.uploads.items()).toEqual([]);
    expect(mock.uploadFileChunked).not.toHaveBeenCalled();
  });

  it('uploads the whole batch once the overwrite is confirmed', async () => {
    confirmAnswer = true;
    const fx = create([fileEntry('a.txt')]);
    const comp = fx.componentInstance;

    await (comp as any).enqueueUploads(fakeFileList(['a.txt', 'new.txt']));
    fx.detectChanges();

    expect(confirmCalls).toBe(1);
    expect(comp.uploads.items().map(u => u.name)).toEqual(['a.txt', 'new.txt']);
    expect(mock.uploadFileChunked).toHaveBeenCalledTimes(1);   // still serialised
  });

  it('does not ask at all when nothing is being overwritten', async () => {
    confirmAnswer = true;
    const fx = create([fileEntry('other.txt'), fileEntry('sub', true)]);
    const comp = fx.componentInstance;

    await (comp as any).enqueueUploads(fakeFileList(['new.txt']));
    fx.detectChanges();

    // A dialog that appears when nothing is at risk teaches people to click through the one that matters.
    expect(confirmCalls).toBe(0);
    expect(comp.uploads.items().map(u => u.name)).toEqual(['new.txt']);
  });

  it('only a DIRECTORY of the same name is not a collision', async () => {
    confirmAnswer = false;
    const fx = create([fileEntry('report', true)]);
    const comp = fx.componentInstance;

    await (comp as any).enqueueUploads(fakeFileList(['report']));
    fx.detectChanges();

    // The clash set is built from `isFile` entries. A directory named `report` cannot be replaced by a
    // file upload, so asking about it would be asking about something that is not going to happen.
    expect(confirmCalls).toBe(0);
    expect(comp.uploads.items().map(u => u.name)).toEqual(['report']);
  });

  it('a FINISHED upload refreshes the directory and tells the host its count moved', async () => {
    confirmAnswer = true;
    const fx = create();
    const comp = fx.componentInstance;
    let changed = 0;
    comp.filesChanged.subscribe(() => changed++);

    await (comp as any).enqueueUploads(fakeFileList(['a.txt']));
    fx.detectChanges();

    // Counted from a baseline taken here, not from zero: the page lists the directory on init and again
    // whenever the space or path changes, so a count from zero would pass with the completion deleted.
    const listedBefore = mock.listFiles.mock.calls.length;
    expect(changed).toBe(0);

    mock.streams[0].next({ percent: 100, done: true });
    mock.streams[0].complete();
    fx.detectChanges();

    expect(comp.uploads.items()[0].status).toBe('done');
    expect(mock.listFiles.mock.calls.length).toBe(listedBefore + 1);
    expect(changed).toBe(1);
  });

  it('a FAILED upload refreshes nothing and tells the host nothing', async () => {
    confirmAnswer = true;
    const fx = create();
    const comp = fx.componentInstance;
    let changed = 0;
    comp.filesChanged.subscribe(() => changed++);

    await (comp as any).enqueueUploads(fakeFileList(['a.txt']));
    fx.detectChanges();
    const listedBefore = mock.listFiles.mock.calls.length;

    mock.streams[0].error({ error: { error: 'disk full' } });
    fx.detectChanges();

    // The pair to the case above, and the reason it is here: an unconditional refresh would pass that one
    // while wiping the panel's own error row off a listing that has not changed.
    expect(comp.uploads.items()[0].status).toBe('failed');
    expect(mock.listFiles.mock.calls.length).toBe(listedBefore);
    expect(changed).toBe(0);
  });

  // The file picker moved to `file-toolbar.component.ts` with the element it clears, and its case went
  // with it — see `file-toolbar.component.spec.ts`. A test for a cleared input has to be able to reach the
  // input.

  it('dismissing a finished row leaves the others alone', async () => {
    confirmAnswer = true;
    const fx = create();
    const comp = fx.componentInstance;

    await (comp as any).enqueueUploads(fakeFileList(['a.txt', 'b.txt']));
    mock.streams[0].next({ percent: 100, done: true });
    mock.streams[0].complete();
    fx.detectChanges();

    comp.dismissUpload(comp.uploads.items()[0]);
    fx.detectChanges();

    expect(comp.uploads.items().map(u => u.name)).toEqual(['b.txt']);
    expect(comp.uploads.items()[0].status).toBe('uploading');
  });

  it('crossing between panes keeps the drop target armed; leaving the page disarms it', () => {
    const fx = create();
    const comp = fx.componentInstance;
    const host = document.createElement('div');
    const innerPane = document.createElement('span');
    host.appendChild(innerPane);
    const over = () => ({ preventDefault: () => {}, stopPropagation: () => {} }) as unknown as DragEvent;
    const leaveTo = (related: Node | null) =>
      ({ currentTarget: host, relatedTarget: related }) as unknown as DragEvent;

    comp.onDragOver(over());
    fx.detectChanges();
    expect(comp.dragOver()).toBe(true);

    // Dragging from the tree pane onto the table fires `dragleave` on the way. Clearing there would drop
    // the highlight halfway across the page, so the check is whether the cursor left the COMPONENT.
    comp.onDragLeave(leaveTo(innerPane));
    fx.detectChanges();
    expect(comp.dragOver()).toBe(true);

    comp.onDragLeave(leaveTo(null));
    fx.detectChanges();
    expect(comp.dragOver()).toBe(false);
  });

  it('a queued file goes to the folder it was DROPPED on, not the one open when its turn comes', async () => {
    confirmAnswer = true;
    const fx = create();
    const comp = fx.componentInstance;

    await (comp as any).enqueueUploads(fakeFileList(['a.txt', 'b.txt']));
    fx.detectChanges();
    expect(mock.calls[0].path).toBe('/');

    // The queue is serialised, so b.txt has not started yet. Navigating away while an upload is in flight is
    // ordinary — the panel stays visible on purpose, precisely so you can carry on working.
    comp.navigate('/sub');
    fx.detectChanges();

    mock.streams[0].next({ percent: 100, done: true });
    mock.streams[0].complete();
    fx.detectChanges();

    // b.txt was dropped on the root and must land on the root. Reading the CURRENT path when its turn comes
    // puts it wherever the user happens to be standing, with a done row claiming success and the file
    // nowhere the user looked for it.
    expect(mock.calls.length).toBe(2);
    expect(mock.calls[1].path).toBe('/');
  });

  it('leaving the page aborts an upload that is still running', async () => {
    confirmAnswer = true;
    const fx = create();
    const comp = fx.componentInstance;

    await (comp as any).enqueueUploads(fakeFileList(['a.txt']));
    fx.detectChanges();
    expect(comp.uploads.items()[0].status).toBe('uploading');

    comp.ngOnDestroy();
    mock.streams[0].next({ percent: 50, done: false });

    // Unsubscribing tears down the cold upload observable, which aborts the in-flight chunk request. What is
    // observable from here is that its callbacks stopped arriving: a request left running writes to signals
    // nothing is reading, on a component that is gone.
    expect(comp.uploads.items()[0].percent).toBe(0);
  });

  it('a second drop while one is uploading joins the queue rather than starting beside it', async () => {
    confirmAnswer = true;
    const fx = create();
    const comp = fx.componentInstance;

    await (comp as any).enqueueUploads(fakeFileList(['a.txt']));
    fx.detectChanges();
    expect(mock.uploadFileChunked).toHaveBeenCalledTimes(1);

    // Dropping more files while the first is in flight is the ordinary way this panel gets used. The
    // one-at-a-time rule is what keeps a slow connection from being split across ten parallel uploads, and
    // it has to hold for a batch that arrives DURING one, not only within a single batch.
    await (comp as any).enqueueUploads(fakeFileList(['b.txt']));
    fx.detectChanges();

    expect(mock.uploadFileChunked).toHaveBeenCalledTimes(1);
    expect(comp.uploads.items().map(u => u.status)).toEqual(['uploading', 'queued']);

    mock.streams[0].next({ percent: 100, done: true });
    mock.streams[0].complete();
    fx.detectChanges();
    expect(mock.uploadFileChunked).toHaveBeenCalledTimes(2);
  });

  it('retrying a row that did not fail does nothing — it would upload the file twice', async () => {
    confirmAnswer = true;
    const fx = create();
    const comp = fx.componentInstance;

    await (comp as any).enqueueUploads(fakeFileList(['a.txt']));
    mock.streams[0].next({ percent: 100, done: true });
    mock.streams[0].complete();
    fx.detectChanges();
    expect(comp.uploads.items()[0].status).toBe('done');

    // Retry is offered on a failed row only, and the panel's markup is what enforces that on screen. This
    // is the same rule one layer down: a finished row re-queued would upload the same bytes again, and an
    // upload is a REPLACE that drops the file's derived records — so the second one is not a no-op.
    comp.retryUpload(comp.uploads.items()[0]);
    fx.detectChanges();

    expect(mock.uploadFileChunked).toHaveBeenCalledTimes(1);
    expect(comp.uploads.items()[0].status).toBe('done');
  });
});

// ── File preview / download auth (regression from #134 query-token scoping) ────
describe('FileManagerComponent — preview/download auth', () => {
  beforeEach(() => TestBed.resetTestingModule());

  function create(token: string) {
    TestBed.configureTestingModule({
      imports: [FileManagerComponent, getTranslocoModule()],
      providers: [
        { provide: FilesApi, useValue: makeApi([]) },
        { provide: SpacesApi, useValue: makeApi([]) },
        { provide: AuthService, useValue: { token: () => token } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: () => '' } } } },
      ],
    });
    const fixture = TestBed.createComponent(FileManagerComponent);
    fixture.componentRef.setInput('embeddedSpaceId', 'work');
    fixture.detectChanges();
    return fixture;
  }

  it('downloadFile sends the token in the Authorization header, never in the URL', async () => {
    const fixture = create('T');
    const calls: { url: unknown; opts: any }[] = [];
    const origFetch = globalThis.fetch;
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    globalThis.fetch = vi.fn((url: unknown, opts: any) => {
      calls.push({ url, opts });
      return Promise.resolve({ ok: true, blob: () => Promise.resolve(new Blob(['x'])) } as Response);
    }) as unknown as typeof fetch;
    URL.createObjectURL = vi.fn(() => 'blob:mock');
    URL.revokeObjectURL = vi.fn();
    try {
      await fixture.componentInstance.downloadFile(
        { name: 'photo.png', isDirectory: false, isFile: true, size: 1, modified: '' } as FileEntry,
      );
    } finally {
      globalThis.fetch = origFetch;
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
    }
    expect(calls.length).toBe(1);
    // #134 scoped the ?token= fallback to SSE only — the token must NOT ride in the URL.
    expect(String(calls[0].url)).not.toContain('token=');
    expect(calls[0].opts.headers.Authorization).toBe('Bearer T');
  });
});

/**
 * Characterization for Q-92 point 11: what a user observes when they download a file, pinned before the
 * hand-written blob download is replaced by one shared authenticated-download helper.
 *
 * Every case drives `downloadFile` end to end with `fetch`, the object-URL API and the anchor's `click`
 * stubbed, because jsdom implements none of them. What is pinned is what the user gets: which URL is asked
 * for and with which credential, what the saved file is called, which bytes it holds, that the blob URL is
 * released, and what the page says (and does NOT save) when the request fails.
 */
describe('FileManagerComponent — downloading a file (characterization for Q-92)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  function create(token: string) {
    const toasts: { kind: string; msg: string }[] = [];
    const api = makeApi([]);
    // The REAL URL builder, so the request URL asserted below is the one the app sends, not a stub's.
    api.getFileDownloadUrl = (spaceId: string, path: string) => FilesApi.prototype.getFileDownloadUrl.call(null, spaceId, path);
    TestBed.configureTestingModule({
      imports: [FileManagerComponent, getTranslocoModule()],
      providers: [
        { provide: FilesApi, useValue: api },
        { provide: SpacesApi, useValue: api },
        { provide: AuthService, useValue: { token: () => token } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: () => '' } } } },
        { provide: ToastService, useValue: {
          show: () => {},
          error:   (msg: string) => toasts.push({ kind: 'error', msg }),
          success: (msg: string) => toasts.push({ kind: 'success', msg }),
          info:    (msg: string) => toasts.push({ kind: 'info', msg }),
        } },
      ],
    });
    const fixture = TestBed.createComponent(FileManagerComponent);
    fixture.componentRef.setInput('embeddedSpaceId', 'work');
    fixture.detectChanges();
    return { c: fixture.componentInstance, toasts };
  }

  /** Stub the four browser seams a download touches; `restore` puts every one back. */
  function stubBrowser(respond: (url: string) => Promise<unknown>) {
    const fetches: { url: string; init: any }[] = [];
    const created: unknown[] = [];
    const revoked: string[] = [];
    const clicked: { href: string; download: string; inDom: boolean }[] = [];
    const had = { fetch: 'fetch' in globalThis, create: 'createObjectURL' in URL, revoke: 'revokeObjectURL' in URL };
    const prev = { fetch: (globalThis as any).fetch, create: (URL as any).createObjectURL, revoke: (URL as any).revokeObjectURL };
    (globalThis as any).fetch = (url: string, init: unknown) => { fetches.push({ url, init }); return respond(url); };
    (URL as any).createObjectURL = (b: unknown) => { created.push(b); return 'blob:dl-' + created.length; };
    (URL as any).revokeObjectURL = (u: string) => { revoked.push(u); };
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.getAttribute('href') ?? '', download: this.download, inDom: document.body.contains(this) });
    });
    const restore = () => {
      click.mockRestore();
      if (had.fetch) (globalThis as any).fetch = prev.fetch; else delete (globalThis as any).fetch;
      if (had.create) (URL as any).createObjectURL = prev.create; else delete (URL as any).createObjectURL;
      if (had.revoke) (URL as any).revokeObjectURL = prev.revoke; else delete (URL as any).revokeObjectURL;
    };
    return { fetches, created, revoked, clicked, restore };
  }

  const entryNamed = (name: string) => ({ name, isDirectory: false, isFile: true, size: 1, modified: '' } as FileEntry);

  it('fetches the file endpoint for the current folder with the bearer, and saves the bytes under the entry name', async () => {
    const bytes = new Blob(['%PDF-1.7'], { type: 'application/pdf' });
    const b = stubBrowser(() => Promise.resolve({ ok: true, status: 200, blob: () => Promise.resolve(bytes) }));
    vi.useFakeTimers();
    try {
      const { c, toasts } = create('T');
      c.currentPath.set('/docs/q3');
      await c.downloadFile(entryNamed('report 1.pdf'));

      expect(b.fetches).toHaveLength(1);
      expect(b.fetches[0].url).toBe('/api/files/work?path=%2Fdocs%2Fq3%2Freport%201.pdf');
      expect(b.fetches[0].init).toEqual({ headers: { Authorization: 'Bearer T' } });

      // The saved blob IS the response body: same object, so the type the server sent is the type saved.
      expect(b.created).toEqual([bytes]);
      expect((b.created[0] as Blob).type).toBe('application/pdf');

      // One anchor, clicked while attached to the document, named after the entry, pointing at the blob URL.
      expect(b.clicked).toEqual([{ href: 'blob:dl-1', download: 'report 1.pdf', inDom: true }]);
      // ...and removed afterwards, so repeated downloads do not accumulate anchors.
      expect(document.body.querySelector('a[href="blob:dl-1"]')).toBeNull();

      // AS-IS: the revoke is DEFERRED by 10 s rather than immediate, so the browser has started the save
      // before the URL goes away.
      expect(b.revoked).toEqual([]);
      vi.advanceTimersByTime(9_999);
      expect(b.revoked).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(b.revoked).toEqual(['blob:dl-1']);

      expect(toasts).toEqual([]);
    } finally {
      vi.useRealTimers();
      b.restore();
    }
  });

  it('with no token it sends no Authorization header at all, not an empty bearer', async () => {
    const b = stubBrowser(() => Promise.resolve({ ok: true, status: 200, blob: () => Promise.resolve(new Blob(['x'])) }));
    try {
      const { c } = create('');
      await c.downloadFile(entryNamed('a.txt'));
      expect(b.fetches[0].url).toBe('/api/files/work?path=%2Fa.txt');
      expect(b.fetches[0].init).toEqual({ headers: {} });
    } finally {
      b.restore();
    }
  });

  it('an HTTP error saves nothing and toasts files.downloadFailed with the status', async () => {
    let blobRead = false;
    const b = stubBrowser(() => Promise.resolve({ ok: false, status: 403, blob: () => { blobRead = true; return Promise.resolve(new Blob(['denied'])); } }));
    try {
      const { c, toasts } = create('T');
      await c.downloadFile(entryNamed('secret.pdf'));

      expect(blobRead).toBe(false);          // the error body is never read, let alone saved
      expect(b.created).toEqual([]);
      expect(b.clicked).toEqual([]);
      expect(b.revoked).toEqual([]);
      // The key is echoed by the testing transloco module; the reason is `httpErrorReason(new Error('HTTP 403'))`.
      expect(toasts).toEqual([{ kind: 'error', msg: 'files.downloadFailed HTTP 403' }]);
    } finally {
      b.restore();
    }
  });

  it('a network failure saves nothing and toasts files.downloadFailed with the error message', async () => {
    const b = stubBrowser(() => Promise.reject(new TypeError('Failed to fetch')));
    try {
      const { c, toasts } = create('T');
      await c.downloadFile(entryNamed('a.txt'));
      expect(b.created).toEqual([]);
      expect(b.clicked).toEqual([]);
      expect(toasts).toEqual([{ kind: 'error', msg: 'files.downloadFailed Failed to fetch' }]);
    } finally {
      b.restore();
    }
  });
});

/**
 * Live refresh while a file is processing.
 *
 * The shell opens an SSE stream and bumps `BrainStore.liveRefreshTick` on a `file.*` event — that is how
 * every record tab stays current. This list never read it. Status pill and processing stage bar are both
 * built from the DIRECTORY LISTING, so with no reload they sat at whatever they were when the folder was
 * opened: a file could finish and still read "Embedding" until you navigated away and back.
 *
 * Nothing errored, which is exactly why it presented as a slow pipeline rather than a stale view — so the
 * test asserts the RELOAD happens, not that a particular pill is drawn.
 */
describe('FileManagerComponent — live refresh on the shell tick', () => {
  function create(entries: FileEntry[]) {
    const api = makeApi(entries);
    const listFiles = vi.fn().mockReturnValue(of({ entries }));
    api.listFiles = listFiles;
    const store = new BrainStore();
    TestBed.configureTestingModule({
      imports: [FileManagerComponent, getTranslocoModule()],
      providers: [
        { provide: FilesApi, useValue: api },
        { provide: SpacesApi, useValue: api },
        { provide: AuthService, useValue: { token: () => '' } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: () => '' } } } },
        { provide: BrainStore, useValue: store },
      ],
    });
    const fixture = TestBed.createComponent(FileManagerComponent);
    fixture.componentRef.setInput('embeddedSpaceId', 'work');
    fixture.detectChanges();
    return { fixture, store, listFiles };
  }

  const PROCESSING: FileEntry[] = [
    { name: 'big.pdf', size: 10, isFile: true, isDirectory: false, modified: '2026-01-01', embeddingStatus: 'processing' } as FileEntry,
  ];

  it('re-lists the directory when the shell signals a change', () => {
    const { fixture, store, listFiles } = create(PROCESSING);
    const before = listFiles.mock.calls.length;

    store.liveRefreshTick.update(t => t + 1);
    fixture.detectChanges();

    expect(listFiles.mock.calls.length, 'a tick must re-list the directory').toBeGreaterThan(before);
  });

  it('lists the directory exactly ONCE on open — the effect must not double-load', () => {
    // The effect skips its own first run, because creating the component already listed the folder.
    // Without that guard every folder open costs two identical requests. Asserting the absolute count is
    // what catches it: measuring "no further calls AFTER creation" is blind, since the duplicate already
    // happened by then.
    // Two, not one: opening a folder lists the folder AND the tree root. Three would mean the effect
    // ran on its own first tick and re-listed on top of the initial load.
    const { listFiles } = create(PROCESSING);
    expect(listFiles.mock.calls.length, 'folder + tree root, and nothing more').toBe(2);
  });

  /**
   * B.5 — the stage bar has to ADVANCE, not just react to completion.
   *
   * The tick above fires on `file.*` SSE events, which are brain writes. Per-page progress is not one:
   * `touchJobProgress` writes a heartbeat and publishes nothing, so the bar was drawn once from the
   * listing that was current when the folder was opened and sat at "page 12 of 40" for the whole
   * conversion. The reporter read that as a wedged pipeline.
   *
   * A poll is the honest mechanism for a value with no event behind it — so what these pin is that it is
   * bounded: only while something on screen is in flight, never stacked, never after the view is gone.
   */
  describe('the processing poll', () => {
    const IDLE: FileEntry[] = [
      { name: 'done.pdf', size: 10, isFile: true, isDirectory: false, modified: '2026-01-01', embeddingStatus: 'complete' } as FileEntry,
    ];

    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('re-lists while a file is processing, without waiting for an event', () => {
      const { listFiles } = create(PROCESSING);
      const before = listFiles.mock.calls.length;
      vi.advanceTimersByTime(4_000);
      expect(listFiles.mock.calls.length, 'the poll must re-list').toBeGreaterThan(before);
    });

    it('keeps going — a stage bar that advances once is still stuck', () => {
      const { listFiles } = create(PROCESSING);
      const before = listFiles.mock.calls.length;
      vi.advanceTimersByTime(12_000);
      expect(listFiles.mock.calls.length - before).toBeGreaterThanOrEqual(3);
    });

    it('does NOT poll an idle folder', () => {
      // The cost of getting this wrong is a permanent background request loop on every open folder in
      // every tab, which is worse than the stale bar it was meant to fix.
      const { listFiles } = create(IDLE);
      const before = listFiles.mock.calls.length;
      vi.advanceTimersByTime(20_000);
      expect(listFiles.mock.calls.length).toBe(before);
    });

    it('stops once the file finishes', () => {
      const { fixture, listFiles } = create(PROCESSING);
      // The next listing reports it complete — as the real one does when the job lands.
      listFiles.mockReturnValue(of({ entries: IDLE }));
      vi.advanceTimersByTime(4_000);
      fixture.detectChanges();
      const after = listFiles.mock.calls.length;
      vi.advanceTimersByTime(20_000);
      expect(listFiles.mock.calls.length, 'the poll must retire itself').toBe(after);
    });

    it('never stacks two timers, however many listings land', () => {
      const { fixture, listFiles } = create(PROCESSING);
      // Three more loads, each of which calls the sync — a start-per-load would triple the rate.
      for (let i = 0; i < 3; i++) { fixture.componentInstance.reloadDir(); fixture.detectChanges(); }
      const before = listFiles.mock.calls.length;
      vi.advanceTimersByTime(4_000);
      expect(listFiles.mock.calls.length - before).toBe(1);
    });

    it('does not poll while the Extract tab is open either — same in-flight rule', () => {
      // The poll follows what is on screen, not which face of the pane is showing: a file still being
      // converted is the case where the Extract tab is most worth refreshing.
      const { fixture, listFiles } = create(PROCESSING);
      fixture.componentInstance.detailMode.set('extract');
      const before = listFiles.mock.calls.length;
      vi.advanceTimersByTime(4_000);
      expect(listFiles.mock.calls.length).toBeGreaterThan(before);
    });

    it('a FAILED refresh does not retire the poll — that is how it recovers', () => {
      /*
       * The one case the other seven do not reach, and the one the docblock overclaimed about.
       *
       * `syncProgressPolling` runs on a landed listing. There is no such hook on a FAILED one — and after
       * `G-14` a failed refresh CLEARS the rows, so "only while a row on screen is in flight" stops being
       * true of the code the moment a poll's own request fails.
       *
       * Keeping it running is the right answer, which is why this pins the behaviour rather than changing
       * it: retiring the poll on one failed request would mean a single blip stops progress updating until
       * the person navigates away and back, and the file they are watching finishes with the bar frozen.
       * A stopped poll after a transient failure is indistinguishable from the wedged pipeline this whole
       * mechanism exists to fix.
       */
      const { fixture, listFiles } = create(PROCESSING);

      // The poll's own request fails.
      listFiles.mockReturnValue(throwError(() => ({ status: 500 })));
      vi.advanceTimersByTime(4_000);
      fixture.detectChanges();
      // A failed REFRESH keeps its rows — that is the load-versus-refresh rule, and it is what makes
      // carrying on correct: the file is still processing, the table still says so, and one failed
      // request changed neither of those facts.
      expect(fixture.componentInstance.listing.entries().length, 'a failed refresh keeps its rows').toBe(1);

      // It keeps trying, so the view repairs itself when the server answers again.
      const during = listFiles.mock.calls.length;
      vi.advanceTimersByTime(8_000);
      expect(listFiles.mock.calls.length, 'the poll must survive a failed request').toBeGreaterThan(during);

      // And when it does answer, the rows come back without anyone touching anything.
      listFiles.mockReturnValue(of({ entries: PROCESSING }));
      vi.advanceTimersByTime(4_000);
      fixture.detectChanges();
      expect(fixture.componentInstance.listing.entries().length).toBe(1);
    });

    it('is cleared on destroy, so it cannot outlive the view', () => {
      const { fixture, listFiles } = create(PROCESSING);
      fixture.destroy();
      const after = listFiles.mock.calls.length;
      vi.advanceTimersByTime(20_000);
      expect(listFiles.mock.calls.length).toBe(after);
    });
  });
});

/**
 * R.7 — the row's own actions.
 *
 * Re-embedding lived only in the detail pane, so repairing a file whose embedding had failed meant opening
 * it first — while the row was already showing the failure. These pin the two decisions that make the row
 * button safe to offer: WHICH rows get it (a pending or processing job answers a retry with a 409, and an
 * action whose only outcome is a refusal is worse than an absent one), and that a re-queue in flight greys
 * out THAT row rather than every row.
 */
describe('FileManagerComponent — row actions', () => {
  const FAILED = { ...fileEntry('broken.pdf'), embeddingStatus: 'failed' } as FileEntry;
  const DONE = { ...fileEntry('good.pdf'), embeddingStatus: 'complete' } as FileEntry;
  const RUNNING = { ...fileEntry('busy.pdf'), embeddingStatus: 'processing' } as FileEntry;
  const QUEUED = { ...fileEntry('waiting.pdf'), embeddingStatus: 'pending' } as FileEntry;
  const PLAIN = fileEntry('notes.txt');
  const DIR = fileEntry('folder', true);

  function create(entries: FileEntry[]) {
    const retryEmbedding = vi.fn(() => of({ ok: true }));
    const api = { ...makeApi(entries), retryEmbedding } as any;
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [FileManagerComponent, getTranslocoModule()],
      providers: [
        { provide: FilesApi, useValue: api },
        { provide: SpacesApi, useValue: api },
        { provide: AuthService, useValue: { token: () => '' } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: () => '' } } } },
        { provide: BrainStore, useValue: new BrainStore() },
      ],
    });
    const fixture = TestBed.createComponent(FileManagerComponent);
    fixture.componentRef.setInput('embeddedSpaceId', 'work');
    fixture.detectChanges();
    return { fixture, c: fixture.componentInstance, retryEmbedding };
  }

  it('offers re-embed for a file whose job has settled', () => {
    const { c } = create([FAILED, DONE]);
    expect(c.canRequeue(FAILED)).toBe(true);
    expect(c.canRequeue(DONE)).toBe(true);
  });

  it('does NOT offer it while a job is pending or processing — the server answers those with a 409', () => {
    const { c } = create([RUNNING, QUEUED]);
    expect(c.canRequeue(RUNNING)).toBe(false);
    expect(c.canRequeue(QUEUED)).toBe(false);
  });

  it('does not offer it for a directory, or for a file with no job at all', () => {
    const { c } = create([DIR, PLAIN]);
    expect(c.canRequeue(DIR)).toBe(false);
    expect(c.canRequeue(PLAIN)).toBe(false);
  });

  it('re-queues the row it was clicked on, by path', () => {
    const { c, retryEmbedding } = create([FAILED, DONE]);
    c.requeueEmbedding(FAILED);
    expect(retryEmbedding).toHaveBeenCalledWith('work', 'broken.pdf');
  });

  it('marks only THAT path as in flight, so one retry does not grey out the list', () => {
    // A shared boolean was the obvious version of this, and it reads as "the whole list is busy".
    const pending = new Subject<unknown>();
    const retryEmbedding = vi.fn(() => pending as unknown as Observable<unknown>);
    const api = { ...makeApi([FAILED, DONE]), retryEmbedding } as any;
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [FileManagerComponent, getTranslocoModule()],
      providers: [
        { provide: FilesApi, useValue: api },
        { provide: SpacesApi, useValue: api },
        { provide: AuthService, useValue: { token: () => '' } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: () => '' } } } },
        { provide: BrainStore, useValue: new BrainStore() },
      ],
    });
    const fixture = TestBed.createComponent(FileManagerComponent);
    fixture.componentRef.setInput('embeddedSpaceId', 'work');
    fixture.detectChanges();
    const c = fixture.componentInstance;

    c.requeueEmbedding(FAILED);
    expect(c.metaStore.requeueingPath()).toBe('broken.pdf');
    expect(c.metaStore.requeueingPath()).not.toBe(c.relPath(DONE));

    pending.next({ ok: true });
    pending.complete();
    expect(c.metaStore.requeueingPath()).toBe('');
  });

  it('clears the in-flight path when the request fails, so the button comes back', () => {
    const failing = { ...makeApi([FAILED]), retryEmbedding: vi.fn(() => new Observable(s => s.error({ status: 409 }))) } as any;
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [FileManagerComponent, getTranslocoModule()],
      providers: [
        { provide: FilesApi, useValue: failing },
        { provide: SpacesApi, useValue: failing },
        { provide: AuthService, useValue: { token: () => '' } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: () => '' } } } },
        { provide: BrainStore, useValue: new BrainStore() },
      ],
    });
    const fixture = TestBed.createComponent(FileManagerComponent);
    fixture.componentRef.setInput('embeddedSpaceId', 'work');
    fixture.detectChanges();
    const c = fixture.componentInstance;
    c.requeueEmbedding(FAILED);
    expect(c.metaStore.requeueingPath()).toBe('');
  });

  it('renders rename as an icon with its label kept for hover and assistive tech', () => {
    // The word "Rename" was the one text button among icons, so it set the actions column width on every
    // row. The label has to survive the change or the button becomes unlabelled.
    const { fixture } = create([FAILED]);
    const html = fixture.nativeElement.innerHTML as string;
    expect(html).toContain('files.renameEntryAriaLabel');
    const buttons = Array.from(fixture.nativeElement.querySelectorAll('tbody button')) as HTMLElement[];
    const renameBtn = buttons.find(b => (b.getAttribute('aria-label') ?? '').includes('renameEntryAriaLabel'));
    expect(renameBtn).toBeTruthy();
    expect(renameBtn!.querySelector('ph-icon, svg')).toBeTruthy();
  });
});
