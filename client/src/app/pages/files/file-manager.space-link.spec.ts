/**
 * The standalone Files page opens `?space=`, says when it cannot, and never falls back silently (Q-531, plan rev 3.2 "Client": "The Brain,
 * Graph and Files pages accept `?space=@name`; an id not in the list shows a notice instead of silently falling back").
 *
 * ## The rules
 *
 * 1. A space of the list opens, and nothing is said.
 * 2. An id that is neither a space nor an own view (a deleted space, a typo, a former proxy id, another token's view) opens the first space and
 *    SAYS so, naming the id; it used to land there without a word.
 * 3. A link to a view waits for the views list, and opens the view once it is there, as a view (the page's one `isView` flag is true).
 *
 * The page is embedded in the Brain everywhere it is routed today, so this standalone path has no route; the rule is held where it lives.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { of } from 'rxjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute } from '@angular/router';
import { SpacesApi } from '../../core/spaces-api.service';
import { AuthService } from '../../core/auth.service';
import { ViewsStore } from '../../core/views.store';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { CLIENT_ROOT } from '../../testing/tracked-sources';
import { VIEW_LENS, flushViews } from '../../testing/personal-views';
import { FileManagerComponent } from './file-manager.component';

const EN: Record<string, string> = JSON.parse(readFileSync(resolve(CLIENT_ROOT, 'public/assets/i18n/en.json'), 'utf8'));

function open(space: string) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [FileManagerComponent, getTranslocoModule({ translation: { en: EN } })],
    providers: [
      provideHttpClient(), provideHttpClientTesting(),
      { provide: SpacesApi, useValue: { listSpaces: () => of({ spaces: [{ id: 'qa', label: 'qa' }, { id: 'ops', label: 'ops' }] }) } },
      { provide: AuthService, useValue: { token: () => 't' } },
      { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: (k: string) => (k === 'space' ? space : null) } }, queryParamMap: of() } },
    ],
  });
  const fixture = TestBed.createComponent(FileManagerComponent);
  fixture.detectChanges();
  const http = TestBed.inject(HttpTestingController);
  /** Answer whatever the page asked (listings, trees, stats) with an empty answer: the subject here is which space it opened. */
  const settle = () => { for (const r of http.match(req => !/\/api\/views/.test(req.url))) r.flush({ entries: [], results: [], total: 0 }); fixture.detectChanges(); };
  return { fixture, c: fixture.componentInstance as any, el: fixture.nativeElement as HTMLElement, http, settle };
}

const notice = (el: HTMLElement) => el.querySelector('[role="status"].alert')?.textContent ?? '';

describe('the standalone Files page and ?space= (Q-531)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('opens a space of the list and says nothing', () => {
    const { c, el, settle } = open('ops');
    settle();
    expect(c.activeSpaceId()).toBe('ops');
    expect(notice(el)).toBe('');
  });

  it('an id that is neither a space nor a view of the caller opens the first space and says so, naming the id', () => {
    const { c, el, settle } = open('ghost');
    settle();
    expect(c.activeSpaceId()).toBe('qa');
    expect(notice(el)).toContain('ghost');
    expect(notice(el)).toContain('qa');
  });

  it('a link to a view waits for the views list, then opens the view as a view', () => {
    const { c, el, http, settle } = open('@lens');
    settle();
    expect(c.activeSpaceId(), 'opened something before the views list had arrived').toBe('');
    TestBed.inject(ViewsStore).load();
    flushViews(http, [VIEW_LENS]);
    TestBed.tick();
    settle();
    expect(c.activeSpaceId()).toBe('@lens');
    expect(c.isView()).toBe(true);
    expect(notice(el)).toBe('');
  });

  it('a link to a view the caller does not hold is said, once the list has arrived', () => {
    const { c, el, http, settle } = open('@theirs');
    TestBed.inject(ViewsStore).load();
    flushViews(http, [VIEW_LENS]);
    TestBed.tick();
    settle();
    expect(c.activeSpaceId()).toBe('qa');
    expect(notice(el)).toContain('@theirs');
  });
});
