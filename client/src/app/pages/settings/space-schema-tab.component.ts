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
import { Component, ChangeDetectionStrategy, inject, signal, ElementRef, ViewChild, OnInit, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SchemaTypeNameComponent } from './schema-type-name.component';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { ModalDirective } from '../../shared/modal.directive';
import { SPACE_DIALOG_STYLES } from './space-dialog.styles';
import { SpaceSettingsState, emptyTypeSchemaState, typeSchemaFromState, type TypeSchemaState } from './space-settings-state.service';
import { SchemaApi } from '../../core/schema-api.service';
import { ToastService } from '../../core/toast.service';
import { KnowledgeType, KNOWLEDGE_TYPES, PropertySchema, SchemaLibraryEntry, TypeSchema, recordTtlWindows } from '../../core/api.types';
import { ErrorStateComponent } from '../../shared/error-state.component';
import { httpErrorReason } from '../../core/http-error';

import { SCHEMA_MD_STYLES } from './schema-styles';
import { SchemaTypeEditorComponent } from './schema-type-editor.component';

@Component({
  selector: 'app-space-schema-tab',
  standalone: true,
  imports: [SchemaTypeEditorComponent, SchemaTypeNameComponent, CommonModule, FormsModule, TranslocoPipe, PhIconComponent, ModalDirective, ErrorStateComponent],
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
<div class="sch-coll-tabs" role="tablist" [attr.aria-label]="'spaces.schema.collTabsAriaLabel' | transloco">
  <button class="sch-coll-tab" [class.active]="state.schemaCollTab()==='entity'" [attr.aria-selected]="state.schemaCollTab()==='entity'" role="tab" (click)="state.schemaCollTab.set('entity');schImportError.set('');schImportInfo.set('')">
    {{ 'spaces.schema.tab.entities' | transloco }}
    @if (state.typeCount('entity')) { <span class="sch-cnt-badge">{{ state.typeCount('entity') }}</span> }
  </button>
  <button class="sch-coll-tab" [class.active]="state.schemaCollTab()==='edge'" [attr.aria-selected]="state.schemaCollTab()==='edge'" role="tab" (click)="state.schemaCollTab.set('edge');schImportError.set('');schImportInfo.set('')">
    {{ 'spaces.schema.tab.edges' | transloco }}
    @if (state.typeCount('edge')) { <span class="sch-cnt-badge">{{ state.typeCount('edge') }}</span> }
  </button>
  <button class="sch-coll-tab" [class.active]="state.schemaCollTab()==='fact'" [attr.aria-selected]="state.schemaCollTab()==='fact'" role="tab" (click)="state.schemaCollTab.set('fact');schImportError.set('');schImportInfo.set('')">
    {{ 'spaces.schema.tab.facts' | transloco }}
    @if (state.typeCount('fact')) { <span class="sch-cnt-badge">{{ state.typeCount('fact') }}</span> }
  </button>
  <button class="sch-coll-tab" [class.active]="state.schemaCollTab()==='chrono'" [attr.aria-selected]="state.schemaCollTab()==='chrono'" role="tab" (click)="state.schemaCollTab.set('chrono');schImportError.set('');schImportInfo.set('')">
    {{ 'spaces.schema.tab.chrono' | transloco }}
    @if (state.typeCount('chrono')) { <span class="sch-cnt-badge">{{ state.typeCount('chrono') }}</span> }
  </button>
</div>
<div class="sch-coll-body">

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
        <button type="button" class="sch-type-item" [class.sel]="state.isTypeSelected(kt,name)" (click)="state.selectType(kt,name)">
          <span class="nm">{{ name }}</span>
          <span class="sch-type-badges">
            @if (state.typeLibRef(kt,name)) {
              <span class="badge badge-blue">Library</span>
            } @else {
              @if (state.typeState(kt,name).propertySchemas.length) {
                <span class="badge badge-gray">{{ state.typeState(kt,name).propertySchemas.length }}p</span>
              }
              @if (kt === 'entity' && state.typeState(kt,name).namingPattern) {
                <span class="badge badge-gray">pat</span>
              }
              <!-- A window deletes records, so it is visible from the list rather than only after selecting
                   the type. Amber, not grey: this is the one badge here that describes data loss. -->
              @if (state.typeState(kt,name).retentionDays || state.typeState(kt,name).retentionContentDays) {
                <span class="badge badge-yellow">ttl</span>
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
    // Load the library once so linked types can render their (read-only) properties and be unlinked
    // into an inline copy without a per-type round-trip.
    this.schemaApi.listSchemaLibrary().subscribe({
      next: ({ entries }) => this.libEntriesByName.set(Object.fromEntries(entries.map(e => [e.name, e]))),
      error: () => this.libEntriesByName.set({}),
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
    const schema = entry.schema;
    this.state.schTypeSchemas = {
      ...this.state.schTypeSchemas,
      [kt]: {
        ...(this.state.schTypeSchemas[kt] ?? {}),
        // No retention: a library entry cannot carry one (the library's own schema rejects the field), so an
        // unlinked type starts on the space default rather than inheriting a window from somewhere it never had.
        // _libRef intentionally dropped — the type is now a plain inline schema.
        [name]: emptyTypeSchemaState({
          namingPattern:   schema.namingPattern ?? '',
          propertySchemas: Object.entries(schema.propertySchemas ?? {}).map(([k, ps]) => ({ key: k, s: { ...ps }, _enumInput: '' })),
        }),
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
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `${space.id}_schemas.json`;
    a.click();
    URL.revokeObjectURL(url);
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
        this.exportLibDialog.set({ ...d, saving: false, error: err?.error?.error ?? this.transloco.translate('spaces.schema.exportToLibrary.failed') });
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
    const ref = ts2['$ref'];
    if (typeof ref === 'string' && ref.startsWith('library:')) {
      // `_libRef` is the editor's marker for "this type is a library reference"; `buildMeta()` turns it
      // back into `{ $ref: 'library:<name>' }` on save, and the server resolves it.
      return emptyTypeSchemaState({ _libRef: ref.slice('library:'.length) });
    }
    // A retention window travels with the type it belongs to. It is read defensively because the file is
    // arbitrary JSON: a string or a negative number becomes "inherit" rather than a save the API will reject.
    const ret = ts2['retention'];
    const win = (k: string): number | null => {
      if (!ret || typeof ret !== 'object' || Array.isArray(ret)) return null;
      const v = (ret as Record<string, unknown>)[k];
      return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null;
    };
    return emptyTypeSchemaState({
      namingPattern:   typeof ts2['namingPattern'] === 'string' ? ts2['namingPattern'] : '',
      retentionDays:        win('days'),
      retentionContentDays: win('contentDays'),
      /*
       * Read in so they can be written back out. No control edits either — but `typeSchemaFromState` REBUILDS
       * the type object, so a field this state never holds is deleted the next time an operator saves any type
       * schema. Somebody who declared endpoint types through the API and later renamed a property in the editor
       * would have lost the declaration with no message.
       */
      ...(ts2['endpoints'] !== undefined ? { endpoints: ts2['endpoints'] as { from?: string[]; to?: string[] } } : {}),
      ...(typeof ts2['functional'] === 'boolean' ? { functional: ts2['functional'] } : {}),
      propertySchemas: (() => {
        const ps = ts2['propertySchemas'];
        if (!ps || typeof ps !== 'object' || Array.isArray(ps)) return [];
        // Spread preserves every field, including `$ref` (library references).
        return Object.entries(ps as Record<string, unknown>).map(([k, v]) => ({
          key: k,
          s:   { ...(v as PropertySchema) },
          _enumInput: '',
        }));
      })(),
    });
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
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `${space.id}_${kt}_${name}.json`;
    a.click();
    URL.revokeObjectURL(url);
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
        this.schImportError.set(err?.error?.error ?? this.transloco.translate('spaces.schema.libSave.failed'));
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
