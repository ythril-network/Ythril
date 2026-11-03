/**
 * The space-wide "do not embed" switch tells the operator what Save does to the vectors already stored (Q-368).
 *
 * Turning suppression on does not only stop new vectors: the sweep that follows a Save on a suppressed space REMOVES the stored text vectors of the
 * records it covers (brain/suppression-sweep.ts). The notice under the checkbox said only that "records written while this is on will have no vector",
 * so an operator ticked the box, saved, and lost an index nobody warned them about; the way back is the Backfill button, capped per press, and the
 * notice did not name it.
 *
 * What the reader is owed, in the real words of each language:
 *
 *  - when the draft differs from what is saved (box ticked, space not suppressed), a notice that VECTORS ARE REMOVED on Save, names the button that
 *    brings them back by its label ("Backfill missing embeddings") and says to press it until none remain (a press is capped);
 *  - when nothing would be removed (the space already suppresses, or the box is unticked) the removal sentence is not said: a warning that is always
 *    there is read as furniture;
 *  - the notice is a status (`role="status"`) and the checkbox is described by it (`aria-describedby` -> the notice's id), so a screen reader that
 *    lands on the box hears the consequence, not only the label;
 *  - Save on a not-yet-suppressed space asks the existing confirm dialog first and names that stored vectors are removed; a cancelled confirm sends
 *    nothing; turning suppression OFF asks nothing.
 *
 * Text vectors only: face vectors follow face recognition's own switch, and the sentence says "text".
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { of } from 'rxjs';
import { signal } from '@angular/core';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { dictionary } from '../../testing/i18n-dictionary';
import { SpaceDangerTabComponent } from './space-danger-tab.component';
import { SpaceSettingsState } from './space-settings-state.service';
import { SpacesApi } from '../../core/spaces-api.service';
import { SpacesStore } from './spaces-store.service';
import { NetworksApi } from '../../core/networks-api.service';
import { ToastService } from '../../core/toast.service';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';

/** Each language: how its notice words "vectors", "removed", and the backfill button. */
const WORDS = {
  en: { vector: /vector/i, removed: /remov|delet|dropp|discard/i },
  de: { vector: /vektor/i, removed: /entfern|lösch|verwerf/i },
  pl: { vector: /wektor/i, removed: /usun|usuw|kasuj|odrzuc/i },
} as const;

function mount(language: 'en' | 'de' | 'pl', saved: boolean, confirmResult = true) {
  const confirm = vi.fn().mockResolvedValue(confirmResult);
  const updateSpace = vi.fn().mockReturnValue(of({ space: { id: 'proj', label: 'Project' } }));
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [SpaceDangerTabComponent, getTranslocoModule({ translation: { en: dictionary(language) } })],
    providers: [
      SpaceSettingsState,
      { provide: SpacesApi, useValue: { updateSpace, getSpaceStats: vi.fn().mockReturnValue(of({})), reembedSpace: vi.fn() } },
      { provide: NetworksApi, useValue: { listNetworks: vi.fn().mockReturnValue(of({ networks: [] })), leaveNetwork: vi.fn() } },
      { provide: SpacesStore, useValue: { spaces: signal([]), networks: signal([]), networksLoaded: signal(true), refreshNetworks: () => {}, networksForSpace: () => [], load: () => {} } },
      { provide: ToastService, useValue: { error: () => {}, success: () => {}, show: () => {} } },
      { provide: ConfirmDialogService, useValue: { confirm } },
    ],
  });
  const fixture = TestBed.createComponent(SpaceDangerTabComponent);
  TestBed.inject(SpaceSettingsState).settingsSpace.set({ id: 'proj', label: 'Project', meta: saved ? { suppressEmbeddings: true } : {} } as never);
  TestBed.tick();
  fixture.detectChanges();
  const c = fixture.componentInstance;
  const el = fixture.nativeElement as HTMLElement;
  const box = () => el.querySelector<HTMLInputElement>('input[name="suppressEmbeddings"]')!;
  const tick = (on: boolean) => { c.suppress.set(on); TestBed.tick(); fixture.detectChanges(); };
  // The tab's own act region (`.act-region`, a standing live region for rename / wipe / delete) is a status too; the notice is the other one.
  const notice = () => el.querySelector<HTMLElement>('[role="status"]:not(.act-region)');
  return { c, el, box, tick, notice, confirm, updateSpace };
}

