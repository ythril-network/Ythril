/**
 * The space-settings pop-up — identity, schema, duplicates and the Danger Zone for ONE space.
 *
 * ## Why it is its own component
 *
 * It was 84 lines of template inside `spaces.component`, reachable only from that page's own table. It is a
 * self-contained modal driven by a single signal — set `SpaceSettingsState.settingsSpace(space)` and it
 * appears — so hosting it somewhere else was only ever a question of who provides the service.
 *
 * That second host is the Brain page (U-1): a cog at the far right of the tab strip opens these settings for
 * the space you are already looking at, which is also where the per-space RIGHTS question is answered now that
 * the matrix has shipped. This extraction is the step that makes that a re-host rather than a rewrite, and it
 * is deliberately behaviour-neutral so the two changes can be reviewed apart.
 *
 * ## The template was MOVED, not retyped
 *
 * By line range, and asserted byte-identical against the original. A refactor that retypes eighty lines of
 * template is a refactor that loses one of them, and a modal that renders subtly wrong passes every build.
 *
 * ## Where the CSS lives
 *
 * All seven `.sp-*` rules are in `space-dialog.styles.ts` (lines 55-69) and nowhere else. I had claimed five of
 * them were inline in `spaces.component`'s own `styles` — that was a miscount: the grep behind it matched the
 * `<!-- sp-body -->` closing comments in the template, not CSS. There is one home for these rules, which is why
 * this extraction needs no style surgery at all.
 *
 * ## What came with it, and what deliberately did not
 *
 * `governedBy`, `saveSettings` and `attemptClose` moved — they exist only to serve this template. `canLeave`
 * and the `beforeunload` handler stayed on the Spaces page: they are ROUTE concerns, and a modal that can be
 * opened from two pages must not own either page's navigation guard.
 *
 * The discard prompt moved to the SERVICE rather than being copied, because both the modal's (X) and the
 * route guard need it. Two copies of "are you sure you want to lose these edits" is two places for the answer
 * to drift.
 */
import { SpaceSchemaLayersComponent } from './space-schema-layers.component';
import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, Injector, afterEveryRender, afterNextRender, computed, effect, forwardRef, inject, output, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { forkJoin, type Subscription } from 'rxjs';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { ModalDirective } from '../../shared/modal.directive';
import { StatusPillComponent } from '../../shared/status-pill.component';
import { SpacesApi } from '../../core/spaces-api.service';
import type { Space } from '../../core/api.types';
import { AuthApi } from '../../core/auth-api.service';
import { ConversionApi, conversionRefusalOf, convertNoticeOf } from '../../core/conversion-api.service';
import { SEVERAL } from '../../core/conversion-counts';
import type { ConversionRefusal, ConvertRunNotice, ConvertStatusAnswer } from '../../core/conversion.types';
import type { PollHandle } from '../../core/poll-until';
import { pageTranslator } from '../../core/page-translator';
import { ConvertRecordsDialogComponent, type ConvertDialogChoice } from './convert-records-dialog.component';
import { convertBlocks, withAddedTypes, type AddedType, type ConvertBlockPlan, type ConvertSchemas } from './convert-steps';
import { watchConvertRun } from './convert-status-watch';
import type { TokenRights } from './rights-glyph.component';
import { SpaceSettingsState, typeStateFromSchema } from './space-settings-state.service';
import { SpacesStore } from './spaces-store.service';
import { CONVERT_RUN_HOST, type ConvertRunHost } from './type-convert-bar.component';
import { SpaceSettingsTabComponent } from './space-settings-tab.component';
import { SpaceSchemaTabComponent } from './space-schema-tab.component';
import { SpaceDuplicatesTabComponent } from './space-duplicates-tab.component';
import { SpaceDangerTabComponent } from './space-danger-tab.component';
import { SPACE_DIALOG_STYLES } from './space-dialog.styles';
import { describeRefusal, refusalIssues } from '../../core/refusal-text';
import { isRdfRefusal, rdfRefusalText } from '../../core/rdf-refusal';
import { formatList } from '../../core/list-format';
import { ActiveLanguage } from '../../core/active-language';

/** What the footer's standing count of the changed types' records says: not known, none of them has records, or one does. `key` is the plan it was counted for. */
interface ConvertHint { state: 'unknown' | 'empty' | 'records'; key: string; types: { type: string; was?: string }[] }
const NO_HINT: ConvertHint = { state: 'unknown', key: '', types: [] };
/** Wait this long after an edit that changes which types are converted before counting their records: a count per keystroke is a request per keystroke. */
const HINT_WAIT_MS = 400;
/** The plan a hint was counted for: the types and their steps, so an edit inside a type (which changes neither) counts nothing again. */
const planKey = (blocks: readonly ConvertBlockPlan[]): string => JSON.stringify(blocks.map(b => [b.kind, b.type, b.was ?? null, b.steps]));

