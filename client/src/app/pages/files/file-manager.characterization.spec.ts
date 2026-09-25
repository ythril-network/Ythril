/**
 * FileManagerComponent — characterization tests for G-3.
 *
 * ## What these are, and what they are not
 *
 * They pin the behaviour **as it is today**, before the file is split. They are not a statement that every
 * behaviour here is right — a characterization test's job is to make a refactor's regressions loud, and that
 * requires recording what happens rather than what should. Where something looks like a defect it is marked
 * `AS-IS` with what it does, and changing it must be a deliberate edit to the assertion rather than a
 * deletion. That convention is what let the graph extraction (G-2, G-5, G-6) land three real bugs as
 * three-line diffs instead of archaeology.
 *
 * ## Why this file, and why now
 *
 * `file-manager.component.ts` is 1 618 code lines, the largest in the repo, and its spec never mentions **69
 * of its 117 members**. It is one component doing the browser, the upload flow, the preview, the extract tab
 * and the per-file metadata drawer, and each of those is a plausible seam — so each is a place a lost binding
 * can hide. The repo rule is characterization tests first, as their own change, proven green against the
 * original code.
 *
 * ## Chosen for where a split would actually break something
 *
 * Not coverage for its own sake. Each block below is a seam whose behaviour is non-obvious, is invisible when
 * wrong, or spans two of the concerns the split will separate:
 *
 *   - **sorting** — folders-before-files is enforced ahead of the chosen column, and the third click clears
 *     back to the server's order rather than cycling. Both are easy to lose when a table header becomes a
 *     shared primitive.
 *   - **paths** — `join` and the breadcrumb accumulator are the only two places that build a path, and they
 *     disagree about nothing today. A split that gives the tree its own copy is exactly how they start to.
 *   - **the preview object URL** — a leak is invisible, and so is a premature revoke. Nothing else in this
 *     page owns a resource that must be released.
 *   - **the metadata edit model** — a plain object beside signals, re-seeded on open and on cancel. It is the
 *     one piece of state here that a signal-based extraction would silently change the semantics of.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { of, throwError, Subject } from 'rxjs';
import { ToastService } from '../../core/toast.service';
import { ActivatedRoute } from '@angular/router';
import { FilesApi } from '../../core/files-api.service';
import { SpacesApi } from '../../core/spaces-api.service';
import { BrainApi } from '../../core/brain-api.service';
import { AuthService } from '../../core/auth.service';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { FileManagerComponent } from './file-manager.component';

/** Read-only stubs: this file exercises pure derivation and local state, never a request. */
function makeApi() {
  return {
    listSpaces: () => of({ spaces: [{ id: 'work', label: 'work' }] }),
    listFiles: () => of({ entries: [], path: '/' }),
    getFileDownloadUrl: () => of({ url: '' }),
    getFileExtract: () => of(null),
    createDir: () => of({}),
    deleteFile: () => of({}),
    moveFile: () => of({}),
    retryEmbedding: () => of({}),
    getSpaceStats: () => of({ facts: 0, entities: 0, edges: 0, chrono: 0, files: 0 }),
    getSpaceMeta: () => of({ tagSuggestions: [], typeSchemas: {} }),
    getFileMeta: () => of(null),
    updateFileMeta: () => of({}),
    getExtractStatus: () => of(null),
  } as any;
}

function create() {
  TestBed.configureTestingModule({
    imports: [FileManagerComponent, getTranslocoModule()],
    providers: [
      { provide: FilesApi, useValue: makeApi() },
      { provide: SpacesApi, useValue: makeApi() },
      { provide: BrainApi, useValue: makeApi() },
      { provide: AuthService, useValue: { token: () => 't' } },
      { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: () => null } }, queryParamMap: of() } },
    ],
  });
  const fixture = TestBed.createComponent(FileManagerComponent);
  fixture.detectChanges();
  return fixture.componentInstance as any;
}

/**
 * jsdom implements neither half of the object-URL API, so there is nothing to spy ON — `spyOn` refuses a
 * method that does not exist, which is the right refusal and not a reason to skip the case. Defining it makes
 * the seam testable; the alternative is that the one resource this page must release is the one thing its
 * suite cannot check.
 */
function withRevokeSpy(): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const had = 'revokeObjectURL' in URL;
  const previous = (URL as any).revokeObjectURL;
  (URL as any).revokeObjectURL = (u: string) => { calls.push(u); };
  return { calls, restore: () => { if (had) (URL as any).revokeObjectURL = previous; else delete (URL as any).revokeObjectURL; } };
}

const dir = (name: string, extra: Record<string, unknown> = {}) =>
  ({ name, isDirectory: true, size: 0, ...extra });
const file = (name: string, extra: Record<string, unknown> = {}) =>
  ({ name, isDirectory: false, size: 0, ...extra });

beforeEach(() => TestBed.resetTestingModule());

describe('FileManagerComponent — sorting (characterization for G-3)', () => {
  it('folders come before files whatever the column says', () => {
    /*
     * The rule that outranks the chosen column, and the reason is in the source: this is a file explorer, and
     * interleaving directories with files by size or date makes the tree unnavigable. A shared table-header
     * primitive would not know that, which is exactly why it is pinned here before the split.
     */
    const c = create();
    /*
     * The fixture has to make the two rules DISAGREE, or it proves nothing. The first version gave the folder
     * the larger size under a descending sort, so folders-first and size-desc wanted the same order and
     * deleting the folder rule left the test green. Here the folder is the smallest thing in the list while
     * the sort is descending, so only the folder rule can put it first.
     */
    c.listing.entries.set([file('big-file', { size: 999 }), dir('folder', { size: 1 })]);
    c.sortField.set('size');
    c.sortDir.set('desc');
    expect(c.sortedEntries().map((e: any) => e.name)).toEqual(['folder', 'big-file']);
  });

  it('an unset field returns the server order untouched, not a name sort', () => {
    const c = create();
    c.listing.entries.set([file('b'), file('a')]);
    c.sortField.set('');
    expect(c.sortedEntries().map((e: any) => e.name)).toEqual(['b', 'a']);
  });

  it('the third click on one column CLEARS the sort rather than cycling back to ascending', () => {
    // asc -> desc -> unsorted. A cycle that returned to `asc` would look identical for two clicks and then
    // quietly differ, which is the kind of thing a rewrite gets wrong without anyone noticing.
    const c = create();
    c.setSort('name');
    expect([c.sortField(), c.sortDir()]).toEqual(['name', 'asc']);
    c.setSort('name');
    expect([c.sortField(), c.sortDir()]).toEqual(['name', 'desc']);
    c.setSort('name');
    expect([c.sortField(), c.sortDir()]).toEqual(['', 'asc']);
  });

  it('switching column starts ascending from either previous direction', () => {
    const c = create();
    c.setSort('name');
    c.setSort('name');                       // now descending
    c.setSort('size');
    expect([c.sortField(), c.sortDir()]).toEqual(['size', 'asc']);
  });

  it('equal keys fall back to the name, so the order is stable rather than arbitrary', () => {
    const c = create();
    c.listing.entries.set([file('beta', { size: 5 }), file('alpha', { size: 5 })]);
    c.sortField.set('size');
    c.sortDir.set('asc');
    expect(c.sortedEntries().map((e: any) => e.name)).toEqual(['alpha', 'beta']);
  });

  it('a missing size sorts as zero and a missing status as empty, rather than dropping the row', () => {
    // AS-IS. The rows are `?? 0` and `?? ''`, so an entry with no size is smallest and one with no status
    // sorts first ascending. What matters for the split is that it still APPEARS.
    const c = create();
    c.listing.entries.set([file('sized', { size: 100 }), file('unsized')]);
    c.sortField.set('size');
    c.sortDir.set('asc');
    expect(c.sortedEntries().map((e: any) => e.name)).toEqual(['unsized', 'sized']);
  });

  it('sorting never mutates the entries signal', () => {
    // `[...list].sort()` — the copy is load-bearing, because `Array.sort` is in-place and a signal whose
    // value changed without a write is a bug that shows up somewhere else entirely.
    const c = create();
    const original = [file('b'), file('a')];
    c.listing.entries.set(original);
    c.sortField.set('name');
    c.sortedEntries();
    expect(c.listing.entries().map((e: any) => e.name)).toEqual(['b', 'a']);
  });
});

