/**
 * The Brain page lists the caller's personal views, opens one by `?space=@name`, says what it reads, and never falls back silently
 * (Q-531, bundle-100, plan rev 3.2 "Client", ux S1-S10 and a11y S1-S6).
 *
 * ## The rules
 *
 * 1. **My views** on the Brain page lists the caller's own views from the ViewsStore, each with a VISIBLE marker naming it a personal
 *    view (text, not an `aria-label` on an empty span - a sighted user and a screen reader get the same word).
 * 2. **`?space=@name`** opens that view: the page's active id is the view, and its one `isView` flag is true.
 * 3. **An unknown `?space=`** shows a notice naming the id (role `status` or `alert`) instead of silently landing on the first space.
 *    That fixes the existing silent fallback too, so it is held with a plain space id.
 * 4. **Reads from**: on a view the page says "Reads from:" with the members the caller can read NOW, joined by the list formatter
 *    (`qa and ops`), and names the member it dropped in words. A view with no readable member has its own sentence, never an empty
 *    "Reads from:".
 * 5. **Config panels** (meta, completeness, schema, layers, activity, token access) say "Not available for a personal view" on a view.
 *
 * The translations are the real `en.json`: the words are part of the rule (plan rev 3.2 "The feature's word").
 *
 * ## Seen red at 18e8d598
 *
 * No ViewsStore and no My views: `GET /api/views` is never asked, `?space=@lens` lands on `qa`, an unknown id falls back silently,
 * and no "Reads from:" or "Not available for a personal view" exists in `en.json`.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { BehaviorSubject, of } from 'rxjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { SpacesApi } from '../../core/spaces-api.service';
import { BrainApi } from '../../core/brain-api.service';
import { FilesApi } from '../../core/files-api.service';
import { AdminApi } from '../../core/admin-api.service';
import { NetworksApi } from '../../core/networks-api.service';
import { AuthService } from '../../core/auth.service';
import { formatList } from '../../core/list-format';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { CLIENT_ROOT } from '../../testing/tracked-sources';
import { VIEW_LENS, VIEW_EMPTY, PERSONAL_VIEW_WORD, NOT_FOR_A_VIEW, flushViews, importNew } from '../../testing/personal-views';
import { BrainComponent } from './brain.component';

const EN: Record<string, string> = JSON.parse(readFileSync(resolve(CLIENT_ROOT, 'public/assets/i18n/en.json'), 'utf8'));
const SPACES = ['qa', 'ops'];

/** Read-only stub of every API the page's init cascade asks (as `brain.component.spec.ts`). */
function makeApi() {
  return {
    listSpaces: () => of({ spaces: SPACES.map(id => ({ id, label: id })) }),
    getSpaceStats: () => of({ facts: 0, entities: 0, edges: 0, chrono: 0, files: 0 }),
    getReindexStatus: () => of({ needsReindex: false }),
    getSpaceMeta: () => of({ tagSuggestions: [], typeSchemas: {} }),
    listFacts: () => of({ facts: [] }),
    getEntitiesByIds: () => of({ entities: [] }),
    mintEventsTicket: () => of({ ticket: 't', expiresInMs: 60000 }),
    getErModel: () => of({ spaceId: 'qa', entityTypes: [], relationships: [], danglingEdges: 0, truncated: null, totals: { entities: 0, edges: 0 } }),
    getAbout: () => of(null),
    getEmbeddingQueue: () => of(null),
    getTokenAccess: () => of({ tokens: [] }),
    getCompleteness: () => of(null),
    getSpaceActivity: () => of({ spaceId: 'qa', hours: 168, spaces: [] }),
    listVotes: () => of({ rounds: [] }),
  } as any;
}