@Component({
  selector: 'app-space-settings-popup',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    SpaceSchemaLayersComponent,
    TranslocoPipe, PhIconComponent, ModalDirective, StatusPillComponent,
    SpaceSettingsTabComponent, SpaceSchemaTabComponent, SpaceDuplicatesTabComponent, SpaceDangerTabComponent, ConvertRecordsDialogComponent,
  ],
  styles: [SPACE_DIALOG_STYLES],
  // The type bars inside show a run (their Convert act's, or any run their note is about) through this popup's own progress dialog (`showRun`).
  providers: [{ provide: CONVERT_RUN_HOST, useExisting: forwardRef(() => SpaceSettingsPopupComponent) }],
  template: `
    <!-- SETTINGS POPUP -->
    @if (state.settingsSpace()) {
      <div class="sp-backdrop">
        <div class="sp-panel" [appModal]="state.settingsSpace()!.label" (dismiss)="attemptClose()">
          <div class="sp-header">
            <div style="flex:1;min-width:0;">
              <div style="font-weight:600;font-size:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">{{ state.settingsSpace()!.label }}</div>
              <div style="font-size:12px;color:var(--text-muted);font-family:var(--font-mono);">{{ state.settingsSpace()!.id }}</div>
            </div>
            <!-- Governed BEFORE you type, not after you press Save.
                 Saving a networked space answers 202 vote_pending: the change is submitted for a vote
                 rather than applied. That used to be discovered by pressing the button — the notice
                 explains it afterwards, which is the wrong end of the interaction to learn it. The
                 membership is already on the space record (its networks array), so this costs no request. -->
            @if (governedBy(); as nets) {
              <!-- The link icon, because that is what the sidebar already uses for Networks; the pill has
                   to read as the same concept, not a new one. (No users/gavel icon is registered, and an
                   unregistered name renders BLANK with no error.) -->
              <app-status-pill variant="pending" icon="link"
                [attr.title]="'spaces.popup.governedHint' | transloco: { networks: nets }">
                {{ 'spaces.popup.governed' | transloco }}
              </app-status-pill>
            }
            <button class="icon-btn" [attr.aria-label]="'common.close' | transloco" (click)="attemptClose()"><ph-icon name="x" [size]="14"/></button>
          </div>
          <div class="sp-tabs" role="tablist" [attr.aria-label]="'spaces.settings.tabsAriaLabel' | transloco">
            <button class="sp-tab" [class.active]="state.settingsTab()==='settings'" [attr.aria-selected]="state.settingsTab()==='settings'" role="tab" (click)="state.settingsTab.set('settings')">{{ 'spaces.popup.tab.settings' | transloco }}</button>
            <button class="sp-tab" [class.active]="state.settingsTab()==='schema'" [attr.aria-selected]="state.settingsTab()==='schema'" role="tab"   (click)="state.settingsTab.set('schema')">{{ 'spaces.popup.tab.schema' | transloco }}</button>
            <button class="sp-tab" [class.active]="state.settingsTab()==='duplicates'" [attr.aria-selected]="state.settingsTab()==='duplicates'" role="tab" (click)="state.settingsTab.set('duplicates')">{{ 'spaces.popup.tab.duplicates' | transloco }}</button>
            <button class="sp-tab danger-tab" [class.active]="state.settingsTab()==='danger'" [attr.aria-selected]="state.settingsTab()==='danger'" role="tab" (click)="state.settingsTab.set('danger')">{{ 'spaces.popup.tab.dangerZone' | transloco }}</button>
          </div>
          <div class="sp-body">

            <!-- SETTINGS TAB -->
            @if (state.settingsTab() === 'settings') {
              <app-space-settings-tab />
            }

            <!-- The three tabs that are not where the dialog opens are DEFERRED (Q-112): their code loads the first
                 time one is opened, which keeps this chunk inside its budget. Still gated on the tab, so leaving
                 one unmounts it. -->
            <!-- SCHEMA TAB -->
            @if (state.settingsTab() === 'schema') {
              @defer (on immediate) {
                <app-space-schema-layers [spaceId]="state.settingsSpace()!.id" />
                <app-space-schema-tab [convertNotice]="savedNotice()" />
              } @loading (minimum 200ms) { <span class="spinner"></span> }
            }

            <!-- DUPLICATES TAB -->
            @if (state.settingsTab() === 'duplicates') {
              @defer (on immediate) { <app-space-duplicates-tab /> } @loading (minimum 200ms) { <span class="spinner"></span> }
            }

            <!-- DANGER ZONE TAB -->
            @if (state.settingsTab() === 'danger') {
              @defer (on immediate) { <app-space-danger-tab /> } @loading (minimum 200ms) { <span class="spinner"></span> }
            }
          </div><!-- sp-body -->

          @if (state.settingsTab() !== 'danger' && state.settingsTab() !== 'duplicates') {
            <div class="sp-footer">
              @if (state.settingsError()) {
                <div class="alert alert-error" style="flex:1;margin:0;padding:6px 12px;font-size:13px;">{{ state.settingsError() }}</div>
              }
              <!-- Somebody else changed the schema first (412): saving again would send the same stale version, so the only way on is to read
                   the current one. -->
              @if (state.settingsConflict()) {
                <button class="btn btn-secondary" type="button" data-testid="reload-schema" (click)="reloadSchema()">{{ 'refusal.schemaChanged.reload' | transloco }}</button>
              }
              <!-- Hidden once a new edit lands: a stale "nothing to save" beside a form the
                   operator is actively editing says the opposite of the truth. -->
              @if (state.settingsNotice() && !state.isDirty()) {
                <div class="alert alert-info" style="flex:1;margin:0;padding:6px 12px;font-size:13px;">{{ state.settingsNotice() }}</div>
              }
              <!-- A changed type whose records are counted as none: said BEFORE the press, because the press then saves without asking. -->
              @if (state.isDirty() && conversionNote(); as note) {
                <div class="alert alert-info" style="flex:1;margin:0;padding:6px 12px;font-size:13px;" role="status" data-testid="convert-none-note">{{ note }}</div>
              }
              <!-- Once the outcome is TERMINAL, the button says so.
                   A governed save answers 202 and opens a vote, so the work is finished and there is nothing
                   left to submit, but the button still read "Save changes" and the only exit was the (X),
                   which universally means DISCARD. A reporting operator: "i have to click (X) which feels
                   unsure if the changes are now actually up for vote or discarded."
                   That is a wrong-action risk, not a wobble: read as cancel, someone looks for another way to
                   confirm, saves again, and creates a SECOND proposal for the same change. A button that
                   submitted successfully must not still be offering to submit. -->
              <!-- A finished state ends the moment there is a NEW edit. Without the dirty check a
                   vote-pending submission would keep Save hidden while the operator typed the next
                   change, which is the same trap B-15 was reported for by a different route. NOTE: no backticks
                   in a template comment -- one ends the template string and the error points at @Component. -->
              @if (state.settingsSubmitted() && !state.isDirty()) {
                <button class="btn btn-primary" type="button" data-testid="settings-done" (click)="state.closeSettings()">
                  {{ 'spaces.popup.footer.done' | transloco }}
                </button>
              } @else {
                <button class="btn btn-primary" type="button" data-testid="settings-save" (click)="saveSettings()" [disabled]="state.settingsSaving()">
                  @if (state.settingsSaving()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }{{ footerLabel() | transloco }}
                </button>
              }
            </div>
          }
        </div><!-- sp-panel -->
      </div><!-- sp-backdrop -->

      <!-- The conversion the Save offers, the run it leaves open, and the vote it was submitted to: one dialog, three faces, above this one. -->
      @if (offer(); as o) {
        <app-convert-records-dialog mode="offer" [spaceId]="state.settingsSpace()!.id" [blocks]="o.blocks" [staged]="o.staged"
          [network]="governedBy()" [rights]="rights()" [refusal]="refusal()" [busy]="state.settingsSaving()" (choice)="onChoice($event)" />
      }
      @if (progress(); as p) {
        <app-convert-records-dialog mode="progress" [spaceId]="state.settingsSpace()!.id" [status]="p.status" [notice]="p.notice" [byAct]="p.from === 'act'" [origin]="p.from"
          (closed)="closeProgress()" (openReview)="openReview()" />
      }
      @if (submitted(); as s) {
        <app-convert-records-dialog mode="submitted" [spaceId]="state.settingsSpace()!.id" [blocks]="s.blocks" [network]="s.network"
          (closed)="closeSubmitted()" (openNetworks)="openNetworks()" />
      }
    }
  `,
})
export class SpaceSettingsPopupComponent implements ConvertRunHost {
  readonly state = inject(SpaceSettingsState);
  private spacesApi = inject(SpacesApi);
  private transloco = inject(TranslocoService);
  private readonly say = pageTranslator();
  private readonly injector = inject(Injector);
  private readonly host = inject(ElementRef);
  private readonly language = inject(ActiveLanguage).language;
  /** The list store, so a successful save updates the row behind the modal. Both hosts provide it. */
  private store = inject(SpacesStore);