describe('FileManagerComponent — paths and breadcrumbs (characterization for G-3)', () => {
  it('join does not double a separator, and does not add one to a bare root', () => {
    const c = create();
    expect(c.join('/', 'a')).toBe('/a');
    expect(c.join('/a', 'b')).toBe('/a/b');
    expect(c.join('/a/', 'b')).toBe('/a/b');
  });

  it('the root crumb is always present, even at the root itself', () => {
    const c = create();
    c.updateBreadcrumbs('/');
    expect(c.breadcrumbs()).toEqual([{ label: 'root', path: '/' }]);
  });

  it('each crumb carries the path that leads to it, not just its own name', () => {
    // The crumbs are clickable, so a label without its accumulated path is a link to the wrong folder — and
    // the accumulation is the half a rewrite drops, because the labels look right either way.
    const c = create();
    c.updateBreadcrumbs('/docs/2026/q3');
    expect(c.breadcrumbs()).toEqual([
      { label: 'root', path: '/' },
      { label: 'docs', path: '/docs' },
      { label: '2026', path: '/docs/2026' },
      { label: 'q3', path: '/docs/2026/q3' },
    ]);
  });

  it('empty segments are dropped, so a doubled or trailing slash does not produce a blank crumb', () => {
    const c = create();
    c.updateBreadcrumbs('//docs//');
    expect(c.breadcrumbs().map((b: any) => b.label)).toEqual(['root', 'docs']);
  });
});

describe('FileManagerComponent — the preview object URL (characterization for G-3)', () => {
  it('closing the preview revokes the object URL and forgets it', () => {
    /*
     * A leak here is invisible: the blob stays alive for the life of the tab and nothing reports it. So is the
     * opposite mistake, revoking a URL still bound to an <img>, which shows as an image that silently fails to
     * load. Nothing else on this page owns a resource that must be released, which is why it is easy to drop
     * when the preview becomes its own component.
     */
    const spy = withRevokeSpy();
    const c = create();
    c.preview.objectUrl.bindIfCurrent('blob:fake', () => true);
    c.closePreview();
    expect(spy.calls).toEqual(['blob:fake']);
    expect(c.preview.objectUrl.value).toBeNull();
    spy.restore();
  });

  it('closing twice revokes once — the second call has nothing to release', () => {
    const spy = withRevokeSpy();
    const c = create();
    c.preview.objectUrl.bindIfCurrent('blob:fake', () => true);
    c.closePreview();
    c.closePreview();
    expect(spy.calls).toHaveLength(1);
    spy.restore();
  });

  it('closing with no preview open revokes nothing rather than throwing', () => {
    const spy = withRevokeSpy();
    const c = create();
    c.preview.objectUrl.release();
    expect(() => c.closePreview()).not.toThrow();
    expect(spy.calls).toEqual([]);
    spy.restore();
  });

  it('DESTROYING the view revokes it too — closing is not the only way out', () => {
    /*
     * Navigating away does not call `closePreview`. Angular calls `ngOnDestroy`, and if only the close path
     * released the URL then every preview a user walked away from would leak for the life of the tab.
     * Asserted separately from closing because an extraction is very likely to move one and not the other.
     */
    const spy = withRevokeSpy();
    const c = create();
    c.preview.objectUrl.bindIfCurrent('blob:on-destroy', () => true);
    c.ngOnDestroy();
    expect(spy.calls).toEqual(['blob:on-destroy']);
    spy.restore();
  });

  it('opening a second preview releases the first, before it allocates', () => {
    /*
     * The switch, which is the common gesture: arrow-keying down a folder of images. `openPreview` revokes
     * the current URL as part of resetting the pane, so the previous blob goes before the next one is
     * fetched. Without this the leak is one blob per file walked past.
     */
    const spy = withRevokeSpy();
    const c = create();
    c.preview.objectUrl.bindIfCurrent('blob:first', () => true);
    c.openPreview(file('second.txt'));
    expect(spy.calls).toEqual(['blob:first']);
    spy.restore();
  });

  it('a preview fetch that resolves LATE does not overwrite the file that is open now', () => {
    /*
     * The race, and it is the one thing on this page that both leaks and shows the wrong content.
     *
     * `openPreview` revokes synchronously and the fetch resolves later. Arrow past two images quickly and
     * the order is: revoke (nothing, the first fetch has not resolved), start B, A resolves and assigns
     * `_previewObjectUrl = urlA`, B resolves and assigns `urlB`. `urlA` is now unreachable and never
     * revoked — and between the two resolutions, A's image is displayed under B's name.
     *
     * The xlsx branch already guards exactly this: `if (this.preview.file()?.name !== entry.name) return;
     * // fast arrow-nav moved on`. The image and PDF branch — the only one that allocates a resource — did
     * not have it. One rule, two implementations, and the weaker one on the path where being wrong costs
     * more than a stale table.
     *
     * Driven through `applyPreviewBlobUrl`, the seam the two branches now share, because a test that
     * stubbed `fetch` twice would be asserting on the stub's ordering rather than on the guard.
     */
    const spy = withRevokeSpy();
    const c = create();
    c.preview.file.set(file('b.png'));

    // A's fetch comes back after the selection moved to B.
    c.preview.bindBlobUrl(file('a.png'), 'image', 'blob:stale-a');
    expect(c.preview.mediaUrl()).toBe('');
    expect(spy.calls).toEqual(['blob:stale-a']);
    expect(c.preview.objectUrl.value).toBeNull();

    // And B's own response is still applied.
    c.preview.bindBlobUrl(file('b.png'), 'image', 'blob:live-b');
    expect(c.preview.mediaUrl()).toBe('blob:live-b');
    expect(c.preview.objectUrl.value).toBe('blob:live-b');

    // Released before the spy is, or TestBed's own teardown calls the REAL `revokeObjectURL` on a blob URL
    // that was never created — which fails the case during CLEANUP, with every assertion above green.
    c.closePreview();
    spy.restore();
  });

  it('closing clears the open file as well as the URL', () => {
    const spy = withRevokeSpy();
    const c = create();
    c.preview.file.set(file('x'));
    c.closePreview();
    expect(c.preview.file()).toBeNull();
    spy.restore();
  });
});

describe('FileManagerComponent — the extract tab (characterization for G-3)', () => {
  /*
   * Four rules, and only one of them had a test. Written before the group moves to a store, because three
   * of the four are the kind a rewrite gets subtly wrong while every assertion it kept still passes.
   */
  function withExtract(pages: any[]) {
    let call = 0;
    const api = {
      ...makeApi(),
      getFileExtract: (_s: string, _p: string, _limit: number, _skip: number) => {
        call += 1;
        return of(pages[Math.min(call - 1, pages.length - 1)]);
      },
      calls: () => call,
    } as any;
    TestBed.configureTestingModule({
      imports: [FileManagerComponent, getTranslocoModule()],
      providers: [
        { provide: FilesApi, useValue: api },
        { provide: SpacesApi, useValue: makeApi() },
        { provide: BrainApi, useValue: makeApi() },
        { provide: AuthService, useValue: { token: () => 't' } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: () => null } }, queryParamMap: of() } },
      ],
    });
    const fixture = TestBed.createComponent(FileManagerComponent);
    fixture.detectChanges();
    return { c: fixture.componentInstance as any, api };
  }

  const page = (ids: string[], skip = 0) => ({ chunks: ids.map(id => ({ id, text: id })), skip, total: 99 });

  it('paging APPENDS, and keeps the FIRST response\'s skip', () => {
    /*
     * "Show more" on a diagnostic must not throw away what the reader has already scrolled through. And the
     * `skip` that survives is the first one, not the newest — it records where this view STARTED, which is
     * what the footer reads to say how far in you are. A rewrite that spread the newest response over the
     * old state gets the chunks right and the skip wrong, and nothing on screen contradicts it.
     */
    const { c } = withExtract([page(['a', 'b'], 0), page(['c'], 2)]);
    c.loadExtract(file('doc.pdf'));
    expect(c.extractStore.extract().chunks.map((k: any) => k.id)).toEqual(['a', 'b']);

    c.moreChunks(file('doc.pdf'));
    expect(c.extractStore.extract().chunks.map((k: any) => k.id)).toEqual(['a', 'b', 'c']);
    expect(c.extractStore.extract().skip).toBe(0);
  });

  it('the next page is asked for from what is ON SCREEN, not from the last response', () => {
    // `moreChunks` counts the rendered chunks. Reading the response's own `skip` would ask for the same page
    // again for ever, because the first response's skip is 0 and it is the one that is preserved above.
    const seen: number[] = [];
    const { c } = withExtract([page(['a', 'b'], 0), page(['c', 'd'], 0)]);
    (c as any).extractStore.filesApi.getFileExtract = (_s: string, _p: string, _l: number, skip: number) => {
      seen.push(skip);
      return of(page(['x'], skip));
    };
    c.extractStore.extract.set(page(['a', 'b', 'c'], 0));
    c.moreChunks(file('doc.pdf'));
    expect(seen).toEqual([3]);
  });

  it('opening the tab fetches ONCE, not on every switch back', () => {
    // Lazily, and only when there is nothing to show: the extract is a diagnostic and the request is not
    // cheap. A rewrite that fetched on every `showExtractMode` would look identical on screen.
    const { c, api } = withExtract([page(['a'])]);
    c.preview.file.set(file('doc.pdf'));
    c.showExtractMode();
    c.showExtractMode();
    c.showExtractMode();
    expect(api.calls()).toBe(1);
  });

  it('a failed load clears the spinner and SAYS so, rather than showing an empty extract', () => {
    // The difference a reader has to be able to see: "this file has no chunks" and "we could not ask" are
    // not the same answer, and an empty state for both is the version that gets shipped by accident.
    const { c } = withExtract([]);
    (c as any).extractStore.filesApi.getFileExtract = () => throwError(() => ({ status: 500 }));
    c.loadExtract(file('doc.pdf'));
    expect(c.extractStore.loading()).toBe(false);
    expect(c.extractStore.error()).toBeTruthy();
    expect(c.extractStore.extract()).toBeNull();
  });
});

