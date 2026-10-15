/**
 * What a brain record write ACCEPTS, and the one judge both doors ask whether a body carried something else (Q-320, bundle-128).
 *
 * ## The question this module answers
 *
 * "Does this write carry a top-level field the write does not take, and what does this instance do about it?" REST and MCP used to
 * answer it in two grammars: a REST create warned from seven hand-written key lists, an MCP tool refused from its closed `inputSchema`
 * in every mode, bulk items and a file-metadata PATCH named nothing, and a route's "at least one field" guard was a fifth list. Each was
 * correct when written and each rotted differently (`PATCHABLE_FIELDS` omitted `superseded`; `linkFiles` was read by the route and
 * dropped by the writer). Now there is ONE source of what a write accepts — the paired MCP tool's own `inputSchema`, because that is the
 * contract a caller reads while constructing arguments — and one judge.
 *
 * ## What is inside, so no caller can drop it
 *
 * - **`acceptedWriteKeys` throws instead of returning `[]`.** An empty set passes every loop written over it, so an operation with no
 *   paired tool, or whose tool declares nothing, is a failure, not "nothing is unknown". It is memoised, evaluates nothing at module load
 *   (`brain/bulk.ts` imports this and `mcp/tools/bulk.ts` imports `brain/bulk.ts`), and is forced once at boot (`warmAcceptedWriteKeys`),
 *   so a derivation failure stops the boot and does not 500 the first write.
 * - **Membership is `Set.has`, never `key in obj`**, so a body key `constructor`, `toString` or `__proto__` is an unknown key like any other.
 * - **A refusal carries no received value**, the retired names are refused first in every mode, and the rows are bounded and put first
 *   (`unknown-field-rows.ts`): what a hand-written copy would drop is what the judge does not let you drop.
 * - **The setting is read through `unknownWriteFieldsMode`**, once, of the space the write LANDS in (the caller resolves the proxy target
 *   first), never from the request.
 * - **The count is made here and only here** (`ythril_unknown_write_fields_total`), once per judged call that carried an unknown key, so
 *   the two doors count alike and a key a caller chose can never become a label.
 *
 * ## What it is not
 *
 * It does not decorate an answer (`api/decorate-json-answer.ts` on REST, `mcp/schema-warnings.ts` on MCP), does not validate a value, and
 * does not judge a nested key (each door's body shape refuses those). It judges the TOP level of a single record body — a bulk item is
 * judged against `acceptedWriteKeys('bulk.write', collection)` by `brain/bulk.ts`, with the same membership and wording helpers.
 */
import * as entityTools from '../mcp/tools/entity.js';
import * as factTools from '../mcp/tools/fact.js';
import * as edgeTools from '../mcp/tools/edge.js';
import * as chronoTools from '../mcp/tools/chrono.js';
import * as linkTools from '../mcp/tools/link.js';
import * as fileTools from '../mcp/tools/file.js';
import * as bulkTools from '../mcp/tools/bulk.js';
import type { ToolHandler, ToolSchemas } from '../mcp/tools/types.js';
import { retiredWriteFieldError, retiredWriteFieldHint } from '../brain/retired-write-fields.js';
import { unknownWriteFieldsMode } from '../spaces/spaces.js';
import { findSpace } from '../spaces/proxy.js';
import { NAME_QUOTED, REFUSAL_NAMES_MAX, peerText, unrecognizedKeysIssue, type ParseRefusalIssue } from '../util/log.js';
import { unknownWriteFieldsTotal } from '../metrics/registry.js';
import type { UnknownWriteFieldAnswer } from '../config/types.js';
import { JUDGED_WRITE_OPERATIONS, isJudgedWriteOperation, toolOfJudgedOperation } from './judged-write-operations.js';
import {
  acceptedKeysSentence, boundedUnknownFieldRows, receivedValueSummary, unknownFieldMoreRow, unknownFieldReason,
  UNKNOWN_FIELD_CODE, type UnknownFieldOutcome, type UnknownFieldRow,
} from './unknown-field-rows.js';

// The door vocabulary lives in the leaf module, so a tool module can name its door without importing this one (which imports the tools).
export { writeDoorOfTransport, type WriteDoor } from './judged-write-operations.js';
import type { WriteDoor } from './judged-write-operations.js';

