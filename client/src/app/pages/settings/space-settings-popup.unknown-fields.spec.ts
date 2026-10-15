/**
 * bundle-128 (design-v3 §1.1 item 5, §1.5 "vote_pending", §8.3 client specs): what the Settings dialog says, and does to the
 * list behind it, when a save of a NETWORKED space carries the instance-local `unknownWriteFields` setting together with a
 * change that needs a vote.
 *
 * ## Why this is its own case
 *
 * A networked space does not apply a `meta` change on the spot: the server opens a vote round and answers `202 vote_pending`
 * with no `space`. The new setting is NOT part of that vote (it is local to this instance and is not shared), so the server
 * applies it before it returns - design finding DI1, gated server-side by G13. Without a client half the dialog says the
 * whole save is "saved as a proposal ... takes effect once the vote passes", which is false for the setting the operator also
 * changed, and the list behind the dialog goes on showing `Warn` for a space that now refuses (the dialog's own copy cannot
 * be reloaded from a `vote_pending` answer, which carries no `space`).
 *
 * So, on a `vote_pending` answer to a save whose body carried the key:
 *  - the notice still says the meta change is waiting for the vote (it names the network),
 *  - and ALSO says the local setting took effect now,
 *  - and the store copy of the space is refreshed (patched from what was sent, or re-listed: either way the list's space
 *    carries the new value). The mock below answers `refuse` on the next list call, so both implementations are accepted.
 *
 * Real English is loaded so the sentence can be asserted; a notice that is the plain vote sentence is the red this spec wants.
 * The state field is reached through a cast (`schUnknownWriteFields`) so a missing field fails the assertion that names it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { of } from 'rxjs';
import { SpacesApi } from '../../core/spaces-api.service';
import { NetworksApi } from '../../core/networks-api.service';
import { SchemaApi } from '../../core/schema-api.service';
import { ToastService } from '../../core/toast.service';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import type { Space } from '../../core/api.types';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { SpaceSettingsPopupComponent } from './space-settings-popup.component';
import { SpaceSettingsState } from './space-settings-state.service';
import { SpacesStore } from './spaces-store.service';

const EN: Record<string, string> = JSON.parse(readFileSync(resolve(__dirname, '../../../../public/assets/i18n/en.json'), 'utf8'));

const networked = (over: Record<string, unknown> = {}): Space =>
  ({ id: 'work', label: 'Work', maxGiB: 10, networks: [{ id: 'net-a', label: 'Alpha', type: 'democratic' }], ...over }) as unknown as Space;

const LAYERS_EMPTY = { spaceId: 'work', own: {}, layers: [], precedence: [], clashes: [] };
const VOTE_PENDING = { status: 'vote_pending', rounds: [{ networkId: 'net-a', networkLabel: 'Alpha', roundId: 'r1' }], message: 'pending' };

/** Plain vote sentence, as the dialog renders it today for the same network. */
const PLAIN_NOTICE = EN['spaces.settings.votePending']!.replace(/\{\{\s*networks\s*\}\}/, 'Alpha');

/** The space as the list held it when the dialog opened (`held` is what the server keeps for the key afterwards). */
function mount(opened: Space = networked()) {
  TestBed.resetTestingModule();
  const held: { unknownWriteFields?: 'refuse' } = { ...((opened as unknown as { unknownWriteFields?: 'refuse' }).unknownWriteFields ? { unknownWriteFields: 'refuse' as const } : {}) };
  const updateSpace = vi.fn((_id: string, body: Record<string, unknown>) => {
    if (body['unknownWriteFields'] === 'refuse') held.unknownWriteFields = 'refuse';
    if (body['unknownWriteFields'] === '') delete held.unknownWriteFields;
    return of(VOTE_PENDING);
  });
  const api = {
    listSpaces: () => of({ spaces: [networked({ ...held })] }), getActivity: () => of({ spaces: [] }), updateSpace,
    listNetworks: () => of({ networks: [] }),
    getSchema: () => of({ meta: {} }), listSchemaLibrary: () => of({ entries: [] }),
    getSchemaLayers: () => of(LAYERS_EMPTY), getSpaceStats: () => of({ spaceId: 'work', facts: 0, entities: 0, edges: 0, chrono: 0, files: 0 }),
  };
  TestBed.configureTestingModule({
    imports: [SpaceSettingsPopupComponent, getTranslocoModule({ translation: { en: EN } })],
    providers: [
      SpaceSettingsState, SpacesStore,
      { provide: SpacesApi, useValue: api }, { provide: NetworksApi, useValue: api }, { provide: SchemaApi, useValue: api },
      { provide: ToastService, useValue: { show: () => {}, error: () => {}, success: () => {}, info: () => {} } },
      { provide: ConfirmDialogService, useValue: { confirm: () => Promise.resolve(true) } },
    ],
  });
  const f = TestBed.createComponent(SpaceSettingsPopupComponent);
  f.detectChanges();
  const store = TestBed.inject(SpacesStore);
  store.spaces.set([opened]);
  const state = f.componentInstance.state;
  state.openSettings(opened);
  f.detectChanges();
  return { f, state, store, updateSpace };
}

