import { Injector, computed, effect, inject, signal, untracked, type ProviderToken, type Signal } from '@angular/core';
import type { Subscription } from 'rxjs';
import type { Space } from '../../core/api.types';
import { AuthApi } from '../../core/auth-api.service';
import { ConversionApi } from '../../core/conversion-api.service';
import { holdsSchemaAdmin } from '../../core/token-capability';
import type { TokenRights } from '../settings/rights-glyph.component';
import { SpaceSettingsState } from '../settings/space-settings-state.service';

/**
 * What the Brain page does with the schema and the conversion, kept out of the page (bundle-285 slice S6, Q-747; plan sections 3.1, 5 row V1, 14).
 *
 * `brain.component.ts` is frozen at its size, so a concern moves out along a real seam before the page may carry another: "open the settings
 * pop-up from this page, on a space or on a type of its data model" (`openSettings`, which the cog used to do in the page, and `editType`), and
 * "what the page knows about the conversion" (the count on the Review tab, and whether the token may change the schema, which draws the pencil).
 *
 * ## What it prevents
 *
 * - **A pencil nobody can press, or a pencil that does nothing.** The Overview's data model draws a pencil on each type only when told the token may
 *   change the schema (`canEditSchema`), and reports a press as the type's name. The page bound neither, so the pencil was never drawn. The right is
 *   `holdsSchemaAdmin` on the open space (the Schema tab's own rule), false while the rights are unknown: a control that may fail is not drawn on a guess.
 * - **A type the pop-up cannot show.** A press on a type the schema does not declare yet (the "+") declares it, then selects it: the Schema tab shows only
 *   declared types. The data model draws entity types only, so the pop-up opens on the entities.
 * - **A count that outlives its space.** The Review tab's count is read once per space the page shows, an answer for another space is dropped, a personal
 *   view (which has no Review tab) is never asked, and a count that is zero, unknown or failed is `null`: the tab shows a number only for a real one.
 * - **A count that outlives an act (S12, Q-939).** The page's own read is the count only until the Review tab's Unconverted section has read one
 *   (`seen`, after its every list answer: a dismiss, a bulk dismiss, a run's records), and the settings pop-up closing reads it again. The page reads it
 *   on no timer: every change comes from an act on this page.
 * - **A host with no network to ask.** The reads go through the injector; a host without them draws no count and no pencil, and nothing throws.
 *
 * Call {@link brainSchemaLinks} once, as a field initializer (it injects).
 */
export class BrainSchemaLinks {
  /** The token's rights as read once; `null` until then, and when they cannot be read. */
  private readonly rights = signal<TokenRights | null>(null);
  /** Does the token hold the schema right on the open space: the pencil of the data model is drawn exactly when it does. */
  readonly canEditSchema = computed(() => holdsSchemaAdmin(this.rights(), this.spaceId()));
  /** The open unconverted records of the open space, or `null` while unknown, when nothing is open and when the read failed. */
  readonly unconvertedOpen = signal<number | null>(null);

  private read: Subscription | undefined;

  constructor(
    private readonly state: SpaceSettingsState,
    private readonly spaceId: Signal<string>,
    private readonly isView: Signal<boolean>,
    private readonly injector: Injector,
  ) {
    this.api(AuthApi)?.verifyToken().subscribe({ next: me => this.rights.set(me.rights ?? null), error: () => this.rights.set(null) });
    effect(() => {
      const space = this.spaceId();
      const view = this.isView();
      untracked(() => this.readUnconverted(space, view));
    });
    // The pop-up closing: a Save, a type's Convert records or a vote's run seen there may have converted records while it was open.
    let settingsOpen = false;
    effect(() => {
      const open = this.state.settingsSpace() !== null;
      if (settingsOpen && !open) untracked(() => this.refresh());
      settingsOpen = open;
    });
  }

  /**
   * The open count the Review tab's Unconverted section read for `space`, after its every list answer (a load, a dismiss, a bulk dismiss, a run's
   * records): from then on the tab shows that number, never an older read of the page's own (one still on its way is dropped). An answer about a
   * space the page no longer shows is dropped.
   */
  seen(read: { space: string; open: number }): void {
    if (read.space !== this.spaceId() || this.isView()) return;
    this.read?.unsubscribe();
    this.unconvertedOpen.set(read.open > 0 ? read.open : null);
  }

  private api<T>(token: ProviderToken<T>): T | null {
    try { return this.injector.get(token); } catch { return null; }
  }

  /** Read the open count again, for the space shown now (when the settings pop-up closes: a conversion may have run in it). */
  refresh(): void {
    this.readUnconverted(this.spaceId(), this.isView());
  }

  private readUnconverted(space: string, view: boolean): void {
    this.read?.unsubscribe();
    this.unconvertedOpen.set(null);
    const conversion = space && !view ? this.api(ConversionApi) : null;
    if (!conversion) return;
    this.read = conversion.listUnconverted(space, { limit: 1 }).subscribe(result => {
      if (space !== this.spaceId()) return;
      const open = result.ok ? result.value.counts?.open : undefined;
      this.unconvertedOpen.set(typeof open === 'number' && open > 0 ? open : null);
    });
  }

  /** Open the space's settings on their first tab (the cog). */
  openSettings(space: Space | undefined): void {
    if (space) this.state.openSettings(space);
  }

  /** Open the space's settings on the Schema tab with the entity type `type` selected; a type the schema does not declare yet is declared first. */
  editType(space: Space | undefined, type: string): void {
    if (!space) return;
    this.state.openSettings(space);
    this.state.settingsTab.set('schema');
    this.state.schemaCollTab.set('entity');
    if (this.state.typeNames('entity').includes(type)) { this.state.selectType('entity', type); return; }
    this.state.schNewTypeInputs = { ...this.state.schNewTypeInputs, entity: type };
    this.state.addType('entity');
  }
}

/** The Brain page's links into the schema and the conversion; call as a field initializer, AFTER the signals it reads are declared. */
export function brainSchemaLinks(state: SpaceSettingsState, spaceId: Signal<string>, isView: Signal<boolean>): BrainSchemaLinks {
  return new BrainSchemaLinks(state, spaceId, isView, inject(Injector));
}
