/**
 * The drawer's "Type definition" row (design r4 §7.7, §5.3, test C3), mounted alone over the REAL `SchemaApi` on a fake HTTP backend.
 *
 * ## The contract this spec fixes for the build (chosen here and listed in the hand-off)
 *
 * - `RecordTypeDefinitionComponent` in `record-type-definition.component.ts`, selector `app-record-type-definition`, inputs
 *   `spaceId`, `kind`, `type`, `fp` (the record's `schemaFingerprint`; absent for a record with no stamp), output `compare`
 *   emitting the rep of the record's definition (the host opens the history with it chosen).
 * - It renders `[data-testid="type-definition-row"]` holding the label, the state line, a "?" toggle, and when they apply
 *   `type-definition-compare` and `type-definition-check-again`.
 * - It asks `GET /api/spaces/:id/schema-versions?fps=<fp>&kind=&type=`, one stamp, and nothing for a record with no stamp.
 * - A 403 hides the row, and every later row in the session asks nothing and shows nothing (r4 §7.7).
 *
 * ## Seen red
 *
 * Red on 327b105e: `./record-type-definition.component` does not exist.
 */
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { DateFormatService } from '../../core/date-format.service';
import { RecordTypeDefinitionComponent } from './record-type-definition.component';

const spell = (v: unknown): string => `«${String(v).slice(0, 10).replace(/\d/g, d => 'abcdefghij'[+d]!)}»`;
const dates = {
  format: vi.fn((v: unknown) => spell(v)), transform: vi.fn((v: unknown) => spell(v)),
  parts: vi.fn((v: unknown) => ({ date: spell(v), time: '', iso: '' })), calendarDate: vi.fn((v: unknown) => spell(v)),
  relative: vi.fn((v: unknown) => spell(v)), iso: vi.fn((v: unknown) => spell(v)),
  options: () => ({ style: 'auto', zone: 'local', locale: 'en' }),
};
const EN = {
  'brain.drawer.typeDefinition.older': 'Older (from {{since}})',
  'brain.drawer.typeDefinition.failed': 'Could not check: {{reason}}',
};

const FP = 'cc33dd44cc33dd44';
const CURRENT = 'ff99aa00ff99aa00';

function configure(): HttpTestingController {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [RecordTypeDefinitionComponent, getTranslocoModule({ translation: { en: EN } })],
    providers: [provideHttpClient(), provideHttpClientTesting(), { provide: DateFormatService, useValue: dates }],
  });
  return TestBed.inject(HttpTestingController);
}

interface Row { fixture: ComponentFixture<RecordTypeDefinitionComponent>; el: HTMLElement; compared: string[] }

async function row(fp: string | undefined, over: { kind?: string; type?: string } = {}): Promise<Row> {
  const fixture = TestBed.createComponent(RecordTypeDefinitionComponent);
  document.body.appendChild(fixture.nativeElement);
  fixture.componentRef.setInput('spaceId', 'work');
  fixture.componentRef.setInput('kind', over.kind ?? 'entity');
  fixture.componentRef.setInput('type', over.type ?? 'person');
  fixture.componentRef.setInput('fp', fp);
  const compared: string[] = [];
  (fixture.componentInstance as unknown as { compare: { subscribe(f: (v: unknown) => void): void } }).compare.subscribe(v => compared.push(String(v)));
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement, compared };
}
const settle = async (r: Row) => { r.fixture.detectChanges(); await r.fixture.whenStable(); r.fixture.detectChanges(); };

function reads(http: HttpTestingController): { req: TestRequest; p: Record<string, string> }[] {
  return http.match(r => r.method === 'GET' && r.url.split('?')[0] === '/api/spaces/work/schema-versions').map(req => {
    const p: Record<string, string> = {};
    for (const k of req.request.params.keys()) p[k] = req.request.params.get(k)!;
    const q = req.request.urlWithParams.split('?')[1];
    if (q) for (const [k, v] of new URLSearchParams(q)) p[k] = v;
    return { req, p };
  });
}
async function answer(http: HttpTestingController, r: Row, body: unknown, status = 200): Promise<void> {
  const out = reads(http);
  expect(out.length, 'the row did not ask for its standing').toBe(1);
  expect(out[0]!.p).toEqual({ fps: FP, kind: 'entity', type: 'person' });
  if (status === 200) out[0]!.req.flush(body as never); else out[0]!.req.flush(body as never, { status, statusText: 'x' });
  await settle(r);
}
const standing = (s: string, definition?: unknown) => ({ kind: 'entity', type: 'person', current: CURRENT, standings: [{ fp: FP, standing: s, ...(definition ? { definition } : {}) }] });
const $ = (root: ParentNode, sel: string) => root.querySelector<HTMLElement>(sel);
const rowText = (r: Row) => $(r.el, '[data-testid="type-definition-row"]')?.textContent ?? null;

