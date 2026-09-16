/**
 * SpaceDangerTabComponent characterization tests.
 *
 * Written BEFORE the PR-U9 rework (escalate Wipe to a red tier, add type-to-confirm to Rename, responsive
 * tiles) and proven green against the ORIGINAL component. The danger tab performs the IRREVERSIBLE space
 * operations — rename, wipe, delete, leave-network — each behind a confirm. These tests pin that gating so
 * the redesign can't weaken it: a cancelled confirm must never call the API, and a confirmed one calls the
 * right endpoint and updates state. (Wipe/Delete already use type-to-confirm; the rework adds it to Rename.)
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { of } from 'rxjs';
import { signal } from '@angular/core';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { SpaceDangerTabComponent } from './space-danger-tab.component';
import { SpaceSettingsState } from './space-settings-state.service';
import { SpacesApi } from '../../core/spaces-api.service';
import { SpacesStore } from './spaces-store.service';
import { NetworksApi } from '../../core/networks-api.service';
import { ToastService } from '../../core/toast.service';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';

/*
 * Generic in the OVERRIDES, so a mock a caller adds is visible on the returned `spacesApi`.
 *
 * It was `Partial<Record<string, unknown>>`, which accepts anything and contributes nothing: the return type
 * was inferred from the base stub alone, so `h.spacesApi.updateSpace` — passed in by `withMeta` and present at
 * runtime — did not exist as far as the compiler was concerned. Four assertions were reading a property the
 * type said was absent.
 */
function setup<E extends Record<string, unknown>>(confirmResult: boolean, api: E = {} as E) {
  const spacesApi = {
    renameSpace: vi.fn().mockReturnValue(of({ space: { id: 'renamed', label: 'S' } })),
    wipeSpace: vi.fn().mockReturnValue(of({})),
    deleteSpace: vi.fn().mockReturnValue(of({})),
    getSpaceStats: vi.fn().mockReturnValue(of({})),
    ...api,
  };
  const networksApi = {
    listNetworks: vi.fn().mockReturnValue(of({ networks: [] })),
    leaveNetwork: vi.fn().mockReturnValue(of({})),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [SpaceDangerTabComponent, getTranslocoModule()],
    providers: [
      SpaceSettingsState,
      { provide: SpacesApi, useValue: spacesApi },
      { provide: NetworksApi, useValue: networksApi },
      // `networksForSpace` and `load` are needed because these tests run a real change-detection pass
      // (`TestBed.tick()`) to fire the seeding effect, which renders the template. The earlier tests called
      // methods directly and never rendered, so the mock could get away with less.
      { provide: SpacesStore, useValue: { spaces: signal([]), networks: signal([]), refreshNetworks: () => {}, networksForSpace: () => [], load: () => {} } },
      { provide: ToastService, useValue: { error: () => {}, success: () => {}, show: () => {} } },
      { provide: ConfirmDialogService, useValue: { confirm: () => Promise.resolve(confirmResult) } },
    ],
  });
  const c = TestBed.createComponent(SpaceDangerTabComponent).componentInstance;
  const state = TestBed.inject(SpaceSettingsState);
  state.settingsSpace.set({ id: 'proj', label: 'Project' } as never);
  return { c, state, spacesApi, networksApi };
}