  /**
   * A save that was APPLIED, with the updated space.
   *
   * The store row behind the modal is already patched by `applySpace`, which is enough for the spaces
   * page — it renders from that store. The Brain host does not: it holds its own space list (with per-space
   * stats attached), so without this a rename saved from the Brain cog left the old label in the sidebar
   * that had just opened the dialog. Emitting the record rather than a bare signal means the host can patch
   * the one row instead of refetching the list.
   *
   * NOT emitted on the 202 vote_pending path: nothing has been applied yet, and a host that patched its
   * row there would show a change the network has not agreed to.
   */
  readonly saved = output<Space>();

  /**
   * Which networks govern this space, as a label list — or null when none do.
   *
   * Deliberately not keyed on `networkStatus`: that reports whether something is *happening* (a vote, a sync,
   * a degraded peer), and a quiet network still means Save opens a round. The question the badge answers is
   * "is this space governed", which is membership.
   */
  governedBy = computed(() => {
    const nets = this.state.settingsSpace()?.networks ?? [];
    return nets.length > 0 ? nets.map(n => n.label).join(', ') : null;
  });

  // ── The conversion a Save offers (bundle-285 slice S6, Q-747) ─────────────────────────────────────────────────────────

  /**
   * The schema as the space stores it, as `buildMeta` writes it: read whenever the state is re-baselined (opened, saved, rebased on the layers),
   * the one moment the staged schema IS the stored one. `convertBlocks` sets the staged schema against it to find the types a Save changes.
   */
  private stored: ConvertSchemas | null = null;
  private lastStored: ConvertSchemas | null = null;

