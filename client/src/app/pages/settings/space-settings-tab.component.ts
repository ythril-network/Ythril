/**
 * Settings tab — identity, purpose, and storage limits, grouped into SettingsCards (PR-U9 pt3).
 *
 * Extracted from SpacesComponent (A17.8b). Needs no inputs and no data outputs: SpacesStore owns
 * the server data and SpaceSettingsState owns the dialog form state, and both are services the
 * page provides — so this component just renders them and calls them.
 *
 * The schema-validation controls (`validationMode`, `strictLinkage`) deliberately live on the SCHEMA
 * tab, not here: validation posture governs the schemas, so it belongs beside them (U9 pt3 IA fix).
 * Their state still lives in the shared SpaceSettingsState, so moving the inputs changed nothing about
 * how the footer save persists them.
 */
import { Component, ChangeDetectionStrategy, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslocoPipe } from '@jsverse/transloco';
import { SPACE_DIALOG_STYLES } from './space-dialog.styles';
import { SpaceSettingsState } from './space-settings-state.service';
import { SpacesStore } from './spaces-store.service';
import { SettingsCardComponent } from '../../shared/settings-card.component';
import { SpaceRdfCardComponent } from './space-rdf-card.component';

@Component({
  selector: 'app-space-settings-tab',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslocoPipe, SettingsCardComponent, SpaceRdfCardComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [SPACE_DIALOG_STYLES, `
    /* A cap you cannot see is one you only learn about by losing work. Muted until it matters, then not. */
    .char-count { font-size: 11px; color: var(--text-muted); text-align: right; margin-top: 3px;
      font-variant-numeric: tabular-nums; }
    .char-count.near { color: var(--warning); font-weight: 600; }
  `],
  template: `
<div style="display:flex;flex-direction:column;gap:16px;max-width:720px;">

  <app-settings-card icon="tag" [heading]="'spaces.settings.card.identity' | transloco" [purpose]="'spaces.settings.card.identityHint' | transloco">
    <div class="field" style="margin:0;">
      <label>{{ 'spaces.settings.label' | transloco }}</label>
      <input type="text" [(ngModel)]="state.stForm.label" maxlength="200" />
    </div>
  </app-settings-card>

  <app-settings-card icon="info" [heading]="'spaces.settings.card.purpose' | transloco" [purpose]="'spaces.settings.card.purposeCardHint' | transloco">
    <div class="field">
      <label>{{ 'spaces.settings.purpose' | transloco }} <span style="font-size:11px;color:var(--text-muted);font-weight:normal;">{{ 'spaces.settings.purposeHint' | transloco }}</span></label>
      <textarea [(ngModel)]="state.stForm.purpose" rows="6" [attr.maxlength]="PURPOSE_MAX" style="resize:vertical;"></textarea>
      <div class="char-count" [class.near]="near(state.stForm.purpose, PURPOSE_MAX)">{{ (state.stForm.purpose || '').length }} / {{ PURPOSE_MAX }}</div>
    </div>
    <div class="field" style="margin-bottom:0;">
      <label>{{ 'spaces.settings.usageNotes' | transloco }} <span style="font-size:11px;color:var(--text-muted);font-weight:normal;">{{ 'spaces.settings.usageNotesHint' | transloco }}</span></label>
      <textarea [(ngModel)]="state.stForm.usageNotes" rows="3" [attr.maxlength]="USAGE_NOTES_MAX" style="resize:vertical;"></textarea>
      <div class="char-count" [class.near]="near(state.stForm.usageNotes, USAGE_NOTES_MAX)">{{ (state.stForm.usageNotes || '').length }} / {{ USAGE_NOTES_MAX }}</div>
    </div>
  </app-settings-card>

  <app-settings-card icon="database" [heading]="'spaces.settings.card.limits' | transloco" [purpose]="'spaces.settings.card.limitsHint' | transloco">
    <div style="display:flex;gap:24px;align-items:flex-start;flex-wrap:wrap;">
      <div class="field" style="margin:0;max-width:220px;">
        <label>{{ 'spaces.settings.maxStorage' | transloco }}</label>
        <input type="number" [(ngModel)]="state.stForm.maxGiB" min="0" step="0.1" [placeholder]="'spaces.settings.unlimitedPlaceholder' | transloco" />
        <div style="font-size:11px;color:var(--text-muted);margin-top:3px;">{{ 'spaces.settings.maxStorageHint' | transloco }}</div>
      </div>
      <!-- Retention moved to the Danger Zone (owner call, 2026-08-02). It DELETES records, which is what the
           Danger Zone is for, and it sat here beside a storage cap that only refuses new writes — two very
           different consequences in one card. The pointer stays so nobody concludes the setting vanished. -->
      <div class="field" style="margin:0;max-width:260px;">
        <label>{{ 'spaces.settings.recordTtl' | transloco }}</label>
        <div style="font-size:12px;color:var(--text-muted);">{{ 'spaces.settings.recordTtlMoved' | transloco }}</div>
      </div>
    </div>
  </app-settings-card>

  <!-- RDF names (Q-942, layout D): beside the space's other identity settings, before what reads its documents. -->
  <app-space-rdf-card />

  <app-settings-card icon="package" [heading]="'spaces.settings.card.extraction' | transloco" [purpose]="'spaces.settings.card.extractionHint' | transloco">
    <div class="field" style="margin:0;max-width:260px;">
      <label>{{ 'spaces.settings.extractionMode' | transloco }}</label>
      <select [(ngModel)]="state.stForm.documentExtraction">
        <option value="">{{ 'spaces.settings.extractionInherit' | transloco }}</option>
        <option value="auto">{{ 'spaces.settings.extractionAuto' | transloco }}</option>
        <option value="off">{{ 'spaces.settings.extractionOff' | transloco }}</option>
        <!-- Only offer modes within the instance ceiling: a space can't extract more than the instance
             allows, so a higher option would just be silently capped. The current value is always kept
             visible, even if a since-lowered ceiling now excludes it. -->
        @if (isExtractionAllowed('ocr') || state.stForm.documentExtraction === 'ocr') { <option value="ocr">{{ 'spaces.settings.extractionOcr' | transloco }}</option> }
        @if (isExtractionAllowed('vlm') || state.stForm.documentExtraction === 'vlm') { <option value="vlm">{{ 'spaces.settings.extractionVlm' | transloco }}</option> }
        @if (isExtractionAllowed('repair') || state.stForm.documentExtraction === 'repair') { <option value="repair">{{ 'spaces.settings.extractionRepair' | transloco }}</option> }
      </select>
      <div style="font-size:11px;color:var(--text-muted);margin-top:3px;">{{ 'spaces.settings.extractionHint' | transloco }}</div>
      @if (store.docExtractionCeiling() !== 'auto' && store.docExtractionCeiling() !== 'repair') {
        <div style="font-size:11px;color:var(--text-muted);margin-top:3px;">{{ 'spaces.settings.extractionCeilingHint' | transloco: { ceiling: store.docExtractionCeiling() } }}</div>
      }
    </div>
  </app-settings-card>

  <app-settings-card icon="image" [heading]="'spaces.settings.card.media' | transloco" [purpose]="'spaces.settings.card.mediaHint' | transloco">
    <div style="display:flex; flex-wrap:wrap; gap:16px;">
      <div class="field" style="margin:0; max-width:190px;">
        <label>{{ 'spaces.settings.media.image' | transloco }}</label>
        <select [(ngModel)]="state.stForm.imageAnalysis">
          <option value="">{{ 'spaces.settings.media.lvl.inherit' | transloco }}</option>
          <option value="auto">{{ 'spaces.settings.media.lvl.auto' | transloco }}</option>
          <option value="off">{{ 'spaces.settings.media.lvl.off' | transloco }}</option>
          @if (isMediaAllowed('image', 'caption') || state.stForm.imageAnalysis === 'caption') { <option value="caption">{{ 'spaces.settings.media.lvl.caption' | transloco }}</option> }
          @if (isMediaAllowed('image', 'recognition') || state.stForm.imageAnalysis === 'recognition') { <option value="recognition">{{ 'spaces.settings.media.lvl.recognition' | transloco }}</option> }
        </select>
        @if (showMediaCeiling('image')) {
          <div style="font-size:11px;color:var(--text-muted);margin-top:3px;">{{ 'spaces.settings.media.ceilingHint' | transloco: { ceiling: mediaCeiling('image') } }}</div>
        }
      </div>
      <div class="field" style="margin:0; max-width:190px;">
        <label>{{ 'spaces.settings.media.audio' | transloco }}</label>
        <select [(ngModel)]="state.stForm.audioAnalysis">
          <option value="">{{ 'spaces.settings.media.lvl.inherit' | transloco }}</option>
          <option value="auto">{{ 'spaces.settings.media.lvl.auto' | transloco }}</option>
          <option value="off">{{ 'spaces.settings.media.lvl.off' | transloco }}</option>
          @if (isMediaAllowed('audio', 'on') || state.stForm.audioAnalysis === 'on') { <option value="on">{{ 'spaces.settings.media.lvl.on' | transloco }}</option> }
        </select>
        @if (showMediaCeiling('audio')) {
          <div style="font-size:11px;color:var(--text-muted);margin-top:3px;">{{ 'spaces.settings.media.ceilingHint' | transloco: { ceiling: mediaCeiling('audio') } }}</div>
        }
      </div>
      <div class="field" style="margin:0; max-width:190px;">
        <label>{{ 'spaces.settings.media.video' | transloco }}</label>
        <select [(ngModel)]="state.stForm.videoAnalysis">
          <option value="">{{ 'spaces.settings.media.lvl.inherit' | transloco }}</option>
          <option value="auto">{{ 'spaces.settings.media.lvl.auto' | transloco }}</option>
          <option value="off">{{ 'spaces.settings.media.lvl.off' | transloco }}</option>
          @if (isMediaAllowed('video', 'audio') || state.stForm.videoAnalysis === 'audio') { <option value="audio">{{ 'spaces.settings.media.lvl.audioOnly' | transloco }}</option> }
          @if (isMediaAllowed('video', 'full') || state.stForm.videoAnalysis === 'full') { <option value="full">{{ 'spaces.settings.media.lvl.full' | transloco }}</option> }
        </select>
        @if (showMediaCeiling('video')) {
          <div style="font-size:11px;color:var(--text-muted);margin-top:3px;">{{ 'spaces.settings.media.ceilingHint' | transloco: { ceiling: mediaCeiling('video') } }}</div>
        }
      </div>
      <div class="field" style="margin:0; max-width:190px;">
        <label>{{ 'spaces.settings.media.text' | transloco }}</label>
        <select [(ngModel)]="state.stForm.textAnalysis">
          <option value="">{{ 'spaces.settings.media.lvl.inherit' | transloco }}</option>
          <option value="auto">{{ 'spaces.settings.media.lvl.auto' | transloco }}</option>
          <option value="off">{{ 'spaces.settings.media.lvl.off' | transloco }}</option>
          @if (isMediaAllowed('text', 'embed') || state.stForm.textAnalysis === 'embed') { <option value="embed">{{ 'spaces.settings.media.lvl.embed' | transloco }}</option> }
          @if (isMediaAllowed('text', 'chunk') || state.stForm.textAnalysis === 'chunk') { <option value="chunk">{{ 'spaces.settings.media.lvl.chunk' | transloco }}</option> }
        </select>
        @if (showMediaCeiling('text')) {
          <div style="font-size:11px;color:var(--text-muted);margin-top:3px;">{{ 'spaces.settings.media.ceilingHint' | transloco: { ceiling: mediaCeiling('text') } }}</div>
        }
      </div>
    </div>
    <div style="font-size:11px;color:var(--text-muted);margin-top:8px;">{{ 'spaces.settings.media.hint' | transloco }}</div>
  </app-settings-card>

</div>
  `,
})
export class SpaceSettingsTabComponent {
  readonly state = inject(SpaceSettingsState);
  readonly store = inject(SpacesStore);

