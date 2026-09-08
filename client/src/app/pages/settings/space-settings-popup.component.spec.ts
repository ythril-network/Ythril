/**
 * The space-settings pop-up.
 *
 * These tests came from `spaces.component.spec.ts` unchanged when the pop-up became its own component — they
 * were always testing the modal rather than the page around it, and moving the code without moving them would
 * have left the page's spec asserting on members it no longer has. Which is exactly how it failed first: four
 * tests calling `c.saveSettings()` on a host that had handed that method away.
 *
 * The setup differs from the page's in one way that matters: this component does not PROVIDE
 * `SpaceSettingsState` or `SpacesStore` — both hosts do. So the spec provides them, which is also the shape the
 * Brain page will use when it becomes the second host.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect } from 'vitest';
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

function space(over: Partial<Space> = {}): Space {
  return { id: 'work', label: 'Work', maxGiB: 10, networks: [], ...over } as Space;
}

/** What the last `updateSpace` call was given, so a case can assert the BODY and not just the effect. */
let lastUpdateBody: Record<string, unknown> | null = null;

function makeApi(spaces: Space[] = []) {
  return {
    listSpaces: () => of({ spaces }),
    list: () => of({ spaces }),
    getActivity: () => of({ spaces: [] }),
    updateSpace: (_id: string, body: Record<string, unknown>) => {
      lastUpdateBody = body;
      return of({ space: spaces[0] ?? space() });
    },
    getSchema: () => of({ meta: {} }),
    listEntries: () => of({ entries: [] }),
    listSchemaLibrary: () => of({ entries: [] }),
    getSpaceStats: () => of({ spaceId: 'work', memories: 1, entities: 2, edges: 3, chrono: 4, files: 5 }),
  };
}

/** The pop-up, with the state and store its hosts would have provided. */
function create(spaces: Space[] = []) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [SpaceSettingsPopupComponent, getTranslocoModule()],
    providers: [
      SpaceSettingsState, SpacesStore,
      { provide: SpacesApi, useValue: makeApi(spaces) },
      { provide: NetworksApi, useValue: makeApi(spaces) },
      { provide: SchemaApi, useValue: makeApi(spaces) },
      { provide: ToastService, useValue: { show: () => {}, error: () => {}, success: () => {} } },
      { provide: ConfirmDialogService, useValue: { confirm: () => Promise.resolve(true) } },
    ],
  });
  const fixture = TestBed.createComponent(SpaceSettingsPopupComponent);
  fixture.detectChanges();
  return fixture;
}

describe('SpaceSettingsPopup — settings dialog rendering', () => {
  const s = space({ id: 'work', label: 'Work' });
  const text = (f: { nativeElement: HTMLElement }) => f.nativeElement.textContent ?? '';

  it('no dialog until openSettings, and closeSettings tears it down', () => {
    const fixture = create([s]);
    const c = fixture.componentInstance;
    expect(c.state.settingsSpace()).toBeNull();
    c.state.openSettings(s);
    fixture.detectChanges();
    expect(c.state.settingsSpace()).not.toBeNull();
    c.state.closeSettings();
    fixture.detectChanges();
    expect(c.state.settingsSpace()).toBeNull();
  });

  it('each tab renders its own pane', () => {
    const fixture = create([s]);
    const c = fixture.componentInstance;
    c.state.openSettings(s);
    fixture.detectChanges();

    // every tab is reachable and swapping panes does not throw
    for (const tab of ['settings', 'schema', 'duplicates', 'danger'] as const) {
      c.state.settingsTab.set(tab);
      fixture.detectChanges();
      expect(c.state.settingsTab()).toBe(tab);
      expect(text(fixture).length).toBeGreaterThan(0);
    }
  });

  /**
   * A governed space says so BEFORE you type.
   *
   * Saving a networked space answers `202 vote_pending`: the change is submitted for a vote, not applied.
   * The notice added with that fix explains it *afterwards*, which is the wrong end of the interaction —
   * an operator should know the rules of the dialog before they start editing in it. Membership is already
   * on the space record, so the badge is free.
   */
  it('shows the governed badge, naming the networks, for a networked space', () => {
    const fixture = create([s]);
    const c = fixture.componentInstance;
    c.state.openSettings({ ...s, networks: [
      { id: 'n1', label: 'Research Federation', type: 'democratic' },
      { id: 'n2', label: 'Ops Braintree', type: 'braintree' },
    ] } as never);
    fixture.detectChanges();
    expect(c.governedBy()).toBe('Research Federation, Ops Braintree');
    expect(text(fixture)).toContain('spaces.popup.governed');
  });

  /**
   * A terminal outcome stops offering to submit.
   *
   * A governed save answers 202 and opens a vote, so the work is finished — but the footer still read "Save
   * changes" and the only exit was the (X), which universally means DISCARD. A reporting operator: *"i have to
   * click (X) which feels unsure if the changes are now actually up for vote or discarded."*
   *
   * The risk is a wrong action, not a wobble: read as cancel, someone looks for another way to confirm, saves
   * again, and creates a SECOND proposal for the same change.
   */
  it('swaps Save changes for Done once a save has a terminal outcome', () => {
    const fixture = create([s]);
    const c = fixture.componentInstance;
    c.state.openSettings(s);
    fixture.detectChanges();
    // Before: the dialog is offering to submit.
    expect(text(fixture)).toContain('spaces.popup.footer.saveChanges');
    expect(text(fixture)).not.toContain('spaces.popup.footer.done');

    // A governed save sets the notice and keeps the dialog open.
    c.state.settingsNotice.set('submitted for a vote');
    fixture.detectChanges();
    expect(text(fixture)).toContain('spaces.popup.footer.done');
    expect(text(fixture)).not.toContain('spaces.popup.footer.saveChanges');
  });

  it('the Done button closes the dialog rather than saving again', () => {
    // The whole point: a second click must not open a second vote round.
    const fixture = create([s]);
    const c = fixture.componentInstance;
    c.state.openSettings(s);
    c.state.settingsNotice.set('submitted for a vote');
    fixture.detectChanges();
    const btn = (fixture.nativeElement as HTMLElement).querySelector('.sp-footer .btn-primary') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    btn.click();
    fixture.detectChanges();
    expect(c.state.settingsSpace()).toBeNull();
  });

  it('shows NOTHING for a space in no network', () => {
    // The badge has to be absent, not empty: a permanent chip that sometimes means nothing is noise, and
    // most spaces are in no network at all.
    const fixture = create([s]);
    const c = fixture.componentInstance;
    c.state.openSettings(s);
    fixture.detectChanges();
    expect(c.governedBy()).toBeNull();
    expect(text(fixture)).not.toContain('spaces.popup.governed');
  });

  it('keys on MEMBERSHIP, not on whether something is happening', () => {
    // `networkStatus: 'idle'` means the network is quiet — and Save still opens a vote. Keying the badge
    // on activity would hide it exactly when nothing is going on, which is most of the time.
    const fixture = create([s]);
    const c = fixture.componentInstance;
    c.state.openSettings({ ...s, networkStatus: 'idle', networks: [{ id: 'n1', label: 'Quiet Net', type: 'democratic' }] } as never);
    fixture.detectChanges();
    expect(c.governedBy()).toBe('Quiet Net');
  });

});

