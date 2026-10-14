/**
 * The Files page against a FAKE FILE SERVER, for specs that must see what the page SENDS and what it does with the answer.
 *
 * ## Why this exists beside the stub-the-API specs
 *
 * The page's specs stub `FilesApi` with `useValue`, which is right for "what does the page say" and blind to the
 * request itself: a stubbed `deleteFile` takes whatever arguments the page hands it, so a body that says
 * `confirm: true` for a plain file passes every one of them. Here the REAL `FilesApi` runs over `HttpTestingController`
 * and every request is answered the way the server answers it (listing, delete with its `confirm_required` refusal,
 * move, mkdir), against an in-memory tree the spec can change between the page's reads. What a spec asserts is then
 * the wire (method, path, body) and the screen, never a method signature of a store — so a rewrite of the stores'
 * internals cannot make it pass or fail for a reason unrelated to the rule.
 *
 * Nothing here knows a selector the change under test introduces: rows are found by the name button the page has
 * always had, and a row's delete by the danger icon button.
 */
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { of } from 'rxjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ActivatedRoute } from '@angular/router';
import { SpacesApi } from '../core/spaces-api.service';
import { AuthService } from '../core/auth.service';
import { ToastService } from '../core/toast.service';
import { ConfirmDialogService } from '../core/confirm-dialog.service';
import { FileManagerComponent } from '../pages/files/file-manager.component';
import { getTranslocoModule } from './transloco-testing';

const I18N = resolve(__dirname, '../../../public/assets/i18n');

/** One locale's translation file as shipped. */
export function locale(name: string): Record<string, string> {
  return JSON.parse(readFileSync(resolve(I18N, `${name}.json`), 'utf8'));
}

/** What a spec seeds: a path to `'dir'`, to a file's size in bytes, or to a directory that reports a size (`{ dirSize }`, as the server's listing totals one). */
export type FakeTree = Record<string, 'dir' | number | { dirSize: number }>;

/** One request as the page sent it. */
export interface SentRequest { method: string; path: string; params: Record<string, string>; body: unknown }

/** A toast as the page raised it: its kind, its words, and the lifetime it asked for (0 = until dismissed, undefined = the default). */
export interface RaisedToast { kind: 'success' | 'error' | 'info'; message: string; duration: number | undefined }

/** What the confirm dialog was asked, exactly as `ConfirmDialogService.confirm` received it. */
export interface AskedConfirm { title?: string; message?: string; confirmLabel?: string; danger?: boolean; [key: string]: unknown }

const dirOf = (path: string): string => path.replace(/\/[^/]*$/, '') || '/';
const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** The server side: a tree of paths and the three writes the Files page makes, answered as the server answers them. */
export class FakeFileServer {
  readonly nodes = new Map<string, 'dir' | number | { dirSize: number }>();
  readonly sent: SentRequest[] = [];
  /** Answers a spec wants to force: the next request matching (method, path) gets this status and body instead. */
  readonly forced: { method: string; path: string; status: number; body: unknown }[] = [];

  constructor(tree: FakeTree) {
    for (const [path, kind] of Object.entries(tree)) this.nodes.set(path, kind);
  }

  /** Make `path` a directory with the given size now, whatever it was — the stale-row case. */
  put(path: string, kind: 'dir' | number | { dirSize: number }): void { this.nodes.set(path, kind); }

  children(dir: string): { name: string; type: 'file' | 'dir'; size: number; modifiedAt: string }[] {
    const out: { name: string; type: 'file' | 'dir'; size: number; modifiedAt: string }[] = [];
    for (const [path, kind] of this.nodes) {
      if (path === dir || dirOf(path) !== dir) continue;
      const isDir = typeof kind !== 'number';
      out.push({ name: nameOf(path), type: isDir ? 'dir' : 'file', size: typeof kind === 'number' ? kind : typeof kind === 'object' ? kind.dirSize : 0, modifiedAt: '2026-10-01T10:00:00.000Z' });
    }
    return out;
  }

