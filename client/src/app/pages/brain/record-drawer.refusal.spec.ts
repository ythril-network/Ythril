/**
 * The record drawer shows a refused save in the reader's language, and a `409 write_race_lost` is one (bundle-378, Q-976, lens finding L4.2).
 *
 * ## The rule
 *
 * A save the server refuses with a coded body (`{ error, code: 'write_race_lost', id }`) is worded from the client's dictionary under
 * `networks.refusal.<code>` with the record's id filled in, never in the server's English. The drawer holds the failure as data
 * (`drawerFailure`) and the component words it through `refusalViewOf`, the module `failEdit` words a refusal through too; the plain-English
 * string state `drawerError` that sat beside it had no reader and said the server's sentence, so it is gone and nothing in the drawer can word a refusal on its own.
 *
 * ## What is driven
 *
 * The real `RecordDrawerComponent` and `RecordDrawerState`, a Transloco whose `networks.refusal.write_race_lost` is a sentinel carrying
 * `{{id}}`, a fact opened and saved against an API that answers the 409. The alert must read the sentinel with the id and never the server's sentence.
 *
 * ## Seen red
 *
 * On f91569511 the case holding `drawerError` away fails: the drawer state still has the English computed. The rendering case is green on the base
 * by construction (the component already words the failure): it holds the behaviour the removal must keep.
 */
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { of } from 'rxjs';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { BrainApi } from '../../core/brain-api.service';
import { BrainStore } from './brain-store.service';
import { EntityRefPicker } from './entity-ref-picker.service';
import { RecordDrawerState } from './record-drawer-state.service';
import { RecordDrawerComponent } from './record-drawer.component';
import { aMemory } from '../../testing/records';

const SENTINEL = 'RACE-LOST-SENTENCE for {{id}}';
const SERVER_ENGLISH = 'was changed by other writes on each of this write\'s 3 attempts; nothing was written. Retry it (write_race_lost).';

function create() {
  const api = {
    getEntitiesByIds: () => of({ entities: [] }),
    updateFact: () => ({ subscribe: (h: any) => h.error({ status: 409, error: { error: `'m1' ${SERVER_ENGLISH}`, code: 'write_race_lost', id: 'm1' } }) }),
  } as any;
  TestBed.configureTestingModule({
    imports: [RecordDrawerComponent, getTranslocoModule({ translation: { en: { networks: { refusal: { write_race_lost: SENTINEL } } } } })],
    providers: [provideHttpClient(), provideHttpClientTesting(), RecordDrawerState, BrainStore, EntityRefPicker, { provide: BrainApi, useValue: api }],
  });
  const fixture = TestBed.createComponent(RecordDrawerComponent);
  fixture.detectChanges();
  return fixture;
}

describe('RecordDrawerComponent: a refused save', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('words a 409 write_race_lost from the dictionary with the record id, not in the server\'s English', () => {
    const fixture = create();
    const state = TestBed.inject(RecordDrawerState);
    state.open('fact', aMemory({ _id: 'm1', fact: 'before' }));
    state.drawerEditMemory.fact = 'after';
    state.save();
    fixture.detectChanges();

    const alert = fixture.nativeElement.querySelector('app-refusal-alert .alert') as HTMLElement | null;
    expect(alert, 'the refused save shows no alert').toBeTruthy();
    expect(alert!.textContent).toContain('RACE-LOST-SENTENCE for m1');
    expect(alert!.textContent).not.toContain('nothing was written. Retry it');
  });

  it('holds the failure as data and offers no English string beside it', () => {
    create();
    const state = TestBed.inject(RecordDrawerState);
    state.open('fact', aMemory({ _id: 'm1', fact: 'before' }));
    state.drawerEditMemory.fact = 'after';
    state.save();
    expect(state.drawerFailure()?.error?.code).toBe('write_race_lost');
    expect('drawerError' in state, 'the drawer state words a refusal in plain English on its own').toBe(false);
  });
});