  /** The dialog the Save opens (`offer`), the run it leaves open (`progress`) and the vote it went to (`submitted`): at most one of each. */
  protected readonly offer = signal<{ blocks: ConvertBlockPlan[]; staged: ConvertSchemas } | null>(null);
  protected readonly progress = signal<{ notice: ConvertRunNotice | null; status: ConvertStatusAnswer | null; from: 'save' | 'act' | 'note' } | null>(null);
  protected readonly submitted = signal<{ blocks: ConvertBlockPlan[]; network: string } | null>(null);
  /** What the last converting Save answered, kept after its dialog is closed: the Schema tab's type pane says from it that nothing was converted. */
  protected readonly savedNotice = signal<ConvertRunNotice | null>(null);
  /** The refusal of the last converting Save, for the dialog to word; cleared when it is tried again. */
  protected readonly refusal = signal<ConversionRefusal | null>(null);
  /** The token's rights, read once when the dialog first opens; unknown (`undefined`, or `null` when unreadable) counts as allowed: the server decides. */
  protected readonly rights = signal<TokenRights | null | undefined>(undefined);

  /** The footer's standing count (see `refreshHint`), and what it was counted for. */
  protected readonly hint = signal<ConvertHint>(NO_HINT);
  private hintKey = '';
  private lastSnapshot = '';
  private hintTimer: ReturnType<typeof setTimeout> | undefined;
  private hintRead: Subscription | undefined;

  private watch: PollHandle | null = null;
  private pollFailed = false;
  /** The popup opened on the Schema tab with a type chosen, and that type's head has not been drawn yet: once it is, it is shown (`showTypeOnceDrawn`). */
  private typeToShow = false;
  /** The space the dialogs above belong to: another space opening ends them. */
  private convertSpace = '';

  /** "Submit for vote" when the save will open a vote about types that hold records (drawing 4a); otherwise the plain Save. */
  protected readonly footerLabel = computed(() => (this.governedBy() && this.hint().state === 'records' ? 'spaces.schema.convert.submitForVote' : 'spaces.popup.footer.saveChanges'));

  /** The footer's line for changed types with no records at all (plan F2), in the words of the drawing; none otherwise. */
  protected readonly conversionNote = computed<string | null>(() => {
    const h = this.hint();
    if (h.state !== 'empty' || h.types.length === 0) return null;
    const first = h.types[0]!;
    const network = this.governedBy();
    if (network) return this.say('spaces.schema.convert.noRecordsNet', { network, type: first.was ?? first.type });
    if (h.types.length >= SEVERAL) return this.say('spaces.schema.convert.noRecordsTwo');
    return first.was !== undefined ? this.say('spaces.schema.convert.noRecordsShort', { type: first.was }) : this.say('spaces.schema.convert.noRecords', { type: first.type });
  });

  constructor() {
    effect(() => {
      this.state.schemaEpoch();
      const open = this.state.settingsSpace();
      untracked(() => { this.stored = open ? (this.state.buildMeta().typeSchemas as ConvertSchemas) : null; });
    });
    effect(() => {
      const open = this.state.settingsSpace();
      untracked(() => { if (!open || open.id !== this.convertSpace) this.endConversion(); });
    });
    // Opened on the Schema tab with a type already chosen (the Overview's pencil): that type is what the person asked to see.
    let wasOpen = false;
    effect(() => {
      const open = this.state.settingsSpace() !== null;
      untracked(() => { this.typeToShow = open && (wasOpen ? this.typeToShow : this.state.settingsTab() === 'schema' && this.state.schSelectedType !== null); });
      wasOpen = open;
    });
    // After every render, not in `ngDoCheck`: a hook of this component runs only when its PARENT's view is refreshed, and an edit made deep in
    // the Schema tab marks the popup for traversal, not for refresh. A render follows every edit event.
    afterEveryRender(() => { this.refreshHint(); this.showTypeOnceDrawn(); });
    inject(DestroyRef).onDestroy(() => this.endConversion());
  }