  /** Requests a spec holds in flight (`METHOD path-param`), so what the page shows WHILE one runs can be read. */
  private readonly holds = new Set<string>();
  private readonly held = new Map<string, TestRequest>();

  hold(method: string, path: string): void { this.holds.add(`${method} ${path}`); }

  /** Answer a held request the way the server would, now. */
  release(method: string, path: string): void {
    const key = `${method} ${path}`;
    this.holds.delete(key);
    const req = this.held.get(key);
    this.held.delete(key);
    if (req) this.respond(req);
  }

  /** Receive one request: record it, then answer it, or keep it in flight when a spec holds it. */
  answer(req: TestRequest): void {
    const url = new URL(req.request.url, 'http://x');
    this.sent.push({
      method: req.request.method, path: url.pathname,
      params: Object.fromEntries(req.request.params.keys().map(k => [k, req.request.params.get(k) ?? ''])),
      body: req.request.body,
    });
    const key = `${req.request.method} ${req.request.params.get('path') ?? ''}`;
    if (this.holds.has(key)) { this.held.set(key, req); return; }
    this.respond(req);
  }

  private respond(req: TestRequest): void {
    const url = new URL(req.request.url, 'http://x');
    const path = req.request.params.get('path') ?? '';
    const record = { method: req.request.method, path: url.pathname };
    const forcedAt = this.forced.findIndex(f => f.method === record.method && f.path === path);
    if (forcedAt >= 0) {
      const [f] = this.forced.splice(forcedAt, 1);
      req.flush(f!.body as Parameters<TestRequest['flush']>[0], { status: f!.status, statusText: 'forced' });
      return;
    }
    const files = /^\/api\/files\/[^/]+$/.test(url.pathname);
    if (files && record.method === 'GET') { req.flush({ entries: this.children(path) }); return; }
    if (files && record.method === 'DELETE') {
      const kind = this.nodes.get(path);
      const confirmed = (req.request.body as { confirm?: unknown } | null)?.confirm === true;
      if (kind !== undefined && typeof kind !== 'number' && !confirmed) {
        req.flush({ error: 'Deleting a directory requires confirm: true.', code: 'confirm_required', path }, { status: 422, statusText: 'Unprocessable' });
        return;
      }
      for (const key of [...this.nodes.keys()]) if (key === path || key.startsWith(`${path}/`)) this.nodes.delete(key);
      req.flush(null, { status: 204, statusText: 'No Content' });
      return;
    }
    if (files && record.method === 'PATCH') {
      const to = (req.request.body as { destination: string }).destination;
      if (this.nodes.has(to)) { req.flush({ error: 'exists', code: 'destination_exists', path: to }, { status: 409, statusText: 'Conflict' }); return; }
      for (const key of [...this.nodes.keys()]) {
        if (key === path || key.startsWith(`${path}/`)) { const kind = this.nodes.get(key)!; this.nodes.delete(key); this.nodes.set(to + key.slice(path.length), kind); }
      }
      req.flush(null, { status: 204, statusText: 'No Content' });
      return;
    }
    if (/\/mkdir$/.test(url.pathname)) { this.nodes.set(path, 'dir'); req.flush(null, { status: 201, statusText: 'Created' }); return; }
    // Everything else (the file's metadata record, space stats, ...) is not what these specs are about: an empty answer.
    req.flush({ results: [], total: 0 });
  }

  /** The requests of one method and path-parameter, in the order the page sent them. */
  sentWith(method: string, path?: string): SentRequest[] {
    return this.sent.filter(r => r.method === method && (path === undefined || r.params['path'] === path));
  }
}

export interface MountedPage {
  fixture: ComponentFixture<FileManagerComponent>;
  /** The page component, untyped on purpose: specs reach the same public members the existing specs do. */
  c: any;
  server: FakeFileServer;
  confirms: AskedConfirm[];
  toasts: RaisedToast[];
  /** Let every pending request be answered and every promise settle, re-rendering between rounds. */
  settle(): Promise<void>;
  el: HTMLElement;
  /** The listing's rows, by the name button the page has always had. */
  rowNames(): string[];
  /** The `<tr>` whose name button reads `name`. */
  row(name: string): HTMLTableRowElement;
  /** Click the delete button of a row (the danger icon button), then settle. */
  clickDelete(name: string): Promise<void>;
  confirmAnswer: { value: boolean };
}

