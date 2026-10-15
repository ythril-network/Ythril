/**
 * Schema tab — per-type schemas, property rules, and schema-library import/export.
 *
 * Extracted from SpacesComponent (A17.8b), together with the import-conflict and library-picker
 * dialogs it owns. Needs no inputs/outputs: SpaceSettingsState holds the schema being edited.
 *
 * Layout is master/detail (PR-U4): a type list on the left selects the type shown in a stable editor
 * pane on the right, so editing a type or a property no longer collapses the whole list (the old
 * 4-level accordion). Property editors are multi-open — several can be expanded at once in the pane.
 *
 * `schImportError`/`schImportInfo` are signals here, unlike in the old component where they were
 * plain fields. They are written from `FileReader.onload`, which is a bare async callback with no
 * signal write of its own — under OnPush a plain field mutated there would leave the message
 * unrendered. That hazard is exactly why OnPush was not retrofitted onto the 1600-line parent and
 * is applied per component instead.
 */
import { Component, ChangeDetectionStrategy, Injector, inject, signal, ElementRef, ViewChild, OnInit, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SchemaTypeNameComponent } from './schema-type-name.component';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { ModalDirective } from '../../shared/modal.directive';
import { SPACE_DIALOG_STYLES } from './space-dialog.styles';
import { SpaceSettingsState, emptyTypeSchemaState, ruleRowsFromWire, typeSchemaFromState, typeStateFromSchema, type RuleRow, type TypeSchemaState } from './space-settings-state.service';
import { SchemaApi, type SchemaLayersView } from '../../core/schema-api.service';
import { ToastService } from '../../core/toast.service';
import { KnowledgeType, KNOWLEDGE_TYPES, PropertySchema, SchemaLibraryEntry, SpaceMeta, TypeSchema, recordTtlWindows } from '../../core/api.types';
import { ErrorStateComponent } from '../../shared/error-state.component';
import { StatusPillComponent, type StatusVariant } from '../../shared/status-pill.component';
import { httpErrorReason } from '../../core/http-error';
import { saveBlob } from '../../core/authenticated-download';

import { SCHEMA_MD_STYLES } from './schema-styles';
import { SchemaTypeEditorComponent, type LayerMark } from './schema-type-editor.component';
import { RuleRowsComponent, type RuleRowRefusal } from '../../shared/rule-rows.component';
import { RULE_LIMITS } from '../../shared/rule-limits';
import { SpacesApi, type ValidateSchemaResult } from '../../core/spaces-api.service';
import { AuthApi } from '../../core/auth-api.service';
import { describeWarnings, type RefusalRow } from '../../core/refusal-text';
import { proposalFor } from './space-schema-layers.component';
import { refusalText } from '../../core/refusal-text';

