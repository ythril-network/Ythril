import { Injectable, inject, signal } from '@angular/core';
import {
  Space, SpaceMeta, SpaceStats, KnowledgeType, PropertySchema, TypeSchema, SchemaRule, SpaceSchemaRule,
  ValidationMode, DupeActionRule,
  KNOWLEDGE_TYPES,
} from '../../core/api.types';
import { TranslocoService } from '@jsverse/transloco';
import { SpacesApi } from '../../core/spaces-api.service';
import type { SchemaLayersView } from '../../core/schema-api.service';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import {
  addProp as addPropTo,
  removeProp as removePropFrom,
  addEnumVal as addEnumValTo,
  removeEnumVal as removeEnumValFrom,
} from './type-schema-edits';

/**
 * One CEL rule of a type or of the space, as a ROW in the editor: a keyed LIST like `propertySchemas`, because a name is being
 * typed and the row needs a stable identity while it is. The wire format is a map keyed by name (`TypeSchema.rules`).
 */
export interface RuleRow { name: string; rule: string; message: string }

/** A space rule row: the same, plus the kinds it applies to. An EMPTY list means every kind, and is omitted on the wire. */
export interface SpaceRuleRow extends RuleRow { kinds: KnowledgeType[] }

const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The rows of a `rules` map as it arrives from the API, a file or a library entry, copied BY VALUE.
 *
 * Read defensively because a file is arbitrary JSON: a value that is not a map is no rules, and an entry that is not
 * `{ rule: string, message: string }` is skipped rather than turned into a save the API refuses. Order is the map's own.
 */
export function ruleRowsFromWire(raw: unknown): RuleRow[] {
  if (!isPlainObject(raw)) return [];
  const rows: RuleRow[] = [];
  for (const [name, def] of Object.entries(raw)) {
    if (!isPlainObject(def) || typeof def['rule'] !== 'string' || typeof def['message'] !== 'string') continue;
    rows.push({ name, rule: def['rule'], message: def['message'] });
  }
  return rows;
}

/** The space's rule rows: the type rows' reading, plus the kinds a rule names (only real kinds; none means every kind). */
export function spaceRuleRowsFromWire(raw: unknown): SpaceRuleRow[] {
  if (!isPlainObject(raw)) return [];
  return ruleRowsFromWire(raw).map(row => {
    const kinds = (raw[row.name] as Record<string, unknown>)['kinds'];
    return { ...row, kinds: Array.isArray(kinds) ? kinds.filter((k): k is KnowledgeType => (KNOWLEDGE_TYPES as readonly string[]).includes(k as string)) : [] };
  });
}

/**
 * Editable form state for one type schema.
 *
 * `propertySchemas` is a keyed LIST rather than the wire format's map, because the UI needs stable
 * row identity while a key is being typed. `_`-prefixed fields are transient input buffers and never
 * reach the server — see `buildMeta()`.
 */
export interface TypeSchemaState {
  /**
   * What this TYPE is for, in the operator's own words (`F-24`).
   *
   * Carried as well as edited. `typeSchemaFromState` rebuilds the wire object from scratch, so a field
   * this state does not hold is DELETED the next time anybody saves any type in the UI — which is the
   * note `endpoints` above carries, for the same reason.
   */
  description:     string;
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
  /**
   * The CEL rules of this type (F-46): an enforced constraint, so losing one on an unrelated save widens what the space accepts with no
   * message anywhere. Carried by every path that builds this state (the loader, a file, a library entry) and written by
   * `typeSchemaFromState`, which REBUILDS the wire object and would otherwise delete them.
   */
  rules: RuleRow[];
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
    description: '', namingPattern: '', retentionDays: null, retentionContentDays: null, suppressEmbeddings: null,
    whenDuePasses: null,
    propertySchemas: [], rules: [], _newPropInput: '', _newTagInput: '',
    ...over,
  };
}

