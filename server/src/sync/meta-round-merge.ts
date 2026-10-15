/**
 * Applying a passed `meta_change` round without discarding everyone else's edits.
 *
 * ## The loss
 *
 * A `meta_change` round stored the **whole merged meta** — the proposer's patch already folded into the
 * base they read — and applying it was `updateSpace(spaceId, { meta: round.pendingMeta })`, a wholesale
 * replace. That is correct for one round at a time and silently destructive for two:
 *
 *   1. The space's meta is at version 7.
 *   2. Alice proposes a new `purpose`. Her round carries the full meta: new purpose, v7's everything else.
 *   3. Bob proposes `strictLinkage: true`. His round carries the full meta: v7's purpose, new flag.
 *   4. Alice's round passes → purpose updated, version 8.
 *   5. Bob's round passes → the whole meta is replaced by his snapshot, which still holds **v7's purpose**.
 *
 * Alice's change is gone. Nothing reports it: the round passed, the vote is recorded as carried, and the
 * space's meta is internally consistent — just missing an edit the network voted to make. Rounds run for
 * `votingDeadlineHours` (hours, sometimes days), so overlapping proposals are not an exotic race; they are
 * the normal cadence of a network where more than one operator configures a space.
 *
 * ## What is applied instead
 *
 * Only the fields the proposer actually changed. The round records them (`metaChangedFields`) alongside
 * the meta version it was computed against (`baseMetaVersion`), and conclusion re-merges those fields into
 * whatever the meta says **now**, rather than into whatever it said when the round opened.
 *
 * ## Same-field conflict: the vote wins
 *
 * When two rounds change the *same* field, the later-concluding one takes effect. That is the deliberate
 * answer, not a fallback that got left in:
 *
 *   - The network **voted** for that value. Refusing to apply a passed round because the field moved would
 *     turn a carried motion into a silent no-op, which is the failure this module exists to remove, just
 *     relocated.
 *   - Reopening or re-voting cannot be done here — conclusion runs on every peer independently, and a
 *     decision that needs a new round is not a decision one peer may take alone.
 *
 * So the conflict is *reported*, not resolved by refusal: {@link applyMetaRound} returns which fields were
 * overwritten while the meta had moved on, and the caller logs them. An operator whose edit was superseded
 * learns it from the log rather than from noticing the value is wrong weeks later.
 *
 * "Moved on" is a question about the FIELD (R6-8): the round carries what its changed fields held when it was proposed (`metaBase`), and
 * a field is overwritten only when the stored value differs from that. The version it replaced for this cannot be read for a network's
 * layer or the own definitions a layer set apart, which have none — a first conclusion into either read every field as moved and warned
 * of an overwrite nobody made.
 *
 * ## Peers that have not upgraded
 *
 * `VoteRound` is gossiped, so a round proposed by an older peer arrives with neither field set. Those apply
 * **wholesale**, exactly as before. This is the only safe reading: an older proposer computed
 * `pendingMeta` as the complete intended result, and field-merging a round whose changed-field list is
 * unknown would apply an empty set — a passed round that changes nothing at all. The absence of the
 * version is therefore the compatibility switch, and the pre-upgrade behaviour is the fallback.
 */
import { isDeepStrictEqual } from 'node:util';
import type { SpaceMeta } from '../config/types.js';
import { parseSpaceMeta, type ParsedSpaceMeta } from '../spaces/body-schemas.js';
import { boundedNames, metaFieldKind, PER_TYPE_META_FIELD } from '../spaces/meta-fields.js';