  /** The types a Save with these changes converts, and the schema they are read from; none when the body changes no type. */
  private plan(body: Record<string, unknown>): { blocks: ConvertBlockPlan[]; staged: ConvertSchemas } {
    const staged = (body['meta'] as { typeSchemas?: ConvertSchemas } | undefined)?.typeSchemas;
    if (!staged || !this.stored) return { blocks: [], staged: {} };
    return { blocks: convertBlocks(this.stored, staged, this.state.renameLedger()), staged };
  }

  /**
   * The footer's standing count: once an edit changes WHICH types a Save converts (not what is inside them), their records are counted after a
   * short wait, so a Save that has nothing to ask can say so before the press and then save without a dialog. Run after every render, so it only
   * compares two strings unless the staged schema moved; it never writes a signal except to forget a count that no longer applies.
   */
  private refreshHint(): void {
    if (!this.state.settingsSpace()) return;
    const snapshot = this.state.snapshot();
    if (snapshot === this.lastSnapshot && this.stored === this.lastStored) return;
    this.lastSnapshot = snapshot;
    this.lastStored = this.stored;
    const blocks = this.plan(this.state.changedSettings()).blocks;
    const key = blocks.length > 0 ? planKey(blocks) : '';
    if (key === this.hintKey) return;
    this.hintKey = key;
    clearTimeout(this.hintTimer);
    this.hintRead?.unsubscribe();
    this.hint.set(NO_HINT);
    if (key) {
      const space = this.state.settingsSpace()!.id;
      this.hintTimer = setTimeout(() => this.countHint(space, key, blocks), HINT_WAIT_MS);
    }
  }

  private countHint(space: string, key: string, blocks: readonly ConvertBlockPlan[]): void {
    let api: ConversionApi;
    try { api = this.injector.get(ConversionApi); } catch { return; }   // a host with no HTTP client counts nothing: the dialog asks, as it does for an unknown count
    this.hintRead = forkJoin(blocks.map(b => api.countsFor(space, { kind: b.kind, type: b.type, ...(b.was !== undefined ? { was: b.was } : {}), steps: [] }))).subscribe(answers => {
      if (this.hintKey !== key) return;
      const state = answers.some(a => a.ok && a.counts.total > 0) ? 'records' : answers.every(a => a.ok) ? 'empty' : 'unknown';
      this.hint.set({ state, key, types: blocks.map(b => ({ type: b.type, ...(b.was !== undefined ? { was: b.was } : {}) })) });
    });
  }

  /** Stop everything the conversion started here: the run's watch, the dialogs, the footer's count. */
  private endConversion(): void {
    this.watch?.stop();
    this.watch = null;
    this.offer.set(null);
    this.progress.set(null);
    this.savedNotice.set(null);
    this.submitted.set(null);
    this.refusal.set(null);
    this.convertSpace = '';
    clearTimeout(this.hintTimer);
    this.hintRead?.unsubscribe();
    this.hintKey = '';
    this.lastSnapshot = '';
    this.hint.set(NO_HINT);
  }

  private loadRights(): void {
    if (this.rights() !== undefined) return;
    let auth: AuthApi;
    try { auth = this.injector.get(AuthApi); } catch { return; }
    auth.verifyToken().subscribe({ next: me => this.rights.set(me.rights ?? null), error: () => this.rights.set(null) });
  }

  /** Close the pop-up, prompting first if the editor has unsaved edits. */
  async attemptClose(): Promise<void> {
    if (await this.state.confirmDiscardIfDirty()) this.state.closeSettings();
  }

  saveSettings(): void {
    const target = this.state.settingsSpace();
    if (!target) return;
    this.state.settingsSaving.set(true);
    this.state.settingsError.set('');
    this.state.settingsNotice.set('');
    this.state.settingsConflict.set(false);
    this.state.ruleRefusal.set(null);
    /*
     * ONLY WHAT CHANGED. See `changedSettings()` for why, and for the two fields that are not a plain diff.
     *
     * Every field on this route answers to the area that owns it since 4.4, so posting the whole form made
     * the highest requirement in it decide — a `files` writer editing a media level was refused for the
     * twenty-one fields they had not touched.
     *
     * The empty case is a real one: the footer Save is reachable with nothing edited, and the body is
     * `.strict()` with an at-least-one-field refine, so sending `{}` would be a 400 rather than a no-op.
     */
    const body = this.bodyNow();
    if (!Object.keys(body).length) {
      this.state.settingsSaving.set(false);
      // A notice and NOT a submission: nothing was sent, so Save has to stay. Before `B-15` this
      // retired the button for the rest of the session.
      this.state.settingsNotice.set(this.transloco.translate('spaces.settings.nothingToSave'));
      return;
    }
    // A changed type whose records exist (or are not known yet) is asked about first: the dialog says what converting would do and the
    // answer decides whether the save carries `convertRecords`. Only counts that SAY none, for every changed type, save without asking.
    const { blocks, staged } = this.plan(body);
    if (blocks.length > 0 && this.hintFor(blocks) !== 'empty') {
      this.state.settingsSaving.set(false);
      this.loadRights();
      this.convertSpace = target.id;
      this.refusal.set(null);
      this.offer.set({ blocks, staged });
      return;
    }
    this.send(target, body, null);
  }

