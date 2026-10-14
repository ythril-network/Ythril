/**
 * The folder tree is a WAI-ARIA tree a keyboard can drive (`Q-476`).
 *
 * It was a stack of clickable `div`s: no role, no focus stop, no arrows, so the sidebar was mouse-only. These cases drive the
 * REAL page and read the DOM and the focus, never a component's private state, so the rule is what a keyboard and a screen reader
 * meet: roles, one roving tab stop, the arrow keys, Enter, `aria-expanded`, `aria-current`, and where focus goes when the
 * focused node is removed.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mountFilesPage, type MountedPage } from '../../testing/files-page-harness';

const TREE = {
  '/alpha': 'dir', '/alpha/inner': 'dir', '/alpha/inner/deep': 'dir', '/beta': 'dir', '/gamma': 'dir', '/note.txt': 1,
} as const;

beforeEach(() => TestBed.resetTestingModule());

const items = (page: MountedPage): HTMLElement[] => [...page.el.querySelectorAll('[role="treeitem"]')] as HTMLElement[];

/** The folder name an item shows for itself: its own text, not that of the group of children it may contain. */
function labelOf(item: HTMLElement): string {
  const own = item.cloneNode(true) as HTMLElement;
  own.querySelectorAll('[role="group"]').forEach(g => g.remove());
  return (item.getAttribute('aria-label') ?? own.textContent ?? '').trim();
}

const item = (page: MountedPage, name: string): HTMLElement => {
  const found = items(page).find(i => labelOf(i) === name);
  if (!found) throw new Error(`no treeitem for ${name}; items: ${items(page).map(labelOf).join(', ') || '(none)'}`);
  return found;
};