/** The parts of a `VoteRound` this module reads. Kept structural so it is testable without a full round. */
export interface MetaRoundProposal {
  /**
   * What the proposer's write CHANGED, laid out as a meta (R6-6): the fields it named and, inside `typeSchemas`, the types it
   * changed — never the whole meta it was computed from, which carried every other type of the space into the network's layer.
   * A round from a peer before that release holds the whole merged meta; `parseMetaRound` finds its parts by comparing it.
   */
  pendingMeta: SpaceMeta;
  /**
   * Top-level meta fields the proposer changed. Absent on rounds from peers predating field-merge — see
   * the module header for why those must still apply wholesale.
   */
  metaChangedFields?: string[];
  /** The space's `meta.version` the proposal was computed against. Absent on pre-upgrade rounds. */
  baseMetaVersion?: number;
  /**
   * What the changed fields HELD when the proposal was computed (R6-8): each named field's value, and for the types it changed, those
   * types' definitions (`typeSchemas.<kind>.<name>`). A field absent here held nothing. Absent altogether on a round from a peer
   * before this release, which is judged by the version history as it always was.
   *
   * It is what makes "somebody changed this field since the proposal" a question about the FIELD. The version cannot answer it: a
   * network's layer has none (`replicatedMetaOf` strips the counters), nor do the own definitions a layer set apart, so a first
   * conclusion into either compared version 0 against the base's and read every field as moved.
   */
  metaBase?: SpaceMeta;
}

/** Housekeeping the space layer owns — a round must never carry these across. */
const HOUSEKEEPING = ['version', 'updatedAt', 'previousVersions'] as const;

export interface MetaRoundApplication {
  /** The meta to hand to `updateSpace`. */
  meta: Omit<SpaceMeta, 'version' | 'updatedAt' | 'previousVersions'>;
  /** Fields whose current value the round overwrote while the meta had moved past its base version. */
  conflicts: string[];
  /** True when the round carried no provenance and was applied wholesale (pre-upgrade proposer). */
  wholesale: boolean;
  /**
   * The fields this release has never heard of that the round named (R6-7), by name, bounded. A tolerant reader applies what it
   * knows and reports the rest here; it never stores one, so a newer peer's new key is not a reason to refuse the round.
   */
  unknownFields: string[];
}

/**
 * Compute the meta a passed `meta_change` round should produce, given the space's meta right now.
 *
 * Pure: takes the current meta and the round, returns the result and what it collided with. Conclusion
 * happens independently on every peer, so this has to be a function of state both peers can see — anything
 * read from local wall-clock or ambient config would let two peers apply the same round differently.
 *
 * Each field is merged by its kind (`spaces/meta-fields.ts`): a scalar or a whole object replaces, the types are merged per type
 * name (a round REPLACES a type by name, so what the new definition lacks is gone), and a field with no kind is reported, not stored.
 * This is the raw merge; what may be STORED is {@link parseMetaRound}'s.
 */