  // ── Field limits, matching the API ────────────────────────────────────────────────────────────────────
  //
  // `usageNotes` had `maxlength="2000"` here while the API accepts 50 000 and the docs say 50 000. A browser
  // does not warn at `maxlength` — it silently refuses the rest of a paste — so an operator who authored
  // 2,377 characters got 2,000 stored, with no error on either side and no counter to notice it by.
  //
  // That field is the instruction sheet an MCP client receives at handshake. A truncated instruction sheet
  // does not fail; it stops instructing, and the rules that get cut are the ones at the END, which is where
  // people put the specific ones. The operator who reported it lost their write-order and repair-on-defect
  // rules and only caught it by reading the field back in the same session.
  //
  // So the cap now matches the API rather than undercutting it by 25x, and both fields show a live count —
  // a limit you cannot see is one you learn about by losing work.
  readonly PURPOSE_MAX = 4000;
  readonly USAGE_NOTES_MAX = 50_000;

  /** Within 10% of the cap — the point at which a counter should start being noticeable. */
  near(value: string | undefined, max: number): boolean {
    return (value?.length ?? 0) >= max * 0.9;
  }

  private static readonly LADDER = ['off', 'ocr', 'vlm', 'repair'] as const;

  /** Per-class media ladders, low to high (excluding `auto`, which resolves rather than ranks). Same
   *  contract as the extraction ladder: a level is offered only when it sits at or below the ceiling. */
  private static readonly MEDIA_LADDERS = {
    image: ['off', 'caption', 'recognition'],
    audio: ['off', 'on'],
    video: ['off', 'audio', 'full'],
    text: ['off', 'embed', 'chunk'],
  } as const;