/**
 * The dirty snapshot must be re-baselined by a successful save.
 *
 * It was only ever taken when a space was OPENED, so after saving, the editor still compared against the
 * pre-save values and reported unsaved changes for edits it had just persisted. Closing the dialog on
 * success hid it in the common path, but any flow that kept the editor open produced a discard prompt
 * for nothing — and a discard prompt that fires after a save is worse than none, because it trains
 * people to click through discard prompts.
 */
describe('SpaceSettingsPopup — save re-baselines the unsaved-changes guard', () => {
  it('is not dirty after a successful save', () => {
    const fixture = create([space()]);
    const c = fixture.componentInstance as any;

    c.state.settingsSpace.set(space());
    c.state.markPristine();
    c.state.stForm.label = 'Renamed';
    expect(c.state.isDirty(), 'an edit must be dirty').toBe(true);

    c.saveSettings();

    // Asserted on the STATE, not on whether the dialog closed: closing is what used to mask this.
    c.state.settingsSpace.set(space());
    expect(c.state.isDirty(), 'a saved edit must not still count as unsaved').toBe(false);
  });
});

/**
 * The Usage column and its two sorts — the surface that answers the question the panel cannot.
 *
 * The Overview shows one space. "Which spaces are how useful" is a comparison, so it lives here, and the
 * ordering is where the thinking is: busiest-first finds load, worst-answered-first finds a content gap — a
 * space fielding questions it cannot answer, which no other column on this page can show.
 *
 * The case these pin hardest is the one that is easy to get wrong: a space nobody has asked anything has NO
 * answer rate, and must not sort as though it were the worst offender. Zero-filling it would put every unused
 * space above the one space that actually has a problem.
 */

describe('SpaceSettingsPopup — Save sends the difference, not the form', () => {
  /*
   * Every field on `PATCH /api/spaces/:id` answers to the area that owns it since 4.4. Posting the whole
   * form makes the HIGHEST requirement in it decide, so a `files` writer editing a media level was refused
   * for the twenty-one fields they had not touched — the per-field rungs were real on the API and inert in
   * this dialog. `changedSettings()` is unit-tested next door; this pins the WIRING, which is the half a
   * green diff function cannot tell you about.
   */
  it('one edited field reaches the API alone', () => {
    lastUpdateBody = null;
    const fixture = create([space()]);
    const c = fixture.componentInstance as any;

    c.state.settingsSpace.set(space());
    c.state.markPristine();
    c.state.stForm.imageAnalysis = 'caption';
    c.saveSettings();

    expect(lastUpdateBody).toEqual({ imageAnalysis: 'caption' });
  });

  it('an untouched dialog calls nothing at all', () => {
    // The body is `.strict()` with an at-least-one-field refine, so an empty object is a 400 rather than a
    // no-op. Save is reachable with nothing edited, so this path has to exist.
    lastUpdateBody = null;
    const fixture = create([space()]);
    const c = fixture.componentInstance as any;

    c.state.settingsSpace.set(space());
    c.state.markPristine();
    c.saveSettings();

    expect(lastUpdateBody).toBeNull();
    expect(c.state.settingsSaving()).toBe(false);
  });
});
