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
import { ChangeDetectionStrategy, Component, computed, inject, output } from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { ModalDirective } from '../../shared/modal.directive';
import { StatusPillComponent } from '../../shared/status-pill.component';
import { SpacesApi } from '../../core/spaces-api.service';
import type { Space } from '../../core/api.types';
import { SpaceSettingsState } from './space-settings-state.service';
import { SpacesStore } from './spaces-store.service';
import { SpaceSettingsTabComponent } from './space-settings-tab.component';
import { SpaceSchemaTabComponent } from './space-schema-tab.component';
import { SpaceDuplicatesTabComponent } from './space-duplicates-tab.component';
import { SpaceDangerTabComponent } from './space-danger-tab.component';
import { SPACE_DIALOG_STYLES } from './space-dialog.styles';

@Component({
  selector: 'app-space-settings-popup',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    TranslocoPipe, PhIconComponent, ModalDirective, StatusPillComponent,
    SpaceSettingsTabComponent, SpaceSchemaTabComponent, SpaceDuplicatesTabComponent, SpaceDangerTabComponent,
  ],
  styles: [SPACE_DIALOG_STYLES],
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

            <!-- SCHEMA TAB -->
            @if (state.settingsTab() === 'schema') {
              <app-space-schema-tab />
            }

            <!-- DUPLICATES TAB -->
            @if (state.settingsTab() === 'duplicates') {
              <app-space-duplicates-tab />
            }

            <!-- DANGER ZONE TAB -->
            @if (state.settingsTab() === 'danger') {
              <app-space-danger-tab />
            }
          </div><!-- sp-body -->

          @if (state.settingsTab() !== 'danger' && state.settingsTab() !== 'duplicates') {
            <div class="sp-footer">
              @if (state.settingsError()) {
                <div class="alert alert-error" style="flex:1;margin:0;padding:6px 12px;font-size:13px;">{{ state.settingsError() }}</div>
              }
              @if (state.settingsNotice()) {
                <div class="alert alert-info" style="flex:1;margin:0;padding:6px 12px;font-size:13px;">{{ state.settingsNotice() }}</div>
              }
              <!-- Once the outcome is TERMINAL, the button says so.
                   A governed save answers 202 and opens a vote, so the work is finished and there is nothing
                   left to submit, but the button still read "Save changes" and the only exit was the (X),
                   which universally means DISCARD. A reporting operator: "i have to click (X) which feels
                   unsure if the changes are now actually up for vote or discarded."
                   That is a wrong-action risk, not a wobble: read as cancel, someone looks for another way to
                   confirm, saves again, and creates a SECOND proposal for the same change. A button that
                   submitted successfully must not still be offering to submit. -->
              @if (state.settingsNotice()) {
                <button class="btn btn-primary" type="button" (click)="state.closeSettings()">
                  {{ 'spaces.popup.footer.done' | transloco }}
                </button>
              } @else {
                <button class="btn btn-primary" type="button" (click)="saveSettings()" [disabled]="state.settingsSaving()">
                  @if (state.settingsSaving()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }{{ 'spaces.popup.footer.saveChanges' | transloco }}
                </button>
              }
            </div>
          }
        </div><!-- sp-panel -->
      </div><!-- sp-backdrop -->
    }
  `,
})
export class SpaceSettingsPopupComponent {
  readonly state = inject(SpaceSettingsState);
  private spacesApi = inject(SpacesApi);
  private transloco = inject(TranslocoService);
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
    const body = this.state.changedSettings();
    if (!Object.keys(body).length) {
      this.state.settingsSaving.set(false);
      this.state.settingsNotice.set(this.transloco.translate('spaces.settings.nothingToSave'));
      return;
    }
    // An emptied label field means "unchanged", not "no name": the diff compares against what the dialog
    // opened with, so a blank simply does not appear in the body.
    if (body['label'] === '') delete body['label'];
    this.spacesApi.updateSpace(target.id, body).subscribe({
      next: (result) => {
        this.state.settingsSaving.set(false);
        // A networked space does not apply a meta change on the spot: the server opens a vote round per
        // network and answers 202 with no `space`. Destructuring it as one threw inside this callback —
        // which RxJS does not route to `error` — so Save appeared to do nothing at all, and the editor
        // then asked whether to discard the change it had just submitted. Say what happened instead.
        if (result.status === 'vote_pending') {
          this.state.settingsNotice.set(this.transloco.translate('spaces.settings.votePending', {
            networks: result.rounds.map(r => r.networkLabel).join(', '),
          }));
          this.state.markPristine();   // it is submitted; it is not an unsaved edit any more
          return;                      // stay open so the notice is read, unlike the applied path
        }
        this.store.applySpace(result.space);
        this.saved.emit(result.space);
        // Re-baseline BEFORE closing. The dirty snapshot was only ever taken when a space was opened, so
        // a successful save left it stale: the editor still compared against the pre-save values and
        // reported unsaved changes for edits that were already persisted. Closing here happened to hide
        // it, but any path that keeps the dialog open (or reopens it without a full load) nagged — and a
        // discard prompt after a save teaches people to click through discard prompts.
        this.state.markPristine();
        this.state.closeSettings();
      },
      error: (err) => { this.state.settingsSaving.set(false); this.state.settingsError.set(err.error?.error ?? this.transloco.translate('spaces.error.saveFailed')); },
    });
  }
}
