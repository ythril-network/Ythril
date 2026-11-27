/**
 * The settings write of a space, from a body to its outcome: the one chain `PATCH /api/spaces/:id`, MCP `schema_update` and `update_space`,
 * and the schema-from-RDF door write a space's settings and type schemas through (bundle-270, Q-754, design revisions 2 and 3).
 *
 * ## What it prevents
 *
 * The chain (the field rungs, the planner, the conversion price, the audit pair, the apply and the notices) was written twice, once in the
 * REST handler and once in the tools, and the schema-from-RDF door would have been a third copy. Two copies of a chain of refusals drift: one
 * gains a step the other lacks, and a caller meets a weaker rule through one door. Each door now hands this act what it read off its wire and
 * words what comes back; no door decides a refusal of the chain.
 *
 * ## What it answers
 *
 * A value, never a status written to a wire: `written` with the outcome (`applied` or `vote_pending`), the audit pair the door hands its audit
 * entry (`plan.audit`, taken before anything was applied) and the notices both doors spread into their answer (`networkWriteNotice`,
 * `convertNotice`); `lost` when the space went between the plan and the write (each door keeps its own lost-space answer);
 * `fields-refused` with the fields the caller's rungs do not reach (each door words it); `refused` with the planner's, the price's, the
 * networked or the hold's status and body. A space an RDF import holds (`SpaceNotWritableError` from the hold gate) is `refused` 409
 * `space_being_rdf_imported`, its error carried as `held` for a door that answers it as thrown.
 *
 * ## `refuseIfNetworked`
 *
 * A door that may not open a vote round (the schema-from-RDF door, F1) sets it. The networked question is asked after the plan and the price,
 * in the same synchronous step as the apply, with no await between them and none in the apply before its own vote branch: a space joined to a
 * network while the door read its upload is refused `409 space_networked`, and no round opens.
 *
 * What stays at the doors: their wording, the lost-space answer, REST's face-width check (two database reads, asked before the act), and REST's
 * `requireSettingsFields` middleware, which answers the field rungs before the handler; the act asks them again for the doors without it.
 */
import { refusalsForSpaceUpdate } from '../auth/space-field-rights.js';
import type { TokenRights } from '../config/rights-shape.js';
import { getConfig } from '../config/loader.js';
import {
  planSpaceMetaUpdate, applySpaceMetaUpdate, networkWriteNotice, convertNotice, type MetaUpdateOutcome, type MetaUpdatePlan, type WriteCaller,
} from './meta-update.js';
import { isPlainObject } from '../util/plain-object.js';
import { schemaConvertPrice } from './schema-convert-acts.js';
import { spaceWriteClosedAnswer } from './space-write-gate.js';
import { schemaRoomRefusal } from './schema-room.js';

/** The code a networked space is refused with when the door may not open a vote round. */
export const SPACE_META_WRITE_NETWORKED = 'space_networked';
/** The statuses the act answers with itself, each named. */
const FORBIDDEN = 403;
const CONFLICT = 409;

/** Who writes: the record the planner and the notices read (a REST token, or a tool's rights), its rights, and whether it administers the instance. */
export interface SpaceMetaWriteCaller {
  record: WriteCaller;
  rights: TokenRights | null | undefined;
  instanceAdmin: boolean;
}

/** What a door hands the act. */
export interface SpaceMetaWriteInput {
  spaceId: string;
  /**
   * The update body as the door read it (`meta`, the space-level fields, `typeSchemasMode`, `targetNetwork`, `convertRecords`). A REST door hands
   * the request's body as it came, a missing one included: the planner's parse refuses what is not an object, in its own words, as it did
   * before the act existed.
   */
  body: unknown;
  /** How the body's `typeSchemas` combine with the stored ones, when the door decides it rather than the body (the body's own is kept otherwise). */
  typeSchemasMode?: 'merge' | 'replace';
  /** The precondition: REST's `If-Match`; a door with no header passes undefined (no precondition asked for). */
  ifMatch: string | undefined;
  caller: SpaceMetaWriteCaller;
  /** The heavy-call allowance's key a conversion price spends (the token's id, or the request's address). */
  rateKey: string;
  /** Refuse a space in any network rather than open a vote round there (see the module's docblock). */
  refuseIfNetworked?: boolean;
}

/** A written (or proposed) settings write. */
export interface SpaceMetaWritten {
  kind: 'written';
  outcome: Exclude<MetaUpdateOutcome, { outcome: 'not_found' }>;
  audit: MetaUpdatePlan['audit'];
  notice: Record<string, unknown>;
}

