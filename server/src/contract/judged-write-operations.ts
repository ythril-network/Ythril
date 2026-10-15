/**
 * Which operations the unknown-write-field judge judges — the brain RECORD writes — and which tool is each one's MCP door.
 *
 * ## The question this answers
 *
 * "Is this operation (or this tool) a record write whose top-level body keys are judged against what the write accepts?" Three places
 * need the answer and must not each own a list: the judge (`write-accepts.ts`, which derives what an operation accepts), the dispatcher
 * (`mcp/call-tool.ts`, which asks of a tool name whether its arguments are judged) and the metric (`metrics/registry.ts`, which declares
 * `ythril_unknown_write_fields_total` at 0 for every judged operation). It is a leaf module — it imports `audit-map` and nothing that
 * imports the registry — so the registry can read it at load without a cycle, which `write-accepts.ts` (it imports the registry to
 * count) could not offer.
 *
 * ## What it prevents
 *
 * A hand-kept list of judged operations is the defect `a-route-reads-what-its-tool-declares` exists for: a tenth write added next
 * month is judged on one door and not the other, and nothing contradicts it. Here the set is READ from `MCP_TOOL_OPERATIONS`, the table
 * every tool is already paired to its audit operation by, filtered by the one shape that says "a record write": a record family and a
 * write verb. A new `edge.something` tool is outside it on purpose; a new family or verb is one edit HERE, and the gate that compares
 * the routers' write operations with this set (`a-route-reads-what-its-tool-declares`) goes red until it is made.
 */
import { MCP_TOOL_OPERATIONS } from '../mcp/audit-map.js';
import type { UNKNOWN_WRITE_FIELD_DOORS } from '../metrics/registry.js';

/** Which door asked: REST, an MCP tool call, or `POST /api/<tool>` (on the tool side, `caller.transport` says which of the last two). */
export type WriteDoor = (typeof UNKNOWN_WRITE_FIELD_DOORS)[number];

/**
 * The door a tool call came through, in the judge's and the metric's vocabulary. A tool is reached by MCP (`mcp`) or by `POST /api/<tool>`,
 * which the dispatcher's `transport` calls `rest` and the judge calls `tool` — `rest` is the brain ROUTES' door. One answer, so the
 * dispatcher and a tool that judges for itself (`save_bulk`) cannot label one call two ways. Here, in the leaf, because a tool module
 * names its door and must not import the judge's module, which imports the tools.
 */
export function writeDoorOfTransport(transport: 'mcp' | 'rest'): WriteDoor {
  return transport === 'mcp' ? 'mcp' : 'tool';
}

/** A record family and a write verb: `entity.create`, `fact.update`, `entity.merge`, `link.create`, `file.meta.update`, `bulk.write`. */
const RECORD_WRITE_OPERATION = /^(?:(?:entity|fact|edge|chrono|link)\.(?:create|update|merge)|file\.meta\.update|bulk\.write)$/;

/** Tool name → the one record-write operation it performs, for every tool whose arguments are judged. */
const TOOL_OF_OPERATION = new Map<string, string>();
const OPERATION_OF_TOOL = new Map<string, string>();
for (const [tool, operation] of Object.entries(MCP_TOOL_OPERATIONS)) {
  if (typeof operation !== 'string' || !RECORD_WRITE_OPERATION.test(operation)) continue;
  if (TOOL_OF_OPERATION.has(operation)) {
    // Two tools for one operation would make "the paired tool" a guess, which is what the judge derives its accepted keys from.
    throw new Error(`judged write operation '${operation}' is performed by two tools ('${TOOL_OF_OPERATION.get(operation)}' and '${tool}'): the accepted keys of an operation are read from ONE tool`);
  }
  TOOL_OF_OPERATION.set(operation, tool);
  OPERATION_OF_TOOL.set(tool, operation);
}
if (TOOL_OF_OPERATION.size === 0) {
  throw new Error('no record-write operation was found in MCP_TOOL_OPERATIONS: the judge would judge nothing, and an empty set passes every loop written over it');
}

/** Every judged operation, in the order the tools are declared. Never empty. */
export const JUDGED_WRITE_OPERATIONS: readonly string[] = Object.freeze([...TOOL_OF_OPERATION.keys()]);

/** Is this operation one the judge judges? */
export function isJudgedWriteOperation(operation: string): boolean {
  return TOOL_OF_OPERATION.has(operation);
}

/** The MCP tool that is the door of a judged operation, or `undefined` for an operation the judge does not judge. */
export function toolOfJudgedOperation(operation: string): string | undefined {
  return TOOL_OF_OPERATION.get(operation);
}

/**
 * Is this operation a BATCH — one whose body holds collections of records rather than one record? Its top level is collection names
 * (refused in every mode) and each ITEM is judged by the batch writer (`brain/bulk.ts`) against its collection, so a door that judges "the
 * body" of a record write must leave a batch alone. One question, one answer: a door asks this and never spells the operation's name.
 */
export function isBatchWriteOperation(operation: string): boolean {
  return operation === 'bulk.write';
}

/** The judged operation a tool performs, or `null` for a tool whose arguments are not judged (a read, a delete, an act, any other write). */
export function judgedOperationOfTool(toolName: string): string | null {
  return OPERATION_OF_TOOL.get(toolName) ?? null;
}