afterEach(() => { document.body.innerHTML = ''; });

describe('the drawer\'s Type definition row (C3)', () => {
  it('a record with no stamp reads No version, and no call is made', async () => {
    const http = configure();
    const r = await row(undefined);
    expect(rowText(r)).toContain('brain.drawer.typeDefinition.none');
    expect(reads(http)).toEqual([]);
  });

  it('says Checking while the one-stamp read is out, then Current for a stamp the same as current', async () => {
    const http = configure();
    const r = await row(FP);
    expect(rowText(r)).toContain('brain.drawer.typeDefinition.checking');
    await answer(http, r, standing('current', { rep: CURRENT, since: '2026-11-03T08:00:00.000Z' }));
    expect(rowText(r)).toContain('brain.drawer.typeDefinition.current');
    expect(rowText(r)).not.toContain('brain.drawer.typeDefinition.checking');
    expect($(r.el, '[data-testid="type-definition-compare"]')).toBeNull();
  });

  it('an older stamp reads "Older (from {since})" with Compare, which emits the definition\'s rep', async () => {
    const http = configure();
    const r = await row(FP);
    await answer(http, r, standing('older', { rep: 'aa11bb22aa11bb22', since: '2026-10-21T08:00:00.000Z', until: '2026-11-03T08:00:00.000Z' }));
    expect(rowText(r)).toContain('Older (from «cacg-ba-cb»)');
    const compare = $(r.el, '[data-testid="type-definition-compare"]');
    expect(compare?.tagName).toBe('BUTTON');
    compare!.click();
    expect(r.compared).toEqual(['aa11bb22aa11bb22']);
  });

  for (const s of ['notHeld', 'unclassified', 'aStandingFromANewerRelease']) {
    it(`a stamp standing ${s} reads Cannot tell, with no Compare`, async () => {
      const http = configure();
      const r = await row(FP);
      await answer(http, r, standing(s));
      expect(rowText(r)).toContain('brain.drawer.typeDefinition.cannotTell');
      expect($(r.el, '[data-testid="type-definition-compare"]')).toBeNull();
    });
  }

  it('a failed read says "Could not check: {reason}", and Check again asks again', async () => {
    const http = configure();
    const r = await row(FP);
    await answer(http, r, { error: 'boom' }, 500);
    expect(rowText(r)).toContain('Could not check: common.reason.noAnswer');
    $(r.el, '[data-testid="type-definition-check-again"]')!.click();
    await settle(r);
    await answer(http, r, standing('current'));
    expect(rowText(r)).toContain('brain.drawer.typeDefinition.current');
  });

  it('a 403 hides the row, and the next row of the session asks nothing and shows nothing', async () => {
    const http = configure();
    const first = await row(FP);
    await answer(http, first, { error: 'no', code: 'forbidden' }, 403);
    expect($(first.el, '[data-testid="type-definition-row"]')).toBeNull();
    const second = await row(FP);
    expect(reads(http)).toEqual([]);
    expect($(second.el, '[data-testid="type-definition-row"]')).toBeNull();
  });

  it('its help is closed by default behind "?" and opens through aria-expanded with the four state lines', async () => {
    const http = configure();
    const r = await row(FP);
    await answer(http, r, standing('current'));
    const toggle = Array.from(r.el.querySelectorAll<HTMLElement>('button[aria-expanded]'))[0];
    expect(toggle, 'no "?" toggle').toBeDefined();
    expect(toggle!.getAttribute('aria-expanded')).toBe('false');
    const box = document.getElementById(toggle!.getAttribute('aria-controls') ?? '');
    expect(box?.hidden).toBe(true);
    toggle!.click();
    await settle(r);
    expect(box!.hidden).toBe(false);
    for (const k of ['current', 'older', 'none', 'cannotTell']) expect(box!.textContent).toContain(`brain.drawer.typeDefinition.help.${k}`);
  });
});