/**
 * Mount the Files page embedded in a space, over a fake server holding `tree`, in `lang` (the REAL translation file,
 * so what a spec reads is the sentence the operator reads), and settle the first listing.
 */
export async function mountFilesPage(tree: FakeTree, opts: { lang?: string; sidebarOpen?: boolean } = {}): Promise<MountedPage> {
  const lang = opts.lang ?? 'en';
  const server = new FakeFileServer(tree);
  const confirms: AskedConfirm[] = [];
  const toasts: RaisedToast[] = [];
  const confirmAnswer = { value: true };
  try { localStorage.setItem('ythril.sidebar', opts.sidebarOpen === false ? 'closed' : 'open'); } catch { /* storage is a convenience */ }
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [FileManagerComponent, getTranslocoModule({
      langs: { [lang]: locale(lang) },
      translocoConfig: { availableLangs: [lang], defaultLang: lang },
    })],
    providers: [
      provideHttpClient(), provideHttpClientTesting(),
      { provide: SpacesApi, useValue: { listSpaces: () => of({ spaces: [{ id: 'work', label: 'work' }] }) } },
      { provide: AuthService, useValue: { token: () => 't' } },
      { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: () => null } }, queryParamMap: of() } },
      { provide: ConfirmDialogService, useValue: { confirm: (o: AskedConfirm) => { confirms.push(o); return Promise.resolve(confirmAnswer.value); } } },
      { provide: ToastService, useValue: {
        error: (message: string, duration?: number) => { toasts.push({ kind: 'error', message, duration }); return 0; },
        info: (message: string, duration?: number) => { toasts.push({ kind: 'info', message, duration }); return 0; },
        success: (message: string, duration?: number) => { toasts.push({ kind: 'success', message, duration }); return 0; },
        show: (message: string, kind: 'success' | 'error' | 'info' = 'info', duration?: number) => { toasts.push({ kind, message, duration }); return 0; },
        dismiss: () => {}, clear: () => {},
      } },
    ],
  });
  const http = TestBed.inject(HttpTestingController);
  const fixture = TestBed.createComponent(FileManagerComponent);
  fixture.componentRef.setInput('embeddedSpaceId', 'work');
  const el = fixture.nativeElement as HTMLElement;

  const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0));
  const settle = async (): Promise<void> => {
    for (let idle = 0; idle < 3;) {
      await tick();
      fixture.detectChanges();
      const pending = http.match(() => true);
      if (pending.length === 0) { idle++; continue; }
      idle = 0;
      for (const req of pending) server.answer(req);
    }
    await fixture.whenStable();
    fixture.detectChanges();
  };

  fixture.detectChanges();
  await settle();

  const rowNames = (): string[] => [...el.querySelectorAll('tbody .file-name-btn')].map(b => (b.textContent ?? '').trim());
  const row = (name: string): HTMLTableRowElement => {
    const btn = [...el.querySelectorAll('tbody .file-name-btn')].find(b => (b.textContent ?? '').trim() === name);
    if (!btn) throw new Error(`no row named ${name}; rows: ${rowNames().join(', ') || '(none)'}`);
    return btn.closest('tr') as HTMLTableRowElement;
  };
  const clickDelete = async (name: string): Promise<void> => {
    const button = row(name).querySelector('button.icon-btn.danger') as HTMLButtonElement | null;
    if (!button) throw new Error(`row ${name} has no delete button (button.icon-btn.danger)`);
    button.click();
    await settle();
  };

  return { fixture, c: fixture.componentInstance as any, server, confirms, toasts, settle, el, rowNames, row, clickDelete, confirmAnswer };
}