/** The page, opened with `?space=<space>` (or none), its views answered with `views`. */
async function open(space: string | null, views: readonly object[] = [VIEW_LENS, VIEW_EMPTY], needViews = true) {
  const params = new BehaviorSubject(new Map<string, string>(space ? [['space', space]] : []));
  const snapshot = { queryParamMap: { get: (k: string) => params.value.get(k) ?? null } };
  TestBed.configureTestingModule({
    imports: [BrainComponent, getTranslocoModule({ translation: { en: EN } })],
    providers: [
      provideHttpClient(), provideHttpClientTesting(),
      ...[SpacesApi, BrainApi, FilesApi, AdminApi, NetworksApi].map(t => ({ provide: t, useValue: makeApi() })),
      { provide: AuthService, useValue: { token: () => '' } },
      { provide: ActivatedRoute, useValue: { snapshot, queryParamMap: params.asObservable() } },
      { provide: Router, useValue: { navigate: () => Promise.resolve(true) } },
    ],
  });
  const fixture = TestBed.createComponent(BrainComponent);
  fixture.detectChanges();
  const http = TestBed.inject(HttpTestingController);
  if (flushViews(http, views) === 0 && needViews) {
    // The store may be loaded by the shell rather than by this page; load it here so the page has views to show.
    const { ViewsStore } = await importNew<{ ViewsStore: unknown }>('../core/views.store');
    (TestBed.inject(ViewsStore as never) as { load: () => unknown }).load();
    flushViews(http, views);
  }
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, c: fixture.componentInstance as any, el: fixture.nativeElement as HTMLElement };
}

const textOf = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ');

describe('the Brain page and personal views (Q-531)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('My views lists the caller\'s views, each with a visible "personal view" marker', async () => {
    const { el } = await open(null);
    const chips = [...el.querySelectorAll('button, a, li')].filter(e => /\blens\b/.test(textOf(e)));
    expect(chips.length, 'no control on the page names the view "lens"').toBeGreaterThan(0);
    expect(chips.some(e => textOf(e).toLowerCase().includes(PERSONAL_VIEW_WORD.en)),
      'the view is not marked with the visible words "personal view"').toBe(true);
  });

  it('?space=@lens opens the view, and the page\'s isView flag says so', async () => {
    const { c } = await open('@lens');
    expect(c.activeSpaceId()).toBe('@lens');
    expect(typeof c.isView, 'the page has no isView flag').toBe('function');
    expect(c.isView()).toBe(true);
  });

  it('an id that is neither a space nor an own view shows a notice naming it, not a silent fallback', async () => {
    for (const ghost of ['ghost-space', '@ghost-view']) {
      TestBed.resetTestingModule();
      const { el } = await open(ghost, [VIEW_LENS], ghost.startsWith('@'));
      const notices = [...el.querySelectorAll('[role="status"], [role="alert"]')].map(textOf);
      expect(notices.some(t => t.includes(ghost)), `no notice names ${ghost}; notices: ${JSON.stringify(notices)}`).toBe(true);
    }
  });

  it('on a view: "Reads from:" lists the readable members by the list formatter and names the dropped one', async () => {
    const { el } = await open('@lens');
    const text = textOf(el);
    expect(text).toContain('Reads from:');
    expect(text).toContain(formatList(['qa', 'ops'], 'en'));
    const line = [...el.querySelectorAll('*')].map(textOf).filter(t => t.includes('Reads from:')).sort((a, b) => a.length - b.length)[0] ?? '';
    expect(text.includes('gone'), 'the member the caller can no longer read is not named').toBe(true);
    expect(line.includes(formatList(['qa', 'ops', 'gone'], 'en')), 'the dropped member is listed as if it were read').toBe(false);
  });

  it('a view with no readable member has its own sentence, never an empty "Reads from:"', async () => {
    const { el } = await open('@empty');
    const text = textOf(el);
    expect(text.includes('Reads from:'), 'a view that reads nothing says "Reads from:"').toBe(false);
    expect(text, 'the member it cannot read is not named').toContain('gone');
  });

  it('config panels say "Not available for a personal view" on a view', async () => {
    const { el } = await open('@lens');
    expect(textOf(el)).toContain(NOT_FOR_A_VIEW);
  });
});
