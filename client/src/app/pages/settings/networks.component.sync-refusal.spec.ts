/**
 * A refused sync trigger is said in words of the reader's language, through the toast every sibling action uses (Q-679).
 *
 * `sync()` answered any error with `{ ok: false }` in a four-second inline badge: a 503 `shutting_down` (the instance is stopping), a 401, a 403, a 404,
 * a 409 or a 429 all read as the same "failed", with neither the reason nor a lasting place to read it. The sibling actions (leave, save schedule,
 * remove member) already hand the error to `refusalText(...)` and `toast.error(...)`, which turns a code the client has words for into a sentence in
 * the active language and falls back to the server's own prose for a code it does not know. The sync trigger does the same, and so gets the same words.
 *
 * Only the refusals that can reach this door get words: `shutting_down` (new) and the ones `networks.refusal.*` already carries. `sync_failed` and
 * `sync_store_failed` are not added: the UI never waits for the cycle (it only asks for it), so they cannot arrive here.
 *
 * Red until `networks.refusal.shutting_down` exists in en, de and pl and `sync()` shows a refusal through the toast.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { NetworksApi } from '../../core/networks-api.service';
import { SpacesApi } from '../../core/spaces-api.service';
import { AdminApi } from '../../core/admin-api.service';
import { ToastService } from '../../core/toast.service';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { dictionary } from '../../testing/i18n-dictionary';
import { NetworksComponent } from './networks.component';

function make(language: 'en' | 'de' | 'pl', answer: unknown) {
  const toastError = vi.fn();
  const api = {
    listNetworks: vi.fn(() => of({ networks: [] })), listVotes: vi.fn(() => of({ rounds: [] })), listVoteOutcomes: vi.fn(() => of({ outcomes: [], total: 0 })),
    triggerSync: vi.fn(() => throwError(() => answer)), getSyncHistory: vi.fn(() => of({ history: [] })),
    getLocalAgentStatus: vi.fn(() => of({ canExecute: false })),
  } as any;
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [NetworksComponent, getTranslocoModule({ translation: { en: dictionary(language) } })],
    providers: [
      { provide: NetworksApi, useValue: api },
      { provide: SpacesApi, useValue: { listSpaces: () => of({ spaces: [] }) } },
      { provide: AdminApi, useValue: { getAbout: () => of({ publicUrl: '' }) } },
      { provide: ToastService, useValue: { error: toastError, success: vi.fn() } },
      { provide: ConfirmDialogService, useValue: { confirm: () => Promise.resolve(true) } },
    ],
  });
  return { c: TestBed.createComponent(NetworksComponent).componentInstance, toastError };
}

const refused = (status: number, code: string, prose: string) => ({ status, error: { code, error: prose } });

describe('a refused sync trigger is a sentence in the reader\'s language (Q-679)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('the key exists in en, de and pl, and de and pl are not the English sentence', () => {
    const en = dictionary('en')['networks.refusal.shutting_down'];
    expect(en, 'en').toBeTruthy();
    for (const language of ['de', 'pl'] as const) {
      const words = dictionary(language)['networks.refusal.shutting_down'];
      expect(words, language).toBeTruthy();
      expect(words, `${language} is translated`).not.toBe(en);
    }
  });

  for (const language of ['en', 'de', 'pl'] as const) {
    it(`${language}: a 503 shutting_down is toasted in that language, not as the server's English`, () => {
      const { c, toastError } = make(language, refused(503, 'shutting_down', 'Server is shutting down'));
      c.sync('n1');
      expect(toastError).toHaveBeenCalledTimes(1);
      expect(toastError.mock.calls[0]![0]).toBe(dictionary(language)['networks.refusal.shutting_down']);
    });
  }

  it('the refusals networks.refusal.* already words are toasted in words too (a 409 round_expired)', () => {
    const { c, toastError } = make('de', refused(409, 'round_expired', 'Voting closed'));
    c.sync('n1');
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError.mock.calls[0]![0]).toBe(dictionary('de')['networks.refusal.round_expired']);
  });

  it('a code the client has no words for shows the server\'s own prose, never the raw code and never a blank', () => {
    const { c, toastError } = make('en', refused(429, 'brand_new_code', 'Too many sync requests, wait a minute.'));
    c.sync('n1');
    expect(toastError).toHaveBeenCalledTimes(1);
    const said = String(toastError.mock.calls[0]![0]);
    expect(said).toContain('Too many sync requests');
    expect(said).not.toContain('brand_new_code');
  });

  it('an answer that carries nothing keeps the old result: {ok:false} for the row, so the row still says it failed', () => {
    const { c } = make('en', {});
    c.sync('n2');
    expect(c.syncResult('n2')).toEqual({ ok: false });
  });

  it('the success path is untouched: no toast', () => {
    const { c, toastError } = make('en', {});
    (TestBed.inject(NetworksApi) as any).triggerSync.mockReturnValue(of({ ok: true }));
    c.sync('n1');
    expect(toastError).not.toHaveBeenCalled();
    expect(c.syncResult('n1')).toEqual({ ok: true });
  });
});
