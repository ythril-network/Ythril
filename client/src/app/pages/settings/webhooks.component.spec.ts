/**
 * C1 — WebhooksComponent create/edit payload shaping (the security-relevant bits).
 *
 * - "Subscribe to all events" / "All spaces" send empty arrays (server semantics for "everything").
 * - The write-only secret is sent ONLY when the user typed one — on edit, a blank field must NOT send
 *   a secret (the server never returns it, so blank means "keep the existing one").
 * - The page stays OnPush.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi } from 'vitest';
import { of } from 'rxjs';
import { TranslocoService, TranslocoTestingModule } from '@jsverse/transloco';
import { AdminApi } from '../../core/admin-api.service';
import { SpacesApi } from '../../core/spaces-api.service';
import { ToastService } from '../../core/toast.service';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { WebhooksComponent } from './webhooks.component';
import type { WebhookSubscription } from '../../core/api.types';
import { isOnPush } from '../../testing/onpush';

function webhook(over: Partial<WebhookSubscription> = {}): WebhookSubscription {
  return {
    id: 'w1', url: 'https://x.example.com/h', spaces: [], events: [], enabled: true,
    createdAt: '', updatedAt: '', status: 'active', consecutiveFailures: 0, ...over,
  };
}

describe('WebhooksComponent — payload shaping (C1)', () => {
  let admin: { createWebhook: any; updateWebhook: any; listWebhooks: any };

  function create() {
    admin = {
      listWebhooks: vi.fn(() => of({ webhooks: [] })),
      createWebhook: vi.fn(() => of(webhook())),
      updateWebhook: vi.fn(() => of(webhook())),
    };
    TestBed.configureTestingModule({
      imports: [WebhooksComponent, getTranslocoModule()],
      providers: [
        { provide: AdminApi, useValue: admin },
        { provide: SpacesApi, useValue: { listSpaces: () => of({ spaces: [] }) } },
        { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
        { provide: ConfirmDialogService, useValue: { confirm: vi.fn(() => Promise.resolve(true)) } },
      ],
    });
    return TestBed.createComponent(WebhooksComponent).componentInstance;
  }

  it('is OnPush', () => {
    expect(isOnPush(WebhooksComponent)).toBe(true);
  });

  it('create with "all events"/"all spaces" sends empty arrays + the typed secret', () => {
    const cmp = create();
    cmp.openCreate();
    const f = cmp.form()!;
    f.url = 'https://hook.example.com/x';
    f.secret = 'longenough';
    cmp.save(f);
    expect(admin.createWebhook).toHaveBeenCalledWith({
      url: 'https://hook.example.com/x', events: [], spaces: [], enabled: true, secret: 'longenough',
    });
  });

  it('create with specific events sends exactly those', () => {
    const cmp = create();
    cmp.openCreate();
    const f = cmp.form()!;
    f.url = 'https://hook.example.com/x';
    f.secret = 'longenough';
    f.allEvents = false;
    cmp.toggleEvent(f, 'fact.created');
    cmp.toggleEvent(f, 'entity.deleted');
    cmp.save(f);
    const body = admin.createWebhook.mock.calls[0][0];
    expect(body.events.sort()).toEqual(['entity.deleted', 'fact.created']);
  });

  it('edit with a blank secret does NOT send a secret (keeps existing)', () => {
    const cmp = create();
    cmp.openEdit(webhook({ id: 'w9', url: 'https://k.example.com' }));
    const f = cmp.form()!;
    f.enabled = false; // some other change
    cmp.save(f);
    expect(admin.updateWebhook).toHaveBeenCalledTimes(1);
    const [id, body] = admin.updateWebhook.mock.calls[0];
    expect(id).toBe('w9');
    expect('secret' in body).toBe(false);
    expect(body.enabled).toBe(false);
  });
});

/*
 * A failing webhook says when it will be probed next (bundle-119, Q-477, design rev 3 item 13): the failing pill shows "next probe
 * <time>" from the subscription's `nextProbeAt`, as text (readable without a tooltip), in the reader's language, with the time
 * formatted for that language rather than the raw ISO instant. The time is asserted by PATTERN, never by value: the rendered hour is
 * the runner's zone (pitfall-rendered-date-is-in-the-runners-zone). The phrase is read from the real dictionaries, so a key missing
 * from de or pl, or left as the English text, is red here.
 *
 * Seen red at a644fe92: the row renders no probe time at all, and no dictionary has `webhooks.nextProbe`.
 */