/**
 * The editor state of a wire `TypeSchema` - the reverse of {@link typeSchemaFromState}, in one place.
 *
 * Three paths turned a wire schema into editor state, each by its own list of fields: the loader (a space opening), a file import and
 * "unlink a library entry". The last read two fields of nine, so unlinking a type deleted its description, its edge ends and its
 * embedding setting on the next save; a file import read seven and lost the rest. A field this does not read is deleted the next
 * time anybody saves any type, which is why there is one reader and it is written beside the serialiser.
 *
 * The input is read DEFENSIVELY (it may be a file: arbitrary JSON) and copied BY VALUE (the dialog must never mutate the object a list
 * renders from). A retention window that is not a positive integer reads as "inherit", a stated flag that is not a boolean as "not
 * stated". A library reference `{ $ref: 'library:<name>' }` becomes the `_libRef` sentinel `buildMeta()` turns back into one.
 */
export function typeStateFromSchema(raw: unknown): TypeSchemaState {
  if (!isPlainObject(raw)) return emptyTypeSchemaState();
  const ref = raw['$ref'];
  if (typeof ref === 'string' && ref.startsWith('library:')) return emptyTypeSchemaState({ _libRef: ref.slice('library:'.length) });
  const str = (k: string): string => (typeof raw[k] === 'string' ? raw[k] as string : '');
  const flag = (k: string): boolean | null => (typeof raw[k] === 'boolean' ? raw[k] as boolean : null);
  const retention = isPlainObject(raw['retention']) ? raw['retention'] : {};
  const window = (k: string): number | null => {
    const v = retention[k];
    return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null;
  };
  const endpoints = isPlainObject(raw['endpoints']) ? raw['endpoints'] : null;
  const names = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((n): n is string => typeof n === 'string') : undefined);
  const from = endpoints ? names(endpoints['from']) : undefined;
  const to = endpoints ? names(endpoints['to']) : undefined;
  const props = isPlainObject(raw['propertySchemas']) ? raw['propertySchemas'] : {};
  return emptyTypeSchemaState({
    description:   str('description'),
    namingPattern: str('namingPattern'),
    // `null`, never 0: an absent window means "inherit the space default", and 0 is a value the API rejects.
    retentionDays: window('days'),
    retentionContentDays: window('contentDays'),
    suppressEmbeddings: flag('suppressEmbeddings'),
    whenDuePasses: raw['whenDuePasses'] === 'overdue' || raw['whenDuePasses'] === 'nothing' ? raw['whenDuePasses'] : null,
    // An edge label's ends and cardinality: no control carries them in every host, and a save rebuilds the object.
    endpoints: endpoints ? { ...(from ? { from: [...from] } : {}), ...(to ? { to: [...to] } : {}) } : undefined,
    functional: typeof raw['functional'] === 'boolean' ? raw['functional'] : undefined,
    // Spread preserves every field of a property, including `$ref`.
    propertySchemas: Object.entries(props).map(([key, ps]) => ({ key, s: { ...(ps as PropertySchema) }, _enumInput: '' })),
    rules: ruleRowsFromWire(raw['rules']),
  });
}

/**
 * A property default, as the DECLARED type — or `undefined` when the text cannot be one.
 *
 * Dropped rather than sent as a string, because a numeric property carrying `default: "5"` is written
 * into every record that omits it and then fails that record's own type check on the next validated
 * write. A default that cannot be honoured is worse than none: the first is a space refusing records it
 * created, the second is a property with no default.
 *
 * A number that does not parse, or a boolean that is neither word, is the operator mid-edit as often as
 * it is a mistake — so it is simply not emitted, and the input keeps what they typed.
 */