describe('FileManagerComponent — the metadata edit model (characterization for G-3)', () => {
  /** A component whose `updateFileMeta` is under the test's control, and whose directory reload is observable. */
  function createWithSave(update: (s: string, p: string, body: any) => any, onList?: () => void) {
    const api = {
      ...makeApi(),
      updateFileMeta: update,
      listFiles: (...args: unknown[]) => { onList?.(); return (makeApi() as any).listFiles(...args); },
    } as any;
    TestBed.configureTestingModule({
      imports: [FileManagerComponent, getTranslocoModule()],
      providers: [
        { provide: FilesApi, useValue: api },
        { provide: SpacesApi, useValue: makeApi() },
        { provide: BrainApi, useValue: makeApi() },
        { provide: AuthService, useValue: { token: () => 't' } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: () => null } }, queryParamMap: of() } },
      ],
    });
    const fixture = TestBed.createComponent(FileManagerComponent);
    fixture.detectChanges();
    return fixture.componentInstance as any;
  }

  it('seeds every field from the record, and linkEntities as a COMMA-JOINED STRING', () => {
    /*
     * The asymmetry is the behaviour. `tags`, `linkFacts` and `linkChronos` stay arrays; `linkEntities` becomes a
     * string because its control is a free-text field. A signal-based rewrite that made all four the same
     * shape would break the round-trip in one direction only, and only for entity references.
     */
    const c = create();
    c.metaStore.seed({ description: 'd', tags: ['t'], linkEntities: ['e1', 'e2'], linkFacts: ['m'], linkChronos: ['c'] });
    expect(c.metaStore.model).toEqual({
      description: 'd', tags: ['t'], linkEntities: 'e1, e2', linkFacts: ['m'], linkChronos: ['c'],
    });
  });

  it('a null record seeds empties rather than leaving the previous file\'s values', () => {
    // Opening a file with no meta record after one that had some is the case this protects: the drawer must
    // not show the last file's description.
    const c = create();
    c.metaStore.seed({ description: 'old', tags: ['x'], linkEntities: ['e'], linkFacts: [], linkChronos: [] });
    c.metaStore.seed(null);
    expect(c.metaStore.model).toEqual({ description: '', tags: [], linkEntities: '', linkFacts: [], linkChronos: [] });
  });

  it('the arrays are COPIED, so editing the form cannot reach back into the loaded record', () => {
    const c = create();
    const loaded = { description: '', tags: ['keep'], linkEntities: [], linkFacts: [], linkChronos: [] };
    c.metaStore.seed(loaded);
    c.metaStore.model.tags.push('added');
    expect(loaded.tags).toEqual(['keep']);
  });

  it('cancelling re-seeds from the loaded record and drops the error', () => {
    const c = create();
    c.metaStore.selectedMeta.set({ description: 'saved', tags: [], linkEntities: [], linkFacts: [], linkChronos: [] });
    c.metaStore.model.description = 'typed but not saved';
    c.metaStore.error.set('something went wrong');
    c.cancelMeta();
    expect(c.metaStore.model.description).toBe('saved');
    expect(c.metaStore.error()).toBeNull();
    expect(c.detailMode()).toBe('preview');
  });

  it('SAVING splits linkEntities back into an array, and trims the description', () => {
    /*
     * The other half of the asymmetry the seeding case describes. `linkEntities` is a comma-joined STRING in the
     * form because its control is free text, and it has to become an array again on the way out — with the
     * blanks dropped, or a trailing comma posts an empty id. A rewrite that made all four fields the same
     * shape breaks the round trip in one direction only, and only for entity references.
     */
    let sent: any = null;
    const c = createWithSave((_s: string, _p: string, body: any) => { sent = body; return of({}); });
    c.preview.file.set(file('doc.pdf'));
    c.metaStore.model = { description: '  spaced  ', tags: ['t'], linkEntities: 'e1, e2 ,, e3', linkFacts: [], linkChronos: [] };
    c.saveMeta(file('doc.pdf'));
    expect(sent.linkEntities).toEqual(['e1', 'e2', 'e3']);
    expect(sent.description).toBe('spaced');
  });

  it('a successful save re-seeds from the RESPONSE, not from what was typed', () => {
    /*
     * The server normalises — it may drop an id it cannot resolve, or return the description it actually
     * stored. Re-seeding from the model that was just sent looks identical on screen and is wrong: the form
     * then shows what the user asked for rather than what exists, and the difference only surfaces on a
     * reload, by which time nobody connects the two.
     */
    const c = createWithSave(() => of({ description: 'as stored', tags: ['kept'], linkEntities: ['e1'], linkFacts: [], linkChronos: [] }));
    c.preview.file.set(file('doc.pdf'));
    c.metaStore.model = { description: 'as typed', tags: ['dropped'], linkEntities: 'e1,e2', linkFacts: [], linkChronos: [] };
    c.saveMeta(file('doc.pdf'));
    expect(c.metaStore.model.description).toBe('as stored');
    expect(c.metaStore.model.tags).toEqual(['kept']);
    expect(c.metaStore.model.linkEntities).toBe('e1');
  });

  it('and it leaves the edit face, clears the spinner, and reloads the DIRECTORY', () => {
    // The reload is the part that is easy to drop: tags and embedding status are shown on the list ROW, so a
    // save that did not reload would leave the row disagreeing with the pane until something else refreshed.
    let listed = 0;
    const c = createWithSave(() => of({}), () => { listed += 1; });
    c.preview.file.set(file('doc.pdf'));
    c.detailMode.set('meta');

    // From a BASELINE, not from zero. The page lists the directory while it is constructing, so
    // `listed > 0` was true whether or not the save reloaded anything — the first version of this case
    // survived deleting the reload outright, which is the failure a count without a baseline always has.
    const before = listed;
    c.saveMeta(file('doc.pdf'));
    expect(c.detailMode()).toBe('preview');
    expect(c.metaStore.saving()).toBe(false);
    expect(listed).toBe(before + 1);
  });

  it('a REFUSED save keeps you on the edit face with what you typed', () => {
    // The opposite of the success path, and the reason it is asserted separately: dropping the user back to
    // the preview on failure loses the edit, and the toast is gone by the time they notice.
    const c = createWithSave(() => throwError(() => ({ status: 500 })));
    c.preview.file.set(file('doc.pdf'));
    c.detailMode.set('meta');
    c.metaStore.model = { description: 'kept', tags: [], linkEntities: '', linkFacts: [], linkChronos: [] };
    c.saveMeta(file('doc.pdf'));
    expect(c.detailMode()).toBe('meta');
    expect(c.metaStore.error()).toBeTruthy();
    expect(c.metaStore.saving()).toBe(false);
    expect(c.metaStore.model.description).toBe('kept');
  });

  it('opening the edit face re-seeds too, so a previous cancel cannot leak into it', () => {
    const c = create();
    c.metaStore.selectedMeta.set({ description: 'saved', tags: [], linkEntities: [], linkFacts: [], linkChronos: [] });
    c.metaStore.model.description = 'stale';
    c.showMetaMode();
    expect(c.metaStore.model.description).toBe('saved');
  });
});

/*
 * The `formatSize` block moved to `file-format.spec.ts` when it became a shared function.
 *
 * It was reaching through the page for six lines of arithmetic, and the page kept a named handle on the
 * function ONLY so this could find it. That is the trap `file-format.spec.ts`'s own docblock describes and the
 * one G-7 removed twice — a spec that reaches through a component keeps passing after the component stops
 * using the thing, so the coverage reads as protection for code nobody can reach.
 *
 * The boundary cases are unchanged there, plus the ones that were awkward to assert from a component.
 */