describe('SpaceDangerTabComponent — irreversible ops are confirm-gated', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('rename: no-op when the new id is blank or unchanged', async () => {
    const { c, state, spacesApi } = setup(true);
    state.dangerRenameId = '';
    await c.submitDangerRename();
    state.dangerRenameId = 'proj'; // same as current
    await c.submitDangerRename();
    expect(spacesApi.renameSpace).not.toHaveBeenCalled();
  });

  it('rename: a cancelled confirm does not call the API', async () => {
    const { c, state, spacesApi } = setup(false);
    state.dangerRenameId = 'proj-2';
    await c.submitDangerRename();
    expect(spacesApi.renameSpace).not.toHaveBeenCalled();
  });

  it('rename: confirmed calls renameSpace(old,new) and reflects the new space', async () => {
    const { c, state, spacesApi } = setup(true, {
      renameSpace: vi.fn().mockReturnValue(of({ space: { id: 'proj-2', label: 'Project' } })),
    });
    state.dangerRenameId = 'proj-2';
    await c.submitDangerRename();
    expect(spacesApi.renameSpace).toHaveBeenCalledWith('proj', 'proj-2');
    expect(state.settingsSpace()?.id).toBe('proj-2');
  });

  it('wipe: cancelled does not call the API; confirmed does', async () => {
    const cancelled = setup(false);
    await cancelled.c.confirmDangerWipe();
    expect(cancelled.spacesApi.wipeSpace).not.toHaveBeenCalled();

    const ok = setup(true);
    await ok.c.confirmDangerWipe();
    expect(ok.spacesApi.wipeSpace).toHaveBeenCalledWith('proj');
  });

  it('delete: cancelled does not call the API; confirmed deletes and closes the dialog', async () => {
    const cancelled = setup(false);
    await cancelled.c.confirmDangerDelete();
    expect(cancelled.spacesApi.deleteSpace).not.toHaveBeenCalled();

    const ok = setup(true);
    await ok.c.confirmDangerDelete();
    expect(ok.spacesApi.deleteSpace).toHaveBeenCalledWith('proj');
    expect(ok.state.settingsSpace()).toBeNull(); // closeSettings()
  });

  it('leave network: cancelled does not call the API; confirmed leaves', async () => {
    const cancelled = setup(false);
    await cancelled.c.leaveNetworkDanger('net1');
    expect(cancelled.networksApi.leaveNetwork).not.toHaveBeenCalled();

    const ok = setup(true);
    await ok.c.leaveNetworkDanger('net1');
    expect(ok.networksApi.leaveNetwork).toHaveBeenCalledWith('net1');
  });
});

describe('the embedding suppression section', () => {
  // The seeding lives in an `effect()`, so it does not run on `set()` alone — it needs a change-detection pass.
  // Flushed explicitly rather than worked around, because the effect IS the behaviour being tested: seeding from
  // the space is what makes the toggle show the stored value instead of always starting off.
  const withMeta = (meta: Record<string, unknown>) => {
    const h = setup(true, {
      updateSpace: vi.fn().mockReturnValue(of({ space: { id: 'proj', label: 'Project' } })),
      reembedSpace: vi.fn().mockReturnValue(of({ spaceId: 'proj', enqueued: 12, skippedSuppressed: 0, byKind: { fact: 12 }, remaining: 0, truncated: false })),
    });
    h.state.settingsSpace.set({ id: 'other', label: 'Other', meta } as never);
    TestBed.tick();
    return h;
  };

  it('seeds the toggle from the space, treating absent as OFF', () => {
    // Suppression is opt-in. Reading absent as ON would silently stop a space embedding.
    expect(withMeta({}).c.suppress()).toBe(false);
    expect(withMeta({ suppressEmbeddings: true }).c.suppress()).toBe(true);
  });

  it('sends the flag inside meta, so the server MERGES rather than replacing', () => {
    // Sending a whole meta back would race any other edit made since the dialog opened.
    const h = withMeta({});
    h.c.suppress.set(true);
    return h.c.saveSuppress().then(() => {
      expect(h.spacesApi.updateSpace).toHaveBeenCalledWith('other', { meta: { suppressEmbeddings: true } });
    });
  });

  it('sends false when turned OFF, rather than omitting it', () => {
    // Omitting the field under a merge would leave suppression on while the save reported success.
    const h = withMeta({ suppressEmbeddings: true });
    h.c.suppress.set(false);
    return h.c.saveSuppress().then(() => {
      expect(h.spacesApi.updateSpace).toHaveBeenCalledWith('other', { meta: { suppressEmbeddings: false } });
    });
  });

  it('lists only the types that STATE a value', () => {
    // A type that says nothing inherits; listing it would suggest an override that is not there.
    const h = withMeta({ typeSchemas: { fact: { note: { suppressEmbeddings: true }, plain: {} }, entity: { row: { suppressEmbeddings: false } } } });
    expect(h.c.declaredSuppression().map(r => r.key).sort()).toEqual(['entity.row', 'fact.note']);
  });

  it('keeps the backfill result, because the counts ARE the answer', () => {
    const h = withMeta({});
    return h.c.backfill().then(() => {
      expect(h.spacesApi.reembedSpace).toHaveBeenCalledWith('other');
      expect(h.c.backfillResult()?.enqueued).toBe(12);
    });
  });

  it('clears a previous backfill result when the space changes', () => {
    // Otherwise one space's counts would be shown under another space's name.
    const h = withMeta({});
    return h.c.backfill().then(() => {
      h.state.settingsSpace.set({ id: 'third', label: 'Third' } as never);
      TestBed.tick();
      expect(h.c.backfillResult()).toBe(null);
    });
  });
});