@Component({
  selector: 'app-space-schema-tab',
  standalone: true,
  imports: [SchemaTypeEditorComponent, RuleRowsComponent, SchemaTypeNameComponent, CommonModule, FormsModule, TranslocoPipe, PhIconComponent, ModalDirective, ErrorStateComponent, StatusPillComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [SPACE_DIALOG_STYLES, SCHEMA_MD_STYLES],
  template: `
<!-- space-wide schema validation (governs every type in this space, not one collection) -->
<div class="sch-validation-bar">
  <div class="svb-label">
    <span class="svb-title">{{ 'spaces.schema.validation.sectionTitle' | transloco }}</span>
    <span class="svb-hint">{{ 'spaces.schema.validation.appliesHint' | transloco }}</span>
  </div>
  <div class="val-controls">
    <label class="val-lbl" [attr.title]="'spaces.schema.validation.hint' | transloco">
      {{ 'spaces.schema.validation.label' | transloco }}
      <select [(ngModel)]="state.schValidation" class="val-select">
        <option value="off">{{ 'spaces.settings.validation.off' | transloco }}</option>
        <option value="warn">{{ 'spaces.settings.validation.warn' | transloco }}</option>
        <option value="strict">{{ 'spaces.settings.validation.strict' | transloco }}</option>
      </select>
    </label>
    <label class="val-check" [attr.title]="'spaces.settings.strictLinkageHint' | transloco">
      <input type="checkbox" [(ngModel)]="state.schStrictLinkage" />
      {{ 'spaces.settings.strictLinkage' | transloco }}
    </label>
  </div>
</div>

<!-- THIS INSTANCE (bundle-128): a setting that is NOT part of the schema and is not shared. It has its own row, below the bar, because
     the bar's hint promises space-wide, shared behaviour and a local setting inside it would inherit that promise. -->
<section class="sch-instance" data-testid="this-instance-row">
  <div class="section-title">{{ 'spaces.schema.instance.title' | transloco }}</div>
  @if (isProxySpace()) {
    <p class="sch-hint" data-testid="unknown-fields-proxy-note">{{ 'spaces.schema.unknownFields.proxyNote' | transloco }}</p>
  } @else {
    <label class="val-lbl inst-lbl">
      {{ 'spaces.schema.unknownFields.label' | transloco }}
      <select [(ngModel)]="state.schUnknownWriteFields" class="val-select inst-select" data-testid="unknown-fields-select"
        [disabled]="!canEditInstanceSetting()" [attr.aria-describedby]="unknownFieldsDescribedBy()">
        <option value="warn">{{ 'spaces.schema.unknownFields.warn' | transloco }}</option>
        <option value="refuse">{{ 'spaces.schema.unknownFields.refuse' | transloco }}</option>
      </select>
    </label>
    <p class="inst-hint" id="unknown-fields-hint" data-testid="unknown-fields-hint">{{ 'spaces.schema.unknownFields.hint' | transloco }}</p>
    @if (state.schUnknownWriteFields === 'refuse') {
      <p class="inst-hint inst-warn" id="unknown-fields-consequence" data-testid="unknown-fields-consequence">{{ 'spaces.schema.unknownFields.consequence' | transloco }}</p>
    }
    @if (!canEditInstanceSetting()) {
      <p class="inst-hint" id="unknown-fields-readonly-reason" data-testid="unknown-fields-readonly-reason">{{ 'spaces.schema.unknownFields.readonlyReason' | transloco }}</p>
    }
  }
</section>

<!-- SPACE RULES (F-46): constraints over a record that apply to every type, or to the kinds a rule names. Edited here, shown read-only in the
     pane of each type they apply to. A token without schema admin sees them, and the reason it cannot change them. -->
<section class="sch-space-rules" data-testid="space-rules-section">
  <div class="section-title">{{ 'rules.space.title' | transloco }}
    <span class="sch-hint">{{ 'rules.space.hint' | transloco }}</span></div>
  @if (!canEditRules()) {
    <p class="sch-hint" data-testid="rules-readonly-reason">{{ 'rules.readonlyReason' | transloco }}</p>
  }
  <app-rule-rows [rules]="state.schRules" [space]="true" [readOnly]="!canEditRules()" [max]="limits.perSpace"
    [refusal]="spaceRuleRefusal()" idPrefix="space-rules" />
</section>

<!-- THE LIVE CHECK: ask the server how the schema as it stands (staged edits included) judges a pasted record, or the data the space
     already holds, before saving it. Stored data is read a page at a time, and the all-clear is said only when the whole space was read. -->
<section class="sch-validate">
  <div class="section-title">{{ 'validate.title' | transloco }}
    <span class="sch-hint">{{ 'validate.hint' | transloco }}</span></div>
  <div class="val-modes" role="radiogroup" [attr.aria-label]="'validate.title' | transloco">
    <label class="val-mode"><input type="radio" name="validateMode" value="sample" data-testid="validate-mode-sample"
      [checked]="validateMode() === 'sample'" (change)="setValidateMode('sample')" /> {{ 'validate.mode.sample' | transloco }}</label>
    <label class="val-mode"><input type="radio" name="validateMode" value="stored" data-testid="validate-mode-stored"
      [checked]="validateMode() === 'stored'" (change)="setValidateMode('stored')" /> {{ 'validate.mode.stored' | transloco }}</label>
  </div>
  @if (validateMode() === 'sample') {
    <textarea class="val-sample" data-testid="validate-sample" rows="4" spellcheck="false"
      [ngModel]="validateSampleText()" (ngModelChange)="validateSampleText.set($event)"
      [attr.aria-label]="'validate.sample.label' | transloco" [placeholder]="'validate.sample.placeholder' | transloco"></textarea>
  }
  @let stale = isValidateStale();
  <div class="val-actions">
    <button class="btn btn-secondary btn-sm" type="button" data-testid="validate-schema" [disabled]="validating()" (click)="runValidate()">
      @if (validating()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;margin-inline-end:5px;"></span> }{{ 'validate.run' | transloco }}
    </button>
    @if (validateCanContinue() && !stale) {
      <button class="btn btn-secondary btn-sm" type="button" data-testid="validate-continue" [disabled]="validating()" (click)="runValidate(true)">{{ 'validate.continue' | transloco }}</button>
    }
  </div>
  @if (validateError()) {
    <div class="sch-msg err" role="alert">{{ validateError() }}</div>
  }
  <!-- The summary is a polite live region, and it is in the page from the start: a region inserted together with its words is not reliably
       read, so finishing a check (the readout, the all-good word) or going stale is announced because its words change inside it. -->
  <div class="val-summary" role="status" data-testid="validate-status">
    @if (validateResult() && stale) {
      <!-- The schema was edited after this check ran: what it found describes the schema as it WAS, so none of it is shown. -->
      <div class="sch-msg warn" data-testid="validate-stale">{{ 'validate.stale' | transloco }}</div>
    } @else if (validateResult()) {
      <!-- A sample reads nothing stored, so there is no count to give: the readout is the stored-data walk's. -->
      @if (validateMode() === 'stored') {
        <div class="val-result" data-testid="validate-progress" [attr.data-checked]="validateChecked().checked" [attr.data-total]="validateChecked().total">
          {{ validateProgressKey() | transloco: { checked: validateChecked().checked, total: validateChecked().total } }}
          @if (!validateDone()) { <span class="sch-hint">{{ 'validate.incomplete' | transloco }}</span> }
        </div>
      }
      @if (validateAllGood()) {
        <!-- "Matches" is said only when the whole space (or the one sample) was read and nothing was found. -->
        <div class="sch-msg ok" data-testid="validate-all-good"><app-status-pill variant="ok" icon="check-circle">{{ 'validate.outcome.match' | transloco }}</app-status-pill> {{ 'validate.allGood' | transloco }}</div>
      }
    }
  </div>
  @if (validateResult() && !stale) {
    @if (validateRows().length) {
      <ul class="val-violations">
        @for (v of validateRows(); track $index) {
          <li>@if (v.sample) { <span class="val-where" data-testid="validate-sample-row">{{ 'validate.sample.row' | transloco }}</span> } @else { <code class="val-where">{{ v.where }}</code> }
            @for (r of v.rows; track $index) {
              <span class="val-row"><app-status-pill [variant]="outcomeWord(r.outcome).variant">{{ outcomeWord(r.outcome).key | transloco }}</app-status-pill> {{ r.text }}</span>
            }
          </li>
        }
      </ul>
    }
  }
</section>

<!-- export / import toolbar -->
<div style="display:flex;gap:8px;align-items:center;margin-bottom:14px;flex-wrap:wrap;">
  <button class="btn btn-secondary btn-sm" type="button" (click)="exportSchema()" [attr.title]="'spaces.schema.exportTitle' | transloco"><ph-icon name="upload" [size]="13" style="margin-right:5px;"/>{{ 'spaces.schema.exportJsonButton' | transloco }}</button>
  <button class="btn btn-secondary btn-sm" type="button" (click)="triggerImportSchema()" [attr.title]="'spaces.schema.importTitle' | transloco"><ph-icon name="download-simple" [size]="13" style="margin-right:5px;"/>{{ 'spaces.schema.importJsonButton' | transloco }}</button>
  <button class="btn btn-secondary btn-sm" type="button" (click)="openExportToLibrary()" [attr.title]="'spaces.schema.exportToLibraryTitle' | transloco"><ph-icon name="bookmarks" [size]="13" style="margin-right:5px;"/>{{ 'spaces.schema.exportToLibraryButton' | transloco }}</button>
  <button class="btn btn-secondary btn-sm" type="button" (click)="triggerImportFromLibraryAny()" [attr.title]="'spaces.schema.importFromLibraryTitle' | transloco"><ph-icon name="bookmarks" [size]="13" style="margin-right:5px;"/>{{ 'spaces.schema.importLibraryButton' | transloco }}</button>
  <input #schImportInput type="file" accept=".json,application/json" style="display:none" (change)="onImportSchemaFile($event)" />
  <input #schTypeImportInput type="file" accept=".json,application/json" style="display:none" (change)="onImportTypeSchemaFile($event)" />
  <span style="font-size:11px;color:var(--text-muted);margin-left:4px;">{{ 'spaces.schema.autoSyncHint' | transloco }}</span>
</div>
<!-- collection tabs -->
<!-- One tab stop for the strip (roving tabindex): the selected tab is in the Tab order, the others are reached with the arrow keys, Home and End. -->
<div class="sch-coll-tabs" role="tablist" [attr.aria-label]="'spaces.schema.collTabsAriaLabel' | transloco">
  @for (t of collTabs; track t.kt) {
    <button class="sch-coll-tab" type="button" role="tab" [id]="'sch-coll-tab-' + t.kt" [attr.data-testid]="'sch-coll-tab-' + t.kt"
      [class.active]="state.schemaCollTab() === t.kt" [attr.aria-selected]="state.schemaCollTab() === t.kt"
      aria-controls="sch-coll-panel" [attr.tabindex]="state.schemaCollTab() === t.kt ? 0 : -1"
      (click)="selectCollTab(t.kt)" (keydown)="onCollTabKey($event)">
      {{ t.label | transloco }}
      @if (state.typeCount(t.kt)) { <span class="sch-cnt-badge">{{ state.typeCount(t.kt) }}</span> }
    </button>
  }
</div>
<div class="sch-coll-body" id="sch-coll-panel" role="tabpanel" [attr.aria-labelledby]="'sch-coll-tab-' + state.schemaCollTab()">

  <!-- collection sub-header (per-type guidance for the active collection) -->
  <!-- ONE hint, with the field name as a parameter. There used to be four near-identical strings that
       differed only in the field they named (entity.type, edge.label, and so on), which is both the
       "different styles" the owner saw and the reason this row changed height between collections —
       and everything below it, the add control included, moved with it. -->
  <div class="sch-head-row">
    <div class="sch-sub">
      {{ (state.schemaCollTab() === 'edge' ? 'spaces.schema.subtitle.labels' : 'spaces.schema.subtitle.types') | transloco }}
      <span class="sch-hint">{{ 'spaces.schema.typeHint' | transloco: { field: allowlistField() } }}</span>
    </div>
  </div>

  <!-- master / detail -->
  <ng-container *ngTemplateOutlet="masterDetail; context: { kt: state.schemaCollTab() }"></ng-container>

  <!-- The space-wide tag-suggestion editor stood here. Retired: one list, editable in a single
       place, applied to every type and every record form in the space — so it steered what agents
       and people tagged with while being easy to set once and never revisit. Tag autocomplete now
       comes from the tags actually in use, which maintains itself. Any stored list is preserved in
       config.json untouched (see space-settings-state.service). -->

</div><!-- sch-coll-body -->

<!-- ── master/detail template ── -->
<ng-template #masterDetail let-kt="kt">
  <div class="sch-md">
    <!-- MASTER: selectable type list -->
    <div class="sch-master">
      <!-- Pinned ABOVE the list on purpose. It used to sit underneath, so it slid further down the
           column with every type added — the control you reach for most moved every time you used
           it. Fixed position, one line: type a name, press Enter or the plus. -->
      <div class="sch-add-row">
        <input type="text" [(ngModel)]="state.schNewTypeInputs[kt]"
          [placeholder]="kt === 'edge' ? ('spaces.schema.newLabelPlaceholder' | transloco) : ('spaces.schema.newTypeNamePlaceholder' | transloco)"
          [attr.aria-label]="kt === 'edge' ? ('spaces.schema.addLabelButton' | transloco) : ('spaces.schema.addTypeButton' | transloco)"
          (keydown.enter)="$event.preventDefault();state.addType(kt)" />
        <button class="sch-add-btn" type="button" (click)="state.addType(kt)"
          [disabled]="!state.schNewTypeInputs[kt]?.trim()"
          [attr.title]="kt === 'edge' ? ('spaces.schema.addLabelButton' | transloco) : ('spaces.schema.addTypeButton' | transloco)"
          [attr.aria-label]="kt === 'edge' ? ('spaces.schema.addLabelButton' | transloco) : ('spaces.schema.addTypeButton' | transloco)">
          <ph-icon name="plus-circle" [size]="18"/>
        </button>
      </div>

      <!-- The type list scrolls inside its own box: a long allowlist must not stretch the whole dialog
           (and push the imports / Save out of reach) — it stays put and the list scrolls. -->
      <div class="sch-type-list">
      @for (name of state.typeNames(kt); track name) {
        <button type="button" class="sch-type-item" [class.sel]="state.isTypeSelected(kt,name)" [attr.aria-current]="state.isTypeSelected(kt,name) ? 'true' : null" (click)="state.selectType(kt,name)">
          <span class="nm">{{ name }}</span>
          <span class="sch-type-badges">
            @if (state.typeLibRef(kt,name)) {
              <span class="badge badge-blue">{{ 'spaces.schema.badge.library' | transloco }}</span>
            } @else {
              @if (state.typeState(kt,name).propertySchemas.length) {
                <span class="badge badge-gray">{{ state.typeState(kt,name).propertySchemas.length }}p</span>
              }
              @if (state.typeState(kt,name).rules.length) {
                <span class="badge badge-gray rules-count" data-testid="rules-count" [attr.title]="'rules.countTitle' | transloco: { count: state.typeState(kt,name).rules.length }">{{ state.typeState(kt,name).rules.length }}</span>
              }
              @if (kt === 'entity' && state.typeState(kt,name).namingPattern) {
                <span class="badge badge-gray">{{ 'spaces.schema.badge.pattern' | transloco }}</span>
              }
              <!-- A window deletes records, so it is visible from the list rather than only after selecting
                   the type. Amber, not grey: this is the one badge here that describes data loss. -->
              @if (state.typeState(kt,name).retentionDays || state.typeState(kt,name).retentionContentDays) {
                <span class="badge badge-yellow">{{ 'spaces.schema.badge.ttl' | transloco }}</span>
              }
            }
          </span>
        </button>
      } @empty {
        <div class="sch-empty-list">{{ kt === 'edge' ? ('spaces.schema.noEdgeLabels' | transloco) : ('spaces.schema.noTypes' | transloco) }}</div>
      }
      </div>

      <!-- Imports stay at the bottom: they are the occasional path, and putting them beside the
           everyday control is what made the top of this column busy. -->
      <div class="sch-add-imports">
      </div>
      @if (schImportError()) {
        <div class="sch-msg err">{{ schImportError() }}</div>
      }
      @if (libImportSkipped().length) {
        <div class="sch-msg err">{{ 'spaces.schema.libPicker.skipped' | transloco: { names: libImportSkipped().join(', ') } }}</div>
      }
      @if (schImportInfo()) {
        <div class="sch-msg ok">{{ schImportInfo() }}</div>
      }
    </div>

    <!-- DETAIL: editor for the selected type -->
    <div class="sch-detail">
      @if (selectedTypeName(kt); as name) {
        <div class="sch-detail-head">
          <!-- The name and its rename are one question, in their own component (B-18). -->
          <app-schema-type-name [name]="name" [rename]="renamerFor(kt, name)" />
          <span class="acts">
            <button class="btn btn-ghost btn-sm" type="button" (click)="exportTypeSchema(kt,name)"
              style="padding:2px 6px;" [attr.title]="'spaces.schema.exportTypeTitle' | transloco"><ph-icon name="upload" [size]="13"/></button>
            @if (!state.typeLibRef(kt,name)) {
              <button class="btn btn-ghost btn-sm" type="button" (click)="saveTypeToLibrary(kt,name)"
                style="padding:2px 6px;" [attr.title]="'spaces.schema.saveToLibraryTitle' | transloco"
                [attr.aria-label]="'spaces.schema.saveToLibraryButton' | transloco"><ph-icon name="bookmarks" [size]="13"/></button>
            }
            <button class="icon-btn danger" type="button" (click)="state.removeType(kt,name)" [attr.title]="'common.remove' | transloco"><ph-icon name="x" [size]="14"/></button>
          </span>
        </div>

        <!-- The editor body is a shared component: the Brain Overview opens the SAME one in a dialog, so a
             one-field schema change no longer means a trip to Space Settings and back. The header above
             keeps the library and delete actions deliberately — see the component for why. -->
        <app-schema-type-editor
          [knowledgeType]="kt"
          [draft]="state.typeState(kt,name)"
          [libRef]="state.typeLibRef(kt,name)"
          [linkedProps]="linkedProps(kt,name)"
          [linkedRules]="linkedRules(kt,name)"
          [applicableRules]="applicableRules(kt)"
          [ruleRefusal]="typeRuleRefusal(kt,name)"
          [layerMarks]="layerMarksFor(kt,name)"
          (proposeTo)="onProposeProperty(kt,name,$event)"
          [spaceWindowDays]="spaceWindow(kt)"
          [entityTypeNames]="state.typeNames('entity')"
          (unlink)="unlinkType(kt,name)" />
      } @else {
        <div class="sch-detail-empty">{{ kt === 'edge' ? ('spaces.schema.detail.emptyEdge' | transloco) : ('spaces.schema.detail.empty' | transloco) }}</div>
      }
    </div>
  </div>
</ng-template>

@if (importConflict(); as conflict) {
  <div style="position:fixed;inset:0;background:var(--bg-scrim);display:flex;align-items:center;justify-content:center;z-index:320;">
    <div style="background:var(--bg-primary);border:1px solid var(--border);border-radius:var(--radius-lg);padding:24px;width:440px;max-width:96vw;" [appModal]="'spaces.schema.conflict.title' | transloco" (dismiss)="dismissImportConflict()" (click)="$event.stopPropagation()">
      <div style="font-weight:700;font-size:15px;margin-bottom:8px;">{{ 'spaces.schema.conflict.title' | transloco }}</div>
      <p style="font-size:13px;color:var(--text-secondary);margin-bottom:20px;" [innerHTML]="'spaces.schema.conflict.body' | transloco: { name: conflict.name, kt: conflict.kt }"></p>
      <div style="display:flex;flex-direction:column;gap:10px;">
        <button class="btn btn-secondary" type="button" (click)="resolveImportConflictOverride()">{{ 'spaces.schema.conflict.override' | transloco }}</button>
        @if (importConflict()!.allowAddAs) {
          <div style="display:flex;gap:8px;align-items:center;">
            <input type="text" [ngModel]="importConflictAddAsName()" (ngModelChange)="importConflictAddAsName.set($event)"
              [placeholder]="'spaces.schema.conflict.newNamePlaceholder' | transloco" style="flex:1;" (keydown.enter)="$event.preventDefault();resolveImportConflictAddAs()" />
            <button class="btn btn-primary btn-sm" type="button" (click)="resolveImportConflictAddAs()" [disabled]="!importConflictAddAsName().trim()">{{ 'spaces.schema.conflict.addAs' | transloco }}</button>
          </div>
        }
        <button class="btn btn-ghost" type="button" (click)="dismissImportConflict()">{{ 'common.cancel' | transloco }}</button>
      </div>
    </div>
  </div>
}

@if (showLibPickerDialog()) {
  <div style="position:fixed;inset:0;background:var(--bg-scrim);display:flex;align-items:center;justify-content:center;z-index:310;">
    <div style="background:var(--bg-primary);border:1px solid var(--border);border-radius:var(--radius-lg);padding:24px;width:560px;max-width:96vw;max-height:80vh;overflow-y:auto;" [appModal]="'spaces.schema.libPicker.title' | transloco" appModalCloseOnBackdrop (dismiss)="closeLibPicker()" (click)="$event.stopPropagation()">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
        <strong>{{ 'spaces.schema.libPicker.title' | transloco }}</strong>
        <button class="icon-btn" type="button" [attr.aria-label]="'common.close' | transloco" (click)="closeLibPicker()"><ph-icon name="x" [size]="14"/></button>
      </div>
      @if (libPickerLoading()) {
        <div class="empty-state"><span class="spinner"></span></div>
      } @else if (libPickerError() !== null) {
        <app-error-state [message]="'spaces.schema.libPicker.loadError' | transloco" [reason]="libPickerError() ?? ''"
                         [icon]="32" (retry)="retryLibPicker()" />
      } @else if (!libPickerEntries().length) {
        <p style="font-size:13px;color:var(--text-muted);">{{ 'spaces.schema.libPicker.empty' | transloco }}</p>
      } @else {
        <div style="display:grid;gap:8px;">
          @for (g of libPickerGroups(); track g.group) {
            @if (g.group) {
              <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:4px;">
                <strong style="font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted);">{{ g.group }}</strong>
                <button class="btn btn-secondary btn-sm" type="button" (click)="importGroupFromLibrary(g.group)">{{ 'spaces.schema.libPicker.importGroup' | transloco }}</button>
              </div>
            }
          @for (entry of g.entries; track entry.name) {
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-surface);">
              <div>
                <div style="font-weight:600;font-size:13px;font-family:var(--font-mono);">{{ entry.name }}</div>
                <div style="font-size:11px;color:var(--text-muted);">{{ entry.knowledgeType }} · {{ entry.typeName }}</div>
                @if (entry.description) { <div style="font-size:11px;color:var(--text-secondary);">{{ entry.description }}</div> }
              </div>
              <div style="display:flex;gap:6px;flex-shrink:0;">
                <button class="btn btn-secondary btn-sm" type="button" (click)="importFromLibraryRef(entry)">{{ 'spaces.schema.libPicker.importRef' | transloco }}</button>
              </div>
            </div>
          }
          }
        </div>

      }
    </div>
  </div>
}

@if (exportLibDialog(); as d) {
  <div style="position:fixed;inset:0;background:var(--bg-scrim);display:flex;align-items:center;justify-content:center;z-index:320;">
    <div style="background:var(--bg-primary);border:1px solid var(--border);border-radius:var(--radius-lg);padding:24px;width:480px;max-width:96vw;" [appModal]="'spaces.schema.exportToLibrary.title' | transloco" appModalCloseOnBackdrop (dismiss)="closeExportToLibrary()" (click)="$event.stopPropagation()">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
        <strong>{{ 'spaces.schema.exportToLibrary.title' | transloco }}</strong>
        <button class="icon-btn" type="button" [attr.aria-label]="'common.close' | transloco" (click)="closeExportToLibrary()"><ph-icon name="x" [size]="14"/></button>
      </div>
      <p style="font-size:12px;color:var(--text-muted);margin:0 0 14px;">{{ 'spaces.schema.exportToLibrary.hint' | transloco }}</p>
      @if (state.isDirty()) {
        <div class="alert alert-warning" style="font-size:12px;margin-bottom:12px;">{{ 'spaces.schema.exportToLibrary.dirtyWarning' | transloco }}</div>
      }
      <div class="field" style="margin-bottom:10px;">
        <label style="font-size:12px;">{{ 'spaces.schema.exportToLibrary.groupLabel' | transloco }}</label>
        <input type="text" [ngModel]="d.groupName" (ngModelChange)="exportLibDialog.set({ ...d, groupName: $event })" style="width:100%;" />
      </div>
      <div class="field" style="margin-bottom:14px;">
        <label style="font-size:12px;">{{ 'spaces.schema.exportToLibrary.prefixLabel' | transloco }}</label>
        <input type="text" [ngModel]="d.namePrefix" (ngModelChange)="exportLibDialog.set({ ...d, namePrefix: $event })" style="width:100%;" />
      </div>
      @if (d.error) { <div class="alert alert-error" style="font-size:12px;margin-bottom:12px;">{{ d.error }}</div> }
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button class="btn btn-secondary btn-sm" type="button" (click)="closeExportToLibrary()">{{ 'common.cancel' | transloco }}</button>
        <button class="btn btn-primary btn-sm" type="button" (click)="doExportToLibrary()" [disabled]="d.saving || state.isDirty() || !d.groupName.trim()">
          @if (d.saving) { <span class="spinner" style="width:12px;height:12px;border-width:2px;margin-right:5px;"></span> }
          {{ 'spaces.schema.exportToLibrary.confirm' | transloco }}
        </button>
      </div>
    </div>
  </div>
}
  `,
})
export class SpaceSchemaTabComponent implements OnInit {
  readonly state = inject(SpaceSettingsState);
  private schemaApi = inject(SchemaApi);
  private toast = inject(ToastService);
  private transloco = inject(TranslocoService);
  private spacesApi = inject(SpacesApi);
  private injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly limits = RULE_LIMITS;

  // ── the collection tabs (roving tabindex)
  /** The strip, left to right: the order the arrow keys walk. */
  protected readonly collTabs: readonly { kt: KnowledgeType; label: string }[] = [
    { kt: 'entity', label: 'spaces.schema.tab.entities' },
    { kt: 'edge', label: 'spaces.schema.tab.edges' },
    { kt: 'fact', label: 'spaces.schema.tab.facts' },
    { kt: 'chrono', label: 'spaces.schema.tab.chrono' },
  ];

  protected selectCollTab(kt: KnowledgeType): void {
    this.state.schemaCollTab.set(kt);
    this.schImportError.set('');
    this.schImportInfo.set('');
  }

  /**
   * ArrowRight / ArrowLeft move to the next / previous tab and wrap, Home / End go to the first / last. The tab that receives focus is
   * selected as well (the panel beneath is a quick switch, not a load), so the one tab in the Tab order is always the selected one.
   */
  protected onCollTabKey(event: KeyboardEvent): void {
    const at = this.collTabs.findIndex(t => t.kt === this.state.schemaCollTab());
    if (at < 0) return;
    const last = this.collTabs.length - 1;
    const to = event.key === 'ArrowRight' ? (at === last ? 0 : at + 1)
      : event.key === 'ArrowLeft' ? (at === 0 ? last : at - 1)
      : event.key === 'Home' ? 0
      : event.key === 'End' ? last
      : -1;
    if (to < 0) return;
    event.preventDefault();
    this.selectCollTab(this.collTabs[to]!.kt);
    // The tabindex of the new tab is applied by the next change detection; focus once it has run.
    queueMicrotask(() => this.host.nativeElement.querySelector<HTMLElement>(`#sch-coll-tab-${this.collTabs[to]!.kt}`)?.focus());
  }

  // ── rights: the rules are a constraint on every write, so changing them needs schema admin
  /** Whether this token may change rules. Unknown (still loading, or no rights to read) counts as yes: the server decides, this only explains. */
  private readonly schemaAdmin = signal(true);
  readonly canEditRules = computed(() => this.schemaAdmin());
  /**
   * The "This instance" control is charged to the same area as the rules (`schema` admin on REST), so it follows the same signal; it
   * is its own name because it is not a rule, and a template that asked `canEditRules()` about it would read as a mistake.
   */
  readonly canEditInstanceSetting = computed(() => this.schemaAdmin());
  /**
   * A proxy space holds no data of its own and a write to it lands in a member, where the MEMBER's setting governs it, so the
   * control would promise something this instance cannot keep here. `proxyFor` is non-empty for a member list and for `['*']`.
   */
  readonly isProxySpace = (): boolean => (this.state.settingsSpace()?.proxyFor?.length ?? 0) > 0;
  /** The ids the select is described by: the hint always, the consequence while Refuse is chosen, the reason while it is disabled. */
  protected unknownFieldsDescribedBy(): string {
    return ['unknown-fields-hint',
      ...(this.state.schUnknownWriteFields === 'refuse' ? ['unknown-fields-consequence'] : []),
      ...(this.canEditInstanceSetting() ? [] : ['unknown-fields-readonly-reason'])].join(' ');
  }

  // ── the live check
  protected readonly validateMode = signal<'sample' | 'stored'>('sample');
  protected readonly validateSampleText = signal('');
  protected readonly validating = signal(false);
  protected readonly validateError = signal('');
  protected readonly validateResult = signal<ValidateSchemaResult | null>(null);
  /**
   * Whether any page of the check has found a violation. A boolean, not the rows: only the CURRENT page's rows are shown, and the
   * earlier pages' rows were kept for the life of the check to be asked whether there were any.
   */
  private readonly validateFound = signal(false);
  private readonly validateCursor = signal<string | null>(null);
  /** The records the check has read, summed over its pages: each answer's `progress.checked` is what THAT call read. */
  private readonly validateRead = signal(0);
  /** How many records the space held when the check started, as the latest answer says. */
  private readonly validateTotal = signal(0);

  @ViewChild('schImportInput') schImportInputRef?: ElementRef<HTMLInputElement>;
  @ViewChild('schTypeImportInput') schTypeImportInputRef?: ElementRef<HTMLInputElement>;
  private _typeImportTarget: { kt: KnowledgeType; name: string } | null = null;
  /**
   * Where a library import lands. `kt: null` means the pick came from the TOP action row, which is not
   * scoped to a knowledge type — the entry carries its own, so the target is derived per entry.
   */
  private _libPickerTarget: { kt: KnowledgeType | null; name: string } | null = null;

  schImportError = signal('');

  /**
   * The record field the active collection's allowlist governs — the one word that differs between the
   * four collections, so the guidance around it can be a single string rather than four near-copies.
   */
  readonly allowlistField = computed(() => {
    switch (this.state.schemaCollTab()) {
      case 'edge': return 'edge.label';
      case 'fact': return 'memory.type';
      case 'chrono': return 'chrono.type';
      default: return 'entity.type';
    }
  });

  /** Success/info note after a schema import stages types (cleared on the next action). */
  schImportInfo = signal('');

  /** Pending import conflict: holds the parsed state waiting for user resolution. */
  importConflict = signal<{ kt: KnowledgeType; name: string; state: TypeSchemaState; allowAddAs: boolean } | null>(null);

  importConflictAddAsName = signal('');

  showLibPickerDialog = signal(false);

  /** "Export whole schema to library" dialog state (null = closed). */
  /**
   * The rename this type would perform, as a closure. The component owns the INTERACTION and the
   * host owns what a rename means to its state — the same split `app-schema-type-editor` uses, and
   * the reason neither of them injects the settings service.
   */
  renamerFor(kt: KnowledgeType, from: string): (to: string) => 'empty' | 'exists' | 'missing' | null {
    return (to: string) => this.state.renameType(kt, from, to);
  }

  exportLibDialog = signal<{ groupName: string; namePrefix: string; saving: boolean; error: string } | null>(null);

  libPickerLoading    = signal(false);
  /** Null until the picker's fetch failed — checked before its empty text, so a failure never reads as "the library is empty". */
  libPickerError      = signal<string | null>(null);

  libPickerEntries    = signal<SchemaLibraryEntry[]>([]);

  /** All schema-library entries by name — used to show a linked type's properties read-only and to
   *  resolve its schema when unlinking (turning the $ref into an inline, editable copy). */
  readonly libEntriesByName = signal<Record<string, SchemaLibraryEntry>>({});

  ngOnInit(): void {
    this.loadRights();
    // Load the library once so linked types can render their (read-only) properties and be unlinked
    // into an inline copy without a per-type round-trip.
    this.schemaApi.listSchemaLibrary().subscribe({
      next: ({ entries }) => this.libEntriesByName.set(Object.fromEntries(entries.map(e => [e.name, e]))),
      error: () => this.libEntriesByName.set({}),
    });
  }

  /**
   * Read what this token may do to the space's schema. Silent on failure and when the host has no auth api (a spec of the tab alone):
   * the section simply stays editable, and a write the token may not make is refused by the server.
   */
  private loadRights(): void {
    let auth: AuthApi;
    try { auth = this.injector.get(AuthApi); } catch { return; }
    auth.verifyToken().subscribe({
      next: (me) => {
        const rights = me.rights;
        if (!rights) return;
        const id = this.state.settingsSpace()?.id ?? '';
        const admin = rights.instanceAdmin || rights.spaceAdmin?.floor === true || rights.spaceAdmin?.spaces.includes(id) === true
          || rights.perSpace?.[id]?.['schema'] === 'admin' || (!rights.perSpace?.[id] && rights.floor?.['schema'] === 'admin');
        this.schemaAdmin.set(!!admin);
      },
      error: () => { /* the server decides */ },
    });
  }

  // ── rules: what the type pane and the space section are told about a refused save
  /** The refusal, when it names a rule of THIS type: the same object each time, so a row is asked to open once per refusal. */
  typeRuleRefusal(kt: KnowledgeType, name: string): RuleRowRefusal | null {
    const r = this.state.ruleRefusal();
    return r && r.scope === 'type' && r.kt === kt && r.type === name ? r : null;
  }

  spaceRuleRefusal(): RuleRowRefusal | null {
    const r = this.state.ruleRefusal();
    return r && r.scope === 'space' ? r : null;
  }

  /** The space rules that apply to a record of this kind: those that name it, and those that name none (every kind). */
  applicableRules(kt: KnowledgeType): { name: string; message: string }[] {
    return this.state.schRules.filter(r => r.kinds.length === 0 || r.kinds.includes(kt)).map(r => ({ name: r.name, message: r.message }));
  }

  // ── layers: the properties a network supplies
  private static readonly NO_MARKS: Record<string, LayerMark> = {};

  /** Per `kind|type`: the properties whose definition a network layer supplies, and which network applies. Derived from the clashes the layers answer lists. */
  private readonly layerMarks = computed<Record<string, Record<string, LayerMark>>>(() => {
    const view = this.state.schemaLayers();
    const out: Record<string, Record<string, LayerMark>> = {};
    if (!view) return out;
    const label = (id: string): string => view.layers.find(l => l.networkId === id)?.networkLabel ?? id;
    for (const c of view.clashes) {
      if (!c.kind || !c.type || !c.property || !c.values.length) continue;
      const [winner, ...rest] = c.values;
      (out[`${c.kind}|${c.type}`] ??= {})[c.property] = {
        networkId: winner!.networkId,
        networkLabel: label(winner!.networkId),
        others: rest.map(v => ({ networkId: v.networkId, networkLabel: label(v.networkId) })),
      };
    }
    return out;
  });

  layerMarksFor(kt: KnowledgeType, name: string): Record<string, LayerMark> {
    return this.layerMarks()[`${kt}|${name}`] ?? SpaceSchemaTabComponent.NO_MARKS;
  }

  /** Offer the definition that applies here to another network that holds a different one: a vote on that network, never a direct write (F-39.5). */
  onProposeProperty(kt: KnowledgeType, name: string, ev: { key: string; networkId: string }): void {
    const view: SchemaLayersView | null = this.state.schemaLayers();
    const spaceId = this.state.settingsSpace()?.id;
    const clash = view?.clashes.find(c => c.kind === kt && c.type === name && c.property === ev.key);
    if (!view || !spaceId || !clash) return;
    const layer = view.layers.find(l => l.networkId === ev.networkId)?.meta ?? {};
    const network = view.layers.find(l => l.networkId === ev.networkId)?.networkLabel ?? ev.networkId;
    this.schemaApi.proposeToNetwork(spaceId, ev.networkId, proposalFor(clash, layer)).subscribe({
      next: () => {
        this.toast.success(this.transloco.translate('spaces.schema.layers.proposed', { network }));
        this.state.layersRefresh.update(n => n + 1);
      },
      error: (err) => this.toast.error(refusalText(this.transloco, err, 'spaces.schema.layers.proposeFailed')),
    });
  }

  // ── the live check
  setValidateMode(mode: 'sample' | 'stored'): void {
    this.validateMode.set(mode);
    this.resetValidate();
  }

  private resetValidate(): void {
    this.validateResult.set(null);
    this.validateFound.set(false);
    this.validateCursor.set(null);
    this.validateRead.set(0);
    this.validateTotal.set(0);
    this.validateRunMeta = null;
    this.validateRunKey = '';
    this.validateError.set('');
  }

  /** True when the walk reached the end of the space (or the sample was judged): nothing is left after the latest answer. The answer's `complete`. */
  readonly validateDone = computed(() => {
    const r = this.validateResult();
    return !!r && SpaceSchemaTabComponent.isDone(r);
  });

  private static isDone(result: ValidateSchemaResult): boolean { return result.complete === true; }

  /** The next page is offered while the check is not done and the server gave a cursor. */
  readonly validateCanContinue = computed(() => this.validateMode() === 'stored' && this.validateResult() !== null && !this.validateDone() && this.validateCursor() !== null);

  /**
   * What the whole check has read so far, of how many records the space holds. Each answer's `progress.checked` is what THAT call read, so
   * the readout is their sum (b23 W6b: a call no longer re-reads records an earlier page passed, and counts nothing past its page); the
   * total is the latest answer's. An answer without `progress` falls back to the one call's per-collection count.
   */
  readonly validateChecked = computed(() => ({ checked: this.validateRead(), total: this.validateTotal() }));

  /**
   * The sentence the readout is said in. "Checked N of M" says the check has covered M, so a check that is not done never says it when N has
   * reached M (the space grew while paging): it says how many it has read so far, and no total to contradict "not finished" (Q-488).
   */
  readonly validateProgressKey = computed(() => {
    const { checked, total } = this.validateChecked();
    return !this.validateDone() && checked >= total ? 'validate.progressOpen' : 'validate.progress';
  });

  /** "All good" is said only when the whole space was read (or the sample judged) and nothing was found. */
  readonly validateAllGood = computed(() => this.validateDone() && !this.validateFound());

  /** What one answer read: its `progress`, else the per-collection counts of the call. */
  private static readOf(result: ValidateSchemaResult): { checked: number; total: number } {
    if (result.progress) return result.progress;
    let checked = 0, total = 0;
    for (const c of Object.values(result.checked ?? {})) { checked += c.checked; total += c.total; }
    return { checked, total };
  }

  private static readonly VALIDATE_SHOWN = 50;

  /**
   * The CURRENT page's rows. Each page is asked for at most {@link VALIDATE_SHOWN} records, so a page's rows are all shown and the next
   * page brings new ones; listing every page's rows together and showing the first fifty left page two invisible (b23 verify U4). A
   * sample's one row has no stored id: it is labelled as the pasted record (b23 verify U2: it read "entities undefined").
   */
  readonly validateRows = computed<{ where: string; sample: boolean; rows: RefusalRow[] }[]>(() =>
    (this.validateResult()?.violations ?? []).slice(0, SpaceSchemaTabComponent.VALIDATE_SHOWN).map(v => ({
      where: `${v.collection} ${v._id ?? ''}`,
      sample: this.validateMode() === 'sample',
      rows: describeWarnings(this.transloco, '', v.violations),
    })));

  /** The word an outcome is said with (StatusPill's vocabulary): the translation key, and the pill's variant. */
  protected outcomeWord(outcome: RefusalRow['outcome']): { key: string; variant: StatusVariant } {
    switch (outcome) {
      case 'could_not_evaluate': return { key: 'validate.outcome.couldNotEvaluate', variant: 'warn' };
      case 'too_large': return { key: 'validate.outcome.tooLarge', variant: 'warn' };
      case 'undeclared': return { key: 'validate.outcome.undeclared', variant: 'warn' };
      default: return { key: 'validate.outcome.violated', variant: 'error' };
    }
  }

  /** The schema the result on screen was judged under, and its serialisation: what a later edit is told apart from. Null while there is no result. */
  private validateRunMeta: Partial<SpaceMeta> | null = null;
  private validateRunKey = '';

  /**
   * True when the schema has been edited since the check that produced the result on screen ran. The staged schema is plain mutable
   * state with no change signal, so it is compared as the request would carry it; the template asks on every pass, and an edit is an event
   * inside this component's tree, so the pass happens. A stale result is not shown and cannot be continued: it describes a schema that is
   * no longer the one on the screen.
   */
  isValidateStale(): boolean {
    return this.validateResult() !== null && this.validateRunKey !== JSON.stringify(this.state.buildMeta());
  }

  /**
   * Run the live check on the schema AS STAGED. A sample is one pasted record (nothing is scanned); stored data is read a page at a time,
   * the next page asked for with the cursor the last answer gave. A continuation belongs to the run it continues: it asks under the schema
   * that run started with (never the staged schema as it is now), and after an edit there is nothing to continue.
   */
  runValidate(next = false): void {
    const spaceId = this.state.settingsSpace()?.id;
    if (!spaceId) return;
    if (next && (!this.validateRunMeta || this.isValidateStale())) return;
    const meta = next ? this.validateRunMeta! : this.state.buildMeta();
    const body: Parameters<SpacesApi['validateSchema']>[1] = { meta };
    if (this.validateMode() === 'sample') {
      try {
        body.sample = JSON.parse(this.validateSampleText());
      } catch {
        this.resetValidate();
        this.validateError.set(this.transloco.translate('validate.sample.notJson'));
        return;
      }
    } else {
      // A page holds no more than is shown, so every row of it is seen and continuing brings the next ones.
      body.limit = SpaceSchemaTabComponent.VALIDATE_SHOWN;
      if (next && this.validateCursor()) body.after = this.validateCursor()!;
    }
    if (!next) {
      this.resetValidate();
      this.validateRunMeta = meta;
      this.validateRunKey = JSON.stringify(meta);
    }
    this.validateError.set('');
    this.validating.set(true);
    this.spacesApi.validateSchema(spaceId, body).subscribe({
      next: (result) => {
        this.validating.set(false);
        this.validateResult.set(result);
        if (result.violations?.length) this.validateFound.set(true);
        const read = SpaceSchemaTabComponent.readOf(result);
        this.validateRead.update(n => n + read.checked);
        this.validateTotal.set(read.total);
        this.validateCursor.set(SpaceSchemaTabComponent.isDone(result) ? null : (result.nextAfter ?? null));
      },
      error: (err) => {
        this.validating.set(false);
        this.validateError.set(refusalText(this.transloco, err, 'validate.failed'));
      },
    });
  }

  /** The library entry a linked type points at, if it has been loaded — else null. */
  linkedEntry(kt: KnowledgeType, name: string): SchemaLibraryEntry | null {
    const ref = this.state.typeLibRef(kt, name);
    return ref ? (this.libEntriesByName()[ref] ?? null) : null;
  }

  /** A linked type's property schemas, as a display list (read-only), resolved from the library. */
  linkedProps(kt: KnowledgeType, name: string): { key: string; s: PropertySchema }[] {
    const schema = this.linkedEntry(kt, name)?.schema;
    return Object.entries(schema?.propertySchemas ?? {}).map(([key, s]) => ({ key, s }));
  }

  /** A linked type's rules, as `{ name, rule, message }` rows (read-only), resolved from the library like `linkedProps`; empty until the entry has loaded. */
  linkedRules(kt: KnowledgeType, name: string): RuleRow[] {
    return ruleRowsFromWire(this.linkedEntry(kt, name)?.schema.rules);
  }

  /**
   * The effective delete window when a chrono type's content window sits at or beyond it — else null.
   *
   * Mirrors `contentDays()` on the server exactly, including its fall-through: a type with no `days` of its own
   * is still deleted at the SPACE default, so a 30-day content window under a 30-day space default never fires
   * either. Returning the number lets the message say which window it lost to, which is the part an operator
   * cannot work out from the two fields in front of them.
   */
  contentWindowNeverFires(kt: KnowledgeType, name: string): number | null {
    if (kt !== 'chrono') return null;
    const s = this.state.typeState(kt, name);
    const content = Number(s.retentionContentDays);
    if (!Number.isFinite(content) || content <= 0) return null;
    const total = Number(s.retentionDays) || this.spaceWindow(kt) || 0;
    return total > 0 && content >= total ? total : null;
  }

  /**
   * The space-tier window this collection would inherit, or null.
   *
   * The space tier is five per-collection windows, so "the space default" is not one number. Naming the wrong
   * bucket in the hint would be worse than naming none — an operator would set a window against a figure that
   * does not apply to the type in front of them.
   */
  spaceWindow(kt: KnowledgeType): number | null {
    return recordTtlWindows(this.state.settingsSpace()?.recordTtlDays)[kt];
  }

  /** A one-line, read-only summary of a property's constraints for the linked-type view. */
  propConstraintSummary(s: PropertySchema): string {
    const parts: string[] = [];
    if (s.required) parts.push(this.transloco.translate('spaces.schema.propDetail.required'));
    if (s.enum?.length) parts.push(`${this.transloco.translate('spaces.schema.propDetail.enumValues')}: ${s.enum.join(', ')}`);
    if (s.minimum != null) parts.push(`${this.transloco.translate('spaces.schema.propDetail.min')} ${s.minimum}`);
    if (s.maximum != null) parts.push(`${this.transloco.translate('spaces.schema.propDetail.max')} ${s.maximum}`);
    if (s.pattern) parts.push(`/${s.pattern}/`);
    if (s.default != null) parts.push(`${this.transloco.translate('spaces.schema.propDetail.default')} ${s.default}`);
    return parts.join(' · ') || '—';
  }

  /**
   * Unlink a library-linked type: replace the `$ref` with an inline copy of the library entry's schema
   * so the space can then customise it. Mirrors the inline branch of the state loader; leaves the change
   * pending in the form (buildMeta() then stores it inline instead of a $ref) — the footer Save persists.
   */
  unlinkType(kt: KnowledgeType, name: string): void {
    const entry = this.linkedEntry(kt, name);
    if (!entry) { this.toast.error(this.transloco.translate('spaces.schema.libRef.unlinkFailed')); return; }
    this.state.schTypeSchemas = {
      ...this.state.schTypeSchemas,
      [kt]: {
        ...(this.state.schTypeSchemas[kt] ?? {}),
        // The inline copy of EVERYTHING the entry holds - description, edge ends, embedding setting, rules, not only the naming
        // pattern and the properties - through the one reader of a wire schema. A library entry carries no retention (its own
        // schema rejects the field), so an unlinked type starts on the space default rather than inheriting a window it never had.
        // _libRef intentionally dropped — the type is now a plain inline schema.
        [name]: typeStateFromSchema(entry.schema),
      },
    };
  }

  /** The selected type's name if it belongs to the given collection and still exists, else null. */
  selectedTypeName(kt: KnowledgeType): string | null {
    const s = this.state.schSelectedType;
    return s && s.kt === kt && this.state.typeNames(kt).includes(s.name) ? s.name : null;
  }

  exportSchema(): void {
    const space = this.state.settingsSpace();
    if (!space) return;
    const meta = this.state.buildMeta();
    const payload = {
      spaceId:     space.id,
      spaceLabel:  space.label,
      exportedAt:  new Date().toISOString(),
      typeSchemas: meta.typeSchemas ?? {},
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    saveBlob(blob, `${space.id}_schemas.json`);
  }

  triggerImportSchema(): void {
    this.schImportError.set('');
    this.schImportInputRef?.nativeElement.click();
  }

  /**
   * Export the WHOLE space schema into the instance schema library as a named, reusable group
   * (auto-grouped: one entry per inline type, `$ref` types skipped). Reuses the server `export-space`
   * endpoint, which reads the SAVED space config — so it is disabled while the editor has unsaved
   * changes (the dialog says so). The Schema-Library page's "apply group" is the reverse.
   */
  openExportToLibrary(): void {
    const space = this.state.settingsSpace();
    if (!space) return;
    this.exportLibDialog.set({ groupName: space.label || space.id, namePrefix: space.id, saving: false, error: '' });
  }

  closeExportToLibrary(): void { this.exportLibDialog.set(null); }

  doExportToLibrary(): void {
    const d = this.exportLibDialog();
    const space = this.state.settingsSpace();
    if (!d || !space || this.state.isDirty() || !d.groupName.trim()) return;
    this.exportLibDialog.set({ ...d, saving: true, error: '' });
    this.schemaApi.exportSpaceSchemaToLibrary({
      spaceId: space.id,
      groupName: d.groupName.trim(),
      namePrefix: d.namePrefix.trim() || undefined,
    }).subscribe({
      next: (r) => {
        this.exportLibDialog.set(null);
        this.toast.success(this.transloco.translate('spaces.schema.exportToLibrary.done', {
          created: r.created, updated: r.updated, group: d.groupName.trim(),
        }));
      },
      error: (err) => {
        this.exportLibDialog.set({ ...d, saving: false, error: refusalText(this.transloco, err, 'spaces.schema.exportToLibrary.failed') });
      },
    });
  }

  /**
   * Map one raw type-schema object (as exported / stored) into editor state.
   *
   * A type-level `$ref` is read FIRST and short-circuits the rest. It used to be ignored entirely, and the
   * consequence was not a broken import but a silently empty one: `{ "$ref": "library:cross-space-reference" }`
   * has no `namingPattern`, no `propertySchemas` and no `retention`, so every field below read as absent and
   * the type saved as `{}` — no naming rule, nothing required, every new record accepted. The per-type
   * "import as $ref" action always handled this; the whole-file import did not, which is why the same file
   * gave two different answers depending on which button was used.
   */
  private mapImportedTypeSchema(ts2: Record<string, unknown>): TypeSchemaState {
    return typeStateFromSchema(ts2);
  }

  onImportSchemaFile(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    this.schImportError.set('');
    this.schImportInfo.set('');
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const raw = JSON.parse(reader.result as string);
        // Accept either { typeSchemas: {...} } wrapper or a bare typeSchemas object.
        const ts: unknown = raw?.typeSchemas ?? raw;
        if (!ts || typeof ts !== 'object' || Array.isArray(ts)) {
          this.schImportError.set(this.transloco.translate('spaces.schema.import.invalidFile'));
          return;
        }
        const tsObj = ts as Record<string, unknown>;
        const KINDS: readonly KnowledgeType[] = KNOWLEDGE_TYPES;
        const merged = { ...this.state.schTypeSchemas };
        let imported = 0;

        if (typeof tsObj['knowledgeType'] === 'string'
            && typeof tsObj['typeName'] === 'string'
            && tsObj['schema'] && typeof tsObj['schema'] === 'object' && !Array.isArray(tsObj['schema'])) {
          // Shape 1: Ythril's own per-type export — { knowledgeType, typeName, schema }.
          const kt = tsObj['knowledgeType'] as KnowledgeType;
          if (KINDS.includes(kt)) {
            const existing = { ...(merged[kt] ?? {}) };
            existing[tsObj['typeName'] as string] = this.mapImportedTypeSchema(tsObj['schema'] as Record<string, unknown>);
            merged[kt] = existing;
            imported++;
          }
        } else {
          // Shape 2: { entity: { <typeName>: <schema>, ... }, edge: {...}, ... }.
          for (const kt of KINDS) {
            const ktRaw = tsObj[kt];
            if (!ktRaw || typeof ktRaw !== 'object' || Array.isArray(ktRaw)) continue;
            const existing = { ...(merged[kt] ?? {}) };
            for (const [typeName, tsRaw] of Object.entries(ktRaw as Record<string, unknown>)) {
              existing[typeName] = this.mapImportedTypeSchema(tsRaw as Record<string, unknown>);
              imported++;
            }
            merged[kt] = existing;
          }
        }

        if (imported === 0) {
          // Valid JSON, but nothing recognisable — tell the user instead of silently
          // clearing the error and appearing to succeed (B2).
          const foundKeys = Object.keys(tsObj).slice(0, 12).join(', ') || '(none)';
          this.schImportError.set(this.transloco.translate('spaces.schema.import.noTypesFound', { keys: foundKeys }));
          return;
        }

        this.state.schTypeSchemas = merged;
        this.schImportError.set('');
        // Import only STAGES the schemas — they aren't persisted until Save is pressed.
        this.schImportInfo.set(this.transloco.translate('spaces.schema.import.staged', { count: imported }));
      } catch {
        this.schImportError.set(this.transloco.translate('spaces.schema.import.parseFailed'));
      } finally {
        // Reset the input so the same file can be re-imported if needed
        if (this.schImportInputRef) this.schImportInputRef.nativeElement.value = '';
      }
    };
    reader.readAsText(file);
  }

  /** Download a single type definition as a JSON snippet. */
  exportTypeSchema(kt: KnowledgeType, name: string): void {
    const space = this.state.settingsSpace();
    if (!space) return;
    // The export carries the retention window: it is part of what this type IS, and a file that omits it
    // re-imports as "inherit the space default" — a silent policy change on a round trip.
    const schema = typeSchemaFromState(kt, this.state.typeState(kt, name));
    const payload = { knowledgeType: kt, typeName: name, schema };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    saveBlob(blob, `${space.id}_${kt}_${name}.json`);
  }

  /** Open the file picker for per-type schema import (existing type replacement). */
  triggerImportTypeSchema(kt: KnowledgeType, name: string): void {
    this._typeImportTarget = { kt, name };
    this.schImportError.set('');
    this.schTypeImportInputRef?.nativeElement.click();
  }


  /** Handle the file chosen for per-type import. */
  onImportTypeSchemaFile(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file || !this._typeImportTarget) return;
    const { kt } = this._typeImportTarget;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const raw = JSON.parse(reader.result as string);
        // Accept either a full snippet { knowledgeType, typeName, schema } or a bare TypeSchema object
        const schemaRaw: unknown = raw?.schema ?? raw;
        if (!schemaRaw || typeof schemaRaw !== 'object' || Array.isArray(schemaRaw)) {
          this.schImportError.set(this.transloco.translate('spaces.schema.import.invalidTypeFile'));
          return;
        }
        // Determine target type name: from _typeImportTarget.name (existing), or file's typeName (new)
        const name: string = this._typeImportTarget?.name || (typeof raw?.typeName === 'string' ? raw.typeName.trim() : '');
        if (!name) {
          this.schImportError.set(this.transloco.translate('spaces.schema.import.invalidTypeFile'));
          return;
        }
        // Same mapping as the whole-schema import, and deliberately the same CALL: this was a hand-copied
        // duplicate of it, so the two paths read different subsets of a type — the bulk import gained
        // fields the per-type one silently dropped.
        const imported: TypeSchemaState = this.mapImportedTypeSchema(schemaRaw as Record<string, unknown>);
        // When importing as a new type (name derived from file), check for collision
        if (!this._typeImportTarget?.name && this.state.typeNames(kt).includes(name)) {
          // Stash parsed state and show conflict dialog instead of erroring
          this.importConflict.set({ kt, name, state: imported, allowAddAs: true });
          this.importConflictAddAsName.set(name + '-2');
          return;
        }
        this.state.schTypeSchemas = {
          ...this.state.schTypeSchemas,
          [kt]: { ...(this.state.schTypeSchemas[kt] ?? {}), [name]: imported },
        };
        this.schImportError.set('');
      } catch {
        this.schImportError.set(this.transloco.translate('spaces.schema.import.parseFailed'));
      } finally {
        if (this.schTypeImportInputRef) this.schTypeImportInputRef.nativeElement.value = '';
        this._typeImportTarget = null;
      }
    };
    reader.readAsText(file);
  }

  dismissImportConflict(): void {
    this.importConflict.set(null);
    this.importConflictAddAsName.set('');
  }

  resolveImportConflictOverride(): void {
    const c = this.importConflict();
    if (!c) return;
    this.state.schTypeSchemas = {
      ...this.state.schTypeSchemas,
      [c.kt]: { ...(this.state.schTypeSchemas[c.kt] ?? {}), [c.name]: c.state },
    };
    this.dismissImportConflict();
  }

  resolveImportConflictAddAs(): void {
    const c = this.importConflict();
    const newName = this.importConflictAddAsName().trim();
    if (!c || !newName) return;
    if (this.state.typeNames(c.kt).includes(newName)) {
      // Still conflicts — update the suggested name signal so the input shakes visually
      this.importConflictAddAsName.set(newName);
      return;
    }
    this.state.schTypeSchemas = {
      ...this.state.schTypeSchemas,
      [c.kt]: { ...(this.state.schTypeSchemas[c.kt] ?? {}), [newName]: c.state },
    };
    this.dismissImportConflict();
  }

  saveTypeToLibrary(kt: KnowledgeType, name: string): void {
    const state = this.state.typeState(kt, name);
    // Auto-derive entry name from the type name (slug)
    const entryName = name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 200);
    if (!entryName) return;

    // `withRetention: false` — a library entry has no `retention` key and its schema is strict, so including
    // one would 400. That is also why the caller is warned: converting this type to a $ref leaves the window
    // behind, and a silently-dropped delete policy is the worst kind to drop.
    const schema = typeSchemaFromState(kt, state, { withRetention: false });
    const losesRetention = state.retentionDays !== null || state.retentionContentDays !== null;

    const body = { knowledgeType: kt, typeName: name, schema: schema as Omit<TypeSchema, '$ref'> };
    this.schemaApi.upsertSchemaLibraryEntry(entryName, body).subscribe({
      next: () => {
        // Convert the in-space type to a $ref pointing at the new library entry
        const refState: TypeSchemaState = emptyTypeSchemaState({ _libRef: entryName });
        this.state.schTypeSchemas = {
          ...this.state.schTypeSchemas,
          [kt]: { ...(this.state.schTypeSchemas[kt] ?? {}), [name]: refState },
        };
        if (losesRetention) this.toast.info(this.transloco.translate('spaces.schema.retention.libDropped', { name }));
      },
      error: (err) => {
        this.schImportError.set(refusalText(this.transloco, err, 'spaces.schema.libSave.failed'));
      },
    });
  }

  triggerImportFromLibrary(kt: KnowledgeType, name: string): void {
    this._libPickerTarget = { kt, name };
    this.libPickerLoading.set(true);
    this.libPickerError.set(null);
    this.showLibPickerDialog.set(true);
    this.schemaApi.listSchemaLibrary().subscribe({
      next: ({ entries }) => {
        this.libPickerEntries.set(entries.filter(e => e.knowledgeType === kt));
        this.libPickerLoading.set(false);
      },
      error: (err) => {
        this.libPickerEntries.set([]);
        this.libPickerError.set(httpErrorReason(err));
        this.libPickerLoading.set(false);
      },
    });
  }

  /** Retry from the picker's error state — re-runs whichever of the two open paths produced it. */
  retryLibPicker(): void {
    const target = this._libPickerTarget;
    if (target?.kt) this.triggerImportFromLibrary(target.kt, target.name);
    else this.triggerImportFromLibraryAny();
  }


  /**
   * Open the library picker unscoped — every entry, from the top action row.
   *
   * Replaces the per-knowledge-type buttons that used to sit under each section: those existed only to
   * tell the importer where the schema belonged, and the library entry already records that.
   */
  triggerImportFromLibraryAny(): void {
    this.libImportSkipped.set([]);
    this._libPickerTarget = { kt: null, name: '' };
    this.libPickerLoading.set(true);
    this.libPickerError.set(null);
    this.showLibPickerDialog.set(true);
    this.schemaApi.listSchemaLibrary().subscribe({
      next: ({ entries }) => { this.libPickerEntries.set(entries); this.libPickerLoading.set(false); },
      error: (err) => {
        this.libPickerEntries.set([]);
        this.libPickerError.set(httpErrorReason(err));
        this.libPickerLoading.set(false);
      },
    });
  }

  /** Entries bucketed by `schemaGroup`, so a whole group can be taken in one action. Ungrouped last. */
  libPickerGroups = computed<{ group: string; entries: SchemaLibraryEntry[] }[]>(() => {
    const byGroup = new Map<string, SchemaLibraryEntry[]>();
    for (const e of this.libPickerEntries()) {
      const g = e.schemaGroup?.trim() || '';
      byGroup.set(g, [...(byGroup.get(g) ?? []), e]);
    }
    return [...byGroup.entries()]
      .map(([group, entries]) => ({ group, entries }))
      .sort((a, b) => (a.group === '' ? 1 : b.group === '' ? -1 : a.group.localeCompare(b.group)));
  });

  /**
   * Import every entry in a group.
   *
   * Silently SKIPS a type that already exists rather than raising the single-import conflict dialog:
   * a group can hold many entries, and a modal per collision would be unusable. The skipped names are
   * surfaced so the outcome is never a silent partial import.
   */
  importGroupFromLibrary(group: string): void {
    const entries = this.libPickerGroups().find(g => g.group === group)?.entries ?? [];
    const skipped: string[] = [];
    let next: Record<string, Record<string, TypeSchemaState>> =
      { ...this.state.schTypeSchemas } as Record<string, Record<string, TypeSchemaState>>;
    for (const entry of entries) {
      const kt = entry.knowledgeType;
      const typeName = entry.typeName;
      if (!typeName) continue;
      if (Object.keys(next[kt] ?? {}).includes(typeName)) { skipped.push(typeName); continue; }
      const refState: TypeSchemaState = emptyTypeSchemaState({ _libRef: entry.name });
      next = { ...next, [kt]: { ...(next[kt] ?? {}), [typeName]: refState } };
    }
    this.state.schTypeSchemas = next as typeof this.state.schTypeSchemas;
    this.libImportSkipped.set(skipped);
    this.closeLibPicker();
  }

  /** Type names a group import left alone because the space already had them. */
  libImportSkipped = signal<string[]>([]);

  closeLibPicker(): void {
    this.showLibPickerDialog.set(false);
    this._libPickerTarget = null;
  }

  /** Set the space's type to use a $ref pointing at this library entry. */
  importFromLibraryRef(entry: SchemaLibraryEntry): void {
    const target = this._libPickerTarget;
    if (!target) return;
    // An unscoped (top-row) pick takes the knowledge type from the ENTRY. That is what lets one button
    // replace the per-type ones: the library already records where each schema belongs.
    const kt = target.kt ?? entry.knowledgeType;
    const typeName = target.name || entry.typeName;
    if (!typeName) return;
    // Store as a special sentinel state that renders as a $ref in buildMeta()
    const refState: TypeSchemaState = emptyTypeSchemaState({ _libRef: entry.name });
    // When adding a new type from lib (no pre-existing name), check for collision
    if (!target.name && this.state.typeNames(kt).includes(typeName)) {
      this.closeLibPicker();
      this.importConflict.set({ kt, name: typeName, state: refState, allowAddAs: false });
      return;
    }
    this.state.schTypeSchemas = {
      ...this.state.schTypeSchemas,
      [kt]: { ...(this.state.schTypeSchemas[kt] ?? {}), [typeName]: refState },
    };
    this.closeLibPicker();
  }
}