describe('WebhooksComponent: a failing webhook shows its next probe time (Q-477)', () => {
  const LANGS = ['en', 'de', 'pl'] as const;
  const dict = (lang: string): Record<string, string> =>
    JSON.parse(readFileSync(resolve(__dirname, `../../../../public/assets/i18n/${lang}.json`), 'utf8'));
  // In the future whatever day the suite runs (a past one reads as due, round 2 F5a; the first version's date became the past on its own day).
  const NEXT_PROBE_AT = '2099-10-23T14:37:00.000Z';
  const PAST_PROBE_AT = '2020-01-01T08:00:00.000Z';
  /** The static text of a translation, its `{{ param }}` placeholders taken out. */
  const staticParts = (text: string): string[] => text.split(/\{\{[^}]*\}\}/).map(s => s.trim()).filter(Boolean);

  async function render(lang: string, nextProbeAt = NEXT_PROBE_AT) {
    TestBed.configureTestingModule({
      imports: [
        WebhooksComponent,
        TranslocoTestingModule.forRoot({
          langs: Object.fromEntries(LANGS.map(l => [l, dict(l)])),
          translocoConfig: { availableLangs: [...LANGS], defaultLang: 'en' },
          preloadLangs: true,
        }),
      ],
      providers: [
        { provide: AdminApi, useValue: { listWebhooks: vi.fn(() => of({ webhooks: [
          webhook({ id: 'wf', status: 'failing', consecutiveFailures: 6, nextProbeAt, probeAttempts: 2 } as Partial<WebhookSubscription>),
        ] })) } },
        { provide: SpacesApi, useValue: { listSpaces: () => of({ spaces: [] }) } },
        { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
        { provide: ConfirmDialogService, useValue: { confirm: vi.fn(() => Promise.resolve(true)) } },
      ],
    });
    TestBed.inject(TranslocoService).setActiveLang(lang);
    const fixture = TestBed.createComponent(WebhooksComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const row = [...(fixture.nativeElement as HTMLElement).querySelectorAll('tr')].find(tr => tr.textContent?.includes('x.example.com'));
    return (row?.textContent ?? '').replace(/\s+/g, ' ');
  }

  for (const lang of LANGS) {
    it(`${lang}: the failing row says "next probe" and a time formatted for ${lang}, as text`, async () => {
      const text = await render(lang);
      expect(text, 'fixture: the failing webhook row did not render').toContain(dict(lang)['webhooks.status.failing']);
      // A clock time, whatever zone the runner is in: H:MM or HH:MM (en may add AM/PM; de and pl do not).
      expect(text, `the failing row shows no next probe time: "${text}"`).toMatch(/\b\d{1,2}[:.]\d{2}\b/);
      expect(text, 'the next probe time is the raw ISO instant, not a time formatted for the reader').not.toContain(NEXT_PROBE_AT);
      if (lang !== 'en') expect(text, `a ${lang} time is written with AM/PM`).not.toMatch(/\b(AM|PM)\b/);
      const phrase = dict(lang)['webhooks.nextProbe'];
      expect(phrase, `public/assets/i18n/${lang}.json has no webhooks.nextProbe`).toBeTruthy();
      if (lang !== 'en') expect(phrase, `webhooks.nextProbe in ${lang} is the English text`).not.toBe(dict('en')['webhooks.nextProbe']);
      for (const part of staticParts(phrase)) expect(text, `the row does not say "${part}"`).toContain(part);
    });

    it(`${lang}: a next probe already past reads as due, never as a time in the past (round 2, F5a)`, async () => {
      const text = await render(lang, PAST_PROBE_AT);
      expect(text, 'fixture: the failing webhook row did not render').toContain(dict(lang)['webhooks.status.failing']);
      const due = dict(lang)['webhooks.probeDue'];
      expect(due, `public/assets/i18n/${lang}.json has no webhooks.probeDue`).toBeTruthy();
      if (lang !== 'en') expect(due, `webhooks.probeDue in ${lang} is the English text`).not.toBe(dict('en')['webhooks.probeDue']);
      expect(text, `a past next probe does not read as due: "${text}"`).toContain(due);
      expect(text, `a past next probe still shows a clock time: "${text}"`).not.toMatch(/\b\d{1,2}[:.]\d{2}\b/);
    });
  }
});