  /** What the standing count says of this plan: nothing, unless it was counted for exactly this plan. */
  private hintFor(blocks: readonly ConvertBlockPlan[]): ConvertHint['state'] {
    const h = this.hint();
    return h.key === planKey(blocks) ? h.state : 'unknown';
  }

  /**
   * ONLY WHAT CHANGED (`changedSettings`), with an emptied label left out: it means "unchanged", not "no name", because the diff compares
   * against what the dialog opened with, so a blank simply does not appear in the body.
   */
  private bodyNow(): Record<string, unknown> {
    const body = this.state.changedSettings();
    if (body['label'] === '') delete body['label'];
    return body;
  }

  /**
   * Send the save. `choice` is the dialog's answer when it was "convert", and only then does the body carry `convertRecords`: the steps are put
   * in HERE, from the choice, so no other path can send them. A schema save is conditional on the version of the meta the dialog read
   * (If-Match): a save made on top of somebody else's change is refused (412) instead of overwriting it.
   */
  private send(target: Space, base: Record<string, unknown>, choice: ConvertDialogChoice | null): void {
    const body = choice ? { ...base, convertRecords: { steps: choice.steps } } : base;
    const ifMatch = 'meta' in body && this.state.schMetaVersion !== undefined ? { ifMatch: this.state.schMetaVersion } : {};
    this.state.settingsSaving.set(true);
    this.refusal.set(null);
    this.spacesApi.updateSpace(target.id, body, ifMatch).subscribe({
      next: (result) => {
        this.state.settingsSaving.set(false);
        // The instance-local setting is in force whatever else the save did, and a clear is a key the server's answer leaves out,
        // which `applySpace`'s merge would not remove: so the list's copy is set from what was sent, before either answer is read.
        const localSetting = 'unknownWriteFields' in body;
        if (localSetting) this.store.setUnknownWriteFields(target.id, body['unknownWriteFields'] as 'warn' | 'refuse' | '' | null);
        // A networked space does not apply a meta change on the spot: the server opens a vote round per
        // network and answers 202 with no `space`. Destructuring it as one threw inside this callback —
        // which RxJS does not route to `error` — so Save appeared to do nothing at all, and the editor
        // then asked whether to discard the change it had just submitted. Say what happened instead.
        if (result.status === 'vote_pending') {
          const networks = result.rounds.map(r => r.networkLabel).join(', ');
          // The one setting of this save that is NOT held: it is local to this instance and not part of the vote, so the server
          // applied it before answering. Say so (the answer carries no space to merge; the list was refreshed above).
          this.state.settingsNotice.set(localSetting
            ? this.transloco.translate('spaces.settings.votePendingLocalNow', { networks })
            : choice
              ? this.transloco.translate('spaces.schema.convert.submitted.notice', { network: networks })
              : this.transloco.translate('spaces.settings.votePending', { networks }));
          this.state.markPristine();   // it is submitted; it is not an unsaved edit any more
          this.state.settingsSubmitted.set(true);  // ...and Save must stop offering to submit it again
          // A conversion that goes with the vote is said on its own dialog: the steps and this instance's counts stay on screen, and the way to the vote is a button.
          if (choice) {
            this.offer.set(null);
            this.showFirstConverted(choice);
            this.submitted.set({ blocks: choice.blocks.map(b => ({ ...b, offers: [], warnings: [] })), network: networks });
          }
          return;                      // stay open so the notice is read, unlike the applied path
        }
        this.store.applySpace(result.space);
        this.saved.emit(result.space);
        // A space in more than one network can answer one outcome per network: applied in one, held for a vote in another. The
        // applied half has happened, the pending half has not, and the dialog says both by name instead of closing on the first
        // or reporting only the second.
        const pending = (result.layers ?? []).filter(l => l.outcome === 'vote_pending');
        if (pending.length > 0) {
          const applied = (result.layers ?? []).filter(l => l.outcome === 'applied');
          const lang = this.language();
          this.state.settingsNotice.set(this.transloco.translate('spaces.settings.layersMixed', {
            applied: formatList(applied.map(l => l.networkLabel), lang),
            pending: formatList(pending.map(l => l.networkLabel), lang),
          }));
          this.state.markPristine();
          this.state.settingsSubmitted.set(true);
          if (choice) this.afterConvert(target, choice, result);
          return;
        }
        // Re-baseline BEFORE closing. The dirty snapshot was only ever taken when a space was opened, so
        // a successful save left it stale: the editor still compared against the pre-save values and
        // reported unsaved changes for edits that were already persisted. Closing here happened to hide
        // it, but any path that keeps the dialog open (or reopens it without a full load) nagged — and a
        // discard prompt after a save teaches people to click through discard prompts.
        this.state.markPristine();
        // A converting save stays open: the run is the next thing to read, in the dialog and on the type.
        if (choice) { this.state.settingsSubmitted.set(true); this.afterConvert(target, choice, result); return; }
        this.offer.set(null);
        this.state.closeSettings();
      },
      error: (err) => {
        this.state.settingsSaving.set(false);
        const view = describeRefusal(this.transloco, '', err, 'spaces.error.saveFailed');
        // The refusals of the RDF setting (a base another space holds, or nests with) are worded in the RDF family: the networks one has none.
        const text = isRdfRefusal(err) ? rdfRefusalText(this.transloco, err) : view.text;
        this.state.settingsError.set(text);
        // 412: somebody changed the schema first - offer to read the current one. Anything else that names a rule opens that rule.
        const ruleShown = view.reload ? false : this.state.showRuleRefusal(refusalIssues(err), text);
        if (view.reload) this.state.settingsConflict.set(true);
        // The dialog keeps a refusal it can word and the user can act on from there (a bad step, the rate limit, the lock, a conversion already
        // running); a stale schema or a rule is answered in the popup, so the dialog goes and the popup says it.
        if (!this.offer()) return;
        if (view.reload || ruleShown) { this.offer.set(null); return; }
        this.state.settingsError.set('');
        this.refusal.set(conversionRefusalOf(err));
      },
    });
  }

