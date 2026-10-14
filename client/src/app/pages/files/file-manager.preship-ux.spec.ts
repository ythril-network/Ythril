/**
 * The Files page's pre-ship ux and accessibility fixes (b113 sweep): a repeated announcement is heard again, the focus after the
 * last row is deleted goes somewhere on screen, the detail pane's tab strip is not clipped, and the status column is not covered.
 *
 * The first two run the page over the fake file server (`testing/files-page-harness.ts`), so they read the DOM a screen reader
 * reads. The two layout cases read the COMPUTED style of the real component (jsdom applies the component stylesheet), which says
 * what the rule is and cannot say how wide anything is: the widths were measured in Chrome at 1400 px with the pane open, in
 * German, and the numbers pinned here are the ones that measurement settled on.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mountFilesPage, type MountedPage } from '../../testing/files-page-harness';

beforeEach(() => TestBed.resetTestingModule());

const entryOf = (page: MountedPage, name: string) => page.c.listing.entries().find((e: any) => e.name === name);
const px = (value: string): number => Number.parseFloat(value);

describe('a repeated announcement is announced again (A1)', () => {
  it('the same sentence twice passes through an empty region, so the second one is a change a screen reader hears', async () => {
    const page = await mountFilesPage({ '/a.txt': 1, '/d': 'dir', '/d/a.txt': 2 });
    const region = page.el.querySelector('.sr-only[role="status"]') as HTMLElement;
    expect(region, 'the polite region is always in the DOM').toBeTruthy();
    const seen: string[] = [];
    const observer = new MutationObserver(() => seen.push((region.textContent ?? '').trim()));
    observer.observe(region, { childList: true, characterData: true, subtree: true });

    await page.clickDelete('a.txt');
    await vi.waitFor(() => { page.fixture.detectChanges(); expect(seen.filter(s => s.includes('a.txt')).length).toBe(1); }, { timeout: 1500 });
    page.c.navigate('/d');
    await page.settle();
    await page.clickDelete('a.txt');
    await vi.waitFor(() => { page.fixture.detectChanges(); expect(seen.filter(s => s.includes('a.txt')).length, 'heard twice').toBe(2); }, { timeout: 1500 });
    observer.disconnect();

    const first = seen.findIndex(s => s.includes('a.txt'));
    const second = seen.findIndex((s, i) => i > first && s.includes('a.txt'));
    expect(seen.slice(first + 1, second), 'the region was emptied between the two').toContain('');
  });
});

describe('the focus after the last row is deleted goes to something on screen (A2)', () => {
  it('it lands on the empty-state heading, not on the screen-reader-only caption', async () => {
    const page = await mountFilesPage({ '/a.txt': 1 });
    await page.clickDelete('a.txt');
    await vi.waitFor(() => {
      page.fixture.detectChanges();
      const active = document.activeElement as HTMLElement | null;
      expect(active, 'something has the focus').toBeTruthy();
      expect(active, 'not the page body').not.toBe(document.body);
      expect(active!.closest('.sr-only'), 'not an element only a screen reader can see').toBeNull();
      expect(active!.closest('caption'), 'not the caption').toBeNull();
      expect(active!.closest('.empty-state'), 'the folder is empty now, and its heading says so').toBeTruthy();
    }, { timeout: 1500 });
  });
});

describe('the detail pane tab strip stays reachable at a narrow width (U2)', () => {
  it('it wraps instead of clipping its tabs', async () => {
    const page = await mountFilesPage({ '/a.txt': 1 });
    page.c.openPreview(entryOf(page, 'a.txt'));
    await page.settle();
    const strip = page.el.querySelector('.seg-toggle') as HTMLElement;
    expect(strip, 'the pane is open with its tab strip').toBeTruthy();
    const style = getComputedStyle(strip);
    expect(style.flexWrap, 'a strip that cannot fit in one row goes on to the next').toBe('wrap');
    expect(style.overflow, 'overflow hidden is what clipped the third tab at 320px').not.toBe('hidden');
  });
});

describe('the status pill is not covered by the sticky actions at the narrow list (U3)', () => {
  it('the name column and the action buttons leave the status column the room it needs', async () => {
    const page = await mountFilesPage({ '/a.txt': 1 });
    const name = getComputedStyle(page.el.querySelector('.name-cell') as HTMLElement);
    const actions = getComputedStyle(page.el.querySelector('.row-actions') as HTMLElement);
    expect(px(name.minWidth), 'the name column ellipsizes below this').toBeLessThanOrEqual(80);
    expect(px(actions.gap), 'the action buttons sit this close').toBeLessThanOrEqual(4);
  });
});
