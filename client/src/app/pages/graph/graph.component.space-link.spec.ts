/**
 * The standalone Graph page opens `?space=`, says when it cannot, and never falls back silently (Q-531, plan rev 3.2 "Client": "The Brain, Graph
 * and Files pages accept `?space=@name`; an id not in the list shows a notice instead of silently falling back").
 *
 * ## The rules
 *
 * 1. A space of the list opens, and nothing is said.
 * 2. An id that is neither a space nor an own view opens the first space and SAYS so, naming the id. The page used to take ANY `?space=` as the
 *    open space (a deleted one, a typo, a former proxy id) and fail on its first read, with nothing said about why.
 * 3. A link to a view waits for the views list, then opens the view.
 *
 * Embedded in the Brain (its only routed use today) the page is handed its space and never reads the link, so this path has no route; the rule
 * is held where it lives. The spec's words are the shipped English: the harness's echo of a key would not carry the id.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ActivatedRoute } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

vi.mock('cytoscape', () => {
  const chain: any = new Proxy(() => chain, { get: () => () => chain });
  return { default: () => chain };
});

import { SpacesApi } from '../../core/spaces-api.service';
import { BrainApi } from '../../core/brain-api.service';
import { AuthApi } from '../../core/auth-api.service';
import { ViewsStore } from '../../core/views.store';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { CLIENT_ROOT } from '../../testing/tracked-sources';
import { VIEW_LENS, flushViews } from '../../testing/personal-views';
import { GraphComponent } from './graph.component';

const EN: Record<string, string> = JSON.parse(readFileSync(resolve(CLIENT_ROOT, 'public/assets/i18n/en.json'), 'utf8'));

function open(space: string, metaAsked: string[] = []) {
  const api = {
    getMe: () => of({ readOnly: false }),
    listSpaces: () => of({ spaces: [{ id: 'qa', label: 'qa' }, { id: 'ops', label: 'ops' }] }),
    getSpaceMeta: (id: string) => { metaAsked.push(id); return of({ typeSchemas: {} }); },
  } as any;
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [GraphComponent, getTranslocoModule({ translation: { en: EN } })],
    providers: [
      provideHttpClient(), provideHttpClientTesting(),
      { provide: SpacesApi, useValue: api }, { provide: BrainApi, useValue: api }, { provide: AuthApi, useValue: api },
      { provide: ActivatedRoute, useValue: { snapshot: { queryParams: { space } } } },
    ],
  });
  const fixture = TestBed.createComponent(GraphComponent);
  fixture.detectChanges();
  return { fixture, c: fixture.componentInstance as any, el: fixture.nativeElement as HTMLElement };
}

const notice = (el: HTMLElement) => el.querySelector('[role="status"].alert')?.textContent ?? '';

describe('the standalone Graph page and ?space= (Q-531)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('opens a space of the list and says nothing', () => {
    const { fixture, c, el } = open('ops');
    fixture.detectChanges();
    expect(c.activeSpaceId()).toBe('ops');
    expect(notice(el)).toBe('');
  });

  it('an id that is neither a space nor a view of the caller opens the first space and says so, naming the id', () => {
    const { fixture, c, el } = open('team');
    fixture.detectChanges();
    expect(c.activeSpaceId()).toBe('qa');
    expect(notice(el)).toContain('team');
  });

  it('a link to a view waits for the views list, then opens the view', () => {
    const { fixture, c, el } = open('@lens');
    expect(c.activeSpaceId(), 'opened something before the views list had arrived').toBe('');
    TestBed.inject(ViewsStore).load();
    flushViews(TestBed.inject(HttpTestingController), [VIEW_LENS]);
    TestBed.tick();
    fixture.detectChanges();
    expect(c.activeSpaceId()).toBe('@lens');
    expect(notice(el)).toBe('');
  });

  // Found by the Q-531 verify probe (2026-10-21): the Graph tab on a view asked GET /api/spaces/@team/meta and got 404 - a view has no meta of
  // its own (plan "Client": config reads are not available for a personal view), so the page must not ask, as the Brain page already does not.
  it('a view asks for no space meta, a space does', () => {
    const asked: string[] = [];
    const { fixture } = open('@lens', asked);
    TestBed.inject(ViewsStore).load();
    flushViews(TestBed.inject(HttpTestingController), [VIEW_LENS]);
    TestBed.tick();
    fixture.detectChanges();
    expect(asked, `the Graph page asked a view's meta: ${JSON.stringify(asked)}`).not.toContain('@lens');
    const control: string[] = [];
    open('ops', control).fixture.detectChanges();
    expect(control, 'a space still loads its meta').toContain('ops');
  });
});
