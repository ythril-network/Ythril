/**
 * Which schema a stored record is judged by in the live check (`POST /api/spaces/:id/validate-schema`, MCP `schema_validate`): the space's
 * current one, or the version the record carries (`against: 'stamp'`, Q-743; bundle-267 design r3 §5).
 *
 * ## What it prevents
 *
 * - **A record with no version to judge it by passed as valid.** A record with no stamp, or a stamp whose text this server does not hold,
 *   is judged by nothing: it is COUNTED (`skipped.unversioned`, `skipped.notHeld[fp]`) where the walk reads it, never listed as a row and
 *   never judged by the current schema in its place.
 * - **A store that did not answer read as "not held".** The texts are read through `versionTexts`, which throws on a failed read; the
 *   check fails with it rather than counting every record of the page as not held.
 * - **A text read per record, or rules compiled per record.** The stamps a page names are read in ONE batched read per page (only those
 *   this call has not read yet), each text is parsed once per call and member, and its rules compile once per call into a program map the
 *   call owns (`compileRulesInto`), so the shared program cache is never churned by versions no space holds now.
 *
 * ## What a version text does not carry
 *
 * A version's text holds its `typeSchemas` and `rules` only. The settings it is run with — `validationMode`, `strictLinkage` and the
 * rest — are the checked space's current ones, in both modes.
 *
 * Rules from a peer's text were cost-checked when the text arrived (`verifySnapshot` → `readPeerMeta`), so a stamp-mode check runs only
 * rules a save or an arrival accepted: the door's "only rules its caller could save" promise, held in spirit.
 */
import type { SpaceMeta } from '../config/types.js';
import { carriedStampOf } from './schema-stamp.js';
import { versionMetaOf, versionTexts } from './schema-version-text.js';
import { resolveMetaRefs } from './schema-validation.js';
import { compileRulesInto, ownRulePrograms } from './schema-rules.js';

/** What a stored record is judged by: the space's current schema (the default), or the version the record carries. */
export const VALIDATE_AGAINST = ['current', 'stamp'] as const;
export type ValidateAgainst = typeof VALIDATE_AGAINST[number];

/** The records of THIS call that no version judged: those with no stamp, and those whose stamp names a text not held, per fingerprint. */
export interface ValidateSkipped { unversioned: number; notHeld: Record<string, number> }

/** Which schema judges each record a walk reads. */
export interface RecordJudge {
  readonly against: ValidateAgainst;
  /** Read what the records of one page of `memberId` are judged by. Call it once per page, before {@link metaOf} or {@link take}. */
  readPage(memberId: string, docs: readonly Readonly<Record<string, unknown>>[]): Promise<void>;
  /** The schema `doc` is judged by, `null` when none: a lookup that counts nothing (an edge page is judged whole before it is read on). */
  metaOf(memberId: string, doc: Readonly<Record<string, unknown>>): SpaceMeta | null;
  /** The schema `doc` is judged by, for a record the walk READ: a record judged by none is counted here, once. */
  take(memberId: string, doc: Readonly<Record<string, unknown>>): SpaceMeta | null;
  /** The counts of this call ({@link ValidateSkipped}); absent against the current schema, which judges every record. */
  skipped(): ValidateSkipped | undefined;
}

/** Every record judged by `meta`, the space's current schema (resolved). */
export function currentJudge(meta: SpaceMeta): RecordJudge {
  return {
    against: 'current',
    readPage: async () => {},
    metaOf: () => meta,
    take: () => meta,
    skipped: () => undefined,
  };
}

/**
 * Every record judged by the version it carries, run with `settings`' settings (the checked space's current meta). One per call: it holds
 * the call's texts, its program map and its counts.
 */
export function stampJudge(settings: SpaceMeta): RecordJudge {
  /** Per member, per fingerprint: the version's meta, ready to run, or `null` when this server holds no text this release can read. */
  const versions = new Map<string, Map<string, SpaceMeta | null>>();
  const programs = ownRulePrograms();
  const counts: ValidateSkipped = { unversioned: 0, notHeld: {} };

  const metaOf = (memberId: string, doc: Readonly<Record<string, unknown>>): SpaceMeta | null => {
    const fp = carriedStampOf(doc);
    return fp === undefined ? null : versions.get(memberId)?.get(fp) ?? null;
  };

  return {
    against: 'stamp',
    async readPage(memberId, docs) {
      const known = versions.get(memberId) ?? versions.set(memberId, new Map()).get(memberId)!;
      const wanted = [...new Set(docs.map(carriedStampOf).filter((fp): fp is string => fp !== undefined && !known.has(fp)))];
      if (wanted.length === 0) return;
      // One batched read; a failed one throws (never "not held").
      const texts = await versionTexts(memberId, wanted);
      for (const fp of wanted) {
        const text = texts.get(fp);
        const read = text === undefined ? null : versionMetaOf(text);
        known.set(fp, read === null ? null : compileRulesInto(
          resolveMetaRefs({ ...settings, typeSchemas: read.meta.typeSchemas, rules: read.meta.rules } as SpaceMeta), programs));
      }
    },
    metaOf,
    take(memberId, doc) {
      const meta = metaOf(memberId, doc);
      if (meta) return meta;
      const fp = carriedStampOf(doc);
      if (fp === undefined) counts.unversioned++;
      else counts.notHeld[fp] = (counts.notHeld[fp] ?? 0) + 1;
      return null;
    },
    skipped: () => ({ unversioned: counts.unversioned, notHeld: { ...counts.notHeld } }),
  };
}
