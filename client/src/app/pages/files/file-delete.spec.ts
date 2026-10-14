/**
 * Deleting from the Files page (`Q-470`): what the page SENDS, what it ASKS, and what it does with the answer.
 *
 * Every case runs the real `FilesApi` over a fake file server (`testing/files-page-harness.ts`), so the rule is read off the
 * wire and the screen and not off a store's method signature. Wording is read from the REAL translation files in each
 * locale, because the transloco test module echoes keys and an echoed key can never be a wrong sentence.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mountFilesPage, locale, type MountedPage } from '../../testing/files-page-harness';
import { formatSize } from './file-format';

const LANGS = ['en', 'de', 'pl'] as const;

/** The longest run of a sentence that is not a placeholder: what must survive into the rendered words. */
const fixedWords = (sentence: string): string =>
  sentence.split(/\{\{[^}]*\}\}/).map(s => s.trim()).sort((a, b) => b.length - a.length)[0] ?? '';

/** A node of the tree sidebar's state, by path. */
function findNode(page: MountedPage, path: string): any {
  const walk = (nodes: any[]): any => {
    for (const n of nodes) {
      if (n.path === path) return n;
      const inner = n.children ? walk(n.children) : undefined;
      if (inner) return inner;
    }
    return undefined;
  };
  return walk(page.c.tree.treeRoot());
}

beforeEach(() => TestBed.resetTestingModule());

describe('the delete request says confirm ONLY for a directory', () => {
  it('every entry of a mixed folder: a directory is deleted with confirm:true, a file with no confirm', async () => {
    const tree = { '/a.txt': 10, '/b.bin': 5, '/docs': 'dir', '/zeta': 'dir' } as const;
    for (const [path, kind] of Object.entries(tree)) {
      const page = await mountFilesPage({ ...tree });
      await page.clickDelete(path.slice(1));
      const sent = page.server.sentWith('DELETE', path);
      // The last DELETE for the path is the one that took effect: a directory refused for lack of confirm is retried by nobody.
      expect(sent.length, `${path} was deleted`).toBeGreaterThanOrEqual(1);
      const confirm = (sent[0]!.body as { confirm?: unknown } | null)?.confirm;
      if (kind === 'dir') expect(confirm, `${path} is a directory`).toBe(true);
      else expect(confirm, `${path} is a file: a stale "confirm" would delete a folder that replaced it`).not.toBe(true);
      TestBed.resetTestingModule();
    }
  });

  it('a row that is now a FOLDER (it was a file when the list loaded) is refused, the list reloads, and the toast stays and says so', async () => {
    const page = await mountFilesPage({ '/docs': 10, '/keep.txt': 1 });
    expect(page.c.listing.entries().find((e: any) => e.name === 'docs').isDirectory).toBe(false);
    page.server.put('/docs', 'dir');
    page.server.put('/docs/inner.txt', 3);
    const listedBefore = page.server.sentWith('GET', '/').length;

    await page.clickDelete('docs');

    expect(page.server.nodes.has('/docs'), 'nothing was deleted: the folder is still there').toBe(true);
    expect(page.server.nodes.has('/docs/inner.txt')).toBe(true);
    expect(page.server.sentWith('GET', '/').length, 'the listing reloaded after the refusal').toBeGreaterThan(listedBefore);
    expect(page.c.listing.entries().find((e: any) => e.name === 'docs').isDirectory, 'and shows the entry as the folder it is').toBe(true);
    const errors = page.toasts.filter(t => t.kind === 'error');
    expect(errors.length).toBe(1);
    expect(errors[0]!.message).toMatch(/now a folder/i);
    expect(errors[0]!.duration, 'a refusal that tells the operator what to do stays until dismissed').toBe(0);
  });
});

