/**
 * Q-942 (verify finding L4.3): the Settings dialog's Save words the refusals of the RDF setting through the RDF family.
 *
 * Switching RDF names on with a base another space of this instance holds (`rdf_base_shared`) or one that nests with another's
 * (`rdf_base_nested`) is refused by the space PATCH. The dialog's Save used to word every refusal under `networks.refusal`, which has no
 * sentence for them, so the reader saw the server's English. Every other code keeps its words.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi } from 'vitest';
import { of, throwError } from 'rxjs';
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
const LAYERS_EMPTY = { spaceId: 'notes', own: {}, layers: [], precedence: [], clashes: [] };

function mount(refusal: unknown) {
  TestBed.resetTestingModule();
  const api = {
    listSpaces: () => of({ spaces: [] }), getActivity: () => of({ spaces: [] }), updateSpace: vi.fn(() => throwError(() => refusal)),
    listNetworks: () => of({ networks: [] }), getSchema: () => of({ meta: {} }), listSchemaLibrary: () => of({ entries: [] }),
    getSchemaLayers: () => of(LAYERS_EMPTY), getSpaceStats: () => of({ spaceId: 'notes', facts: 0, entities: 0, edges: 0, chrono: 0, files: 0 }),
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
  const opened = { id: 'notes', label: 'Notes', maxGiB: 10 } as unknown as Space;
  TestBed.inject(SpacesStore).spaces.set([opened]);
  const state = f.componentInstance.state;
  state.openSettings(opened);
  f.detectChanges();
  return { f, state };
}

function save(refusal: unknown) {
  const { f, state } = mount(refusal);
  state.stForm.purpose = 'a changed purpose';
  state.rdfForm = { enabled: true, base: 'https://rdf.example.org/ld/other/', vocab: '' };
  f.componentInstance.saveSettings();
  f.detectChanges();
  return state.settingsError();
}

describe('the Settings dialog\'s Save words the RDF refusals in the RDF family', () => {
  it.each(['rdf_base_shared', 'rdf_base_nested'])('%s is the shipped sentence, never the server\'s English', (code) => {
    const english = 'Another space holds this base (server prose, English)';
    const shown = save({ status: 409, error: { error: english, code } });
    expect(shown).toBe(EN[`rdf.refusal.${code}`]);
    expect(shown).not.toContain('server prose');
  });

  it('a refusal that is not an RDF code keeps its own words', () => {
    expect(save({ status: 409, error: { error: 'x', code: 'space_being_wiped' } })).toBe(EN['networks.refusal.space_being_wiped']);
  });
});
