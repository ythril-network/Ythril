import { Injectable, inject, signal } from '@angular/core';
import {
  Space, SpaceMeta, SpaceStats, KnowledgeType, PropertySchema, TypeSchema,
  ValidationMode, DupeActionRule,
  KNOWLEDGE_TYPES,
} from '../../core/api.types';
import { TranslocoService } from '@jsverse/transloco';
import { SpacesApi } from '../../core/spaces-api.service';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import {
  addProp as addPropTo,
  removeProp as removePropFrom,
  addEnumVal as addEnumValTo,
  removeEnumVal as removeEnumValFrom,
} from './type-schema-edits';

/**
 * Editable form state for one type schema.
 *
 * `propertySchemas` is a keyed LIST rather than the wire format's map, because the UI needs stable
 * row identity while a key is being typed. `_`-prefixed fields are transient input buffers and never
 * reach the server — see `buildMeta()`.
 */
export interface TypeSchemaState {
  namingPattern:   string;
  /**
   * Edge-only, and carried rather than edited — there is no control for either yet.
   *
   * They are HERE because `typeSchemaFromState` rebuilds the type object from scratch (`const ts: TypeSchema =
   * {}`), so a field this state does not hold is DELETED the next time an operator saves any type schema in the
   * UI. An operator who declared endpoint types through the API and later renamed a property in the editor would
   * have silently lost the declaration.
   *
   * That is why "no control" and "not carried" are different decisions, and only the first is on the table:
   * `type-schema-editable.test.js` exempts a field from needing an input, never from surviving a save.
   */
  endpoints?:  { from?: string[]; to?: string[] };
  functional?: boolean;
  /**
   * How long records of this type are kept — the SCHEMA tier of record > schema > space.
   *
   * `null` for "not set", not `0`: zero is a real value the API rejects, and an empty number input must mean
   * "inherit the space default" rather than "expire immediately".
   *
   * `contentDays` is chrono-only (it drops the recallable half — description, matchedText and the embedding —
   * while keeping the record and its `properties`). The editor only offers it for chrono, because the API
   * refuses it elsewhere and a control that cannot work is worse than none.
   */
  retentionDays:        number | null;
  retentionContentDays: number | null;
  /**
   * Skip embedding records of this type — the SCHEMA tier of record > schema > space.
   *
   * `null` means NOT STATED, and that is why it is a tri-state rather than a boolean: `false` is a real value
   * meaning "embed this type even though the space suppresses", and collapsing the two would make the
   * space-wide setting unreachable for any type that has a schema at all.
   */
  suppressEmbeddings: boolean | null;
  /**
   * **Chrono only.** What a passed due moment MEANS for this type — the schema tier of schema > space.
   *
   * `null` is NOT STATED and falls through to the space, for the same reason `suppressEmbeddings` above is a
   * tri-state: `'overdue'` is a real value meaning "derive for this type even though the space says not to",
   * and collapsing it into the absent case would make the space-wide setting unreachable for any type that
   * has a schema at all.
   */
  whenDuePasses: 'overdue' | 'nothing' | null;
  propertySchemas: { key: string; s: PropertySchema; _enumInput: string }[];
  _newPropInput:   string;
  _newTagInput:    string;
  /**
   * Set when the type is linked to a schema-library entry (`$ref: "library:<name>"`). Held as a
   * sentinel while editing and turned back into `$ref` by `buildMeta()`. Drop it and saving a space
   * silently converts a linked schema into an empty inline one — pinned by the round-trip tests.
   */
  _libRef?: string;
}

/**
 * A blank `TypeSchemaState`, optionally overridden — the single place the shape is written out.
 *
 * There were NINE object literals spelling this interface out field by field (add-type, unlink, two import
 * paths, three library paths, and two specs). Adding `retentionDays` to the interface made all nine a
 * compile error, which is the good outcome; the bad outcome is the tenth site, written next month, that
 * spreads an older shape and quietly drops a field nobody notices until a save loses it. A factory makes
 * "every construction site" one site.
 */