// ── What a write accepts ─────────────────────────────────────────────────────────────────────────

/**
 * The argument names a tool forwards: everything its own `inputSchema` declares, minus the ones that are not part of the payload.
 *
 * Written once because two tools had hand-written copies of their own schemas beside them, and one of those copies was already wrong —
 * a field declared, accepted by the dispatcher, and dropped before the write, with the other door storing it. The schema is the
 * contract, so the schema is the list, and a field added to it is forwarded by the same commit. (Moved here from `mcp/tools/spaces.ts`
 * when the judge became its third caller: `schema_update` and `save_space` read their own schemas through it, and the judge reads a
 * record write tool's.)
 */
export function forwardedArgNames(tool: ToolHandler, exclude: ReadonlySet<string>): string[] {
  const props = (tool.inputSchema({} as ToolSchemas).properties ?? {}) as Record<string, unknown>;
  return Object.keys(props).filter(k => !exclude.has(k));
}

/** What addresses a write rather than being part of it: the space and the proxy target, on every write. */
const ADDRESSING_BASE = ['space', 'targetSpace'] as const;

/**
 * The keys that ADDRESS an operation's write and are never judged: the space and the proxy target, the record's own `id` on an update
 * (REST takes it from the path), the file's `path` on a file-metadata update, and the two ids of a merge. `id` on a create stays a body
 * key — REST's create takes it in the body.
 */
function addressingOf(operation: string): ReadonlySet<string> {
  const keys: string[] = [...ADDRESSING_BASE];
  if (operation === 'entity.merge') keys.push('survivorId', 'absorbedId');
  else if (operation === 'file.meta.update') keys.push('path');
  else if (operation.endsWith('.update')) keys.push('id');
  return new Set(keys);
}

/**
 * The body a TOOL call's arguments make, for the judge: the arguments minus what ADDRESSES the write (`space`, `targetSpace`, the record's
 * `id` on an update, a file's `path`, a merge's two ids). A REST body carries none of those (they ride in the path and the query), so a REST
 * route judges its body as it is; a tool call carries them beside the payload, and judging them would name `space` an unknown field on every
 * call. One function, so a door that judges arguments cannot forget the half of the arguments that are not the record.
 *
 * A copy: the arguments are the caller's and the handler receives them whole (`validate` strips nothing either).
 */
export function writeBodyOfToolCall(args: Readonly<Record<string, unknown>>, operation: string): Record<string, unknown> {
  const addressing = addressingOf(operation);
  const body: Record<string, unknown> = {};
  for (const key of Object.keys(args)) {
    if (!addressing.has(key)) Object.defineProperty(body, key, { value: args[key], enumerable: true, writable: true, configurable: true });
  }
  return body;
}

/** One memoised derivation: the set, its sorted spelling and the sentence that says it, so none of them is rebuilt per request. */
interface Accepted { keys: ReadonlySet<string>; sorted: readonly string[]; sentence: string }
const derived = new Map<string, Accepted>();

/**
 * The tools that are the doors of the judged operations, by name — read from the tool MODULES that define them, not from the registry
 * (`mcp/tools/index.ts`), and that is deliberate. The tool modules import THIS module (`atLeastOneFieldRefusal`, `carriesAnyAcceptedField`),
 * and the registry builds its list of every tool as it loads: an edge from here to the registry would make a tool module that is
 * imported first read a tool the registry has not been given yet (`Cannot access 'list_spacesTool' before initialization`), which is
 * every test that imports a tool module alone. A module namespace is read lazily, at the first call, when every module has been evaluated.
 *
 * The seven modules are where the record-write tools live; an operation whose tool is in none of them fails `derive` by name, at boot
 * (`warmAcceptedWriteKeys`) and in the gate that pairs every brain write route to a tool, rather than judging nothing.
 */
const TOOL_MODULES: readonly Record<string, unknown>[] = [entityTools, factTools, edgeTools, chronoTools, linkTools, fileTools, bulkTools];
let toolsByName: ReadonlyMap<string, ToolHandler> | undefined;