/**
 * The tree sidebar — characterization, and the last uncovered seam in this page.
 *
 * ## Why it gets its own block, written before the cut rather than after
 *
 * G-3's remaining work is the shell, and the tree is the largest thing the shell still renders inline: a
 * recursive template, five CSS rules, an interface, a signal and three methods. It is also the ONLY part of
 * this page with no assertion anywhere — the blocks above pin sorting, paths, the object URL and the metadata
 * model, and the tree is not mentioned in any of them.
 *
 * That combination is what the repo rule is about: weak coverage plus a refactor means characterization tests
 * first, proven green against the ORIGINAL code, as their own change. Every one of these cases passed before a
 * line of the extraction was written.
 *
 * ## What is actually fragile here
 *
 * The tree's nodes are MUTATED IN PLACE — `node.expanded = false`, `node.children = [...]`, `node.loading =
 * true` — and the page is `OnPush`. So every mutation is followed by `treeRoot.set([...treeRoot()])`, whose
 * only purpose is to hand Angular a new array reference so the view is marked dirty. Nothing about the code
 * says that out loud, and an extraction that moves this into a store with immutable updates, or that drops one
 * spread, produces a tree which silently never redraws. There is no error, no console warning: the data is
 * right and the screen is stale.
 *
 * The other fragile part is quieter. Collapsing a node does not discard its loaded children, so re-expanding
 * costs no request — and an extraction that rebuilds nodes from a fresh listing would re-fetch every time, on
 * a page where the request is invisible and the only symptom is a slower click.
 */
describe('FileManagerComponent — what a write MEANS beyond the write (characterization for G-3)', () => {
  /*
   * These exist because the eighth cut got one of them wrong and nothing said so.
   *
   * `createFolder` and `confirmRename` cleared their form state inside the request's SUCCESS branch. Moving
   * the requests into a store moved those two lines to the call site, where they run on the ATTEMPT — so a
   * refused create wiped the name you had typed and a refused rename closed the row. All 99 cases passed.
   *
   * The rule for a refactor here is that no assertion is edited, and the corollary is this: behaviour with
   * no assertion is behaviour the rule cannot protect. So it gets one.
   */

  function createWith(apiOverrides: Record<string, unknown>) {
    const api = { ...makeApi(), ...apiOverrides } as any;
    const toasted: string[] = [];
    TestBed.configureTestingModule({
      imports: [FileManagerComponent, getTranslocoModule()],
      providers: [
        { provide: FilesApi, useValue: api },
        { provide: SpacesApi, useValue: api },
        { provide: BrainApi, useValue: api },
        { provide: AuthService, useValue: { token: () => 't' } },
        { provide: ToastService, useValue: { error: (m: string) => toasted.push(m), success: () => {} } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: () => null } }, queryParamMap: of() } },
      ],
    });
    const fixture = TestBed.createComponent(FileManagerComponent);
    fixture.detectChanges();
    return { c: fixture.componentInstance as any, fixture, toasted };
  }

  it('a REFUSED new folder keeps the name that was typed, and SAYS it failed', () => {
    const { c, toasted } = createWith({ createDir: () => throwError(() => new Error('nope')) });
    c.showNewFolder.set(true);
    c.newFolderName.set('notes');

    c.createFolder();

    expect(c.newFolderName()).toBe('notes');
    expect(c.showNewFolder()).toBe(true);
    // The message is the page's, not the store's: the store reports WHICH write failed and nothing else.
    expect(toasted.length).toBe(1);
  });

  it('and an ACCEPTED one closes the form, reloads the FOLDER, and reloads the tree root', () => {
    /*
     * Asserted from a folder that is not the root, because the two reloads are different requests for the
     * same path when you are at the root — the folder you are in, and the tree's root. A `toContain('/')`
     * passed with the folder reload deleted entirely, which is why the paths here are distinguishable.
     */
    const listed: string[] = [];
    const { c } = createWith({
      createDir: () => of({}),
      listFiles: (_s: string, path: string) => { listed.push(path); return of({ entries: [], path }); },
    });
    c.navigate('/docs');
    c.showNewFolder.set(true);
    c.newFolderName.set('notes');
    listed.length = 0;

    c.createFolder();

    expect(c.newFolderName()).toBe('');
    expect(c.showNewFolder()).toBe(false);
    expect(listed).toContain('/docs');   // the folder we are in
    expect(listed).toContain('/');       // the tree's root
  });



  it('a REFUSED rename leaves the row in edit mode', () => {
    const { c } = createWith({ moveFile: () => throwError(() => new Error('nope')) });
    c.renamingEntry.set('a.txt');
    c.renameValue = 'b.txt';

    c.confirmRename(file('a.txt'));

    expect(c.renamingEntry()).toBe('a.txt');
  });

  it('and an ACCEPTED one leaves it', () => {
    const { c } = createWith({ moveFile: () => of({}) });
    c.renamingEntry.set('a.txt');
    c.renameValue = 'b.txt';

    c.confirmRename(file('a.txt'));

    expect(c.renamingEntry()).toBe('');
  });

  it('a delete tells the host the file set changed; a create does not', () => {
    /*
     * The host uses this to refresh its record counts, and the two cases differ on purpose: a folder is
     * not a record, so creating one changes no count. Worth pinning because both arrive on one channel
     * from the store now, and a subscription that reacted to every write would emit a spurious refresh.
     */
    const { c } = createWith({ deleteFile: () => of({}), createDir: () => of({}) });
    let emitted = 0;
    c.filesChanged.subscribe(() => emitted++);

    c.newFolderName.set('notes');
    c.createFolder();
    expect(emitted).toBe(0);

    c.listing.remove(c.activeSpaceId(), '/a.txt', '/');
    expect(emitted).toBe(1);
  });
});