describe('the delete dialog names what is deleted, per kind and per locale', () => {
  for (const lang of LANGS) {
    it(`${lang}: a folder dialog and a file dialog differ, both name the entry, the folder one says its contents go and shows its size`, async () => {
      const words = locale(lang);
      // A folder entry carries a size on the listing (the server totals it), so the dialog has one to show.
      const page = await mountFilesPage({ '/notes.txt': 10, '/docs': { dirSize: 2048 } }, { lang });

      await page.clickDelete('notes.txt');
      await page.clickDelete('docs');

      expect(page.confirms.length).toBe(2);
      const [file, folder] = page.confirms;
      expect(file!.message, 'the file dialog names the file').toContain('notes.txt');
      expect(folder!.message, 'the folder dialog names the folder').toContain('docs');
      expect(folder!.title).not.toBe(file!.title);
      expect(folder!.message).not.toBe(file!.message);
      expect(folder!.message, 'a folder dialog shows the size of what goes').toContain(formatSize(2048));
      const contentsGo: Record<string, RegExp> = {
        en: /everything in it|everything inside|its contents|all (of )?its contents|and all/i,
        de: /samt Inhalt/,
        pl: /razem z całą zawartością/,
      };
      expect(folder!.message, `${lang} folder dialog says the contents go`).toMatch(contentsGo[lang]!);
      expect(file!.message, `${lang} file dialog does not talk about contents`).not.toMatch(contentsGo[lang]!);
      expect(folder!.title, `${lang} the folder dialog's title says folder`).toMatch(/folder|ordner/i);
      for (const dialog of [file!, folder!]) {
        expect(dialog.confirmLabel, 'the confirm button stays the one delete word').toBe(words['common.delete']);
        expect(dialog.danger).toBe(true);
      }
    });
  }
});

describe('every delete button names the entry it deletes', () => {
  for (const lang of LANGS) {
    it(`${lang}: aria-label and title carry the entry's name, so a list of identical "Delete" buttons is not what a screen reader hears`, async () => {
      const names = ['alpha.txt', 'beta.bin', 'gamma'];
      const page = await mountFilesPage({ '/alpha.txt': 1, '/beta.bin': 2, '/gamma': 'dir' }, { lang });
      const labels: string[] = [];
      for (const name of names) {
        const button = page.row(name).querySelector('button.icon-btn.danger') as HTMLButtonElement;
        const label = button.getAttribute('aria-label') ?? '';
        expect(label, `${lang} aria-label of ${name}`).toContain(name);
        expect(button.getAttribute('title') ?? '', `${lang} title of ${name}`).toContain(name);
        labels.push(label);
      }
      expect(new Set(labels).size, 'one label per entry').toBe(names.length);
    });
  }
});

describe('a refused delete says what kind of thing it could not delete', () => {
  it('a folder and a file each have their own failure sentence in every locale, and the page uses them', async () => {
    for (const lang of LANGS) {
      const words = locale(lang);
      expect(words['files.error.deleteFolderFailed'], `${lang} has a folder-delete failure sentence`).toBeTruthy();
      expect(words['files.error.deleteFolderFailed']).not.toBe(words['files.error.deleteFailed']);
      for (const [path, kind, key] of [['/docs', 'dir', 'files.error.deleteFolderFailed'], ['/a.txt', 5, 'files.error.deleteFailed']] as const) {
        const page = await mountFilesPage({ [path]: kind }, { lang });
        page.server.forced.push({ method: 'DELETE', path, status: 500, body: null });
        await page.clickDelete(path.slice(1));
        expect(page.toasts.filter(t => t.kind === 'error').map(t => t.message), `${lang} ${path}`).toEqual([words[key]]);
        TestBed.resetTestingModule();
      }
    }
  });
});