export function defaultForType(raw: unknown, type: string | undefined): string | number | boolean | undefined {
  if (type === 'number' || type === 'integer') {
    const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
    if (!Number.isFinite(n)) return undefined;
    return type === 'integer' && !Number.isInteger(n) ? undefined : n;
  }
  if (type === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    const t = String(raw).trim().toLowerCase();
    return t === 'true' ? true : t === 'false' ? false : undefined;
  }
  // `string`, and anything the schema does not constrain, round-trips as written.
  return typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean' ? raw : undefined;
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
  // Trimmed and omitted when empty, like every other optional here: an empty string would store a
  // description that says nothing and read as one somebody wrote.
  if (state.description.trim()) ts.description = state.description.trim();
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
  // Rules, as the map the wire holds, keyed by name; omitted when the type has none, so a type without rules carries no empty map.
  // `rule` and `message` only: the row's other fields are the editor's own (an open disclosure, a buffer).
  const rules = state.rules.filter(r => r.name.trim());
  if (rules.length) {
    const map: Record<string, SchemaRule> = {};
    for (const r of rules) map[r.name.trim()] = { rule: r.rule, message: r.message };
    ts.rules = map;
  }
  if (state.propertySchemas.length) {
    const ps: Record<string, PropertySchema> = {};
    for (const { key, s } of state.propertySchemas) {
      const schema: PropertySchema = {};
      if (s.description?.trim()) schema.description = s.description.trim();
      if (s.type)            schema.type    = s.type;
      if (s.enum?.length)    schema.enum    = [...s.enum];
      if (s.minimum != null) schema.minimum = s.minimum;
      if (s.maximum != null) schema.maximum = s.maximum;
      if (s.pattern?.trim()) schema.pattern = s.pattern.trim();
      if (s.mergeFn)         schema.mergeFn = s.mergeFn;
      if (s.required)        schema.required = s.required;
      // COERCED to the type the property declares, and this is the un-skippable place for it.
      // `B-17`: the detail pane binds the default to a text input, so it is always a string — set one
      // and then change the type to `number` and the schema said `default: "5"` for a numeric
      // property. That is not cosmetic: the default is written into records that omit the property, so
      // a strict space starts refusing records it created itself.
      //
      // Here rather than on the type-change handler alone, because an operator can set the type first
      // and the default second, or edit the type through the API — whatever the input holds, what is
      // EMITTED has to match the declaration.
      if (s.default != null) {
        const coerced = defaultForType(s.default, s.type);
        if (coerced !== undefined) schema.default = coerced;
      }
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
/**
 * The value that CLEARS a field, given what it used to hold.
 *
 * A key vanishing from the payload means the operator emptied it, and an omitted key tells the server
 * nothing — its merge guards on `!== undefined`, so only an explicit value clears. Derived from the
 * previous value's type rather than from a per-key table: a table is a second list of the editor's
 * fields, and the next field added would not be in it.
 *
 * `null` for anything else, which the server reads as "unset" for the object-valued fields and which no
 * current key reaches.
 */
function clearedValueOf(was: unknown): unknown {
  if (typeof was === 'boolean') return false;
  if (typeof was === 'string') return '';
  if (Array.isArray(was)) return [];
  if (was !== null && typeof was === 'object') return {};
  return null;
}

/** Where an issue of a refused save points inside the rules: a type's rule (its collection and type) or a space rule. */
export type RuleLocation =
  | { scope: 'type'; kt: KnowledgeType; type: string; name: string; field: 'rule' | 'message' }
  | { scope: 'space'; name: string; field: 'rule' | 'message' };

/** A refused save's rule, with the sentence its row says. */
export type RuleRefusal = RuleLocation & { text: string };

/** Which rule (and which of its two texts) an issue path names, or null when it names none. */
export function ruleLocationOf(path: unknown): RuleLocation | null {
  if (!Array.isArray(path)) return null;
  const p = path.map(String);
  const field = (v: string | undefined): 'rule' | 'message' => (v === 'message' ? 'message' : 'rule');
  if (p[0] === 'meta' && p[1] === 'rules' && p[2]) return { scope: 'space', name: p[2], field: field(p[3]) };
  if (p[0] === 'meta' && p[1] === 'typeSchemas' && p[4] === 'rules' && p[5] && (KNOWLEDGE_TYPES as readonly string[]).includes(p[2]!)) {
    return { scope: 'type', kt: p[2] as KnowledgeType, type: p[3]!, name: p[5], field: field(p[6]) };
  }
  return null;
}

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
    entity: 'Entities', fact: 'Memories', edge: 'Edges', chrono: 'Chrono',
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
  /**
   * The edit was SUBMITTED and there is nothing left to send — the only state that may retire Save.
   *
   * Separate from `settingsNotice`, and `B-15` is why. The footer used to swap Save for the
   * close-and-finish button on ANY notice, which was written for the vote-pending path: a networked
   * space answers 202, the change IS submitted, and a button still offering to submit invites a second
   * proposal for the same change. But the same signal carries "nothing to save", which is not a
   * submission and not a finished state — so one Save that reported doing nothing took the Save button
   * away for the rest of the session, leaving an editable form whose only control closes the dialog.
   *
   * Owner-reported, 2026-09-17, alongside the diff bug that made an empty diff easy to reach.
   */
  settingsSubmitted = signal(false);
  schemaCollTab = signal<KnowledgeType>('entity');
  /**
   * The save was refused because somebody else changed the schema first (412): the footer offers a reload, and nothing else can fix it
   * (saving again sends the same stale version).
   */
  settingsConflict = signal(false);
  /**
   * The space's network schema layers, as the layers panel last loaded them: the ONE copy, so the panel above the tab and the tab's own
   * markers (a property a network supplies, with its Propose action) cannot disagree. `layersRefresh` is how the tab asks the panel to
   * load again after it proposed something.
   */
  schemaLayers = signal<SchemaLayersView | null>(null);
  layersRefresh = signal(0);
  /**
   * The rule a refused save named (an issue whose path runs into `rules`), where the Schema tab shows it: its collection, its type and its
   * row are opened, the row carries the message and focus moves into it. One object, replaced by each refusal: its identity IS the
   * request to the tab to open and focus the row again.
   */
  ruleRefusal = signal<RuleRefusal | null>(null);

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
   * What this instance does with a write that names a top-level field its operation does not take (bundle-128). The form's own
   * two-valued spelling: the server never stores `warn` and answers the key only as `'refuse'`, so an ABSENT key is `warn` here
   * (`openSettings`) and `warn` leaves as the clear, `''` (`settingsPayload`). It is NOT part of `meta`: it is local to this
   * instance, and the strict meta body would not take it.
   */
  schUnknownWriteFields: 'warn' | 'refuse' = 'warn';
  /**
   * Space-wide tag suggestions. The editor for this was retired — it was one list applied to every
   * type and every record form, easy to set once and forget while steering what got tagged.
   *
   * The load/save round-trip is KEPT on purpose so an existing list is preserved verbatim in
   * config.json rather than being erased the first time someone opens this tab and hits save. The
   * retirement is reversible; silently destroying an operator's data to tidy up a field would not be.
   */
  schTypeSchemas:    Partial<Record<KnowledgeType, Record<string, TypeSchemaState>>> = {
    entity: {}, fact: {}, edge: {}, chrono: {},
  };
  schNewTypeInputs:  Record<string, string> = { entity: '', fact: '', edge: '', chrono: '' };
  /**
   * The space-wide rules (F-46): the rows of `meta.rules`, each with the kinds it applies to. A plain field like the rest of this tab's
   * model; `buildMeta()` writes them out as one map, SENT WHOLE (the server replaces the map, so a rule left out of it is deleted).
   */
  schRules: SpaceRuleRow[] = [];
  /**
   * The version of the space's meta the dialog read. A schema save sends it as `If-Match`, so a save made on top of somebody else's
   * change is refused (412) instead of overwriting it.
   */
  schMetaVersion: number | undefined = undefined;
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

  /** The type definitions and the space rules of `meta`, as the editor holds them. */
  private loadDefinitionsFrom(meta: Partial<SpaceMeta>): void {
    const loadKt = (kt: KnowledgeType): Record<string, TypeSchemaState> =>
      Object.fromEntries(Object.entries(meta.typeSchemas?.[kt] ?? {}).map(([name, ts]) => [name, typeStateFromSchema(ts)]));
    this.schRules = spaceRuleRowsFromWire(meta.rules);
    this.schTypeSchemas = {
      entity: loadKt('entity'),
      fact: loadKt('fact'),
      edge:   loadKt('edge'),
      chrono: loadKt('chrono'),
    };
  }

  /**
   * The editor edits THIS SPACE'S OWN definitions (bundle-23, R6-14: "verified at build, not assumed").
   *
   * `GET /api/spaces` answers `meta` as the EFFECTIVE meta — the own definitions with every network's layer laid under them — and the
   * own ones are not in that answer (`ownMeta` stays on the server). A space that no network sends schema to has no difference, and the
   * editor opens on what that answer says. A space that has a layer would open on the union: a type both the operator and a network
   * define shows the network's properties as if they were the operator's, and saving an edit of it proposes — and then stores — the
   * union as the space's own definition, whence it is sent on to every other network the space is in. So when the layers answer arrives
   * (`GET /api/spaces/:id/schema-layers`: `own` is the own definitions) and the editor has not been touched, it is loaded again from
   * `own`. What a network supplies is shown by the layers panel and marked on the properties that clash; it is applied beneath what
   * is edited here. An editor with unsaved edits is left alone: replacing it would throw them away, and the save then sends what the
   * operator was looking at.
   */
  rebaseOnOwnDefinitions(view: SchemaLayersView): void {
    if (this.settingsSpace() === null || !view.layers.length || this.isDirty()) return;
    this.loadDefinitionsFrom(view.own as Partial<SpaceMeta>);
    const open = this.schSelectedType;
    if (open && !this.schTypeSchemas[open.kt]?.[open.name]) this.schSelectedType = null;
    this.markPristine();
  }

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
    this.settingsSubmitted.set(false);
    this.settingsSaving.set(false);
    this.settingsConflict.set(false);
    this.ruleRefusal.set(null);
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
    this.schUnknownWriteFields = s.unknownWriteFields === 'refuse' ? 'refuse' : 'warn';
    this.schNewTypeInputs = { entity: '', fact: '', edge: '', chrono: '' };
    this.schSelectedType   = null;
    this.schExpandedProps.clear();
    this.loadDefinitionsFrom(meta);
    this.schMetaVersion = meta.version;
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

  /**
   * A refused save that NAMES a rule: open it where the operator can fix it (F-46, R6-14).
   *
   * The refusal is the server's zod answer, `{ error, issues: [{ path: ['meta', 'typeSchemas', kt, type, 'rules', name, field?] }] }`
   * or `['meta', 'rules', name, field?]` for a space rule. The first issue that points at a rule the dialog holds wins: its collection
   * tab and type are selected, the Schema tab is shown, and `ruleRefusal` tells that row to open, say `text` and take focus. Returns
   * whether a rule was found: an issue about anything else is only the footer's sentence.
   */
  showRuleRefusal(issues: unknown, text: string): boolean {
    for (const issue of Array.isArray(issues) ? issues : []) {
      const at = ruleLocationOf((issue as { path?: unknown } | null)?.path);
      if (!at) continue;
      const exists = at.scope === 'space'
        ? this.schRules.some(r => r.name === at.name)
        : !!this.schTypeSchemas[at.kt]?.[at.type]?.rules.some(r => r.name === at.name);
      if (!exists) continue;
      this.settingsTab.set('schema');
      if (at.scope === 'type') {
        this.schemaCollTab.set(at.kt);
        this.schSelectedType = { kt: at.kt, name: at.type };
      }
      this.ruleRefusal.set({ ...at, text });
      return true;
    }
    return false;
  }

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
      // Top level beside the media levels, never in `meta`. `warn` is sent as the clear (`''`), the spelling `clearedValueOf` gives
      // every other emptied string, so the diff against the opened form sends it only when the operator changed it: the key is
      // charged on presence (schema admin), and a save of a media level must not be refused for a setting it did not touch.
      unknownWriteFields: this.schUnknownWriteFields === 'refuse' ? 'refuse' : '',
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
    //
    // OVER THE UNION OF BOTH KEY SETS, and that is `B-15`. This loop read `Object.keys(nowMeta)` alone,
    // so a key that WAS there and is not any more was never compared: `buildMeta` emits `strictLinkage`
    // only when true and `purpose`/`usageNotes` only when non-empty, so turning strict linkage off or
    // clearing the purpose produced an EMPTY diff. `isDirty()` said there were changes and the save said
    // there was nothing to save — both right about their own question, which is why neither looked wrong.
    // Owner-reported; it had already bitten once for `typeSchemas` and been fixed for that key alone.
    const nowMeta = (now['meta'] ?? {}) as Record<string, unknown>;
    const wasMeta = (was['meta'] ?? {}) as Record<string, unknown>;
    const meta: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(nowMeta), ...Object.keys(wasMeta)])) {
      if (JSON.stringify(nowMeta[key]) === JSON.stringify(wasMeta[key])) continue;
      // An absent key has to be SENT as the cleared value, or the server keeps what it has: its merge
      // guards on `!== undefined`, so `''` and `false` clear correctly and omission does nothing. The
      // empty is taken from what the value WAS, rather than from a per-key list that a new field would
      // not be in.
      meta[key] = key in nowMeta ? nowMeta[key] : clearedValueOf(wasMeta[key]);
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
    // The space's rules, as one map. Absent when there are none: a removed LAST rule is then a key that vanished from the payload,
    // which `changedSettings()` sends as the explicit empty map (the server replaces the map; omission would change nothing).
    const rules = this.schRules.filter(r => r.name.trim());
    if (rules.length) {
      const map: Record<string, SpaceSchemaRule> = {};
      for (const r of rules) map[r.name.trim()] = { rule: r.rule, message: r.message, ...(r.kinds.length ? { kinds: [...r.kinds] } : {}) };
      meta.rules = map;
    }
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

  /**
   * Rename a declared type, keeping everything on it and everything pointing AT it.
   *
   * ## Why this exists
   *
   * Owner-reported, `B-18`: *"i created an entity with full property definitions but made a spelling
   * mistake in the entity name — had to redo all"*. Types are keyed by name, and the editor offered add
   * and delete and nothing between, so the only route from `Prsson` to `Person` was to rebuild every
   * property, every enum value, every pattern. Every knowledge type, not only entities.
   *
   * ## The re-key is the easy half
   *
   * **An edge label's `endpoints.from`/`.to` name ENTITY TYPES.** Renaming an entity type that an edge
   * declares and leaving those lists alone breaks the declaration exactly the way a deletion did in
   * `B-16` — silently, and on a control that looks complete. So the rename follows the name into every
   * edge's endpoint lists.
   *
   * **The insertion ORDER is preserved rather than appending.** `typeNames()` reads `Object.keys`, so
   * rebuilding the map with the renamed entry on the end would reorder the list under the operator's
   * cursor while they are looking at it.
   *
   * ## What it deliberately does NOT do
   *
   * Records already written carry the old type string, and a schema rename does not migrate them. That
   * is the caller's to say out loud — see the confirmation in the tab — because the case this is for is
   * a type built minutes ago with nothing written against it yet, and pretending otherwise would be
   * worse than refusing.
   *
   * Returns an error key when the rename cannot be done, so the caller decides how to say it.
   */
  renameType(kt: KnowledgeType, from: string, to: string): 'empty' | 'exists' | 'missing' | null {
    const trimmed = to.trim();
    if (!trimmed) return 'empty';
    if (trimmed === from) return null;
    const map = this.schTypeSchemas[kt] ?? {};
    if (!(from in map)) return 'missing';
    if (trimmed in map) return 'exists';

    // Rebuilt in the SAME order, with the renamed entry in the old one's place.
    const next: Record<string, TypeSchemaState> = {};
    for (const [name, state] of Object.entries(map)) next[name === from ? trimmed : name] = state;

    const all = { ...this.schTypeSchemas, [kt]: next };

    /*
     * Follow the name into every edge endpoint list that used it. Only an ENTITY rename can be pointed
     * at this way — an edge's ends are entity types — but the walk is written over whatever
     * `endpoints` holds rather than gated on `kt === 'entity'`, so a second kind of reference would be
     * carried by the same code rather than by a second copy of it.
     */
    const edges = all['edge'] ?? {};
    const renamedEdges: Record<string, TypeSchemaState> = {};
    for (const [label, state] of Object.entries(edges)) {
      const swap = (list?: string[]): string[] | undefined =>
        list?.map(n => (n === from ? trimmed : n));
      const ends = state.endpoints;
      renamedEdges[label] = ends
        ? { ...state, endpoints: { ...(ends.from ? { from: swap(ends.from)! } : {}), ...(ends.to ? { to: swap(ends.to)! } : {}) } }
        : state;
    }
    all['edge'] = renamedEdges;

    this.schTypeSchemas = all;
    if (this.schSelectedType?.kt === kt && this.schSelectedType.name === from) {
      this.schSelectedType = { kt, name: trimmed };
    }
    return null;
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
      { label: this.transloco.translate('spaces.stats.facts'), value: s.facts },
      { label: this.transloco.translate('spaces.stats.entities'), value: s.entities },
      { label: this.transloco.translate('spaces.stats.edges'),    value: s.edges    },
      { label: this.transloco.translate('spaces.stats.chrono'),   value: s.chrono   },
      { label: this.transloco.translate('spaces.stats.files'),    value: s.files    },
    ];
  }
}