  /** What the dialog answered. Cancel saves nothing and leaves every edit; Save only sends today's body; Convert sends the steps with it. */
  protected onChoice(choice: ConvertDialogChoice): void {
    const target = this.state.settingsSpace();
    if (!this.offer() || !target) return;
    if (choice.outcome === 'cancel') { this.offer.set(null); this.refusal.set(null); return; }
    if (choice.outcome === 'later') { this.offer.set(null); this.send(target, this.bodyNow(), null); return; }
    if (choice.addedTypes.length > 0) this.addTypes(choice.addedTypes);
    this.send(target, this.bodyNow(), choice);
  }

  /** The types "Add a new type" made are part of the schema being saved: in the staged state (so no later Save deletes them), as copies of their sources. */
  private addTypes(added: readonly AddedType[]): void {
    const withAdded = withAddedTypes(this.state.buildMeta().typeSchemas as ConvertSchemas, added);
    const next = { ...this.state.schTypeSchemas };
    for (const { kind, name } of added) {
      if (next[kind]?.[name]) continue;
      next[kind] = { ...(next[kind] ?? {}), [name]: typeStateFromSchema(withAdded[kind]?.[name]) };
    }
    this.state.schTypeSchemas = next;
  }

  /** The schema is saved and the popup stays open: select the first converted type, and show what became of the run the save asked for. */
  /** The Schema tab with the first type a conversion names selected: where its note (running, finished, or waiting for the vote) is read. */
  private showFirstConverted(choice: ConvertDialogChoice): void {
    const first = choice.types[0];
    if (!first) return;
    this.state.settingsTab.set('schema');
    this.state.schemaCollTab.set(first.kind);
    this.state.selectType(first.kind, first.type);
  }

  private afterConvert(target: Space, choice: ConvertDialogChoice, result: unknown): void {
    this.offer.set(null);
    this.showFirstConverted(choice);
    const notice = convertNoticeOf(result) ?? { state: 'nothing' as const, types: [] };
    this.convertSpace = target.id;
    this.progress.set({ notice, status: null, from: 'save' });
    // An answer that lists no types is about the types this Save converted.
    this.savedNotice.set(notice.types.length > 0 ? notice : { ...notice, types: choice.types });
    if (notice.state === 'started') this.watchRun(target.id);
  }

  /**
   * A type's Convert act started a run, or a type's note asks to show its run (of any source, a vote's included): shown as a converting Save's
   * run is shown, in the same dialog, on the same watch, starting from the status the caller last read.
   */
  showRun(notice: ConvertRunNotice | null, from: 'act' | 'note', status: ConvertStatusAnswer | null = null): void {
    const space = this.state.settingsSpace();
    if (!space) return;
    this.convertSpace = space.id;
    this.progress.set({ notice, status, from });
    this.watchRun(space.id);
  }

