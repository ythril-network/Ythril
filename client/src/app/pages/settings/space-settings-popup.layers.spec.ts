/**
 * What a schema save says on a space that sits in more than one network, and what the layers panel keeps saying
 * afterwards (bundle-23, Q-67, R5-1 as amended by R6-8; client half R6-14 "pending rounds stay listed", ux S8).
 *
 * ## The case
 *
 * A space in two networks, a higher-precedence one that vetoes (or has not yet voted) and a lower one that passes:
 * the own definitions take the edit, the effective schema keeps the higher layer's value, and every door said
 * "saved". The server now answers `layers: [{ networkId, networkLabel, outcome: 'applied' | 'vote_pending' }]` on a
 * write to such a space (the later outcome - passed, vetoed, not carried - is DERIVED on read by
 * `space_schema_layers`, R6-8, never recorded), and `space_schema_layers` names, per field, what this instance holds
 * and which layer is winning instead.
 *
 * The client had two branches in `saveSettings` - applied (close the dialog) and vote_pending (stay open, one notice)
 * - and a MIXED answer fits neither: closing hides the pending half, staying with the single-branch sentence hides
 * the applied half. And the layers panel loaded once, hid itself silently when the load failed, and knew nothing of
 * a hidden edit or a round still pending after the dialog was closed and reopened.
 *
 * ## Names this spec fixes (wire names beyond the contract file; the server slice's tests must agree)
 *
 * - write answer: `layers: { networkId, networkLabel, outcome }[]` beside `space` (applied everywhere) or `rounds`.
 * - `space_schema_layers` answer gains `hidden: { path: string; own: unknown; networkId: string }[]` (own value a
 *   higher layer is overriding) and `rounds: { id: string; networkId: string; status: 'pending'; paths: string[] }[]`.
 * - the panel's states: `[data-testid="layers-error"]` (role alert) with a retry button `[data-testid="layers-retry"]`;
 *   each hidden edit a row `[data-testid="hidden-edit"]`; each pending round a row `[data-testid="pending-round"]`.
 *
 * Real English is loaded so interpolated sentences can be asserted: a key that does not exist yet renders as the raw
 * key, which has no network name in it - the right red for copy that was never written.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { of, throwError } from 'rxjs';
import { SpacesApi } from '../../core/spaces-api.service';
import { NetworksApi } from '../../core/networks-api.service';
import { SchemaApi } from '../../core/schema-api.service';
import { ToastService } from '../../core/toast.service';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import type { Space } from '../../core/api.types';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { SpaceSettingsPopupComponent } from './space-settings-popup.component';
import { SpaceSchemaLayersComponent } from './space-schema-layers.component';
import { SpaceSettingsState } from './space-settings-state.service';
import { SpacesStore } from './spaces-store.service';

const EN: Record<string, string> = JSON.parse(readFileSync(resolve(__dirname, '../../../../public/assets/i18n/en.json'), 'utf8'));
const space = (over: Partial<Space> = {}): Space => ({ id: 'work', label: 'Work', maxGiB: 10, networks: [], ...over }) as Space;
const LAYERS_EMPTY = { spaceId: 'work', own: {}, layers: [], precedence: [], clashes: [] };

function mountPopup(updateSpace: () => unknown) {
  TestBed.resetTestingModule();
  const api = {
    listSpaces: () => of({ spaces: [space()] }), getActivity: () => of({ spaces: [] }), updateSpace,
    getSchema: () => of({ meta: {} }), listSchemaLibrary: () => of({ entries: [] }),
    getSchemaLayers: () => of(LAYERS_EMPTY), getSpaceStats: () => of({ spaceId: 'work', facts: 0, entities: 0, edges: 0, chrono: 0, files: 0 }),
  };
  TestBed.configureTestingModule({
    imports: [SpaceSettingsPopupComponent, getTranslocoModule({ translation: { en: EN } })],
    providers: [
      SpaceSettingsState, SpacesStore,
      { provide: SpacesApi, useValue: api }, { provide: NetworksApi, useValue: api }, { provide: SchemaApi, useValue: api },
      { provide: ToastService, useValue: { show: () => {}, error: () => {}, success: () => {} } },
      { provide: ConfirmDialogService, useValue: { confirm: () => Promise.resolve(true) } },
    ],
  });
  const f = TestBed.createComponent(SpaceSettingsPopupComponent);
  f.detectChanges();
  const s = space();
  f.componentInstance.state.openSettings(s);
  f.componentInstance.state.stForm.purpose = 'a changed purpose';   // something to save
  f.detectChanges();
  return f;
}

describe('a schema save that is applied in one network and pending in another', () => {
  const mixed = {
    space: space({ label: 'Work' }),
    layers: [
      { networkId: 'a', networkLabel: 'Alpha', outcome: 'applied' },
      { networkId: 'b', networkLabel: 'Beta', outcome: 'vote_pending' },
    ],
  };

  it('does not close the dialog on the strength of the applied half: the pending half has not happened yet', () => {
    const f = mountPopup(() => of(mixed));
    f.componentInstance.saveSettings();
    f.detectChanges();
    expect(f.componentInstance.state.settingsSpace(), 'the dialog closed and the Beta vote was never mentioned').not.toBeNull();
  });

  it('says what happened in EACH network, by name, in the notice', () => {
    const f = mountPopup(() => of(mixed));
    f.componentInstance.saveSettings();
    f.detectChanges();
    const notice = f.componentInstance.state.settingsNotice();
    expect(notice).toContain('Alpha');
    expect(notice).toContain('Beta');
    expect(notice, 'two networks with two different outcomes are one sentence, not the single-branch vote text').not.toBe(
      EN['spaces.settings.votePending']!.replace(/\{\{\s*networks\s*\}\}/, 'Alpha, Beta'));
  });

  it('an answer that was applied in every network still closes the dialog as before (control)', () => {
    const allApplied = { space: space(), layers: [{ networkId: 'a', networkLabel: 'Alpha', outcome: 'applied' }, { networkId: 'b', networkLabel: 'Beta', outcome: 'applied' }] };
    const f = mountPopup(() => of(allApplied));
    f.componentInstance.saveSettings();
    f.detectChanges();
    expect(f.componentInstance.state.settingsSpace()).toBeNull();
  });
});

describe('the layers panel keeps what the dialog cannot', () => {
  const view = (over: Record<string, unknown> = {}) => ({
    spaceId: 'work', own: {}, precedence: ['a', 'b'], clashes: [],
    layers: [{ networkId: 'a', networkLabel: 'Alpha', meta: {} }, { networkId: 'b', networkLabel: 'Beta', meta: {} }],
    ...over,
  });

  function mountPanel(getSchemaLayers: () => unknown) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [SpaceSchemaLayersComponent, getTranslocoModule({ translation: { en: EN } })],
      providers: [
        { provide: SchemaApi, useValue: { getSchemaLayers, setNetworkPrecedence: vi.fn(), proposeToNetwork: vi.fn() } },
        { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
      ],
    });
    const f = TestBed.createComponent(SpaceSchemaLayersComponent);
    f.componentRef.setInput('spaceId', 'work');
    f.detectChanges();
    return f;
  }
  const q = (f: { nativeElement: HTMLElement }, sel: string) => [...f.nativeElement.querySelectorAll(sel)] as HTMLElement[];

  beforeEach(() => TestBed.resetTestingModule());

  it('a failed load says so (role=alert) and offers a retry - it does not hide the panel and say nothing', () => {
    const f = mountPanel(() => throwError(() => ({ status: 500, error: { error: 'boom' } })));
    const err = q(f, '[data-testid="layers-error"]')[0];
    expect(err, 'the panel vanished on a failed load').toBeTruthy();
    expect(err!.getAttribute('role')).toBe('alert');
    expect(q(f, '[data-testid="layers-retry"]')).toHaveLength(1);
  });

  it('retry loads again and shows the layers', () => {
    let fail = true;
    const get = vi.fn(() => (fail ? throwError(() => ({ status: 500, error: { error: 'boom' } })) : of(view())));
    const f = mountPanel(get);
    fail = false;
    const retry = q(f, '[data-testid="layers-retry"]')[0];
    expect(retry, 'a failed load offers no retry').toBeTruthy();
    retry!.click();
    f.detectChanges();
    expect(get).toHaveBeenCalledTimes(2);
    expect(f.nativeElement.textContent).toContain('Alpha');
  });

  it('a hidden edit - own value a higher layer overrides - is listed with the network that is winning', () => {
    const f = mountPanel(() => of(view({ hidden: [{ path: 'typeSchemas.entity.person.namingPattern', own: '^P', networkId: 'a' }] })));
    const rows = q(f, '[data-testid="hidden-edit"]');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain('typeSchemas.entity.person.namingPattern');
    expect(rows[0]!.textContent, 'the winning network is named by its label, not its id').toContain('Alpha');
  });

  it('a round still pending is listed in the panel, so closing the dialog does not lose it', () => {
    const f = mountPanel(() => of(view({ rounds: [{ id: 'r1', networkId: 'b', status: 'pending', paths: ['purpose'] }] })));
    const rows = q(f, '[data-testid="pending-round"]');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain('Beta');
    expect(rows[0]!.textContent).toContain('purpose');
  });

  it('nothing is rendered for a space with no network layer even when the answer is well-formed (control)', () => {
    const f = mountPanel(() => of(view({ layers: [], precedence: [] })));
    expect(q(f, '[data-testid="hidden-edit"], [data-testid="pending-round"], [data-testid="layers-error"]')).toHaveLength(0);
  });
});