describe('FileManagerComponent — the tree sidebar (characterization for G-3)', () => {
  /** A fixture whose directory listings are scriptable per path, so an expand can be driven. */
  /**
   * A tree whose listings land WHEN THE TEST SAYS.
   *
   * `createWithTree` answers every request instantly, which makes two things untestable: what a folder looks
   * like while its listing is in flight, and what happens when a second navigation overtakes the first. Both
   * are behaviours this de-duplication introduced — the tree is fed by somebody else's request now — so both
   * need a listing that can be held open.
   *
   * `settle` resolves EVERY request in flight for a path, because the page and the tree's own root load can
   * both be waiting on the same one.
   */
  /**
   * A listing that can be made to fail per path, and switched back.
   *
   * `createWithTree` fixes the outcome when the stub is built, so it cannot express the sequence that matters
   * here: a folder that LOADED and is then refreshed unsuccessfully, versus one whose very first listing
   * fails. Those two get opposite treatment on purpose, and a test that can only build one of them would
   * pin half a rule.
   */
  function createSwitchable(listing: Record<string, unknown[]>) {
    const failing = new Set<string>();
    const requested: string[] = [];
    const api = {
      ...makeApi(),
      listFiles: (_space: string, path: string) => {
        requested.push(path);
        return failing.has(path)
          ? throwError(() => new Error('nope'))
          : of({ entries: listing[path] ?? [], path });
      },
    } as any;
    TestBed.configureTestingModule({
      imports: [FileManagerComponent, getTranslocoModule()],
      providers: [
        { provide: FilesApi, useValue: api },
        { provide: SpacesApi, useValue: api },
        { provide: BrainApi, useValue: api },
        { provide: AuthService, useValue: { token: () => 't' } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: () => null } }, queryParamMap: of() } },
      ],
    });
    const fixture = TestBed.createComponent(FileManagerComponent);
    fixture.detectChanges();
    return { c: fixture.componentInstance as any, fixture, requested, failing };
  }

  function createControlled(listing: Record<string, unknown[]>) {
    const waiting = new Map<string, Subject<unknown>[]>();
    const requested: string[] = [];
    const api = {
      ...makeApi(),
      listFiles: (_space: string, path: string) => {
        requested.push(path);
        const s = new Subject<unknown>();
        waiting.set(path, [...(waiting.get(path) ?? []), s]);
        return s.asObservable();
      },
    } as any;
    TestBed.configureTestingModule({
      imports: [FileManagerComponent, getTranslocoModule()],
      providers: [
        { provide: FilesApi, useValue: api },
        { provide: SpacesApi, useValue: api },
        { provide: BrainApi, useValue: api },
        { provide: AuthService, useValue: { token: () => 't' } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: () => null } }, queryParamMap: of() } },
      ],
    });
    const fixture = TestBed.createComponent(FileManagerComponent);
    fixture.detectChanges();
    const settle = (path: string, entries?: unknown[]) => {
      const subs = waiting.get(path) ?? [];
      if (subs.length === 0) throw new Error(`nothing in flight for ${path}`);
      waiting.delete(path);
      for (const s of subs) { s.next({ entries: entries ?? listing[path] ?? [], path }); s.complete(); }
    };
    return { c: fixture.componentInstance as any, fixture, requested, settle };
  }

  function createWithTree(listing: Record<string, unknown[]>) {
    const requested: string[] = [];
    const api = {
      ...makeApi(),
      listFiles: (_space: string, path: string) => {
        requested.push(path);
        return of({ entries: listing[path] ?? [], path });
      },
    } as any;
    TestBed.configureTestingModule({
      imports: [FileManagerComponent, getTranslocoModule()],
      providers: [
        { provide: FilesApi, useValue: api },
        { provide: SpacesApi, useValue: api },
        { provide: BrainApi, useValue: api },
        { provide: AuthService, useValue: { token: () => 't' } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: () => null } }, queryParamMap: of() } },
      ],
    });
    const fixture = TestBed.createComponent(FileManagerComponent);
    fixture.detectChanges();
    return { c: fixture.componentInstance as any, fixture, requested };
  }

  it('the root holds directories only — a file is not a tree node', () => {
    /*
     * The filter is one `.filter(e => e.isDirectory)` inside the subscribe, and it is the whole reason the tree
     * is a tree. Losing it puts every file in the space into the sidebar, which looks like a listing bug rather
     * than a tree bug and would be blamed on the wrong component.
     */
    const { c } = createWithTree({ '/': [dir('docs'), file('a.txt'), dir('img')] });
    expect(c.tree.treeRoot().map((n: any) => n.name)).toEqual(['docs', 'img']);
  });

  it('a root node starts collapsed with children UNLOADED, which is not the same as empty', () => {
    /*
     * `children: null` means "not fetched yet" and `[]` would mean "fetched, and there are none". The
     * difference decides whether expanding issues a request, so a store that initialised children to `[]`
     * would give a tree whose folders can never be opened — and no error.
     */
    const { c } = createWithTree({ '/': [dir('docs')] });
    const node = c.tree.treeRoot()[0];
    expect(node.expanded).toBe(false);
    expect(node.loading).toBe(false);
    expect(node.children).toBeNull();
  });

  it('a node path is built with the page join, so it matches what the breadcrumb produces', () => {
    // The docblock at the top of this file already names this: `join` and the breadcrumb accumulator are the
    // only two places that build a path, and a tree with its own copy is how they start to disagree.
    const { c } = createWithTree({ '/': [dir('docs')] });
    expect(c.tree.treeRoot()[0].path).toBe(c.join('/', 'docs'));
  });

  it('one click on a folder lists that directory ONCE', () => {
    /*
     * This was pinned AS-IS at TWO, and it is now one — a deliberate edit to the assertion, which is what the
     * convention is for.
     *
     * `onTreeClick` used to call `navigate(path)`, which loads the directory for the main listing, and then
     * the tree's own `toggle`, which listed the same path again for the children. Same URL, same moment,
     * every time a folder was opened from the sidebar. The tree is fed from the listing now.
     *
     * The number stays asserted, not deleted: an assertion that a folder is listed ONCE is what keeps the
     * duplicate from coming back, and it is also what would catch a tree component that started fetching on
     * its own and made it three.
     */
    const { c, requested } = createWithTree({ '/': [dir('docs')], '/docs': [dir('api'), file('note.md')] });
    c.onTreeClick(c.tree.treeRoot()[0]);
    const node = c.tree.treeRoot()[0];
    expect(node.expanded).toBe(true);
    expect(node.children.map((n: any) => n.name)).toEqual(['api']);
    expect(requested.filter(p => p === '/docs').length).toBe(1);
  });

  it('reloading an EMPTY folder is a foreground load, not a refresh', () => {
    /*
     * The rows are half the load-versus-refresh test, and this is the case that proves they are: same path,
     * nothing on screen. A refresh here would be wrong in the honest direction — there is nothing to keep
     * in place, so the spinner is what the operator should see.
     *
     * Found by a surviving mutant that dropped the rows clause and left the path one, which every other
     * case tolerated.
     */
    const { c, settle } = createControlled({ '/': [] });
    settle('/');
    expect(c.listing.entries().length).toBe(0);

    c.reloadDir();

    expect(c.listing.loading()).toBe(true);
    expect(c.listing.refreshing()).toBe(false);
  });

  it('re-expanding a folder shows the children it already has, without waiting for a listing', () => {
    /*
     * The cached expand must stay the STORE's business. The click still navigates — that is one request either
     * way — but the children are already in the node, so they have to appear at once rather than when the
     * listing lands. Routing them through the listing would make a folder that is already open take a network
     * round-trip to open again, and on a slow link the caret would sit on a spinner over data the browser is
     * holding.
     *
     * Asserted while the third listing is still in flight, which is the only moment the two behaviours differ,
     * and on the children's IDENTITY: a re-expand that refetched would replace the array with an equal one.
     */
    const { c, settle } = createControlled({ '/': [dir('docs')], '/docs': [dir('api')] });
    settle('/');
    const node = c.tree.treeRoot()[0];

    c.onTreeClick(node);                       // expand: the listing is what feeds it
    settle('/docs');
    const kids = c.tree.treeRoot()[0].children;
    expect(kids.map((n: any) => n.name)).toEqual(['api']);

    c.onTreeClick(node);                       // collapse
    settle('/docs');
    expect(c.tree.treeRoot()[0].expanded).toBe(false);

    c.onTreeClick(node);                       // re-expand, listing deliberately LEFT IN FLIGHT
    const again = c.tree.treeRoot()[0];
    expect(again.expanded).toBe(true);
    expect(again.loading).toBe(false);
    expect(again.children).toBe(kids);
  });

  it('a listing for another folder cannot fill the folder you clicked', () => {
    /*
     * The node waits for a request it does not own, so it has to check that the listing which arrived is the
     * one it was waiting for. Click a folder, go somewhere else before it lands, and the second listing
     * resolves first — without the path check that folder would be filled with the other directory's
     * contents, silently and permanently, and the tree would be lying about what is on disk.
     */
    const { c, settle } = createControlled({ '/': [dir('docs'), dir('images')] });
    settle('/');
    const docs = c.tree.treeRoot()[0];

    c.onTreeClick(docs);                       // /docs is now in flight, and docs is waiting for it
    c.navigate('/images');                     // ...and we leave before it lands
    settle('/images', [dir('unrelated')]);     // the OTHER listing arrives first

    const stillWaiting = c.tree.treeRoot()[0];
    expect(stillWaiting.children).toBeNull();
    expect(stillWaiting.loading).toBe(true);

    settle('/docs', [dir('api')]);             // and the one it was waiting for
    const filled = c.tree.treeRoot()[0];
    expect(filled.children.map((n: any) => n.name)).toEqual(['api']);
    expect(filled.loading).toBe(false);
  });

  it('and a folder whose listing fails still says so, with no request of its own', () => {
    /*
     * The case most likely to break in this change, which is why it exists.
     *
     * The tree no longer has a request that can fail — it is fed from the listing's — so its error state has
     * to come from the listing's failure. Without this, removing the duplicate would take the tree's message
     * with it and put the silence back that `G-10` had just removed.
     */
    const api = {
      ...makeApi(),
      listFiles: (_s: string, path: string) =>
        (path === '/docs' ? throwError(() => new Error('nope')) : of({ entries: [dir('docs')], path })),
    } as any;
    TestBed.configureTestingModule({
      imports: [FileManagerComponent, getTranslocoModule()],
      providers: [
        { provide: FilesApi, useValue: api },
        { provide: SpacesApi, useValue: api },
        { provide: BrainApi, useValue: api },
        { provide: AuthService, useValue: { token: () => 't' } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: () => null } }, queryParamMap: of() } },
      ],
    });
    const fixture = TestBed.createComponent(FileManagerComponent);
    fixture.detectChanges();
    const c = fixture.componentInstance as any;

    c.onTreeClick(c.tree.treeRoot()[0]);
    const node = c.tree.treeRoot()[0];
    expect(node.loading).toBe(false);
    expect(node.expanded).toBe(false);
    expect(node.children).toBeNull();
    expect(node.error).toBeTruthy();
  });

  it('every mutation replaces the ARRAY, because the page is OnPush', () => {
    /*
     * The assertion this whole block exists for. Nodes are mutated in place, so the signal's value is the same
     * objects every time — only a fresh array reference marks the view dirty. An extraction that keeps the
     * mutation and drops the spread leaves a tree that is correct in memory and frozen on screen.
     *
     * Asserted as reference INEQUALITY rather than by reading the rendered DOM, because the DOM is what would
     * silently agree: a stale view renders the previous state perfectly well.
     */
    const { c } = createWithTree({ '/': [dir('docs')], '/docs': [dir('api')] });
    const before = c.tree.treeRoot();
    c.onTreeClick(before[0]);
    expect(c.tree.treeRoot()).not.toBe(before);
  });

  it('collapsing keeps the loaded children, so re-expanding costs no request', () => {
    /*
     * `onTreeClick` on an expanded node sets `expanded = false` and nothing else. The children stay, which is
     * why the second expand is free — and why an extraction that rebuilds nodes from a fresh listing would
     * re-request on every toggle. Invisible on a fast network and the only symptom is a slower click.
     */
    const { c, requested } = createWithTree({ '/': [dir('docs')], '/docs': [dir('api')] });
    c.onTreeClick(c.tree.treeRoot()[0]);
    expect(requested.filter(p => p === '/docs').length).toBe(1);   // one per click now, not two

    c.onTreeClick(c.tree.treeRoot()[0]);
    expect(c.tree.treeRoot()[0].expanded).toBe(false);
    expect(c.tree.treeRoot()[0].children.map((n: any) => n.name)).toEqual(['api']);

    c.onTreeClick(c.tree.treeRoot()[0]);
    expect(c.tree.treeRoot()[0].expanded).toBe(true);
    /*
     * Three clicks, three requests — and the arithmetic is still the assertion, one number lower per click.
     * Each click costs the LISTING's request, which is the one the page needs anyway; the tree costs nothing,
     * on the first expand or the third. The collapse and the re-expand find `children` already there.
     *
     * It was four: the first click used to pay twice. That is the whole of `G-13`.
     */
    expect(requested.filter(p => p === '/docs').length).toBe(3);
  });

  it('a failed navigation shows NO rows — the folder you left is not relabelled as the one you entered', () => {
    /*
     * `G-14`, and it was found by looking at a screenshot rather than by any assertion.
     *
     * The breadcrumb read `root / docs`, the table showed the rows of `root`, and there was no error anywhere
     * on the listing. An operator was reading one folder's contents under another folder's name.
     *
     * Why nothing caught it: the failure IS recorded (`loadError`), but the listing renders it inside the
     * table's `@empty` block — so it appears only when there are no rows, and a failed navigation left the
     * previous folder's rows in place. Both halves were defensible on their own, which is the shape this
     * codebase produces most.
     */
    const { c, failing } = createSwitchable({ '/': [file('a.txt'), file('b.txt')], '/docs': [file('c.txt')] });
    expect(c.listing.entries().length).toBe(2);

    failing.add('/docs');
    c.navigate('/docs');

    expect(c.currentPath()).toBe('/docs');
    expect(c.listing.entries().length).toBe(0);
    expect(c.listing.loadError()).toBeTruthy();
    expect(c.listing.loading()).toBe(false);
  });

  it('and a failed REFRESH keeps its rows, because that is a different question', () => {
    /*
     * The other half of the same rule, and the reason the fix above is a branch rather than a blanket clear.
     *
     * A poll during an ingest must not blank a table that is fine — #632 is the bug that taught this, and the
     * rows are marked not-current instead (`refreshFailed`). A clear that did not distinguish the two would
     * trade a visible defect for an invisible one: the page would flash empty every time a background tick
     * lost a request.
     */
    const { c, failing } = createSwitchable({ '/': [file('a.txt'), file('b.txt')] });
    expect(c.listing.entries().length).toBe(2);

    failing.add('/');
    c.reloadDir();                             // same path, rows on screen: a refresh

    expect(c.listing.entries().length).toBe(2);
    expect(c.listing.refreshFailed()).toBe(true);
    expect(c.listing.loadError()).toBeNull();
  });

  it('retrying a failed navigation loads the folder it is showing, not the one you came from', () => {
    /*
     * The retry button lives inside the error state, so it only exists in the situation above — and it reads
     * `currentPath`, which has already moved. Worth pinning because clearing the rows makes `loadedPath`
     * stale, and a fix that reset the path instead of the rows would send the retry to the wrong directory
     * while looking correct on screen.
     */
    const { c, failing, requested } = createSwitchable({ '/': [file('a.txt')], '/docs': [file('c.txt')] });
    failing.add('/docs');
    c.navigate('/docs');
    expect(c.listing.entries().length).toBe(0);

    failing.delete('/docs');
    requested.length = 0;
    c.reloadDir();

    expect(requested).toEqual(['/docs']);
    expect(c.listing.entries().map((e: any) => e.name)).toEqual(['c.txt']);
    expect(c.listing.loadError()).toBeNull();
  });

  it('clicking a node NAVIGATES as well as toggling — one gesture, two effects', () => {
    /*
     * Easy to lose in a split, because a presentational tree component naturally emits one event and the page
     * naturally handles one thing with it. Both halves are the behaviour: the listing follows the tree.
     */
    const { c } = createWithTree({ '/': [dir('docs')], '/docs': [] });
    c.onTreeClick(c.tree.treeRoot()[0]);
    expect(c.currentPath()).toBe('/docs');
    expect(c.breadcrumbs().map((b: any) => b.name ?? b.label ?? b)).toContain('docs');
  });

  it('a failed expand clears the spinner, leaves the node closed, and SAYS SO', () => {
    /*
     * This was pinned AS-IS and is now the intended behaviour — a deliberate edit to the assertion, which is
     * the point of the convention.
     *
     * What it used to be: the error branch reset `loading`, did not set `expanded`, and said nothing anywhere.
     * The caret sprang back and that was the whole message, on a page where every other load has a visible
     * failure state (`loadError`, `refreshFailed`, `spacesError`).
     *
     * The node keeps `expanded: false` and `children: null` — a folder that could not be read has no children
     * to show, and pretending otherwise would give an operator an empty folder rather than a failed one.
     */
    const api = {
      ...makeApi(),
      listFiles: (_s: string, path: string) =>
        (path === '/docs' ? throwError(() => new Error('nope')) : of({ entries: [dir('docs')], path })),
    } as any;
    TestBed.configureTestingModule({
      imports: [FileManagerComponent, getTranslocoModule()],
      providers: [
        { provide: FilesApi, useValue: api },
        { provide: SpacesApi, useValue: api },
        { provide: BrainApi, useValue: api },
        { provide: AuthService, useValue: { token: () => 't' } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: () => null } }, queryParamMap: of() } },
      ],
    });
    const fixture = TestBed.createComponent(FileManagerComponent);
    fixture.detectChanges();
    const c = fixture.componentInstance as any;

    c.onTreeClick(c.tree.treeRoot()[0]);
    expect(c.tree.treeRoot()[0].loading).toBe(false);
    expect(c.tree.treeRoot()[0].expanded).toBe(false);
    expect(c.tree.treeRoot()[0].children).toBeNull();
    // The tree's OWN message, on the node that failed.
    expect(c.tree.treeRoot()[0].error).toBeTruthy();

    /*
     * `loadError` is set too, by the main listing, which requested the same failing path through `navigate`.
     *
     * That second request is `G-13`, and it is still pinned AS-IS: it was the ONLY thing that surfaced an
     * error before this change, which is exactly why the tree's own state had to come first. Now that it has,
     * removing the duplicate no longer takes the message with it.
     */
    expect(c.listing.loadError()).toBeTruthy();
  });

  it('and a folder that failed once shows nothing stale when it succeeds', () => {
    // A message left under a folder whose children are now on screen is worse than none: it says the thing
    // in front of you did not load.
    let fail = true;
    const api = {
      ...makeApi(),
      listFiles: (_s: string, path: string) =>
        (path === '/docs' && fail ? throwError(() => new Error('nope')) : of({ entries: [], path })),
    } as any;
    TestBed.configureTestingModule({
      imports: [FileManagerComponent, getTranslocoModule()],
      providers: [
        { provide: FilesApi, useValue: api },
        { provide: SpacesApi, useValue: api },
        { provide: BrainApi, useValue: api },
        { provide: AuthService, useValue: { token: () => 't' } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: () => null } }, queryParamMap: of() } },
      ],
    });
    const fixture = TestBed.createComponent(FileManagerComponent);
    fixture.detectChanges();
    const c = fixture.componentInstance as any;
    c.tree.treeRoot.set([{ name: 'docs', path: '/docs', expanded: false, loading: false, children: null, error: null }]);

    c.tree.toggle(c.tree.treeRoot()[0], c.activeSpaceId());
    expect(c.tree.treeRoot()[0].error).toBeTruthy();

    fail = false;
    c.tree.toggle(c.tree.treeRoot()[0], c.activeSpaceId());
    expect(c.tree.treeRoot()[0].error).toBeNull();
    expect(c.tree.treeRoot()[0].expanded).toBe(true);
  });

  it('a root listing that fails is a failed tree, not an empty one', () => {
    // The same silence one level up, and the one place a per-node message cannot reach: there is no node to
    // hang it on. Without this, a space whose tree could not load looks exactly like a space with no folders.
    const api = {
      ...makeApi(),
      listFiles: () => throwError(() => new Error('nope')),
    } as any;
    TestBed.configureTestingModule({
      imports: [FileManagerComponent, getTranslocoModule()],
      providers: [
        { provide: FilesApi, useValue: api },
        { provide: SpacesApi, useValue: api },
        { provide: BrainApi, useValue: api },
        { provide: AuthService, useValue: { token: () => 't' } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: () => null } }, queryParamMap: of() } },
      ],
    });
    const fixture = TestBed.createComponent(FileManagerComponent);
    fixture.detectChanges();
    const c = fixture.componentInstance as any;

    c.tree.loadRoot(c.activeSpaceId());
    expect(c.tree.rootError()).toBeTruthy();
    expect(c.tree.treeRoot().length).toBe(0);
  });

  it('the sidebar remembers being closed, and loads the tree only when it has none', () => {
    /*
     * Two behaviours in one method, and the second is a request decision rather than a UI one: reopening a
     * sidebar whose tree is already loaded must not re-fetch the root. That is why this belongs with the tree
     * and not with the toolbar.
     */
    const { c, requested } = createWithTree({ '/': [dir('docs')] });
    const rootsAtStart = requested.filter(p => p === '/').length;

    c.tree.toggleSidebar(c.activeSpaceId());
    expect(c.tree.sidebarOpen()).toBe(false);
    expect(localStorage.getItem('ythril.sidebar')).toBe('closed');

    c.tree.toggleSidebar(c.activeSpaceId());
    expect(c.tree.sidebarOpen()).toBe(true);
    expect(localStorage.getItem('ythril.sidebar')).toBe('open');
    expect(requested.filter(p => p === '/').length).toBe(rootsAtStart);
  });

  it('switching space rebuilds the tree from the new space root', () => {
    // The tree is per-space state, and `selectSpace` is the only thing that resets it. A store whose lifetime
    // outlived the selection would show the previous space's folders.
    const { c, requested } = createWithTree({ '/': [dir('docs')] });
    const before = requested.filter(p => p === '/').length;
    c.selectSpace('work');
    expect(requested.filter(p => p === '/').length).toBeGreaterThan(before);
    expect(c.currentPath()).toBe('/');
  });
});