describe('the space-wide suppression notice (Q-368)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  for (const language of ['en', 'de', 'pl'] as const) {
    it(`${language}: ticking the box on a space that embeds says Save removes the stored text vectors, and names the Backfill button`, () => {
      const page = mount(language, false);
      expect(page.notice(), 'nothing to warn about before the box is ticked').toBeNull();
      page.tick(true);
      const notice = page.notice();
      expect(notice, 'the notice is a role=status element').toBeTruthy();
      const said = notice!.textContent ?? '';
      expect(said, `${language} notice: ${said}`).toMatch(WORDS[language].vector);
      expect(said, `${language} notice: ${said}`).toMatch(WORDS[language].removed);
      expect(said, 'it names the button by its label').toContain(dictionary(language)['spaces.dangerZone.embeddingsBackfill']);
    });
  }

  it('the notice leads with the consequence in its first sentence, and never promises one press restores everything (a press is capped)', () => {
    const page = mount('en', false);
    page.tick(true);
    const said = (page.notice()!.textContent ?? '').trim();
    const first = said.split(/(?<=[.!?])\s/)[0]!;
    expect(first, `the first sentence says: ${first}`).toMatch(/vector/i);
    expect(said, 'a press is capped, so it says until none remain').toMatch(/until none remain|until no .* remain|again/i);
  });

  it('the removal sentence is not said when nothing would be removed: the space already suppresses', () => {
    const page = mount('en', true);
    expect(page.box().checked || (page.c as { suppress(): boolean }).suppress(), 'the box starts on for a suppressed space').toBeTruthy();
    const said = (page.notice()?.textContent ?? '');
    expect(said, `says: ${said}`).not.toMatch(/vector[^.]*remov|remov[^.]*vector/i);
  });

  it('the notice goes again when the box is unticked', () => {
    const page = mount('en', false);
    page.tick(true);
    expect(page.notice()).toBeTruthy();
    page.tick(false);
    expect(page.notice()).toBeNull();
  });

  it('the checkbox is described by the notice: aria-describedby is the notice\'s id', () => {
    const page = mount('en', false);
    page.tick(true);
    const notice = page.notice()!;
    expect(notice.id, 'the notice has an id to point at').toBeTruthy();
    expect(page.box().getAttribute('aria-describedby') ?? '').toContain(notice.id);
  });
});

describe('Save on the suppression switch asks first (Q-368)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('turning suppression ON for a space that embeds asks the confirm dialog, naming that stored vectors are removed', async () => {
    const page = mount('en', false);
    page.c.suppress.set(true);
    await page.c.saveSuppress();
    expect(page.confirm).toHaveBeenCalledTimes(1);
    const asked = JSON.stringify(page.confirm.mock.calls[0]);
    expect(asked).toMatch(/vector/i);
    expect(asked).toMatch(/remov|delet/i);
    expect(page.updateSpace).toHaveBeenCalledWith('proj', { meta: { suppressEmbeddings: true } });
  });

  it('a cancelled confirm sends nothing', async () => {
    const page = mount('en', false, false);
    page.c.suppress.set(true);
    await page.c.saveSuppress();
    expect(page.confirm).toHaveBeenCalledTimes(1);
    expect(page.updateSpace).not.toHaveBeenCalled();
  });

  it('turning suppression OFF asks nothing: no vector is removed by it', async () => {
    const page = mount('en', true);
    page.c.suppress.set(false);
    await page.c.saveSuppress();
    expect(page.confirm).not.toHaveBeenCalled();
    expect(page.updateSpace).toHaveBeenCalledWith('proj', { meta: { suppressEmbeddings: false } });
  });
});