describe('while a delete runs, and after it', () => {
  it('the row shows it is being deleted: its delete button is disabled or the row is aria-busy', async () => {
    const page = await mountFilesPage({ '/a.txt': 1, '/b.txt': 2 });
    page.server.hold('DELETE', '/a.txt');
    await page.clickDelete('a.txt');
    const row = page.row('a.txt');
    const button = row.querySelector('button.icon-btn.danger') as HTMLButtonElement;
    expect(button.disabled || row.getAttribute('aria-busy') === 'true', 'pending state on the row in flight').toBe(true);
    const other = page.row('b.txt');
    expect((other.querySelector('button.icon-btn.danger') as HTMLButtonElement).disabled, 'only that row').toBe(false);
    page.server.release('DELETE', '/a.txt');
    await page.settle();
    expect(page.rowNames()).toEqual(['b.txt']);
  });

  it('a polite status announces the deletion by name, for a file and for a folder', async () => {
    const page = await mountFilesPage({ '/a.txt': 1, '/docs': 'dir' });
    const announced = (): string => [...document.body.querySelectorAll('[aria-live="polite"], [role="status"]')]
      .map(e => e.textContent ?? '').join('|');
    await page.clickDelete('a.txt');
    await vi.waitFor(() => { page.fixture.detectChanges(); expect(announced()).toContain('a.txt'); }, { timeout: 1500 });
    await page.clickDelete('docs');
    await vi.waitFor(() => { page.fixture.detectChanges(); expect(announced()).toContain('docs'); }, { timeout: 1500 });
  });

  it('focus moves to the next row after a delete, and to the table caption when there is no next row', async () => {
    const page = await mountFilesPage({ '/a.txt': 1, '/b.txt': 2, '/c.txt': 3 });
    await page.clickDelete('b.txt');
    await vi.waitFor(() => {
      page.fixture.detectChanges();
      expect(document.activeElement?.textContent?.trim()).toBe('c.txt');
      expect(document.activeElement?.closest('tbody')).toBeTruthy();
    }, { timeout: 1500 });

    await page.clickDelete('c.txt');
    await vi.waitFor(() => {
      page.fixture.detectChanges();
      const caption = page.el.querySelector('table caption') as HTMLElement | null;
      expect(caption, 'the table has a caption to land on').toBeTruthy();
      expect(document.activeElement === caption || caption!.contains(document.activeElement)).toBe(true);
    }, { timeout: 1500 });
  });
});

describe('the preview closes when its file is gone', () => {
  const entryOf = (page: MountedPage, name: string) => page.c.listing.entries().find((e: any) => e.name === name);

  it('deleting the open file closes it, and deleting another file leaves it open', async () => {
    const page = await mountFilesPage({ '/a.bin': 1, '/b.bin': 2 });
    page.c.openPreview(entryOf(page, 'b.bin'));
    await page.settle();
    expect(page.c.preview.file()?.name).toBe('b.bin');
    await page.clickDelete('a.bin');
    expect(page.c.preview.file()?.name, 'another file was deleted').toBe('b.bin');
    await page.clickDelete('b.bin');
    expect(page.c.preview.file(), 'the file on show was deleted').toBeNull();
  });

  it('deleting a FOLDER the open file lives under closes it; a folder it does not live under does not', async () => {
    const page = await mountFilesPage({ '/docs': 'dir', '/docs/x.bin': 3, '/other': 'dir', '/y.bin': 1 });
    page.c.open(entryOf(page, 'docs'));
    await page.settle();
    page.c.openPreview(entryOf(page, 'x.bin'));
    await page.settle();
    page.c.navigate('/');
    await page.settle();
    expect(page.c.preview.file()?.name, 'the pane survives navigating to the parent').toBe('x.bin');

    await page.clickDelete('other');
    expect(page.c.preview.file()?.name, 'an unrelated folder was deleted').toBe('x.bin');
    await page.clickDelete('docs');
    expect(page.c.preview.file(), 'the folder holding the open file was deleted').toBeNull();
  });
});

describe('the empty and failed listing rows span every column of the header', () => {
  it('an empty folder: the one cell covers all header cells', async () => {
    const page = await mountFilesPage({});
    const headers = page.el.querySelectorAll('thead th').length;
    const cell = page.el.querySelector('tbody td[colspan]') as HTMLTableCellElement | null;
    expect(headers).toBe(7);
    expect(cell, 'the empty-state cell').toBeTruthy();
    expect(Number(cell!.getAttribute('colspan'))).toBe(headers);
  });

  it('a listing that failed to load: the same', async () => {
    const page = await mountFilesPage({ '/a.txt': 1 });
    page.server.forced.push({ method: 'GET', path: '/x', status: 500, body: { error: 'down' } });
    page.c.navigate('/x');
    await page.settle();
    expect(page.c.listing.loadError()).not.toBeNull();
    const cell = page.el.querySelector('tbody td[colspan]') as HTMLTableCellElement | null;
    expect(cell, 'the failed-load cell').toBeTruthy();
    expect(Number(cell!.getAttribute('colspan'))).toBe(page.el.querySelectorAll('thead th').length);
  });
});