/**
 * Install a `fetch` stub for the duration of one case.
 *
 * `openPreview` reaches for the global directly, because the file endpoint needs an `Authorization` header
 * and a browser-native `<img src>` cannot send one. jsdom provides no `fetch`, so there is nothing to spy on
 * — the same situation as `withRevokeSpy` above, and the same answer: define it, or the three branches that
 * decide what a preview shows are the part of this page its suite cannot reach.
 */
function withFetch(responder: (url: string) => Promise<unknown>): {
  urls: string[]; calls: Array<{ url: string; init?: RequestInit }>; restore: () => void;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const urls: string[] = [];
  const had = 'fetch' in globalThis;
  const previous = (globalThis as any).fetch;
  (globalThis as any).fetch = (url: string, init?: RequestInit) => {
    urls.push(url);
    calls.push({ url, init });
    return responder(url);
  };
  return {
    urls,
    calls,
    restore: () => { if (had) (globalThis as any).fetch = previous; else delete (globalThis as any).fetch; },
  };
}

/** A `Response` with just the three methods `openPreview` calls. */
const okResponse = (body: { text?: string; blob?: unknown; buffer?: ArrayBuffer }) => ({
  ok: true,
  text: () => Promise.resolve(body.text ?? ''),
  blob: () => Promise.resolve(body.blob ?? {}),
  arrayBuffer: () => Promise.resolve(body.buffer ?? new ArrayBuffer(0)),
});