const choose = (s: SpaceSettingsState, v: 'warn' | 'refuse') => { (s as unknown as Record<string, unknown>)['schUnknownWriteFields'] = v; };
const fieldOf = (s: SpaceSettingsState) => (s as unknown as Record<string, unknown>)['schUnknownWriteFields'];

describe('a networked save that carries the local setting and a meta change (vote_pending, bundle-128 §1.5)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('sends the setting at the top level beside the meta change, in one request', () => {
    const { f, state, updateSpace } = mount();
    state.stForm.purpose = 'a changed purpose';   // a meta change: this is what opens the vote
    choose(state, 'refuse');
    f.componentInstance.saveSettings();
    expect(updateSpace).toHaveBeenCalledTimes(1);
    const body = updateSpace.mock.calls[0]![1];
    expect(body, 'the setting was not sent').toHaveProperty('unknownWriteFields', 'refuse');
    expect(body['meta'], 'the meta change was not sent beside it').toMatchObject({ purpose: 'a changed purpose' });
    expect(body['meta'], 'the setting went inside meta').not.toHaveProperty('unknownWriteFields');
  });

  it('the notice still names the network that holds the vote AND says the local setting took effect now', () => {
    const { f, state } = mount();
    state.stForm.purpose = 'a changed purpose';
    choose(state, 'refuse');
    f.componentInstance.saveSettings();
    f.detectChanges();
    const notice = state.settingsNotice();
    expect(notice, 'the whole save is described as waiting for the vote, including the setting that is already in force').not.toBe(PLAIN_NOTICE);
    expect(notice).toContain('Alpha');
    expect(notice).toMatch(/vote/i);
    expect(notice, 'nothing says the setting took effect now').toMatch(/\bnow\b|\bimmediately\b|\balready\b/i);
    expect(notice, 'nothing says the setting is local').toMatch(/this instance|\blocal/i);
    expect(notice, 'the notice is a raw key').not.toMatch(/^spaces\./);
  });

  it('refreshes the store copy: the list behind the dialog carries refuse, not the stale absent value', () => {
    const { f, state, store } = mount();
    expect(store.spaces().find(s => s.id === 'work'), 'fixture: the store starts without the key').not.toHaveProperty('unknownWriteFields');
    state.stForm.purpose = 'a changed purpose';
    choose(state, 'refuse');
    f.componentInstance.saveSettings();
    f.detectChanges();
    const copy = store.spaces().find(s => s.id === 'work') as unknown as Record<string, unknown> | undefined;
    expect(copy, 'the space left the list').toBeDefined();
    expect(copy!['unknownWriteFields'], 'the list still shows Warn for a space that now refuses').toBe('refuse');
  });

  it('keeps the form on refuse and clean, so the submitted setting is not offered as an unsaved edit', () => {
    const { f, state, updateSpace } = mount();
    state.stForm.purpose = 'a changed purpose';
    choose(state, 'refuse');
    f.componentInstance.saveSettings();
    f.detectChanges();
    expect(updateSpace.mock.calls[0]![1], 'the setting was never sent, so there is nothing to keep clean').toHaveProperty('unknownWriteFields', 'refuse');
    expect(fieldOf(state), 'the form lost the value it just sent').toBe('refuse');
    expect(state.isDirty()).toBe(false);
    expect(state.changedSettings(), 'a second Save would resend the setting').toEqual({});
  });

  it('clearing it (refuse to warn) in a networked save is sent as the empty string, said, and refreshed the same way', () => {
    const { f, state, store, updateSpace } = mount(networked({ unknownWriteFields: 'refuse' }));
    expect(fieldOf(state), 'the form did not load refuse').toBe('refuse');
    state.stForm.purpose = 'a changed purpose';
    choose(state, 'warn');
    f.componentInstance.saveSettings();
    f.detectChanges();
    expect(updateSpace.mock.calls[0]![1], 'the clear was not sent as the empty string').toHaveProperty('unknownWriteFields', '');
    expect(state.settingsNotice()).not.toBe(PLAIN_NOTICE);
    expect(store.spaces().find(s => s.id === 'work'), 'the list still shows Refuse after the clear').not.toHaveProperty('unknownWriteFields', 'refuse');
  });

  it('a networked save WITHOUT the setting keeps the plain vote sentence, unchanged (control)', () => {
    const { f, state } = mount();
    state.stForm.purpose = 'a changed purpose';
    f.componentInstance.saveSettings();
    f.detectChanges();
    expect(state.settingsNotice()).toBe(PLAIN_NOTICE);
  });
});