/** A refusal of the chain: its status and the body REST answers it with. `held`: the hold gate's own error, for a door that answers it as thrown. */
export interface SpaceMetaWriteRefused {
  kind: 'refused';
  status: number;
  body: { error: string; code?: string; [k: string]: unknown };
  held?: Error;
}

export type SpaceMetaWriteAnswer =
  | SpaceMetaWritten
  | { kind: 'lost' }
  | { kind: 'fields-refused'; status: typeof FORBIDDEN; fields: string[] }
  | SpaceMetaWriteRefused;

/**
 * The fields of the settings body `body` that `caller`'s rungs do not reach, in the order they arrived: the one place the field rungs are
 * asked. The write below asks it before anything else, and a door that answers a dry run asks it too, so a dry run is refused the rungs its
 * write is refused (Q-754 R1: a `schema: write` token's dry run of a file whose shapes give a type rules answered 200 where the build
 * answered 403).
 */
export function fieldRefusalsOf(spaceId: string, body: Record<string, unknown>, caller: Pick<SpaceMetaWriteCaller, 'instanceAdmin' | 'rights'>): string[] {
  return refusalsForSpaceUpdate(body, spaceId, caller.instanceAdmin, caller.rights);
}

/**
 * Write a space's settings for a door. Never throws for a caller's mistake or the space's state: every refusal is an answer. A fault that is
 * neither (the store, the disk) is thrown to the door.
 */
export async function writeSpaceMeta(input: SpaceMetaWriteInput): Promise<SpaceMetaWriteAnswer> {
  const { spaceId, caller } = input;
  const body = input.typeSchemasMode === undefined || !isPlainObject(input.body) ? input.body : { ...input.body, typeSchemasMode: input.typeSchemasMode };

  // The field rungs first, every refused field at once: one save, one conversation with whoever grants rights. A body that is no object names
  // no field; the planner refuses it below.
  const fields = isPlainObject(body) ? fieldRefusalsOf(spaceId, body, caller) : [];
  if (fields.length > 0) return { kind: 'fields-refused', status: FORBIDDEN, fields };

  const space = getConfig().spaces.find(s => s.id === spaceId);
  const decision = planSpaceMetaUpdate({ spaceId, space, body, ifMatch: input.ifMatch, caller: caller.record });
  if (!decision.ok) return { kind: 'refused', status: decision.refusal.status, body: decision.refusal.body };
  const { plan } = decision;
  // A save that carries `convertRecords` starts the Convert act's mass rewrite, so it pays the act's price (`schemaConvertPrice`, the one
  // function): after every other refusal and before anything is written.
  const priced = plan.convertRecords === undefined ? null : schemaConvertPrice(spaceId, { rights: caller.rights, rateKey: input.rateKey });
  if (priced) return { kind: 'refused', status: priced.status, body: priced.body as SpaceMetaWriteRefused['body'] };
  // Room for the schema the write would store (Q-981): one stored document and the storage quota, before anything is written. Asked of the
  // merged meta; a networked proposal is held to it when its round lands and is merged.
  const room = plan.mergedMeta === undefined ? null : await schemaRoomRefusal(space?.meta, plan.mergedMeta);
  if (room) return { kind: 'refused', status: room.status, body: room.body };
  // Asked in the step that applies: from here to the apply's vote branch nothing is awaited, so the space cannot join a network in between.
  if (input.refuseIfNetworked === true && getConfig().networks.some(n => n.spaces.includes(spaceId))) {
    return { kind: 'refused', status: CONFLICT, body: {
      error: `Space '${spaceId}' is in a network, where a schema change is the network's to vote on: send it through PATCH /api/spaces/:id or schema_update`,
      code: SPACE_META_WRITE_NETWORKED,
    } };
  }

  let outcome: MetaUpdateOutcome;
  try {
    outcome = await applySpaceMetaUpdate(plan);
  } catch (err) {
    // The hold of an RDF import (amendment A3), thrown by the apply before it writes anything: an answer, not a fault.
    const closed = spaceWriteClosedAnswer(err);
    if (!closed) throw err;
    return { kind: 'refused', status: closed.status, body: closed.body, held: err as Error };
  }
  if (outcome.outcome === 'not_found') return { kind: 'lost' };
  return {
    kind: 'written', outcome, audit: plan.audit,
    notice: { ...networkWriteNotice(outcome, caller.record), ...convertNotice(outcome) },
  };
}