/**
 * The preview group: which kind a file is, what happens when the fetch fails, and what the renderer is told.
 *
 * Pinned before `G-3.2` moves all of it into a store. The object-URL block above covers the one resource
 * that must be RELEASED; none of it touches the three things below, and each was measured to have no
 * assertion anywhere in the folder before this change.
 *
 * **The kind decision is a lookup across five extension tables** with an `unknown` fallback, and `unknown`
 * is not an error state — it renders the pane with a download link and no spinner. A move that lost the
 * fallback would show a permanent spinner on a `.zip`, which reads as a hung request.
 *
 * **The failure path is written out THREE TIMES**, once per fetch branch, and that is the shape this
 * codebase produces most: one rule, several implementations, and the weakest winning silently. Nothing
 * asserted any of the three, so a move that unified them could have dropped one and stayed green.
 *
 * **`previewModel` is the contract with the renderer.** Its own docstring says the states are mutually
 * exclusive and that saying so in one place is what stops the child re-deriving "am I loading or erroring"
 * from flags it receives separately. That claim had no test.
 */
describe('FileManagerComponent — what a preview decides (characterization for G-3)', () => {
  const KINDS: Array<[string, string]> = [
    ['notes.md', 'markdown'],
    ['NOTES.MD', 'markdown'],       // the extension is lower-cased before the lookup
    ['notes.markdown', 'markdown'],
    ['main.ts', 'text'],
    ['photo.png', 'image'],
    ['photo.JPEG', 'image'],
    ['report.pdf', 'pdf'],
    ['book.xlsx', 'xlsx'],
    ['archive.zip', 'unknown'],
    ['LICENSE', 'unknown'],         // no dot at all
    ['.gitignore', 'unknown'],      // a leading dot is not an extension
    ['.md', 'unknown'],             // and a file NAMED '.md' has a name, not an extension
  ];

  it('the kind comes from the extension, lower-cased, with unknown as the fallback', () => {
    const f = withFetch(() => Promise.resolve(okResponse({ text: '' })));
    try {
      for (const [name, kind] of KINDS) {
        TestBed.resetTestingModule();
        const c = create();
        c.openPreview(file(name));
        expect(c.preview.kind(), name).toBe(kind);
      }
    } finally {
      f.restore();
    }
  });


  it('every preview branch sends the token in the HEADER, never in the URL', () => {
    /*
     * This is the whole reason the preview fetches by hand instead of letting the browser load the file.
     * The file endpoint requires the header, and a native `<img src>`/`<iframe src>` cannot send one — which
     * is what regressed image and PDF previews when the `?token=` fallback was scoped to SSE-only (#134).
     *
     * **The download path has had a case for this since that regression and the preview path never did**,
     * which is the same rule tested in one of the two places it lives. Nothing here asserted that the header
     * is attached, so a refactor could have dropped it and every branch would have failed identically and
     * silently: a 401 shows up as `previewError`, which reads like a permissions problem with the file.
     *
     * Asserted per BRANCH, because the header used to be built once and passed into three separate `fetch`
     * calls — one of them losing it is exactly the shape this page keeps producing.
     */
    const f = withFetch(() => new Promise(() => { /* never resolves; only the request matters */ }));
    try {
      for (const name of ['main.ts', 'notes.md', 'photo.png', 'report.pdf', 'book.xlsx']) {
        TestBed.resetTestingModule();
        const c = create();
        f.calls.length = 0;
        c.openPreview(file(name));

        expect(f.calls.length, name).toBe(1);
        const { url, init } = f.calls[0];
        expect((init?.headers as Record<string, string>)?.['Authorization'], name).toBe('Bearer t');
        // And it is not ALSO in the URL: a credential in a query string reaches server logs, the browser's
        // history and any `Referer` it sends. `no-credential-travels-in-a-url.test.js` holds the server half.
        expect(url, name).not.toContain('token');
      }
    } finally {
      f.restore();
    }
  });

  it('an unknown type fetches nothing and shows no spinner', () => {
    const f = withFetch(() => Promise.resolve(okResponse({ text: 'x' })));
    try {
      const c = create();
      c.openPreview(file('archive.zip'));

      // There is no fourth branch, and that is deliberate rather than missing: the pane offers a download
      // instead. A spinner left spinning is indistinguishable from a request that never came back.
      expect(f.urls).toEqual([]);
      expect(c.preview.loading()).toBe(false);
      expect(c.preview.error()).toBeNull();
      expect(c.preview.file()?.name).toBe('archive.zip');
    } finally {
      f.restore();
    }
  });

  const FETCHING: Array<[string, string]> = [
    ['notes.md', 'markdown'],
    ['main.ts', 'text'],
    ['photo.png', 'image'],
    ['report.pdf', 'pdf'],
    ['book.xlsx', 'xlsx'],
  ];

  for (const [name, kind] of FETCHING) {
    it(`a failed fetch on the ${kind} branch says why and clears the spinner`, async () => {
      const f = withFetch(() => Promise.resolve({
        ok: false,
        status: 403,
        text: () => Promise.resolve(''),
        blob: () => Promise.resolve({}),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      }));
      try {
        const c = create();
        c.openPreview(file(name));
        expect(c.preview.loading()).toBe(true);

        // Two microtask turns: the `!r.ok` throw happens in the first `.then`, the `.catch` runs after it.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        // A blank pane is the failure mode this replaces — the user cannot tell a forbidden file from an
        // empty one, and there is nothing on screen to retry or report.
        expect(c.preview.error()).toBeTruthy();
        expect(c.preview.loading()).toBe(false);
      } finally {
        f.restore();
      }
    });
  }

  it('a markdown response that resolves LATE does not land on the file that is open now', async () => {
    /*
     * The same race the object-URL block pins for images, on the branch that does not allocate anything.
     * Rendering markdown awaits mermaid, so arrowing past two `.md` files gives: start A, start B, A resolves
     * and sets the HTML, B resolves and sets its own. Between the two, A's rendered document is displayed
     * under B's name — and if B is the smaller document, it stays that way until something else re-renders.
     *
     * Driven by resolving A's fetch after `previewFile` has already moved to B, which is what the guard
     * `this.preview.file()?.name !== entry.name` actually reads.
     */
    let release: ((r: unknown) => void) | null = null;
    const f = withFetch(() => new Promise(res => { release = res; }));
    try {
      const c = create();
      c.openPreview(file('a.md'));
      // The selection moves on while A's fetch is still open.
      c.preview.file.set(file('b.md'));

      release!(okResponse({ text: '# A' }));
      for (let i = 0; i < 8; i++) await Promise.resolve();

      expect(c.preview.html()).toBe('');
    } finally {
      f.restore();
    }
  });

  it('a SOURCE response that resolves late does not land on the file that is open now', async () => {
    /*
     * The fourth copy of the stale-response rule, and it was the one that did not exist.
     *
     * Three branches guard against it — markdown reads `previewFile()?.name !== entry.name` before setting
     * the HTML, xlsx does the same before setting the table, and image/PDF does it inside
     * `applyPreviewBlobUrl`, which is where it was added on 2026-09-02 after a leak. The plain-text branch
     * highlights and assigns with no guard at all.
     *
     * The window is the fetch, which is the slow part. Arrow from a large `.ts` to a small one and the order
     * is: start A, start B, B resolves and shows B, A resolves and overwrites it — so the pane shows A's
     * source under B's name, and stays that way until something else re-renders. Nothing errors.
     */
    const resolvers: Array<(r: unknown) => void> = [];
    const f = withFetch(() => new Promise(res => { resolvers.push(res); }));
    try {
      const c = create();
      c.openPreview(file('big.ts'));
      c.openPreview(file('small.ts'));
      expect(c.preview.file()?.name).toBe('small.ts');

      // B comes back first and is correct.
      resolvers[1](okResponse({ text: 'the small one' }));
      for (let i = 0; i < 8; i++) await Promise.resolve();
      expect(c.preview.html()).toContain('the small one');

      // Then A's response arrives, for a file nobody is looking at any more.
      resolvers[0](okResponse({ text: 'the big one' }));
      for (let i = 0; i < 8; i++) await Promise.resolve();

      expect(c.preview.html()).toContain('the small one');
      expect(c.preview.html()).not.toContain('the big one');
    } finally {
      f.restore();
    }
  });

  it('a stale response does not clear the spinner belonging to the fetch that is still running', async () => {
    /*
     * The image branch used to clear `previewLoading` unconditionally, one line after handing the blob over,
     * while markdown and xlsx returned early without touching it. The one that cleared was wrong: by the
     * time a stale response lands, the CURRENT file's own fetch has already set the spinner, so clearing it
     * leaves a pane with no spinner and no content until that fetch happens to finish.
     */
    const resolvers: Array<(r: unknown) => void> = [];
    const f = withFetch(() => new Promise(res => { resolvers.push(res); }));
    try {
      const c = create();
      c.openPreview(file('a.png'));
      c.openPreview(file('b.png'));
      expect(c.preview.loading()).toBe(true);

      resolvers[0](okResponse({ blob: {} }));   // A's response, for a file nobody is looking at
      for (let i = 0; i < 8; i++) await Promise.resolve();

      // B's fetch is still open. The spinner is B's, and A has no business ending it.
      expect(c.preview.loading()).toBe(true);
    } finally {
      f.restore();
    }
  });

  it('a stale FAILURE does not put one file\'s error on another file\'s pane', async () => {
    /*
     * All three branches used to report any failure, whenever it arrived. A 403 on the file you arrowed past
     * then appears over the file you are looking at — and the file it is actually about is not on screen, so
     * there is nothing the message can be acted on for.
     */
    const resolvers: Array<(r: unknown) => void> = [];
    const f = withFetch(() => new Promise(res => { resolvers.push(res); }));
    try {
      const c = create();
      c.openPreview(file('secret.md'));
      c.openPreview(file('fine.md'));

      resolvers[0]({ ok: false, status: 403, text: () => Promise.resolve('') });
      for (let i = 0; i < 8; i++) await Promise.resolve();

      expect(c.preview.error()).toBeNull();
      expect(c.preview.loading()).toBe(true);   // still fine.md's fetch

      // And the CURRENT file's own failure is still reported.
      resolvers[1]({ ok: false, status: 500, text: () => Promise.resolve('') });
      for (let i = 0; i < 8; i++) await Promise.resolve();
      expect(c.preview.error()).toBeTruthy();
      expect(c.preview.loading()).toBe(false);
    } finally {
      f.restore();
    }
  });

  it('no object URL is allocated for a response nobody is waiting for', async () => {
    /*
     * The ordering that matters, and the reason `URL.createObjectURL` is called in `show` rather than while
     * producing. Allocated before the staleness check it would be created for a file nobody is looking at,
     * and then either dropped — a leak — or released, which is work with a resource in between. Not created
     * is the only version with nothing to get wrong.
     */
    const spy = withRevokeSpy();
    let created = 0;
    (URL as any).createObjectURL = () => { created++; return 'blob:made-' + created; };
    const resolvers: Array<(r: unknown) => void> = [];
    const f = withFetch(() => new Promise(res => { resolvers.push(res); }));
    try {
      const c = create();
      c.openPreview(file('a.png'));
      c.openPreview(file('b.png'));

      resolvers[0](okResponse({ blob: {} }));
      for (let i = 0; i < 8; i++) await Promise.resolve();

      expect(created).toBe(0);
      expect(spy.calls).toEqual([]);   // nothing to revoke, because nothing was made

      resolvers[1](okResponse({ blob: {} }));
      for (let i = 0; i < 8; i++) await Promise.resolve();
      expect(created).toBe(1);
      expect(c.preview.mediaUrl()).toBe('blob:made-1');
    } finally {
      f.restore();
      // The object-URL stubs STAY: jsdom implements neither half, and the fixture teardown releases the
      // pane's URL. Restoring them before cleanup makes the component throw on the way out — which is
      // what the other cases in this block already know, and why none of them restore either.
    }
  });

  it('previewModel is null with nothing open, and reports loading and error rather than leaving them to the child', () => {
    const c = create();
    expect(c.preview.model()).toBeNull();

    c.preview.file.set(file('doc.md'));
    c.preview.kind.set('markdown');
    c.preview.loading.set(true);
    expect(c.preview.model()).toMatchObject({ loading: true, error: null, kind: 'markdown' });

    c.preview.loading.set(false);
    c.preview.error.set('403 Forbidden');
    const m = c.preview.model();
    // Both are present on the one object. The child is given the answer instead of the flags to derive it
    // from, which is what stops "loading" and "error" ever being true at once on screen.
    expect(m.loading).toBe(false);
    expect(m.error).toBe('403 Forbidden');
    expect(m.file.name).toBe('doc.md');
  });

  it('every awkward spreadsheet cell has display text, not [object Object]', async () => {
    /*
     * `exceljs` gives a cell value that is a string, a number, a Date, or one of four OBJECTS — a formula
     * with its cached result, a hyperlink with its label, rich text as runs, and an error. Six branches, and
     * none of them had an assertion. A preview that renders `[object Object]` down a formula column does not
     * error, does not warn, and looks exactly like a spreadsheet nobody filled in.
     */
    const mod = await import('exceljs');
    const ExcelJS = (mod as unknown as { default?: unknown }).default ?? mod;
    const wb = new (ExcelJS as { Workbook: new () => any }).Workbook();
    const ws = wb.addWorksheet('Odd');
    ws.addRow(['formula', 'link', 'rich', 'err', 'when', 'nothing']);
    const row = ws.addRow([]);
    row.getCell(1).value = { formula: 'SUM(1,2)', result: 3 };
    row.getCell(2).value = { text: 'Ythril', hyperlink: 'https://example.invalid' };
    row.getCell(3).value = { richText: [{ text: 'bold' }, { text: 'ed' }] };
    row.getCell(4).value = { error: '#DIV/0!' };
    row.getCell(5).value = new Date(Date.UTC(2026, 8, 2));
    row.getCell(6).value = null;
    const buf = await wb.xlsx.writeBuffer();

    const c = create();
    const table = await c.preview.parseXlsx(buf as ArrayBuffer);

    expect(table.rows[0][0]).toBe('3');          // the cached result, not the formula source
    expect(table.rows[0][1]).toBe('Ythril');     // the label, not the URL
    expect(table.rows[0][2]).toBe('bolded');     // the runs, concatenated
    expect(table.rows[0][3]).toBe('#DIV/0!');
    // The exact string is the RUNNER's locale and zone, so the assertion is the shape. An exact date here
    // passes in CEST and fails on CI in UTC, which is a red build that says nothing about the code.
    expect(table.rows[0][4]).toMatch(/\d/);
    expect(table.rows[0][4]).not.toContain('object');
    expect(table.rows[0][5]).toBe('');           // an empty cell is empty, not the word "null"
  });
});