export function applyMetaRound(current: SpaceMeta | undefined, round: MetaRoundProposal): MetaRoundApplication {
  const strip = (m: SpaceMeta): Omit<SpaceMeta, 'version' | 'updatedAt' | 'previousVersions'> => {
    const { version: _v, updatedAt: _u, previousVersions: _p, ...rest } = m;
    return rest;
  };

  const fields = round.metaChangedFields?.filter(f => !(HOUSEKEEPING as readonly string[]).includes(f));

  // Pre-upgrade round, or one whose proposer recorded no provenance: apply exactly as before. Field-merging
  // an unknown changed-set would mean applying nothing, so a carried motion would silently do nothing.
  if (round.baseMetaVersion === undefined || fields === undefined) {
    const whole = strip(round.pendingMeta) as Record<string, unknown>;
    const known = Object.fromEntries(Object.entries(whole).filter(([k]) => metaFieldKind(k) !== undefined));
    const unknown = Object.keys(whole).filter(k => metaFieldKind(k) === undefined);
    return { meta: known as Omit<SpaceMeta, 'version' | 'updatedAt' | 'previousVersions'>, conflicts: [], wholesale: true, unknownFields: boundedNames(unknown) };
  }

  const base = current ? strip(current) : {};
  const merged: Record<string, unknown> = { ...base };
  const proposed = strip(round.pendingMeta) as Record<string, unknown>;
  const unknownFields: string[] = [];
  const differs = (a: unknown, b: unknown) => !isDeepStrictEqual(a, b);

  /**
   * Did somebody ELSE change this field since the round was proposed? Asked of the FIELD, against what it held at the proposal.
   *
   * Without that base, "the meta moved and this round is writing field X" is indistinguishable from "someone else changed field X" —
   * and reporting the first as a collision would fire on every ordinary concurrent edit of *different* fields, which is precisely the
   * case this module makes safe. A warning that cries wolf on the normal path is one operators learn to skip.
   *
   * A round of this release CARRIES the base (`metaBase`, R6-8) and the answer is a comparison of values: the stored one against the
   * captured one. No version is read, because the stores a conclusion writes do not all have one (a network's layer and the own
   * definitions a layer set apart are stripped of their counters), and a first conclusion into either read every field as moved.
   *
   * A round from a peer before this release carries none, and keeps what it always did: only a meta that has MOVED past the base
   * version can be contested, and the base is recovered from the space's own version history. That is capped, so on a space with a
   * burst of edits the base may have rolled off; then the coarse rule stands (report the overwrite rather than assert it was
   * uncontested; the value is applied either way).
   */
  // A round is a peer's: a base that is not a plain object (null, a list, a string) is no base, and the round is judged as one from a peer
  // before this release is — it must not be a way to make a conclusion throw.
  const captured = typeof round.metaBase === 'object' && round.metaBase !== null && !Array.isArray(round.metaBase)
    ? round.metaBase as Record<string, unknown> : undefined;
  const moved = (current?.version ?? 0) !== round.baseMetaVersion;
  const historyBase: Record<string, unknown> | undefined = captured !== undefined ? undefined
    : current?.version === round.baseMetaVersion
      ? (base as Record<string, unknown>)
      : current?.previousVersions?.find(h => h.version === round.baseMetaVersion)?.meta as Record<string, unknown> | undefined;
  const contested = (field: string, currentValue: unknown, incoming: unknown): boolean => {
    if (!differs(currentValue, incoming)) return false;                          // the round is not changing it now
    if (captured !== undefined) return differs(captured[field], currentValue);   // and it is no longer where the round found it
    return moved && (historyBase === undefined || differs(historyBase[field], currentValue));
  };

  const conflicts: string[] = [];

  for (const field of fields) {
    const kind = metaFieldKind(field);
    if (kind === undefined) {
      // A field this release has never heard of: reported, never stored (R6-7).
      unknownFields.push(field);
      continue;
    }
    if (kind === 'per-type') {
      // Merged per knowledge-type and per type name rather than replaced, matching what `mergeSpaceMeta`
      // does on the request path. A type another round added stays; one this round added or edited wins.
      //
      // A type the proposer *deleted* is therefore not deleted here — but it was never deletable this way:
      // under merge semantics an absent type is indistinguishable from a removed one, which is exactly why
      // deletion goes through the schema PUT with its own precondition instead.
      const currentTs = ((base as Record<string, unknown>)[PER_TYPE_META_FIELD] ?? {}) as Record<string, Record<string, unknown>>;
      const proposedTs = ((proposed as Record<string, unknown>)[PER_TYPE_META_FIELD] ?? {}) as Record<string, Record<string, unknown>>;
      const capturedTs = (captured?.[PER_TYPE_META_FIELD] ?? {}) as Record<string, Record<string, unknown>>;
      const historyTs = (historyBase?.[PER_TYPE_META_FIELD] ?? {}) as Record<string, object>;
      const mergedTs: Record<string, unknown> = { ...currentTs };
      for (const [kt, ktMap] of Object.entries(proposedTs)) {
        if (!ktMap) continue;
        mergedTs[kt] = { ...(currentTs[kt] ?? {}), ...ktMap };
        // Per knowledge-type, on the same rule as a scalar: contested only if this round changes it AND it is no longer where the
        // round found it. With the captured base that is asked of each TYPE the round changes (and the base holds exactly those);
        // without one, of the knowledge type as a whole.
        const collided = captured !== undefined
          ? Object.entries(ktMap).some(([name, def]) => differs(currentTs[kt]?.[name], def) && differs(capturedTs[kt]?.[name], currentTs[kt]?.[name]))
          : moved && differs(currentTs[kt], mergedTs[kt]) && (historyBase === undefined || differs(historyTs[kt], currentTs[kt]));
        if (collided) conflicts.push(`${PER_TYPE_META_FIELD}.${kt}`);
      }
      merged[PER_TYPE_META_FIELD] = mergedTs;
      continue;
    }

    const incoming = proposed[field];
    if (contested(field, merged[field], incoming)) conflicts.push(field);
    // `undefined` is a real proposal: it is how a scalar is cleared. Deleting the key rather than assigning
    // it keeps the stored object free of explicit-undefined properties, which JSON round-trips away anyway.
    if (incoming === undefined) delete merged[field];
    else merged[field] = incoming;
  }

  return {
    meta: merged as Omit<SpaceMeta, 'version' | 'updatedAt' | 'previousVersions'>,
    conflicts,
    wholesale: false,
    unknownFields: boundedNames(unknownFields),
  };
}