export function emptyTypeSchemaState(over: Partial<TypeSchemaState> = {}): TypeSchemaState {
  return {
    namingPattern: '', retentionDays: null, retentionContentDays: null, suppressEmbeddings: null,
    whenDuePasses: null,
    propertySchemas: [], _newPropInput: '', _newTagInput: '',
    ...over,
  };
}

/**
 * Editor state → the wire `TypeSchema`, in one place.
 *
 * There were three copies of this: the save path, the per-type JSON export, and "save this type to the
 * library". They had already drifted — only one of them trimmed the property `pattern` — and adding a field
 * to one of three serialisers is how an editable setting ends up unsaved on some paths and not others.
 *
 * `withRetention: false` is for the schema library, whose entry schema is `.strict()` and has no `retention`
 * key: a window belongs to a type IN A SPACE, and sending one would 400 the request.
 */
export function typeSchemaFromState(
  kt: KnowledgeType,
  state: TypeSchemaState,
  { withRetention = true }: { withRetention?: boolean } = {},
): TypeSchema {
  const ts: TypeSchema = {};
  if (kt === 'entity' && state.namingPattern.trim()) ts.namingPattern = state.namingPattern.trim();
  if (withRetention) {
    // Omitted entirely when neither window is set, so a type that inherits the space default does not carry
    // an empty `retention: {}` the API would reject.
    //
    // `contentDays` is sent only for chrono: the API accepts it elsewhere but the sweep ignores it, so writing
    // it would store a setting that silently does nothing — and dropping it here also keeps a stale value from
    // a type whose kind changed out of the payload.
    const days = positiveDays(state.retentionDays);
    const contentDays = kt === 'chrono' ? positiveDays(state.retentionContentDays) : undefined;
    if (days !== undefined || contentDays !== undefined) {
      ts.retention = { ...(days !== undefined ? { days } : {}), ...(contentDays !== undefined ? { contentDays } : {}) };
    }
  }
  // Sent only when STATED. Writing `false` for "not stated" would pin every type to embedding and make the
  // space-wide switch do nothing — the tier the API resolves last would never be reached.
  if (state.suppressEmbeddings !== null) ts.suppressEmbeddings = state.suppressEmbeddings;
  // Chrono only, and only when STATED — the API refuses it on the other three collections, so writing a
  // value a type kind cannot hold would turn every save on that type into a 400. Dropping it here also keeps
  // a stale value from a type whose kind changed out of the payload, exactly as `contentDays` does above.
  if (kt === 'chrono' && state.whenDuePasses !== null) ts.whenDuePasses = state.whenDuePasses;
  /*
   * Only for edges — the API refuses both on the other three collections, so writing a value a type kind
   * cannot hold would turn every save on that type into a 400.
   *
   * **The sides are pruned rather than copied, and that is not defensive tidying.** The API caps each side at
   * `min(1)` and refuses `endpoints: {}` outright, so a state holding `{ from: [] }` — from a hand-edited
   * draft, or a stored value that arrived before the control existed — would 400 the whole space PATCH. One
   * type's empty list would take every other type's edits down with it, and the message would name a field
   * the operator was not editing.
   *
   * `toggleEndpoint` keeps the same invariant at the other end, on every click. Two guards for one rule is
   * usually this codebase's worst habit; here they answer different questions — the toggle keeps the draft
   * legal as it is edited, this keeps the WIRE legal whatever the draft turns out to hold.
   */
  if (kt === 'edge') {
    const from = state.endpoints?.from?.filter(n => n.trim()) ?? [];
    const to = state.endpoints?.to?.filter(n => n.trim()) ?? [];
    if (from.length || to.length) {
      ts.endpoints = { ...(from.length ? { from } : {}), ...(to.length ? { to } : {}) };
    }
    // `false` is a STATEMENT here, unlike `suppressEmbeddings`: the field has no inherit tier, so an operator
    // who unticks it is saying this label is not functional rather than declining to say.
    if (state.functional !== undefined) ts.functional = state.functional;
  }
  if (state.propertySchemas.length) {
    const ps: Record<string, PropertySchema> = {};
    for (const { key, s } of state.propertySchemas) {
      const schema: PropertySchema = {};
      if (s.type)            schema.type    = s.type;
      if (s.enum?.length)    schema.enum    = [...s.enum];
      if (s.minimum != null) schema.minimum = s.minimum;
      if (s.maximum != null) schema.maximum = s.maximum;
      if (s.pattern?.trim()) schema.pattern = s.pattern.trim();
      if (s.mergeFn)         schema.mergeFn = s.mergeFn;
      if (s.required)        schema.required = s.required;
      if (s.default != null) schema.default  = s.default;
      ps[key] = schema;
    }
    ts.propertySchemas = ps;
  }
  return ts;
}