  /**
   * Whether a concrete extraction mode is within the instance ceiling — so the per-space dropdown only
   * offers levels the space could actually reach. `auto` ceiling imposes no limit; `off`/`auto`/inherit
   * options are always offered separately (a space can always do less, or follow the ceiling).
   */
  isExtractionAllowed(mode: 'ocr' | 'vlm' | 'repair'): boolean {
    const ceiling = this.store.docExtractionCeiling();
    if (ceiling === 'auto') return true;
    return SpaceSettingsTabComponent.LADDER.indexOf(mode) <= SpaceSettingsTabComponent.LADDER.indexOf(ceiling);
  }

  /**
   * Whether a concrete media level is within the instance ceiling for its class — the media analogue of
   * `isExtractionAllowed`, so a per-space picker never offers a level the runtime would silently cap.
   * `auto` ceiling imposes no limit; the stored value is kept visible separately even if since-excluded.
   */
  isMediaAllowed(cls: 'image' | 'audio' | 'video' | 'text', level: string): boolean {
    const ceiling = this.store.mediaCeilings()[cls];
    if (ceiling === 'auto') return true;
    const ladder = SpaceSettingsTabComponent.MEDIA_LADDERS[cls] as readonly string[];
    return ladder.indexOf(level) <= ladder.indexOf(ceiling);
  }

  /** The instance ceiling for a media class (raw level code), for the "capped by the instance" hint. */
  mediaCeiling(cls: 'image' | 'audio' | 'video' | 'text'): string {
    return this.store.mediaCeilings()[cls];
  }

  /**
   * Whether to show the ceiling hint for a class: only when the instance imposes a real limit — the
   * ceiling is neither `auto` (no limit) nor the class maximum (a ceiling AT the top caps nothing).
   */
  showMediaCeiling(cls: 'image' | 'audio' | 'video' | 'text'): boolean {
    const ceiling = this.store.mediaCeilings()[cls];
    const ladder = SpaceSettingsTabComponent.MEDIA_LADDERS[cls] as readonly string[];
    return ceiling !== 'auto' && ceiling !== ladder[ladder.length - 1];
  }
}
