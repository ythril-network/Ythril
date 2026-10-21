/**
 * Settings > Tokens offers "Copy views to this token" to a token manager only, and shows the name a collision gave the copy (Q-531,
 * bundle-100, owner ruling 0050bb1e "a caller who may manage another token may give that token a COPY"; plan rev 3.2 "Client":
 * "Copy: in Settings > Tokens (token managers only, the same guard), a 'Copy views to this token' control with a token's view
 * picker; collision rename shown").
 *
 * ## The contract (see `testing/personal-views.ts`)
 *
 * `TokenViewCopyComponent` (`pages/settings/token-view-copy.component.ts`, selector `app-token-view-copy`), inputs `targetTokenId`
 * and `mayManage`; `copy(viewId)` sends `POST /api/views/<id>/copy {toTokenId}`; the caller's views come from the ViewsStore.
 *
 * ## The rules
 *
 * 1. **Managers only.** Without `mayManage` the control renders no button, select or checkbox, and asks nothing of the server: a
 *    control the server would refuse (403) is not offered.
 * 2. **The copy is sent for the target token**, and **a collision rename is shown**: when the answer's view id differs from the
 *    source's (`@lens` landed as `@lens-2`), the new name is on screen, so the manager knows what the receiver will see.
 * 3. **The Tokens page renders the control** (some component of the tokens page uses `<app-token-view-copy`).
 *
 * ## Seen red at 18e8d598
 *
 * `token-view-copy.component.ts` does not exist and no tokens component renders it.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { CLIENT_ROOT, trackedAppSources } from '../../testing/tracked-sources';
import { VIEW_LENS, flushViews, importNew } from '../../testing/personal-views';

async function make(mayManage: boolean) {
  const { TokenViewCopyComponent } = await importNew<{ TokenViewCopyComponent: unknown }>('../pages/settings/token-view-copy.component');
  TestBed.configureTestingModule({
    imports: [TokenViewCopyComponent as never, getTranslocoModule()],
    providers: [provideHttpClient(), provideHttpClientTesting()],
  });
  const fixture = TestBed.createComponent(TokenViewCopyComponent as never);
  fixture.componentRef.setInput('targetTokenId', 'tok-b');
  fixture.componentRef.setInput('mayManage', mayManage);
  fixture.detectChanges();
  const http = TestBed.inject(HttpTestingController);
  if (flushViews(http, [VIEW_LENS]) === 0 && mayManage) {
    const { ViewsStore } = await importNew<{ ViewsStore: unknown }>('../core/views.store');
    (TestBed.inject(ViewsStore as never) as { load: () => unknown }).load();
    flushViews(http, [VIEW_LENS]);
  }
  fixture.detectChanges();
  return { fixture, http, el: fixture.nativeElement as HTMLElement, c: fixture.componentInstance as any };
}

describe('Copy views to this token (Q-531)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders no control and asks nothing for a caller who may not manage the token', async () => {
    const { el, http } = await make(false);
    expect(el.querySelectorAll('button, select, input').length, 'a non-manager is offered the copy control').toBe(0);
    http.expectNone(r => /\/copy$/.test(r.url));
  });

  it('copies for the target token and shows the name a collision gave the copy', async () => {
    const { fixture, http, el, c } = await make(true);
    expect(el.textContent ?? '', 'the manager is not shown the views to copy').toContain('lens');
    c.copy('@lens');
    const req = http.expectOne(r => r.method === 'POST' && /\/api\/views\/(?:%40|@)lens\/copy$/.test(r.url));
    expect(req.request.body).toEqual({ toTokenId: 'tok-b' });
    req.flush({ view: { id: '@lens-2', name: 'lens-2', members: ['qa', 'ops'] } });
    fixture.detectChanges();
    expect(el.textContent ?? '', 'the collision rename is not shown').toContain('lens-2');
  });

  it('the Tokens page renders the control', () => {
    const tokenPage = trackedAppSources().filter(f => /^src\/app\/pages\/settings\/(?:tokens?|token-)[\w-]*\.component\.ts$/.test(f));
    expect(tokenPage.length, 'no tokens-page component found: the derivation is broken').toBeGreaterThanOrEqual(3);
    const hosts = tokenPage.filter(f => readFileSync(resolve(CLIENT_ROOT, f), 'utf8').includes('<app-token-view-copy'));
    expect(hosts, 'no component of the Tokens page renders <app-token-view-copy>').not.toEqual([]);
  });
});