/** What {@link parseMetaRound} answers: the meta a store may take, or why this member cannot read the round. */
export type MetaRoundParse =
  | { ok: true; meta: ParsedSpaceMeta; conflicts: string[]; wholesale: boolean; unknownFields: string[] }
  | { ok: false; reason: string };

/**
 * The meta a passed round produces for `current`, PARSED — or the reason this member cannot read it (`Q-216`, R6-6).
 *
 * A passed round used to reach the stores with no parse at all, and `effectiveMeta` then dropped a layer that no longer parsed,
 * silently: a member held a layer it did not run, and one bad type stopped every good type that came with it. The rule now: the
 * round is merged ({@link applyMetaRound}) and the result is parsed AGAINST `current` — a part equal to what `current` holds is
 * carried and only what differs is parsed, so a legacy wholesale round that repeats a stored type a stricter body would refuse
 * today is not made unreadable by it — and if any changed part does not parse the round is NOT applied, in whole or in part.
 * Never throws; `reason` names the failing types (bounded) and is what the round's view and `space_schema_layers` show.
 */
export function parseMetaRound(current: SpaceMeta | undefined, round: MetaRoundProposal): MetaRoundParse {
  const applied = applyMetaRound(current, round);
  // Tolerant, as a peer's layer is read (`readKnownMeta`, R6-7): a key a later release added inside a type, a property schema or the
  // kinds is named and left out, not a reason to refuse the round — a member that refused it would cast no yes. A KNOWN field that is
  // wrong still refuses the whole round.
  const parsed = parseSpaceMeta(applied.meta, { against: current ?? {}, tolerant: true });
  if (!parsed.ok) return { ok: false, reason: parsed.failed.join('; ') };
  const unknownFields = parsed.unknown.length > 0 ? [...new Set([...applied.unknownFields, ...parsed.unknown])] : applied.unknownFields;
  return { ok: true, meta: parsed.meta, conflicts: applied.conflicts, wholesale: applied.wholesale, unknownFields };
}

/**
 * Which top-level meta fields a PATCH body actually proposes to change.
 *
 * Taken from the request body's own keys, not from diffing the result against the base. A patch that sets
 * a field to the value it already holds is still a proposal to set it — the network votes on the intent,
 * and diffing would quietly drop that field from the round so a concurrent change to it would win by
 * default.
 */
export function proposedMetaFields(incoming: Partial<SpaceMeta>): string[] {
  return Object.keys(incoming).filter(k => !(HOUSEKEEPING as readonly string[]).includes(k));
}