function judgedTool(name: string): ToolHandler | undefined {
  if (!toolsByName) {
    const found = new Map<string, ToolHandler>();
    for (const mod of TOOL_MODULES) {
      for (const value of Object.values(mod)) {
        const tool = value as Partial<ToolHandler> | null;
        if (tool && typeof tool === 'object' && typeof tool.name === 'string' && typeof tool.inputSchema === 'function' && typeof tool.handle === 'function') {
          found.set(tool.name, tool as ToolHandler);
        }
      }
    }
    toolsByName = found;
  }
  return toolsByName.get(name);
}

/** The collections `save_bulk` takes: every top-level argument that is an array of item objects, read from its own schema. */
function bulkCollections(tool: ToolHandler): string[] {
  const props = (tool.inputSchema({} as ToolSchemas).properties ?? {}) as Record<string, { type?: unknown; items?: { properties?: unknown } }>;
  return Object.keys(props).filter(k => props[k]?.type === 'array' && typeof props[k]?.items?.properties === 'object');
}

function derive(operation: string, collection: string | undefined): Accepted {
  if (!isJudgedWriteOperation(operation)) {
    throw new Error(`'${operation}' is not a judged write operation: no tool is paired to it, so there is nothing to derive what it accepts from`);
  }
  const toolName = toolOfJudgedOperation(operation)!;
  const tool = judgedTool(toolName);
  if (!tool) throw new Error(`operation '${operation}' is paired to tool '${toolName}', which is not registered`);

  let names: string[];
  if (operation === 'bulk.write') {
    // A bulk batch's top level is collection names (refused in every mode); what is judged is an ITEM, against its collection's schema.
    const known = bulkCollections(tool);
    if (collection === undefined || !known.includes(collection)) {
      throw new Error(`bulk.write is judged per item: name one of its collections (${known.join(', ')})`);
    }
    const props = (tool.inputSchema({} as ToolSchemas).properties as Record<string, { items: { properties: Record<string, unknown> } }>);
    names = Object.keys(props[collection]!.items.properties);
  } else {
    if (collection !== undefined) throw new Error(`${operation} takes no collection`);
    names = forwardedArgNames(tool, addressingOf(operation));
  }
  if (names.length === 0) {
    throw new Error(`'${operation}' derived an empty accepted set from ${toolName}: an empty set judges every key unknown, and nothing is`);
  }
  const keys = new Set(names);
  const sorted = [...keys].sort();
  return { keys, sorted, sentence: acceptedKeysSentence(sorted) };
}

function acceptedOf(operation: string, collection?: string): Accepted {
  const id = collection === undefined ? operation : `${operation}\u0000${collection}`;
  let hit = derived.get(id);
  if (!hit) { hit = derive(operation, collection); derived.set(id, hit); }
  return hit;
}

/**
 * The top-level keys a brain write accepts, read from the paired MCP tool's `inputSchema` minus what addresses it. `collection` is for
 * `bulk.write` alone, whose items are judged per collection (`facts`, `entities`, `edges`, `chrono`).
 *
 * A `Set`, and membership is tested with `Set.has` — never `key in obj`, which also answers for `constructor` and `__proto__`.
 * **Throws** for an operation that is not judged, a tool that is not registered, or an empty derivation: it never returns an empty set.
 */
export function acceptedWriteKeys(operation: string, collection?: string): ReadonlySet<string> {
  return acceptedOf(operation, collection).keys;
}

/**
 * Derive what EVERY judged operation accepts (and every bulk collection), once, at boot (`index.ts`, before the server listens): a
 * derivation that cannot be made stops the boot instead of answering the first write of that kind with a 500.
 */
export function warmAcceptedWriteKeys(): void {
  for (const operation of JUDGED_WRITE_OPERATIONS) {
    if (operation === 'bulk.write') {
      const tool = judgedTool(toolOfJudgedOperation(operation)!);
      if (!tool) throw new Error(`operation '${operation}' is paired to a tool that is not registered`);
      const collections = bulkCollections(tool);
      if (collections.length === 0) throw new Error('save_bulk declares no collection of items: bulk items would be judged against nothing');
      for (const collection of collections) acceptedOf(operation, collection);
    } else {
      acceptedOf(operation);
    }
  }
}