  /** Read the run on the bound `watchConvertRun` keeps; a failed read says so in the footer and the next good answer takes the sentence away. */
  private watchRun(spaceId: string): void {
    this.watch?.stop();
    const clearFailure = (): void => { if (this.pollFailed) { this.pollFailed = false; this.state.settingsError.set(''); } };
    this.watch = watchConvertRun(this.injector.get(ConversionApi), spaceId, {
      onStatus: status => { clearFailure(); this.progress.update(p => (p ? { ...p, status } : p)); },
      onFailure: () => { this.pollFailed = true; this.state.settingsError.set(this.transloco.translate('spaces.schema.convert.run.pollFailed')); },
    });
  }

  protected closeProgress(): void {
    const from = this.progress()?.from ?? 'save';
    this.watch?.stop();
    this.watch = null;
    this.progress.set(null);
    this.afterDialogClosed(from);
  }

  /** "Submitted for a vote" closed: the type head with its waiting note in view, focus on the footer button that took Save's place. */
  protected closeSubmitted(): void {
    this.submitted.set(null);
    this.afterDialogClosed('save');
  }

  /** The two closes of a dialog this popup opened over the Schema tab (the run's, the vote's) end alike. */
  private afterDialogClosed(from: 'save' | 'act' | 'note'): void {
    afterNextRender(() => this.backToWhereTheFlowBegan(from), { injector: this.injector });
  }

  /**
   * The popup opened on a type (the Overview's pencil, S12): once the Schema tab (a deferred block) has drawn that type's head, it is shown as a
   * closed run's dialog shows it, scrolled into view with focus in it. The modal keeps the pencil as the element to give focus back to on close.
   */
  private showTypeOnceDrawn(): void {
    if (!this.typeToShow || !(this.host.nativeElement as HTMLElement).querySelector('.sch-detail-head')) return;
    this.typeToShow = false;
    this.backToWhereTheFlowBegan('type');
  }

  /**
   * Once the dialog is gone, scroll the type head with its note into view and put focus on the control that led there: the type's Convert records
   * for the act, the note's "Show the run" for a run shown from the note, the footer button that took Save's place (Done) for a Save. The modal
   * returns focus to the element focused when it opened, and that element no longer exists (the act's dialog, or Save), so without this focus
   * fell to the page body (drive D5). Opened on a type (`type`), focus goes to the type's name control (its rename button, the first button of the
   * head): it names the type, so a screen reader says which type opened, and Tab goes on from the head into the type's editor below it.
   */
  private backToWhereTheFlowBegan(from: 'save' | 'act' | 'note' | 'type'): void {
    const host = this.host.nativeElement as HTMLElement;
    // The type head and the note under it are what the run is told by now: scrolled into view (the pane kept the scroll it had behind the dialog).
    const head = host.querySelector<HTMLElement>('.sch-detail-head');
    head?.scrollIntoView?.({ block: 'start' });
    const to = from === 'act' ? host.querySelector<HTMLElement>('[data-testid="convert-records"]')
      : from === 'note' ? host.querySelector<HTMLElement>('[data-testid="convert-show-run"]')
        : from === 'type' ? head?.querySelector<HTMLElement>('button') ?? null
          : host.querySelector<HTMLElement>('[data-testid="settings-done"], [data-testid="settings-save"]');
    to?.focus({ preventScroll: true });
  }

  /** Open Review on the Unconverted section, asking first when the popup holds an edit the move would lose. */
  protected async openReview(): Promise<void> {
    const space = this.state.settingsSpace()?.id;
    if (!space || !(await this.state.confirmDiscardIfDirty())) return;
    this.state.closeSettings();
    void this.injector.get(Router).navigate(['/brain'], { queryParams: { space, tab: 'review', section: 'unconverted' } });
  }

  /** Open Networks, where the vote this save opened is decided. */
  protected async openNetworks(): Promise<void> {
    if (!(await this.state.confirmDiscardIfDirty())) return;
    this.state.closeSettings();
    void this.injector.get(Router).navigate(['/settings/networks']);
  }

  /** Read the schema as it is now, after a 412. The staged edits are what is lost, so the usual discard question is asked first. */
  async reloadSchema(): Promise<void> {
    const id = this.state.settingsSpace()?.id;
    if (!id || !(await this.state.confirmDiscardIfDirty())) return;
    this.spacesApi.listSpaces().subscribe({
      next: ({ spaces }) => {
        const fresh = spaces.find(s => s.id === id);
        if (!fresh) return;
        this.store.applySpace(fresh);
        this.state.openSettings(fresh);
        this.state.settingsTab.set('schema');
      },
      error: (err) => this.state.settingsError.set(describeRefusal(this.transloco, '', err, 'spaces.error.saveFailed').text),
    });
  }
}