/**
 * A day count the API will accept, or undefined.
 *
 * `Number()` because a `type="number"` input bound with ngModel yields a STRING when the user types into it
 * on some paths, and `'30' > 0` is true while `JSON.stringify` would then send `"30"` — which the server's
 * `z.number()` rejects with a message about the wrong type, on a field the user filled in correctly.
 */
function positiveDays(v: number | null): number | undefined {
  if (v === null || v === undefined || (v as unknown) === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * State for the space-settings dialog, shared by its tabs.
 *
 * Extracted from the 1893-line SpacesComponent (A17.8). It lives in a service rather than in the
 * dialog component because `openSettings()` populates all four tabs atomically and `buildMeta()`
 * reads across two of them (purpose/usageNotes from the settings tab, validation/tags/typeSchemas
 * from the schema tab) — so the tabs cannot each own their slice without one reaching into another.
 *
 * Provided by the dialog component, not root: each opening gets fresh state, and the lifetime
 * matches the dialog rather than the app.
 *
 * Member names are unchanged from the original component ON PURPOSE. This is a move, not a rewrite:
 * keeping the names means every method body diffs clean against the source, which is how the
 * extraction is verified. Renaming during a move hides exactly the kind of transcription slip that
 * a diff would otherwise catch (it already hid three here: a wrong `minScore` default, two missing
 * `dupeSaved.set(false)` calls, and hardcoded English where transloco belonged).
 */
@Injectable()
export class SpaceSettingsState {
  private spacesApi = inject(SpacesApi);
  private transloco = inject(TranslocoService);
  private confirmDialog = inject(ConfirmDialogService);

  /**
   * Ask before losing unsaved edits. Resolves true when it is safe to proceed.
   *
   * On the SERVICE rather than a component because two callers need the identical question: the pop-up's (X)
   * and the Spaces route's CanDeactivate hook. It answers true immediately when nothing is dirty, so no
   * caller has to pair it with its own isDirty() check and risk inverting one of them.
   */
  async confirmDiscardIfDirty(): Promise<boolean> {
    if (!this.isDirty()) return true;
    return this.confirmDialog.confirm({
      title:   this.transloco.translate('spaces.unsaved.title'),
      message: this.transloco.translate('spaces.unsaved.message'),
      confirmLabel: this.transloco.translate('spaces.unsaved.confirm'),
      cancelLabel:  this.transloco.translate('spaces.unsaved.cancel'),
      danger: true,
    });
  }

  readonly KINDS: readonly KnowledgeType[] = KNOWLEDGE_TYPES;
  readonly KIND_LABELS: Record<KnowledgeType, string> = {
    entity: 'Entities', memory: 'Memories', edge: 'Edges', chrono: 'Chrono',
  };

  // ── dialog shell ───────────────────────────────────────────────────────────
  settingsSpace  = signal<Space | null>(null);
  settingsTab    = signal<'settings' | 'schema' | 'duplicates' | 'danger'>('settings');
  settingsSaving = signal(false);
  settingsError  = signal('');
  /**
   * A non-error outcome that still needs saying — today, that a networked space held the change for a
   * vote instead of applying it. Separate from settingsError because it is not a failure: the edit was
   * accepted, and colouring it red would send an operator looking for a problem that does not exist.
   */
  settingsNotice = signal('');
  schemaCollTab = signal<KnowledgeType>('entity');

  // ── settings tab ───────────────────────────────────────────────────────────
  stForm = { label: '', purpose: '', usageNotes: '', maxGiB: null as number | null, documentExtraction: '' as '' | 'off' | 'ocr' | 'vlm' | 'repair' | 'auto',
    imageAnalysis: '' as '' | 'off' | 'caption' | 'recognition' | 'auto',
    audioAnalysis: '' as '' | 'off' | 'on' | 'auto',
    videoAnalysis: '' as '' | 'off' | 'audio' | 'full' | 'auto',
    textAnalysis: '' as '' | 'off' | 'embed' | 'chunk' | 'auto' };

  // ── duplicates tab ─────────────────────────────────────────────────────────
  dupeRulesState: DupeActionRule[] = [];
  dupeSurvivor: 'older' | 'newer' = 'older';
  dupeOnInsert = false;
  dupeSaving = signal(false);
  dupeSaved  = signal(false);
  dupeError  = signal('');

  // ── schema tab ─────────────────────────────────────────────────────────────
  schValidation:     ValidationMode = 'off';
  schStrictLinkage   = false;
  /**
   * Space-wide tag suggestions. The editor for this was retired — it was one list applied to every
   * type and every record form, easy to set once and forget while steering what got tagged.
   *
   * The load/save round-trip is KEPT on purpose so an existing list is preserved verbatim in
   * config.json rather than being erased the first time someone opens this tab and hits save. The
   * retirement is reversible; silently destroying an operator's data to tidy up a field would not be.
   */
  schTypeSchemas:    Partial<Record<KnowledgeType, Record<string, TypeSchemaState>>> = {
    entity: {}, memory: {}, edge: {}, chrono: {},
  };
  schNewTypeInputs:  Record<string, string> = { entity: '', memory: '', edge: '', chrono: '' };
  /** The type shown in the master/detail editor pane (single-select — that's what master/detail is). */
  schSelectedType:   { kt: KnowledgeType; name: string } | null = null;
  /** Property editors open in the detail pane. Multiple may be open at once (U4). Keyed `kt|type|prop`. */
  schExpandedProps = new Set<string>();

  // ── danger tab ─────────────────────────────────────────────────────────────
  dangerRenameId    = '';
  dangerRenaming    = signal(false);
  dangerRenameError = signal('');
  dangerWipeStats   = signal<SpaceStats | null>(null);
  dangerWipeLoading = signal(false);
  dangerWiping      = signal(false);
  dangerWipeError   = signal('');
  dangerDeleting    = signal(false);
  dangerDeleteError = signal('');

  /**
   * Load a space into every tab. Copies by VALUE throughout: the dialog must never mutate the Space
   * object the list is rendering from.
   */
  openSettings(s: Space): void {
    this.settingsSpace.set(s);
    this.settingsTab.set('settings');
    this.schemaCollTab.set('entity');
    this.settingsError.set('');
    this.settingsNotice.set('');
    this.settingsSaving.set(false);
    this.stForm = { label: s.label, purpose: s.meta?.purpose ?? '', usageNotes: s.meta?.usageNotes ?? '', maxGiB: s.maxGiB ?? null, documentExtraction: s.documentExtraction ?? '',
      imageAnalysis: s.imageAnalysis ?? '', audioAnalysis: s.audioAnalysis ?? '', videoAnalysis: s.videoAnalysis ?? '', textAnalysis: s.textAnalysis ?? '' };
    this.dupeRulesState = (s.dupeRules ?? []).map(r => ({ ...r }));
    this.dupeSurvivor = s.dupeMergeSurvivor ?? 'older';
    this.dupeOnInsert = s.dupeRulesOnInsert ?? false;
    this.dupeSaving.set(false);
    this.dupeSaved.set(false);
    this.dupeError.set('');
    const meta = s.meta ?? {};
    this.schValidation     = meta.validationMode ?? 'off';
    this.schStrictLinkage  = meta.strictLinkage ?? false;
    this.schNewTypeInputs  = { entity: '', memory: '', edge: '', chrono: '' };
    this.schSelectedType   = null;
    this.schExpandedProps.clear();
    const loadKt = (kt: KnowledgeType): Record<string, TypeSchemaState> => {
      const map: Record<string, TypeSchemaState> = {};
      for (const [name, ts] of Object.entries(meta.typeSchemas?.[kt] ?? {})) {
        // Preserve $ref as _libRef sentinel so buildMeta() can round-trip it
        if (ts.$ref?.startsWith('library:')) {
          map[name] = emptyTypeSchemaState({ _libRef: ts.$ref.slice('library:'.length) });
        } else {
          map[name] = emptyTypeSchemaState({
            namingPattern:   ts.namingPattern   ?? '',
            // `?? null`, never `?? 0`: an absent window means "inherit the space default", and 0 is a value the
            // API rejects. Reading it as 0 would round-trip a blank field into an invalid save.
            retentionDays:        ts.retention?.days        ?? null,
            retentionContentDays: ts.retention?.contentDays ?? null,
            // `?? null` again, and for the same reason: absent must round-trip as absent, or opening and saving
            // a type would write a value nobody chose.
            suppressEmbeddings:   ts.suppressEmbeddings      ?? null,
            whenDuePasses:        ts.whenDuePasses           ?? null,
            /*
             * An edge label's ends and cardinality, and this line is the one that was MISSING.
             *
             * `typeSchemaFromState` has written both fields since S-1, specifically so a UI save could not
             * delete a declaration made through the API — and it wrote `state.endpoints`, which nothing ever
             * filled. So the declaration was dropped when the space loaded and the save wrote it back as
             * absent: opening Space Settings and pressing Save deleted it, silently, with no control anywhere
             * in the dialog that mentioned the field.
             *
             * The carry-through was tested at the serialiser and the loader was never asked. Found by looking
             * at the finished control against an instance where the API had declared the rule — the boxes were
             * empty.
             */
            endpoints:  ts.endpoints  ? { ...(ts.endpoints.from ? { from: [...ts.endpoints.from] } : {}), ...(ts.endpoints.to ? { to: [...ts.endpoints.to] } : {}) } : undefined,
            functional: ts.functional,
            propertySchemas: Object.entries(ts.propertySchemas ?? {}).map(([k, ps]) => ({ key: k, s: { ...ps }, _enumInput: '' })),
          });
        }
      }
      return map;
    };
    this.schTypeSchemas = {
      entity: loadKt('entity'),
      memory: loadKt('memory'),
      edge:   loadKt('edge'),
      chrono: loadKt('chrono'),
    };
    this.dangerRenameId = s.id;
    this.dangerRenameError.set('');
    this.dangerRenaming.set(false);
    this.dangerDeleteError.set('');
    this.dangerDeleting.set(false);
    this.dangerWipeStats.set(null);
    this.dangerWipeError.set('');
    this.dangerWiping.set(false);
    this.dangerWipeLoading.set(true);
    this.spacesApi.getSpaceStats(s.id).subscribe({
      next: (stats) => { this.dangerWipeStats.set(stats); this.dangerWipeLoading.set(false); },
      error: () => this.dangerWipeLoading.set(false),
    });
    // Baseline the dirty snapshot now that every editable field is populated.
    this.markPristine();
  }

  closeSettings(): void { this.settingsSpace.set(null); }

  // ── unsaved-changes tracking (U4) ────────────────────────────────────────────
  private initialSnapshot = '';
  /** The payload as the dialog opened it. `changedSettings()` is the difference against this. */
  private pristinePayload: Record<string, unknown> = {};
  private dupeInitialSnapshot = '';

  /**
   * Serializes exactly what the footer save persists — label + maxGiB + `buildMeta()` —
   * so it ignores transient input buffers and UI state (the active tab, expanded rows, half-typed
   * new-property inputs) automatically. The duplicates tab persists through its OWN save button, so its
   * edits are snapshotted separately by `dupeSnapshot()` — but BOTH feed `isDirty()`, so unsaved dupe
   * edits still trip the close guard (previously they were silently dropped with no warning).
   */
  snapshot(): string { return JSON.stringify(this.settingsPayload()); }

  /**
   * Everything the footer save can persist, as an object. `snapshot()` is this, stringified.
   *
   * Split out because the SAVE now sends the difference against the pristine copy rather than all of it,
   * and both need the same shape or the diff would compare one thing against another.
   */
  settingsPayload(): Record<string, unknown> {
    return {
      label: this.stForm.label.trim(),
      maxGiB: this.stForm.maxGiB,
      documentExtraction: this.stForm.documentExtraction,
      imageAnalysis: this.stForm.imageAnalysis,
      audioAnalysis: this.stForm.audioAnalysis,
      videoAnalysis: this.stForm.videoAnalysis,
      textAnalysis: this.stForm.textAnalysis,
      meta: this.buildMeta(),
    };
  }

  /**
   * Only the fields the operator actually changed. Empty means there is nothing to save.
   *
   * ## Why the whole form was the wrong body
   *
   * Each field on `PATCH /api/spaces/:id` answers to the area that owns it since 4.4 — a media level is
   * `files` write, a duplicate rule is `dataQuality`, the quota is instance-admin. Posting every field on
   * every save makes the HIGHEST requirement in the form decide, so a token holding exactly what it needs
   * to change one thing is refused for the twenty-one it did not touch. The per-field rungs were real on
   * the API and inert in this dialog.
   *
   * ## Two fields that are not a plain diff, and both have cost something before
   *
   * - `typeSchemasMode: 'replace'` rides along whenever `meta.typeSchemas` does. Without it the server
   *   MERGES, so a type deleted in the editor is simply not mentioned and is faithfully preserved — the
   *   deletion appears to work, survives the save, and is still there on reload. It must never be sent on
   *   its own: with no `typeSchemas` beside it, `replace` is a mode for a map that is not in the body.
   * - `recordTtlDays` is not in this payload at all and must not be added. It is edited in the Danger
   *   Zone, which saves itself, and the space tier is five buckets — a scalar write REPLACES the whole
   *   object, so echoing a stored value back would flatten every per-collection window to one figure.
   */
  changedSettings(): Record<string, unknown> {
    // `record-ttl-buckets.test.js` asserts that field's NAME appears nowhere in this file, and it strips
    // comments before looking — so the paragraph above may name it and this code may not.
    const now = this.settingsPayload();
    const was = this.pristinePayload;
    const out: Record<string, unknown> = {};

    for (const key of Object.keys(now)) {
      if (key === 'meta') continue;
      if (JSON.stringify(now[key]) !== JSON.stringify(was[key])) out[key] = now[key];
    }

    // `meta` is diffed per KEY rather than whole: sending the object because one field inside it moved
    // would put `purpose` (space-admin) and `suppressEmbeddings` (knowledge admin) into a request that
    // meant to change a validation mode.
    const nowMeta = (now['meta'] ?? {}) as Record<string, unknown>;
    const wasMeta = (was['meta'] ?? {}) as Record<string, unknown>;
    const meta: Record<string, unknown> = {};
    for (const key of Object.keys(nowMeta)) {
      if (JSON.stringify(nowMeta[key]) !== JSON.stringify(wasMeta[key])) meta[key] = nowMeta[key];
    }
    if (Object.keys(meta).length) {
      out['meta'] = meta;
      if ('typeSchemas' in meta) out['typeSchemasMode'] = 'replace';
    }
    return out;
  }

  /** Serializes the duplicates-tab form. Baselined independently because that tab has its own save. */
  dupeSnapshot(): string {
    return JSON.stringify({
      rules: this.dupeRulesState,
      survivor: this.dupeSurvivor,
      onInsert: this.dupeOnInsert,
    });
  }

  /** Re-baseline both dirty snapshots — called after opening a space. */
  markPristine(): void {
    this.pristinePayload = this.settingsPayload();
    this.initialSnapshot = this.snapshot();
    this.dupeInitialSnapshot = this.dupeSnapshot();
  }

  /** Re-baseline ONLY the duplicates snapshot — called after the duplicates tab's own successful save. */
  markDupePristine(): void { this.dupeInitialSnapshot = this.dupeSnapshot(); }

  /** True when the settings/schema editor OR the duplicates tab has unsaved edits. */
  isDirty(): boolean {
    if (this.settingsSpace() === null) return false;
    return this.snapshot() !== this.initialSnapshot || this.dupeSnapshot() !== this.dupeInitialSnapshot;
  }

  /** Build the meta payload sent on save. Reads the settings tab AND the schema tab. */
  buildMeta(): Partial<SpaceMeta> {
    const meta: Partial<SpaceMeta> = {};
    if (this.stForm.purpose.trim())    meta.purpose    = this.stForm.purpose.trim();
    if (this.stForm.usageNotes.trim()) meta.usageNotes = this.stForm.usageNotes.trim();
    meta.validationMode = this.schValidation;
    if (this.schStrictLinkage)         meta.strictLinkage  = true;
    // Every knowledge type is emitted, including the empty ones, and `typeSchemas` is always set.
    //
    // Both used to be conditional (`if (names.length)`, `if (Object.keys(typeSchemas).length)`), and that
    // is how a deletion was lost: delete the last entity type and the `entity` key vanished from the
    // payload, so the server had nothing to act on and kept what it had. An absent key and an empty object
    // mean opposite things here, and only one of them can express "this kind now declares nothing".
    //
    // Paired with `typeSchemasMode: 'replace'` on the request, this makes Save mean what it looks like it
    // means: the space ends up holding exactly what the editor was showing.
    const typeSchemas: Partial<Record<KnowledgeType, Record<string, TypeSchema>>> = {};
    for (const kt of this.KINDS) {
      const ktMap = this.schTypeSchemas[kt] ?? {};
      const out: Record<string, TypeSchema> = {};
      for (const name of Object.keys(ktMap)) {
        const state = ktMap[name]!;
        // If this type was set via "import as $ref", emit a $ref TypeSchema
        if (state._libRef) {
          out[name] = { $ref: `library:${state._libRef}` };
          continue;
        }
        out[name] = typeSchemaFromState(kt, state);
      }
      typeSchemas[kt] = out;
    }
    meta.typeSchemas = typeSchemas;
    return meta;
  }

  // ── duplicate rules ────────────────────────────────────────────────────────

  addDupeRule(): void {
    this.dupeRulesState = [...this.dupeRulesState, { minScore: 0.95, action: 'flag' }];
    this.dupeSaved.set(false);
  }

  removeDupeRule(i: number): void {
    this.dupeRulesState = this.dupeRulesState.filter((_, idx) => idx !== i);
    this.dupeSaved.set(false);
  }

  hasAutomergeRule(): boolean {
    return this.dupeRulesState.some(r => r.action === 'automerge');
  }

  // ── type schemas ───────────────────────────────────────────────────────────

  typeNames(kt: KnowledgeType): string[] { return Object.keys(this.schTypeSchemas[kt] ?? {}); }
  typeState(kt: KnowledgeType, name: string): TypeSchemaState { return (this.schTypeSchemas[kt] ?? {})[name]!; }
  typeCount(kt: KnowledgeType): number { return Object.keys(this.schTypeSchemas[kt] ?? {}).length; }
  /** Returns the library entry name if this type is set as a $ref, otherwise null. */
  typeLibRef(kt: KnowledgeType, name: string): string | null {
    return (this.schTypeSchemas[kt] ?? {})[name]?._libRef ?? null;
  }

  /** Master/detail: the selected type is the one rendered in the editor pane. Single-select. */
  isTypeSelected(kt: KnowledgeType, name: string): boolean {
    return this.schSelectedType?.kt === kt && this.schSelectedType?.name === name;
  }

  selectType(kt: KnowledgeType, name: string): void {
    this.schSelectedType = { kt, name };
  }

  private propKey(kt: KnowledgeType, typeName: string, propKey: string): string {
    return `${kt}|${typeName}|${propKey}`;
  }

  addType(kt: KnowledgeType): void {
    const raw = (this.schNewTypeInputs[kt] ?? '').trim();
    if (!raw || (this.schTypeSchemas[kt] ?? {})[raw]) return;
    this.schTypeSchemas = {
      ...this.schTypeSchemas,
      [kt]: { ...(this.schTypeSchemas[kt] ?? {}), [raw]: emptyTypeSchemaState() },
    };
    this.schNewTypeInputs = { ...this.schNewTypeInputs, [kt]: '' };
    this.schSelectedType  = { kt, name: raw };
  }

  removeType(kt: KnowledgeType, name: string): void {
    const { [name]: _dropped, ...rest } = this.schTypeSchemas[kt] ?? {};
    this.schTypeSchemas = { ...this.schTypeSchemas, [kt]: rest };
    if (this.schSelectedType?.kt === kt && this.schSelectedType.name === name) this.schSelectedType = null;
  }

  isPropExpanded(kt: KnowledgeType, typeName: string, propKey: string): boolean {
    return this.schExpandedProps.has(this.propKey(kt, typeName, propKey));
  }

  togglePropExpand(kt: KnowledgeType, typeName: string, propKey: string): void {
    const k = this.propKey(kt, typeName, propKey);
    if (this.schExpandedProps.has(k)) this.schExpandedProps.delete(k);
    else this.schExpandedProps.add(k);
  }

  // ── The per-type edits live in `type-schema-edits.ts` and are delegated to from here.
  //
  // They moved so the Brain Overview's data-model panel can open the same editor in place rather than
  // sending an operator to Space Settings for a one-field change. This service is page-scoped and cannot be
  // injected there; the edits are now plain functions over a state object, so both callers share one
  // implementation. What stays HERE is the expansion set, because which rows are open is a property of this
  // view and a modal editing a single type has no use for it.

  addProp(kt: KnowledgeType, typeName: string): void {
    const key = addPropTo(this.typeState(kt, typeName));
    if (key !== null) this.schExpandedProps.add(this.propKey(kt, typeName, key));
  }

  removeProp(kt: KnowledgeType, typeName: string, propKey: string): void {
    removePropFrom(this.typeState(kt, typeName), propKey);
    this.schExpandedProps.delete(this.propKey(kt, typeName, propKey));
  }

  // `addTypeTag` went with the per-type tag-suggestion editor: the list it edited reached neither the
  // Brain record forms nor the MCP schema guidance, so the control did nothing. 3.0 removed the FIELD
  // too, so there is no longer a value to load or write back — a list already in config.json is left
  // where it is and simply never read.

  onEnumKey(e: KeyboardEvent, kt: KnowledgeType, typeName: string, propKey: string): void {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); this.addEnumVal(kt, typeName, propKey); }
  }

  addEnumVal(kt: KnowledgeType, typeName: string, propKey: string): void {
    addEnumValTo(this.typeState(kt, typeName), propKey);
  }

  removeEnumVal(kt: KnowledgeType, typeName: string, propKey: string, val: string | number | boolean): void {
    removeEnumValFrom(this.typeState(kt, typeName), propKey, val);
  }

  wipeStatCols(): { label: string; value: number }[] {
    const s = this.dangerWipeStats();
    if (!s) return [];
    return [
      { label: this.transloco.translate('spaces.stats.memories'), value: s.memories },
      { label: this.transloco.translate('spaces.stats.entities'), value: s.entities },
      { label: this.transloco.translate('spaces.stats.edges'),    value: s.edges    },
      { label: this.transloco.translate('spaces.stats.chrono'),   value: s.chrono   },
      { label: this.transloco.translate('spaces.stats.files'),    value: s.files    },
    ];
  }
}