/**
 * The one sentence a write that changes nothing is refused with: `At least one of <the accepted keys, sorted> must be provided`. Derived
 * from the same set the judge uses, so it names every field the write takes (the four hand-listed MCP sentences and REST's `At least one
 * field must be provided` omitted `superseded`, and named none on REST).
 */
export function atLeastOneFieldRefusal(operation: string): string {
  return `At least one of ${acceptedOf(operation).sorted.join(', ')} must be provided`;
}

/**
 * Does this body carry ANY field the write takes? **Presence, not truthiness** (`Object.hasOwn`): `ttlDays: null` clears a window and
 * `tags: []` empties a list, and both are changes. A body that is not a plain object carries none. Replaces chrono's `PATCHABLE_FIELDS`
 * (which omitted `superseded`, so a REST `PATCH {superseded:true}` was refused while `update_chrono` took it) and every route's own test.
 */
export function carriesAnyAcceptedField(body: unknown, operation: string): boolean {
  if (!isPlainObject(body)) return false;
  for (const key of acceptedOf(operation).keys) if (Object.hasOwn(body, key)) return true;
  return false;
}

// ── Membership, and the near miss ────────────────────────────────────────────────────────────────

const isPlainObject = (body: unknown): body is Record<string, unknown> =>
  body !== null && typeof body === 'object' && !Array.isArray(body);

/**
 * The own keys of `bag` that are neither accepted nor a RETIRED name (a retired name is answered by its own sentence, by name), in the
 * order the body carries them. The one membership test every door and every bulk item uses: `Set.has`, own keys only.
 */
export function unknownKeysOf(bag: Record<string, unknown>, accepted: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const key of Object.keys(bag)) {
    if (!accepted.has(key) && retiredWriteFieldHint(key) === null) out.push(key);
  }
  return out;
}

/** How many edits apart an unknown name can be from an accepted one and still be offered as what the caller meant. */
const NEAR_MISS_EDITS = 2;

/**
 * The accepted key a name is probably a misspelling of — one or two edits away, or the same letters in another case — or `undefined`.
 *
 * **Bounded, because the name is the caller's** (V7): it is asked only of a name already cut at `NAME_QUOTED` (a name that was cut is
 * nowhere near any key, and the length test says so without a distance), a key whose length differs by more than the threshold is skipped
 * without computing one, and the distance gives up as soon as every cell of a row is past the threshold. A megabyte key costs the cut.
 */
export function nearMissOf(name: string, accepted: readonly string[]): string | undefined {
  const lower = name.toLowerCase();
  for (const key of accepted) if (key !== name && key.length === name.length && key.toLowerCase() === lower) return key;
  let best: string | undefined;
  let bestDistance = NEAR_MISS_EDITS + 1;
  for (const key of accepted) {
    if (Math.abs(key.length - name.length) > NEAR_MISS_EDITS) continue;
    const distance = editDistanceWithin(name, key, NEAR_MISS_EDITS);
    if (distance < bestDistance) { best = key; bestDistance = distance; }
  }
  return best;
}

/** Levenshtein distance between `a` and `b`, or `max + 1` as soon as it is certain to exceed `max`. */
function editDistanceWithin(a: string, b: string, max: number): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cell = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      current.push(cell);
      if (cell < rowMin) rowMin = cell;
    }
    if (rowMin > max) return max + 1;
    previous = current;
  }
  return previous[b.length]!;
}

// ── The judge ────────────────────────────────────────────────────────────────────────────────────

/** What the judge refuses a write with: the body a REST door sends as its 400 and an MCP door carries as `structuredContent`. */
export interface UnknownFieldRefusal {
  error: string;
  /** Only when the refusal is the unknown keys' (not a retired name's): `[{ code: 'unrecognized_keys', path: [], keys }]`, bounded like every refusal. */
  issues?: ParseRefusalIssue[];
  /** The unknown-field rows, without a received value. Absent when the body carried no unknown key (a retired name alone). */
  warnings?: UnknownFieldRow[];
}

