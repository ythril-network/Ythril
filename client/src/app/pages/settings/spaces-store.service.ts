import { DestroyRef, Injectable, inject, signal, computed } from '@angular/core';
import { moveItemInArray } from '@angular/cdk/drag-drop';
import { Network, Space, SpacesResponse } from '../../core/api.types';
import { NetworksApi } from '../../core/networks-api.service';
import { SpacesApi } from '../../core/spaces-api.service';

/** How often the index poll asks while a space is truly BUILDING its indexes (`Q-113`). */
export const INDEX_POLL_FAST_MS = 3_000;
/**
 * How often it asks when every building space is only `indexWaiting` — the search service is late, nothing is
 * being built, and the answer changes when the service returns, not in seconds. Re-read from every answer, so a
 * true build that starts beside a waiting space speeds the chain up again.
 */
export const INDEX_POLL_SLOW_MS = 30_000;

const isBuilding = (s: Space) => s.indexStatus === 'building';

/**
 * Owns the spaces page's SERVER DATA — the space list, the networks, and every mutation of them.
 *
 * Split from SpaceSettingsState on purpose (A17.8b): the two are different kinds of state with
 * different lifetimes. This is data fetched from the server and shared by the list and every dialog;
 * SpaceSettingsState is ephemeral form state that dies when the dialog closes. Tangling them is what
 * forced the old component to own both.
 *
 * Because it is a service, the dialogs and tabs mutate the list by calling it — no `@Output()`
 * plumbing back to a parent, and no component owning data that outlives it. Provided by
 * SpacesComponent (not root), so the lifetime matches the page.
 *
 * VIEW state (search text, sort mode) deliberately does NOT live here — that belongs to the
 * component rendering the list, not to the data.
 */
@Injectable()
export class SpacesStore {
  private spacesApi   = inject(SpacesApi);
  private networksApi = inject(NetworksApi);
  private destroyRef  = inject(DestroyRef);

  /** True from the moment the index poll chain starts until it stops: the one flag that keeps it from stacking. */
  private polling = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  /** A reorder's optimistic list is on screen until the server answers; a poll answer must not overwrite it. */
  private reorderInFlight = false;

  constructor() {
    this.destroyRef.onDestroy(() => this.stopIndexPoll());
  }

  readonly spaces   = signal<Space[]>([]);
  readonly networks = signal<Network[]>([]);
  /** Instance document-extraction ceiling — the highest mode a space may pick. Drives the per-space
   *  extraction dropdown so it never offers a level the runtime would cap. 'auto' = no policy limit. */
  readonly docExtractionCeiling = signal<'off' | 'ocr' | 'vlm' | 'repair' | 'auto'>('auto');
  /** Instance per-class media-analysis ceilings — the highest level a space may pick for each class.
   *  Drives the per-space media pickers so they never offer a level the runtime would cap. 'auto' = no
   *  policy limit (the default when the server omits the field). */
  readonly mediaCeilings = signal<NonNullable<SpacesResponse['mediaCeilings']>>({
    image: 'auto', audio: 'auto', video: 'auto', text: 'auto',
  });
  readonly loading  = signal(true);
  /** Set when the spaces list fails to load, so the page can show an error state rather than a bare empty list. */
  readonly error    = signal(false);

  /**
   * spaceId -> the networks that space belongs to.
   *
   * The list template needs this per row. It used to call `networks().filter(...)` inline — twice
   * per row (once for `.length`, once for the `@for`) — so rendering N rows did 2N full scans of the
   * network list on every change-detection pass, allocating a fresh array each time (which also
   * defeats `@for` tracking, since the identity changed on every pass). This computes the index once
   * per networks() change instead: O(1) lookup per row, and a stable array identity.
   */
  readonly networksBySpace = computed(() => {
    const index = new Map<string, Network[]>();
    for (const n of this.networks()) {
      for (const spaceId of n.spaces) {
        const list = index.get(spaceId);
        if (list) list.push(n);
        else index.set(spaceId, [n]);
      }
    }
    return index;
  });

