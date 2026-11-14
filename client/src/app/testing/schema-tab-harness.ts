/**
 * The Schema tab mounted through the whole settings pop-up, over the REAL `SpacesApi` / `SchemaApi` / `AuthApi` on a fake HTTP
 * backend: what the operator sees, and what goes over the wire.
 *
 * Written in `space-schema-tab.rules.spec.ts`; the type-history specs of bundle-268 are the second site, so it is a module. It answers
 * the reads the tab and its neighbours always make (the token, the layers, the library, the Brain stats) and leaves every other
 * request, the versions door included, pending for the test to answer: a spec that is not about the type list's history reads is
 * not answered for them, so it cannot pass by a canned answer it never asked for.
 */
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { expect, vi } from 'vitest';
import { ToastService } from '../core/toast.service';
import { ConfirmDialogService } from '../core/confirm-dialog.service';
import type { KNOWLEDGE_TYPES, Space } from '../core/api.types';
import { getTranslocoModule } from './transloco-testing';
import { SpaceSettingsPopupComponent } from '../pages/settings/space-settings-popup.component';
import { SpaceSettingsState } from '../pages/settings/space-settings-state.service';
import { SpacesStore } from '../pages/settings/spaces-store.service';

export interface SchemaTabMountOptions {
  /** The space the pop-up opens on; its id names every read. */
  space: Space;
  /** What `GET /api/tokens/me` answers as `rights`. */
  rights: unknown;
  /** `GET /api/spaces/:id/schema-layers`; none by default. */
  layers?: unknown;
  /** `GET /api/schema-library` entries; none by default. */
  library?: unknown[];
  /** Extra `en` words; every other key echoes. */
  translation?: Record<string, string>;
}

export async function mountSchemaTab(opts: SchemaTabMountOptions) {
  const spaceId = opts.space.id;
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [SpaceSettingsPopupComponent, getTranslocoModule({ translation: { en: opts.translation ?? {} } })],
    providers: [
      provideHttpClient(), provideHttpClientTesting(),
      SpaceSettingsState, SpacesStore,
      { provide: ToastService, useValue: { show: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn() } },
      { provide: ConfirmDialogService, useValue: { confirm: () => Promise.resolve(true) } },
    ],
  });
  const http = TestBed.inject(HttpTestingController);
  const fixture = TestBed.createComponent(SpaceSettingsPopupComponent);
  // Attached to the document: `document.activeElement` is meaningless for a detached tree.
  document.body.appendChild(fixture.nativeElement);
  const state = fixture.componentInstance.state;

  /** Answers the reads the tab and its neighbours make; leaves every write (and any read it does not know) for the test. */
  const answers: Record<string, unknown> = {
    '/api/tokens/me': { id: 't1', name: 'token', rights: opts.rights },
    [`/api/spaces/${spaceId}/schema-layers`]: opts.layers ?? { spaceId, own: {}, layers: [], precedence: [], clashes: [] },
    '/api/schema-library': { entries: opts.library ?? [] },
    [`/api/brain/spaces/${spaceId}/stats`]: { spaceId, facts: 0, entities: 0, edges: 0, chrono: 0, files: 0 },
  };
  const flushReads = () => {
    for (const req of http.match(r => r.method === 'GET' && r.url.split('?')[0]! in answers)) req.flush(answers[req.request.url.split('?')[0]!] as never);
  };
  /** Let change detection, deferred blocks and the reads they issued run to rest. */
  const settle = async (until?: () => boolean): Promise<void> => {
    const pass = async (): Promise<void> => {
      fixture.detectChanges();
      flushReads();
      await fixture.whenStable();
      fixture.detectChanges();
    };
    if (!until) { await pass(); return; }
    // Real timers here, so the condition is polled by vitest's own wait; it throws naming the wait when it never holds.
    await vi.waitFor(async () => {
      await pass();
      if (!until()) throw new Error('settle: the awaited state never rendered');
    }, { timeout: 5_000, interval: 50 });
  };

  state.openSettings(opts.space);
  state.settingsTab.set('schema');
  const el = fixture.nativeElement as HTMLElement;
  // The tab sits in a deferred block with a minimum loading time, so wait for IT rather than for a fixed moment.
  await settle(() => !!el.querySelector('.sch-validation-bar'));
  // Once more, so what the reads issued by the first pass answered (the token's rights, the layers) has rendered.
  await settle();
  return { fixture, state, http, el, settle };
}

export type SchemaTabHarness = Awaited<ReturnType<typeof mountSchemaTab>>;

export const $ = (root: ParentNode, sel: string): HTMLElement | null => root.querySelector<HTMLElement>(sel);
export const $$ = (root: ParentNode, sel: string): HTMLElement[] => Array.from(root.querySelectorAll<HTMLElement>(sel));

/** The type pane (`.sch-detail`) with one type selected, clicked as an operator does (the tab is OnPush). */
export async function selectSchemaType(h: SchemaTabHarness, kt: (typeof KNOWLEDGE_TYPES)[number], name: string): Promise<HTMLElement> {
  h.state.schemaCollTab.set(kt);
  await h.settle();
  const item = $$(h.el, '.sch-type-item').find(i => $(i, '.nm')?.textContent?.trim() === name);
  expect(item, `the type list has no "${name}"`).toBeDefined();
  item!.click();
  await h.settle();
  const pane = $(h.el, '.sch-detail');
  expect(pane, 'the type pane did not render').not.toBeNull();
  return pane!;
}
