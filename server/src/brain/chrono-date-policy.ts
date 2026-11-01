/**
 * What a PASSED due moment means for a chrono type — resolved in one place, for every reader.
 *
 * ## The report this answers
 *
 * The canary operator read the same three records two ways minutes apart (2026-09-08T0659Z): the chrono list
 * route answered `overdue`, the collection held `active`. Their argument, and it is right: **a date passing
 * is a fact; what it MEANS is an interpretation, and it is not the store's to make.** "The due moment has
 * passed" is computable and inarguable. "Therefore this is late" depends entirely on what the record is
 * ABOUT — after the date a thing may equally have been finished, recorded, cancelled or simply have
 * happened. Most of their chronos describe events that OCCURRED: an alert episode, a backup run, a deploy.
 * For every one of those a past start date is the normal condition and means the opposite of late.
 *
 * It cost them two readers that compared the returned status against `active` and could therefore never
 * match: **1 687 of 1 806 chronos in one space never closed**, and a backup monitor skipped exactly the hung
 * runs it exists to catch.
 *
 * Owner ruling, 2026-09-08: *"Make derive configurable what it means to pass a date on schema (ladder?).
 * defaults to todays behaviour"*.
 *
 * ## Why the TYPE is the right place, rather than a new field on the answer
 *
 * The alternatives on the table were all shapes of "return both values and let the caller choose". This is
 * better because the interpretation of a record type belongs where that type is already defined: an operator
 * who declares a `deploy` type is exactly the person who knows a past deploy is not late. It also leaves the
 * answer unambiguous — with the derivation off for a type, `status` IS the stored status, so there is no
 * second field anybody has to know to read.
 *
 * ## Two tiers, and no record tier
 *
 * **schema > space**, matching `retention` and `suppressEmbeddings` rather than inventing a third order.
 *
 * There is deliberately no per-RECORD override, where `retention` has one: the meaning of a past date
 * belongs to the KIND of thing, not to one instance of it. A record tier would let two deploy entries
 * disagree about what a deploy is, which is not a capability, it is a way to be inconsistent.
 *
 * ## The ladder was considered and is not built
 *
 * The ruling asks the question. A multi-rung form — overdue at the due moment, something else N days later —
 * has no asker, and it makes the answer a function of HOW LONG ago, so every reader must agree on "now" at
 * more than one boundary. One rung already has that property; more multiply it.
 *
 * The field takes a STRING, so an array is a compatible extension the day somebody needs one. That is the
 * reason it is a string rather than a boolean: `suppressEmbeddings: true|false` cannot grow a third state
 * without a migration, and this can.
 *
 * ## Its two readers, and why neither may resolve this itself
 *
 * `chrono.ts` (the read path and the list filter) and `recall.ts` (a chrono hit's projection). A
 * `?? 'overdue'` in either is a second implementation, and the symptom would be a recall hit disagreeing
 * with a direct read of the SAME record — the two-answers-one-record defect this whole feature was ruled on
 * to end. `a-passed-date-means-what-the-schema-says.test.js` asserts both reach this module.
 *
 * ## Why this module imports nothing but its own types
 *
 * `chrono-status.ts` is a leaf on purpose — `recall.ts` and `chrono.ts` both need it and would otherwise
 * close an import cycle. This is read from the same two places plus the query builder, so it is pure and
 * total: it takes the space meta as an argument and returns a value.
 */
import type { SpaceMeta, DatePassedPolicy } from '../config/types-knowledge.js';
import { DATE_PASSED_VALUES } from '@ythril/schema';

/**
 * What a passed due moment may mean. Two, and the absence of a third is a decision — see the module note.
 *
 * Declared in `@ythril/schema` with the rest of the schema vocabulary and re-exported, so the admin PATCH schema, the MCP tool
 * schema, the gate and an app writing a schema all read one tuple. A second copy of a vocabulary is the defect this repository
 * produces most.
 */
export { DATE_PASSED_VALUES };

export type { DatePassedPolicy };

/** Today's behaviour, and what every absent or unusable setting resolves to. */
export const DEFAULT_DATE_PASSED: DatePassedPolicy = 'overdue';

const KNOWN = new Set<string>(DATE_PASSED_VALUES);

/** A stated policy, or `undefined` when the value is absent or not one this version knows. */
function stated(v: unknown): DatePassedPolicy | undefined {
  return typeof v === 'string' && KNOWN.has(v) ? v as DatePassedPolicy : undefined;
}

/**
 * What a passed due moment means for `type` in this space.
 *
 * **An unrecognised value reads as UNSET rather than as a third behaviour.** `config.json` is hand-editable,
 * so the admin PATCH schema is not the only way in, and a typo must land on the documented default instead
 * of inventing something. Same reasoning as `slotTimeoutMs` refusing a `NaN`: refuse the value, keep the
 * guarantee.
 *
 * `type` may be undefined — a chrono entry is not required to have one — and an untyped entry has no schema
 * to consult, so it takes the space tier. That is the same two-tier shape a FILE gets for
 * `suppressEmbeddings`, and for the same reason: there is no middle tier to read.
 */
export function datePassedPolicy(
  meta: Pick<SpaceMeta, 'typeSchemas' | 'whenDuePasses'> | undefined,
  type: string | undefined,
): DatePassedPolicy {
  const fromSchema = type ? stated(meta?.typeSchemas?.chrono?.[type]?.whenDuePasses) : undefined;
  return fromSchema ?? stated(meta?.whenDuePasses) ?? DEFAULT_DATE_PASSED;
}

/**
 * The chrono types in this space whose passed dates mean NOTHING — what the query builder needs.
 *
 * The read path resolves one entry at a time; a Mongo filter cannot, so it needs the set up front. Derived
 * here rather than in the builder so both answers come from `datePassedPolicy` and cannot diverge — which is
 * the whole failure this module exists to prevent, and it would land in the one door where it is hardest to
 * see: a filter that silently matches records reading as something else.
 *
 * **When the SPACE tier says `nothing`, the set is not enumerable** — every type is exempt, including types
 * no schema declares. `null` says that, and the builder branches on it; an empty array would say the
 * opposite while looking similar, which is the absent-versus-empty conflation this codebase has paid for
 * more than once.
 */
export function typesWhereDatePassedMeansNothing(
  meta: Pick<SpaceMeta, 'typeSchemas' | 'whenDuePasses'> | undefined,
): readonly string[] | null {
  if (datePassedPolicy(meta, undefined) === 'nothing') return null;
  const declared = meta?.typeSchemas?.chrono ?? {};
  return Object.keys(declared).filter(t => stated(declared[t]?.whenDuePasses) === 'nothing');
}