  /** Networks the given space belongs to. Empty array shared across misses — do not mutate it. */
  private static readonly NO_NETWORKS: readonly Network[] = [];
  networksForSpace(spaceId: string): Network[] {
    return this.networksBySpace().get(spaceId) ?? (SpacesStore.NO_NETWORKS as Network[]);
  }

  load(): void {
    this.loading.set(true);
    this.error.set(false);
    this.spacesApi.listSpaces().subscribe({
      next: ({ spaces, docExtractionCeiling, mediaCeilings }) => {
        this.spaces.set(spaces);
        if (docExtractionCeiling) this.docExtractionCeiling.set(docExtractionCeiling);
        if (mediaCeilings) this.mediaCeilings.set(mediaCeilings);
        this.loading.set(false);
        if (spaces.some(isBuilding)) this.pollIndexStatus();
      },
      error: () => { this.error.set(true); this.loading.set(false); },
    });
    this.networksApi.listNetworks().subscribe({
      next: ({ networks }) => this.networks.set(networks),
      error: () => {},
    });
  }

  refreshNetworks(): void {
    this.networksApi.listNetworks().subscribe({
      next: ({ networks }) => this.networks.set(networks),
      error: () => {},
    });
  }

  /** Merge a server-returned space back into the list (after a settings save). */
  applySpace(space: Space): void {
    this.spaces.update(list => list.map(s => s.id === space.id ? { ...s, ...space } : s));
  }

  /** Reorder optimistically, then persist; on failure fall back to a full reload. */
  reorder(previousIndex: number, currentIndex: number): void {
    if (previousIndex === currentIndex) return;
    const list = [...this.spaces()];
    moveItemInArray(list, previousIndex, currentIndex);
    this.spaces.set(list);
    this.reorderInFlight = true;
    this.spacesApi.reorderSpaces(list.map(s => s.id)).subscribe({
      next: ({ spaces }) => { this.reorderInFlight = false; this.spaces.set(spaces); },
      error: () => { this.reorderInFlight = false; this.load(); },
    });
  }

  /**
   * Watch the spaces that are `building` until none is (`Q-113`). Safe to call from anywhere, any number of times:
   * a second call while the chain runs is a no-op, which is the guard a hand-written copy would drop.
   *
   * A space is `building` while its vector indexes are built, and also while it is `indexWaiting` for a search
   * service that is late. Recall is empty in both, and the operator's page must notice the end of either without a
   * reload. So `load()` starts the chain itself, there is no attempt cap (a cap is what left a late service showing
   * "building" for ever), a hidden tab skips its tick, and the store's destruction cancels it.
   */
  pollIndexStatus(): void {
    if (this.polling) return;
    this.polling = true;
    this.scheduleIndexPoll();
  }

  /** Every building space is merely waiting for the search service → the slow cadence; any true build → the fast one. */
  private indexPollDelay(): number {
    const building = this.spaces().filter(isBuilding);
    return building.length > 0 && building.every(s => s.indexWaiting) ? INDEX_POLL_SLOW_MS : INDEX_POLL_FAST_MS;
  }

  private scheduleIndexPoll(): void {
    this.pollTimer = setTimeout(() => this.indexPollTick(), this.indexPollDelay());
  }

  private indexPollTick(): void {
    this.pollTimer = null;
    if (typeof document !== 'undefined' && document.hidden) { this.scheduleIndexPoll(); return; }
    this.spacesApi.listSpaces().subscribe({
      next: ({ spaces }) => {
        if (!this.polling) return;
        if (!this.reorderInFlight) this.spaces.set(spaces);
        if (spaces.some(isBuilding)) this.scheduleIndexPoll();
        else this.polling = false;
      },
      error: () => { if (this.polling) this.scheduleIndexPoll(); },
    });
  }

  private stopIndexPoll(): void {
    this.polling = false;
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
  }
}
