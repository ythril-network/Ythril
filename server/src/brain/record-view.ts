/**
 * The view of a record a validator is handed — built in ONE place, and the only thing a validator takes (F-46, ruling R6-3).
 *
 * ## What it prevents
 *
 * Every validator used to be handed whatever the caller happened to hold: `validateEntity(meta, { name, type, properties })`,
 * `validateEdge(meta, { label, properties })`, `validateFact(meta, { type, properties })`, from seventeen call sites, each correct for the
 * one rule it was written for. A rule reads the record's `title`, `description`, `tags` — and a caller that passes a partial record does
 * not get an error, it gets a rule that silently stops applying: "absent means the rule does not apply" is the right reading of a
 * missing PROPERTY and the wrong one of a missing record FIELD. Three spellings of one thing made it worse: the entity's `name`, the fact's
 * `fact` and the chrono entry's `title` are the same field to a reader, and the map of them was written twice
 * (`entity-refs.ts` and `link-frontier.ts`).
 *
 * So the view is made here, from the record's OWN spelling (`endpointNameField`, the one map of it), and a validator accepts nothing else.
 *
 * ## What is inside, so no caller can drop it
 *
 * - **`RecordView` is a type nothing else can make.** A plain object with the same fields is a type error, and so is a cast: the brand is
 *   a `unique symbol` this module does not export (`a-validator-takes-only-a-record-view` compiles a forged one and a partial one, and
 *   scans the server for a cast).
 * - **It COPIES.** A validator is handed a value, not the document the caller is about to mutate: `properties` and `tags` are copies.
 * - **It carries what a rule may read and nothing else.** The title (the entity's name, the fact's text, the chrono entry's title), the type,
 *   the description, the tags and the properties — and, for an edge, its `label` and NO title, type, `from` or `to`: an edge is validated
 *   (inline, in a bulk import) before its ends exist, so a rule that read them would see nothing there. No vector, no author, no sequence
 *   number, no id: they are derived by the local embedder or written by a peer, and a rule that read one would give two instances two answers.
 * - **A record with no description has an empty one**, and no tags none: the title, the type, the description, the tags and the properties
 *   are ALWAYS there, so "absent" never means "the caller did not pass it".
 * - **{@link isRecordView} is how a validator is told from an untyped caller.** The compiler holds every typed caller; a JavaScript caller
 *   (a script, a fixture) can still hand a validator a plain object, and the validator converts it with the same function rather than reading
 *   it as it is.
 */
import type { RefKind } from '../config/types-knowledge.js';

declare const VIEW: unique symbol;

/**
 * The human-readable field of each kind of record — what a reader would call it.
 *
 * `file` is absent because a file's `_id` IS its path, so there is nothing to look up. The type says so, which
 * is why every caller has to rule `file` out before asking.
 */
const NAME_FIELD: Record<Exclude<RefKind, 'file'>, string> = {
  entity: 'name',
  fact: 'fact',
  chrono: 'title',
};

/**
 * The field to project when resolving a reference to something a person can read — and the one the view of a record takes its title from.
 *
 * It has three readers: the edge embedder, which turns endpoints into the text an edge is embedded from, the edge list route, which
 * turns them into what the Edges table shows, and the view a validator is handed. The list route used to project `name` from the
 * entities collection for both endpoints — correct while every endpoint was an entity, and a bare UUID on screen once one could be a
 * chrono entry. (`brain/entity-refs.ts` re-exports it, so a caller that resolves an endpoint keeps asking there.)
 */
export function endpointNameField(kind: Exclude<RefKind, 'file'>): string {
  return NAME_FIELD[kind];
}

/**
 * What a record of `kind` is called, as a string, or `undefined` when its title field holds none — the one reading of the name field.
 *
 * The view's `title` is this, and so is the display name a graph walk gives a fact or a chrono entry that is reached through a link
 * (`brain/link-frontier.ts` `recordDisplayName`): that walk reads thousands of records and cannot afford the view's copy of the
 * properties, which is why the question has an answer of its own and not a call to {@link recordViewOf}. The map of kind to field stays
 * behind {@link endpointNameField}, written once.
 */
export function recordTitleOf(kind: Exclude<RefKind, 'file'>, record: object): string | undefined {
  const v = (record as Record<string, unknown>)[endpointNameField(kind)];
  return typeof v === 'string' ? v : undefined;
}

/** The four kinds that have properties, and so a validator, and a view. */
export type ViewKind = 'entity' | 'edge' | 'fact' | 'chrono';

/**
 * What a rule reads about one record. Only {@link recordViewOf} makes one; see the module's header for what it carries and why.
 */
export interface RecordView {
  readonly [VIEW]: true;
  /** The entity's name, the fact's text, the chrono entry's title. Absent on an edge, which has none. */
  readonly title?: string;
  /** The entity type, the fact type, the chrono type. Absent on an edge: its label is what it is called. */
  readonly type?: string;
  /** An edge's label. Absent on every other kind. */
  readonly label?: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly properties: Readonly<Record<string, unknown>>;
}

/** The views this module made: the one runtime fact the brand stands for. */
const MADE = new WeakSet<object>();

/** Is `value` a view {@link recordViewOf} made? */
export function isRecordView(value: unknown): value is RecordView {
  return typeof value === 'object' && value !== null && MADE.has(value);
}

const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * The view of `record`, a `kind` record as it is stored or as a write would leave it — the MERGED record, never a patch, or the rule
 * reads a fragment. Anything the record lacks is filled (`''`, `[]`, `{}`); anything it has that a rule may not read is left out.
 */
export function recordViewOf(kind: ViewKind, record: object): RecordView {
  const r = record as Record<string, unknown>;
  const properties = typeof r['properties'] === 'object' && r['properties'] !== null && !Array.isArray(r['properties'])
    ? { ...(r['properties'] as Record<string, unknown>) }
    : {};
  const common = {
    description: text(r['description']) ?? '',
    tags: Array.isArray(r['tags']) ? r['tags'].filter((t): t is string => typeof t === 'string') : [],
    properties,
  };
  const shaped = kind === 'edge'
    ? { ...(text(r['label']) !== undefined ? { label: text(r['label']) } : {}), ...common }
    : {
      ...(recordTitleOf(kind, r) !== undefined ? { title: recordTitleOf(kind, r) } : {}),
      ...(text(r['type']) !== undefined ? { type: text(r['type']) } : {}),
      ...common,
    };
  MADE.add(shaped);
  return shaped as unknown as RecordView;
}
