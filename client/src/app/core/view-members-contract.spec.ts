/**
 * The client sends and reads a view's `members` in the server's own shape, the wildcard included (Q-531, bundle-100 lens W).
 *
 * ## The rule
 *
 * The server parses `members` with `ViewMembersInput` (`server/src/config/view-shape.ts`): a LIST of strings, the wildcard being
 * `[WILDCARD_MEMBER]`. This spec takes the schema and the wildcard FROM that module, so the client is held to what the server parses,
 * not to a literal the two sides could each spell their own way:
 *
 * 1. **What the create dialog sends** for "every space I can read" parses against the server's schema and is the wildcard list.
 * 2. **What the page reads** - a view the server answers with the wildcard list - is shown as "every space", not as a view listing a
 *    space named `*`.
 *
 * ## Seen red at a4a1043d
 *
 * The dialog sent `members: '*'` (a string), which the server refuses as `400 view_members_empty`, so creating an "all spaces" view
 * always failed; the store's spec asserted the same wrong shape, so every test passed. The reads-from line tested `members === '*'` and
 * read the server's `['*']` as a list of one space.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getTranslocoModule } from '../testing/transloco-testing';
import { CLIENT_ROOT } from '../testing/tracked-sources';
import { ViewCreateDialogComponent } from '../pages/brain/view-create-dialog.component';
import { ViewReadsFromComponent } from '../pages/brain/view-reads-from.component';

const SPACES = [{ id: 'qa', label: 'Quality' }, { id: 'ops', label: 'Operations' }];

// The server module is READ, not imported: the client compiles only its own tree (tsconfig rootDir), as the other specs that hold the client
// to server source do. Both facts are taken from that module's own text, with a floor so a renamed export fails here instead of passing.
const VIEW_SHAPE = readFileSync(resolve(CLIENT_ROOT, '../server/src/config/view-shape.ts'), 'utf8');
const WILDCARD_MEMBER = /export const WILDCARD_MEMBER = '([^']+)'/.exec(VIEW_SHAPE)?.[1];
const MEMBERS_ARE_A_LIST = /export const ViewMembersInput = z\.array\(z\.string\(\)\)\.min\(1\)/.test(VIEW_SHAPE);
const ViewMembersInput = {
  safeParse: (v: unknown) => ({ success: Array.isArray(v) && v.length >= 1 && v.every(m => typeof m === 'string') }),
};

it('the server module still states the wildcard and a list-of-strings members schema', () => {
  expect(WILDCARD_MEMBER, 'WILDCARD_MEMBER not found in server/src/config/view-shape.ts').toBeTruthy();
  expect(MEMBERS_ARE_A_LIST, 'ViewMembersInput is no longer z.array(z.string()).min(1)').toBe(true);
});

describe('a view\'s members travel in the server\'s shape (Q-531)', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => { try { TestBed.inject(HttpTestingController).verify(); } catch { /* never made */ } });

  it('the create dialog sends "every space" as the wildcard list the server\'s schema parses', async () => {
    TestBed.configureTestingModule({
      imports: [ViewCreateDialogComponent, getTranslocoModule()],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    const fixture = TestBed.createComponent(ViewCreateDialogComponent);
    fixture.componentRef.setInput('spaces', SPACES);
    fixture.detectChanges();
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const name = root.querySelector<HTMLInputElement>('input[name="name"]')!;
    name.value = 'everything';
    name.dispatchEvent(new Event('input'));
    const all = root.querySelector<HTMLInputElement>('input[type="radio"][value="all"]')!;
    all.click();
    fixture.detectChanges();
    await fixture.whenStable();
    root.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit'));
    const req = TestBed.inject(HttpTestingController).expectOne(r => r.method === 'POST' && r.url === '/api/views');
    const sent = (req.request.body as { members: unknown }).members;
    expect(ViewMembersInput.safeParse(sent).success, `the server's schema refuses members ${JSON.stringify(sent)}`).toBe(true);
    expect(sent).toEqual([WILDCARD_MEMBER]);
    const clientApi = await import('./views-api.service') as { WILDCARD_MEMBER?: unknown };
    expect(clientApi.WILDCARD_MEMBER, 'the client\'s wildcard is not the server\'s').toBe(WILDCARD_MEMBER);
    req.flush({ view: { id: '@everything', name: 'everything', members: [WILDCARD_MEMBER], readable: ['qa'] } });
  });

  it('a view the server answers with the wildcard list reads as "every space", naming what it reads now', () => {
    TestBed.configureTestingModule({ imports: [ViewReadsFromComponent, getTranslocoModule()] });
    const fixture = TestBed.createComponent(ViewReadsFromComponent);
    fixture.componentRef.setInput('view', { id: '@everything', name: 'everything', members: [WILDCARD_MEMBER], readable: ['qa', 'ops'] });
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('views.readsFromAll');
    expect(text, 'the wildcard was shown as a member the caller cannot read').not.toContain('views.dropped');
  });
});
