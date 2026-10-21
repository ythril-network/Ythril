/**
 * ShellComponent — mobile nav drawer logic (U2).
 *
 * The drawer's open/close state is the load-bearing behavior: the hamburger
 * toggles it, Escape and a resize above the breakpoint close it, and (verified
 * separately end-to-end) navigation and the backdrop close it too. These unit
 * tests lock the state transitions; the Playwright run covered the DOM/focus
 * trap/close-on-navigate wiring that needs a real router + layout.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Subject } from 'rxjs';
import { provideRouter, Router, NavigationEnd } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { of } from 'rxjs';
import { FilesApi } from '../../core/files-api.service';
import { AuthService } from '../../core/auth.service';
import { EmbedService } from '../../core/embed.service';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { ShellComponent } from './shell.component';

function make(embedded = false) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [ShellComponent, getTranslocoModule()],
    providers: [
      provideRouter([]),
      provideHttpClient(), provideHttpClientTesting(), // the shell loads the caller's personal views once
      { provide: FilesApi, useValue: { listConflicts: () => of({ conflicts: [] }) } as any },
      { provide: AuthService, useValue: { logout: () => {}, logoutOidc: async () => false } as unknown as AuthService },
      { provide: EmbedService, useValue: { embedded: () => embedded } as unknown as EmbedService },
    ],
  });
  const fixture = TestBed.createComponent(ShellComponent);
  return { fixture, cmp: fixture.componentInstance };
}

describe('ShellComponent — drawer', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => vi.restoreAllMocks());

  it('starts closed', () => {
    const { cmp } = make();
    expect(cmp.drawerOpen()).toBe(false);
  });

  it('toggleDrawer flips open/closed', () => {
    const { cmp } = make();
    cmp.toggleDrawer();
    expect(cmp.drawerOpen()).toBe(true);
    cmp.toggleDrawer();
    expect(cmp.drawerOpen()).toBe(false);
  });

  it('closeDrawer forces closed', () => {
    const { cmp } = make();
    cmp.toggleDrawer();
    cmp.closeDrawer();
    expect(cmp.drawerOpen()).toBe(false);
  });

  it('Escape closes an open drawer and is a no-op when already closed', () => {
    const { cmp } = make();
    cmp.onEscape();
    expect(cmp.drawerOpen()).toBe(false); // no-op
    cmp.toggleDrawer();
    cmp.onEscape();
    expect(cmp.drawerOpen()).toBe(false);
  });

  it('resizing above the breakpoint closes the drawer; staying mobile keeps it', () => {
    const { cmp } = make();
    cmp.toggleDrawer();

    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(500);
    cmp.onResize();
    expect(cmp.drawerOpen()).toBe(true); // still mobile → stays open

    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1200);
    cmp.onResize();
    expect(cmp.drawerOpen()).toBe(false); // crossed to desktop → closed
  });

  /**
   * Embedded mode (`?embedded=1`) hides the topbar because it duplicates the host portal's chrome. The
   * hamburger lived in that topbar — and below 768px the hamburger is the ONLY way to open the sidebar,
   * which is an off-canvas drawer there. So an embedded narrow iframe rendered whatever page it landed on
   * and no navigation at all: measured on a real browser at 420px, sidebar at `left: -280px`, no control
   * anywhere able to reach it.
   */
  describe('embedded mode', () => {
    const opener = (fixture: ReturnType<typeof make>['fixture']) =>
      fixture.nativeElement.querySelector('[aria-controls="app-sidebar"]');

    it('still renders a drawer opener — without one, narrow embeds have no navigation', () => {
      const { fixture } = make(true);
      fixture.detectChanges();
      expect(opener(fixture), 'no control targets app-sidebar, so the off-canvas drawer cannot be opened').toBeTruthy();
    });

    it('renders no host chrome — the reason the topbar was hidden still holds', () => {
      // Guards the fix against overcorrection: bringing the whole topbar back would restore the logo and a
      // Sign out that ends only the Ythril session, which is what embedded mode exists to avoid.
      const { fixture } = make(true);
      fixture.detectChanges();
      const host: HTMLElement = fixture.nativeElement;
      expect(host.querySelector('app-brand-logo'), 'embedded mode must not duplicate the host portal logo').toBeNull();
      expect(host.querySelector('.topbar-logo')).toBeNull();
      expect(
        [...host.querySelectorAll('button')].some(b => /sign ?out|abmelden|wyloguj/i.test(b.textContent ?? '')),
        'embedded mode must not offer Sign out — it would end only the Ythril session',
      ).toBe(false);
      // And the opener from the previous test is still there, so "no chrome" did not become "no nav".
      expect(opener(fixture)).toBeTruthy();
    });

    it('normal mode keeps its full topbar', () => {
      const { fixture } = make(false);
      fixture.detectChanges();
      const host: HTMLElement = fixture.nativeElement;
      expect(host.querySelector('.topbar')).toBeTruthy();
      expect(host.querySelector('app-brand-logo')).toBeTruthy();
      expect(opener(fixture)).toBeTruthy();
    });

    it('the embedded bar is shown only below the breakpoint (asserted on the CSS — jsdom has no layout)', () => {
      // jsdom evaluates no media queries and computes no layout, so the rule itself is the only thing that
      // can be checked here. Without the media-query half, embedded desktop users would get 56px of bar
      // holding a hamburger that does nothing, because the sidebar is already inline at that width.
      // vitest runs with cwd = client/, and `new URL(..., import.meta.url)` throws at collection time here.
      const src = readFileSync(resolve('src/app/pages/shell/shell.component.ts'), 'utf8');
      expect(src, 'the embedded bar must default to hidden').toMatch(/\.topbar-embedded\s*\{\s*display:\s*none;?\s*\}/);
      const mq = src.slice(src.indexOf('@media (max-width: 768px)'));
      const block = mq.slice(0, mq.indexOf('\n    }'));
      expect(block, 'the 768px block must reveal the embedded bar').toMatch(/\.topbar-embedded\s*\{\s*display:\s*flex/);
      expect(block, 'the 768px block must also reveal the hamburger').toMatch(/\.menu-btn\s*\{\s*display:\s*inline-flex/);
    });
  });

  it('navigation closes the drawer (NavigationEnd subscription)', () => {
    const events = new Subject();
    const { fixture, cmp } = make();
    const router = TestBed.inject(Router);
    // Swap the router event stream for a controllable subject before ngOnInit
    // wires up its subscription.
    Object.defineProperty(router, 'events', { value: events.asObservable(), configurable: true });
    fixture.detectChanges(); // runs ngOnInit → subscribes to router.events

    cmp.toggleDrawer();
    expect(cmp.drawerOpen()).toBe(true);
    events.next(new NavigationEnd(1, '/settings/spaces', '/settings/spaces'));
    expect(cmp.drawerOpen()).toBe(false);
  });

  it('loads the caller\'s personal views once, for every page under it (Q-531)', () => {
    // The Brain, Files and Graph pages and Settings > Tokens read the ViewsStore and none of them loads it: a page that did would ask
    // again on every visit, and one that did not would show no views. The shell is the one place all of them sit under.
    const { fixture } = make();
    fixture.detectChanges();
    TestBed.inject(HttpTestingController).expectOne(r => r.method === 'GET' && r.url === '/api/views');
  });
});