/** The judge's answer for one write body. */
export interface UnknownFieldAnswer {
  /** The unknown names, at most the ten that are rowed, each cut at `NAME_QUOTED`. */
  unknown: string[];
  /** How many unknown names the body carried, rowed or not. */
  unknownTotal: number;
  /** The rows to put on the answer (unknown rows first, then a `…(+N more)` row): `value` only when the write is not refused. */
  rows: UnknownFieldRow[];
  /** Did the judge refuse the write: a retired name (every mode), or an unknown key in a space set to refuse. */
  refused: boolean;
  /** Present exactly when `refused`. */
  refusal?: UnknownFieldRefusal;
}

/**
 * Judge one record write body: does it carry a top-level field the write does not take, and what does this instance do about it?
 *
 * `targetSpaceId` is the space the write LANDS in — the caller resolves the proxy target first, so the member's setting governs a write
 * through a proxy. In `warn` (the default; an absent setting) the write proceeds and the answer names each field; in `refuse` the write is
 * refused before anything is stored. **A retired name is refused in either mode**, by its own sentence, and the unknown rows still ride
 * along. A body that is not a plain object is judged as nothing. Counts the call once when it carried an unknown key.
 */
export function answerUnknownWriteFields(body: unknown, operation: string, targetSpaceId: string | undefined, door: WriteDoor): UnknownFieldAnswer {
  const accepted = acceptedOf(operation);
  if (!isPlainObject(body)) return { unknown: [], unknownTotal: 0, rows: [], refused: false };

  const retired = retiredWriteFieldError(body);
  const names = unknownKeysOf(body, accepted.keys);
  const mode: UnknownWriteFieldAnswer = unknownWriteFieldsMode(targetSpaceId === undefined ? undefined : findSpace(targetSpaceId));
  const unknownRefused = names.length > 0 && mode === 'refuse';
  const refused = retired !== null || unknownRefused;
  const outcome: UnknownFieldOutcome = refused ? 'refused' : 'stored';

  const rowed = names.slice(0, REFUSAL_NAMES_MAX);
  const cut = rowed.map(n => peerText(n, { max: NAME_QUOTED }));
  const rows = names.length === 0 ? [] : boundedUnknownFieldRows([
    ...rowed.map((name, i): UnknownFieldRow => ({
      field: name,
      code: UNKNOWN_FIELD_CODE,
      value: receivedValueSummary(Object.getOwnPropertyDescriptor(body, name)?.value),
      reason: unknownFieldReason(outcome, {
        ...(i === 0 ? { accepted: accepted.sentence } : {}),
        ...nearMissOption(cut[i]!, accepted.sorted),
      }),
    })),
    ...(names.length > rowed.length ? [unknownFieldMoreRow(names.length - rowed.length, outcome, rowed.length)] : []),
  ], outcome);

  if (names.length > 0) countJudgedCall(door, operation, mode, outcome);

  const answer: UnknownFieldAnswer = { unknown: cut, unknownTotal: names.length, rows, refused };
  if (retired !== null) {
    answer.refusal = { error: retired, ...(rows.length > 0 ? { warnings: rows } : {}) };
  } else if (unknownRefused) {
    const built = unrecognizedKeysIssue(names);
    answer.refusal = { error: built.reason, issues: [built.issue], warnings: rows };
  }
  return answer;
}

/** `{ nearMiss }` when the (cut) name is a near miss of an accepted key, else nothing, so an absent hint is an absent key. */
function nearMissOption(cutName: string, accepted: readonly string[]): { nearMiss?: string } {
  const hint = nearMissOf(cutName, accepted);
  return hint === undefined ? {} : { nearMiss: hint };
}

/**
 * Count one judged call that carried an unknown key — here and nowhere else (`the-unknown-write-fields-counter-is-incremented-only-by-the-judge`).
 * Exported for the one caller whose call is a batch (`brain/bulk.ts` counts a bulk batch once, not once per item). Every label is a fixed
 * vocabulary: the door and the mode are typed, the operation is refused unless it is a judged one, and the outcome is two words.
 */
export function countJudgedCall(door: WriteDoor, operation: string, mode: UnknownWriteFieldAnswer, outcome: UnknownFieldOutcome): void {
  if (!isJudgedWriteOperation(operation)) throw new Error(`'${operation}' is not a judged write operation: a label outside the vocabulary would mint a series`);
  unknownWriteFieldsTotal.inc({ door, operation, mode, outcome });
}