async function press(page: MountedPage, key: string): Promise<void> {
  (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  await page.settle();
}

describe('the tree has the roles of a WAI-ARIA tree', () => {
  it('one tree, an item for every visible folder (and no file), each with aria-expanded; children sit in groups inside the tree', async () => {
    const page = await mountFilesPage({ ...TREE });
    const trees = page.el.querySelectorAll('[role="tree"]');
    expect(trees.length, 'exactly one tree').toBe(1);
    expect(items(page).map(labelOf)).toEqual(['alpha', 'beta', 'gamma']);
    for (const i of items(page)) {
      expect(trees[0]!.contains(i), `${labelOf(i)} is inside the tree`).toBe(true);
      expect(i.getAttribute('aria-expanded'), `${labelOf(i)}: a collapsed folder says so`).toBe('false');
    }

    page.c.onTreeClick(page.c.tree.treeRoot().find((n: any) => n.path === '/alpha'));
    await page.settle();
    expect(item(page, 'alpha').getAttribute('aria-expanded')).toBe('true');
    expect(items(page).map(labelOf)).toEqual(['alpha', 'inner', 'beta', 'gamma']);
    const groups = [...page.el.querySelectorAll('[role="group"]')];
    expect(groups.length, 'the opened folder holds its children in one group').toBe(1);
    expect(trees[0]!.contains(groups[0]!)).toBe(true);
    expect(groups[0]!.querySelectorAll('[role="treeitem"]').length).toBe(1);
    expect(groups[0]!.contains(item(page, 'inner'))).toBe(true);
  });

  it('the folder being shown is aria-current, and no other item is', async () => {
    const page = await mountFilesPage({ ...TREE });
    page.c.onTreeClick(page.c.tree.treeRoot().find((n: any) => n.path === '/beta'));
    await page.settle();
    const current = (i: HTMLElement): boolean => { const v = i.getAttribute('aria-current'); return v !== null && v !== 'false'; };
    expect(items(page).filter(current).map(labelOf)).toEqual(['beta']);
  });
});

describe('the tree has ONE tab stop that travels with the focus (roving tabindex)', () => {
  const tabStops = (page: MountedPage): string[] => items(page).filter(i => i.getAttribute('tabindex') === '0').map(labelOf);

  it('exactly one item is tabbable and every other is -1, from the first render and after every move', async () => {
    const page = await mountFilesPage({ ...TREE });
    expect(tabStops(page).length).toBe(1);
    for (const i of items(page)) expect(['0', '-1'], labelOf(i)).toContain(i.getAttribute('tabindex'));

    item(page, 'alpha').focus();
    await press(page, 'ArrowDown');
    expect(labelOf(document.activeElement as HTMLElement)).toBe('beta');
    expect(tabStops(page)).toEqual(['beta']);
    await press(page, 'ArrowDown');
    expect(tabStops(page)).toEqual(['gamma']);
  });
});

describe('the arrow keys and Enter drive the tree', () => {
  it('Down and Up move through the VISIBLE items only, and stop at the ends', async () => {
    const page = await mountFilesPage({ ...TREE });
    item(page, 'alpha').focus();
    await press(page, 'ArrowDown');
    expect(labelOf(document.activeElement as HTMLElement), 'the next visible item (alpha is collapsed, its child is not visible)').toBe('beta');
    await press(page, 'ArrowDown');
    expect(labelOf(document.activeElement as HTMLElement)).toBe('gamma');
    await press(page, 'ArrowDown');
    expect(labelOf(document.activeElement as HTMLElement), 'no wrap past the last').toBe('gamma');
    await press(page, 'ArrowUp');
    await press(page, 'ArrowUp');
    await press(page, 'ArrowUp');
    expect(labelOf(document.activeElement as HTMLElement), 'no wrap before the first').toBe('alpha');
  });

  it('Right opens a closed folder, then moves into it; Left closes an open one, then moves to its parent', async () => {
    const page = await mountFilesPage({ ...TREE });
    item(page, 'alpha').focus();

    await press(page, 'ArrowRight');
    expect(item(page, 'alpha').getAttribute('aria-expanded'), 'Right on a closed folder opens it').toBe('true');
    expect(labelOf(document.activeElement as HTMLElement), 'and keeps focus on it').toBe('alpha');

    await press(page, 'ArrowRight');
    expect(labelOf(document.activeElement as HTMLElement), 'Right on an open folder moves to its first child').toBe('inner');

    await press(page, 'ArrowLeft');
    expect(labelOf(document.activeElement as HTMLElement), 'Left on a closed child moves to its parent').toBe('alpha');

    await press(page, 'ArrowLeft');
    expect(item(page, 'alpha').getAttribute('aria-expanded'), 'Left on an open folder closes it').toBe('false');
    expect(labelOf(document.activeElement as HTMLElement)).toBe('alpha');
  });

  it('Enter opens the folder in the listing, exactly as a click does', async () => {
    const page = await mountFilesPage({ ...TREE });
    item(page, 'beta').focus();
    await press(page, 'Enter');
    expect(page.c.currentPath()).toBe('/beta');
    expect(page.server.sentWith('GET', '/beta').length, 'its listing was requested').toBeGreaterThanOrEqual(1);
    expect(labelOf(document.activeElement as HTMLElement), 'focus stays on the tree item').toBe('beta');
  });
});

describe('when the focused node is removed, focus goes to its parent', () => {
  it('a nested folder: focus lands on the parent item, which becomes the tab stop', async () => {
    const page = await mountFilesPage({ ...TREE });
    item(page, 'alpha').focus();
    await press(page, 'ArrowRight');
    await press(page, 'ArrowRight');
    expect(labelOf(document.activeElement as HTMLElement)).toBe('inner');

    page.c.tree.removeByPath('/alpha/inner');
    page.fixture.detectChanges();
    await vi.waitFor(() => {
      page.fixture.detectChanges();
      expect(labelOf(document.activeElement as HTMLElement), 'focus was not left on a node that is gone').toBe('alpha');
    }, { timeout: 1500 });
    expect(item(page, 'alpha').getAttribute('tabindex')).toBe('0');
    expect(items(page).map(labelOf)).toEqual(['alpha', 'beta', 'gamma']);
  });
});