describe('a deleted folder leaves the tree without collapsing it', () => {
  /** Expand /docs, /docs/sub and /other in the tree, the way the operator does: by clicking them. */
  async function expandedTree(extra: Record<string, 'dir' | number> = {}) {
    const page = await mountFilesPage({
      '/docs': 'dir', '/docs/sub': 'dir', '/docs/sub/deep': 'dir', '/docs/sub/deep/leaf': 'dir',
      '/other': 'dir', '/other/kid': 'dir', '/a.txt': 1, ...extra,
    });
    for (const path of ['/other', '/docs', '/docs/sub']) {
      page.c.onTreeClick(findNode(page, path));
      await page.settle();
    }
    expect(findNode(page, '/other').expanded && findNode(page, '/docs').expanded && findNode(page, '/docs/sub').expanded).toBe(true);
    return page;
  }

  it('the node and everything under it go; every other expanded node stays expanded', async () => {
    const page = await expandedTree();
    expect(page.c.currentPath()).toBe('/docs/sub');
    await page.clickDelete('deep');

    expect(findNode(page, '/docs/sub/deep'), 'the deleted folder is out of the tree').toBeUndefined();
    expect(findNode(page, '/docs/sub/deep/leaf')).toBeUndefined();
    for (const path of ['/docs', '/docs/sub', '/other']) expect(findNode(page, path)?.expanded, `${path} stays expanded`).toBe(true);
    expect(findNode(page, '/other').children.map((n: any) => n.path)).toEqual(['/other/kid']);
  });
});

describe('a created or moved folder reaches the tree without collapsing it', () => {
  async function expandedTree() {
    const page = await mountFilesPage({
      '/docs': 'dir', '/docs/sub': 'dir', '/docs/old': 'dir', '/docs/sub/deep': 'dir', '/other': 'dir', '/other/kid': 'dir',
    });
    for (const path of ['/other', '/docs', '/docs/sub']) {
      page.c.onTreeClick(findNode(page, path));
      await page.settle();
    }
    page.c.navigate('/docs');
    await page.settle();
    return page;
  }

  it('a new folder appears under its parent and every expanded node stays expanded', async () => {
    const page = await expandedTree();
    page.c.newFolderName.set('fresh');
    page.c.createFolder();
    await page.settle();

    expect(findNode(page, '/docs/fresh'), 'the new folder is in the tree').toBeDefined();
    for (const path of ['/docs', '/docs/sub', '/other']) expect(findNode(page, path)?.expanded, `${path} stays expanded`).toBe(true);
    expect(findNode(page, '/docs/sub').children.map((n: any) => n.path)).toEqual(['/docs/sub/deep']);
  });

  it('a folder moved between two parents leaves the old one and arrives in the new one, both reloaded, nothing collapsed', async () => {
    const page = await expandedTree();
    const entry = page.c.listing.entries().find((e: any) => e.name === 'old');
    page.c.startRename(entry);
    page.c.renameValue = 'sub/old';
    page.c.confirmRename(entry);
    await page.settle();

    expect(page.server.nodes.has('/docs/sub/old')).toBe(true);
    expect(findNode(page, '/docs').children.map((n: any) => n.path), 'the old parent no longer lists it').not.toContain('/docs/old');
    expect(findNode(page, '/docs/sub').children.map((n: any) => n.path), 'the new parent lists it').toContain('/docs/sub/old');
    for (const path of ['/docs', '/docs/sub', '/other']) expect(findNode(page, path)?.expanded, `${path} stays expanded`).toBe(true);
  });
});
