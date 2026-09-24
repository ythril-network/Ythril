/**
 * Space settings — update (label/meta/dupe rules) and display ordering.
 *
 * The heavy machinery now lives beside this file (A17.7): `vector-index.ts` (Atlas $vectorSearch),
 * `lifecycle.ts` (init/create/remove/wipe/recovery), `rename.ts`, and `_shared.ts`.
 */
import { getConfig, saveConfig } from '../config/loader.js';
import { log } from '../util/log.js';
import type { SpaceConfig, SpaceMeta, DupeActionRule, DocExtractionMode, ImageLevel, AudioLevel, VideoLevel, TextLevel, RecordTtlWindows } from '../config/types.js';
import { buildSpaceVectorIndexes } from './vector-index.js';
import { syncSchemaFiles, META_VERSION_CAP } from './_shared.js';

/**
 * A space's MCP-facing directive, under the one name that still has a store behind it.
 *
 * `description` and `meta.purpose` were two fields for the same thing — `description` was commented
 * "shown to MCP clients as space-level instructions", `purpose` is "injected into MCP instructions at
 * handshake" — and they were served by different tools, so `list_spaces` and `space_meta` disagreed
 * about the same space. Worse, the UI only ever gained an editor for `purpose`, so the field MCP clients
 * actually read was the one no admin could change.
 *
 * `purpose` won because it is the one an operator can edit. `description` was a DERIVED alias for clients
 * that still read it, and it was REMOVED in 3.0 — both doors now refuse a body carrying it
 * (`refuseRemovedDescription`), naming `meta.purpose` so a caller is not left looking the replacement up.
 *
 * A legacy STORED `description` is still lifted into `meta.purpose` at boot by
 * `migrateSpaceDescriptionToPurpose`, and that migration is permanent rather than a release tail: it
 * persists on success and warns *"will retry next boot"* when it cannot, so a config it has never managed to
 * rewrite still carries the old key — and with the input alias refused, an operator cannot re-send the
 * directive under the old name either. See `a-durable-config-migration-stays-wired.test.js`.
 */
export function spacePurpose(space: { meta?: SpaceMeta }): string | undefined {
  const purpose = space.meta?.purpose?.trim();
  return purpose ? purpose : undefined;
}


/** Update mutable fields (label, meta, quotas, ladders) of an existing space in config.
 *  When `meta` is provided the version counter is auto-incremented and the
 *  previous version is pushed to `previousVersions` (capped at META_VERSION_CAP).
 *  Returns the updated SpaceConfig, or null if the space was not found. */
export function updateSpace(
  spaceId: string,
  updates: { label?: string; maxGiB?: number | null; meta?: SpaceMeta; dupeRules?: DupeActionRule[]; dupeMergeSurvivor?: 'older' | 'newer'; dupeRulesOnInsert?: boolean; recordTtlDays?: number | RecordTtlWindows | null; documentExtraction?: DocExtractionMode | null; imageAnalysis?: ImageLevel | null; audioAnalysis?: AudioLevel | null; videoAnalysis?: VideoLevel | null; textAnalysis?: TextLevel | null; completeLinkage?: boolean },
): SpaceConfig | null {
  const cfg = getConfig();
  const space = cfg.spaces.find(s => s.id === spaceId);
  if (!space) return null;
  if (typeof updates.label === 'string') space.label = updates.label;
  /*
   * `description` used to be folded in here, into `meta.purpose`, so a directive edit took the version bump
   * and the previousVersions snapshot every other meta change gets.
   *
   * It is GONE, and removed rather than left in place because it had become the weaker of two
   * implementations of one rule. `refuseRemovedDescription` 400s any body carrying the field, and it runs in
   * both planners — so no request reaches this arm, and all four internal callers pass `meta`. What was left
   * was a path that silently ACCEPTED what the refusal exists to reject, reachable only by an internal
   * caller going straight to `updateSpace` — which `meta-update.ts` warns is exactly what a tool must not
   * do. A directive written from a removed field, with nothing failing.
   */
  if (updates.maxGiB !== undefined) {
    // null or non-positive clears the cap (unlimited); positive number sets the cap
    space.maxGiB = updates.maxGiB !== null && updates.maxGiB > 0 ? updates.maxGiB : undefined;
  }
  // Duplicate-action rules are local (not governed) — apply immediately.
  if (updates.dupeRules !== undefined) {
    space.dupeRules = updates.dupeRules.length > 0 ? updates.dupeRules : undefined;
  }
  if (updates.dupeMergeSurvivor !== undefined) {
    space.dupeMergeSurvivor = updates.dupeMergeSurvivor;
  }
  if (updates.dupeRulesOnInsert !== undefined) {
    space.dupeRulesOnInsert = updates.dupeRulesOnInsert || undefined;
  }
  // F10 auto-TTL — local operational setting; `in` so an explicit clear (undefined) removes it.
  // The caller has already normalised the shape (`normaliseRecordTtl`): merged over what was stored, buckets
  // cleared, and an all-empty object collapsed to undefined. Re-deciding it here is how the two would drift.
  if ('recordTtlDays' in updates) {
    space.recordTtlDays = updates.recordTtlDays ?? undefined;
  }
  // F11-c per-space extraction-mode override — local operational setting; `in` so an explicit clear removes it.
  if ('documentExtraction' in updates) {
    space.documentExtraction = updates.documentExtraction ?? undefined;
  }
  // The other media ladders, same contract: local/operational, `in` so an explicit clear removes it.
  if ('imageAnalysis' in updates) space.imageAnalysis = updates.imageAnalysis ?? undefined;
  if ('audioAnalysis' in updates) space.audioAnalysis = updates.audioAnalysis ?? undefined;
  if ('videoAnalysis' in updates) space.videoAnalysis = updates.videoAnalysis ?? undefined;
  if ('textAnalysis' in updates) space.textAnalysis = updates.textAnalysis ?? undefined;
  /*
   * The conversion marker, and it is NOT settable through the space API any more.
   *
   * It was an ordinary reversible setting — turn it off and the 4.x array writes were accepted again,
   * which is what made a single-space conversion a genuine pilot. 5.0 removed the arrays, so turning it
   * off would mean "read my links from a shape that does not exist": `assertLinkRecords` would refuse
   * every link read on that space, and the operator who flipped it would see a working space stop
   * answering.
   *
   * **The assignment stays because the CONVERSION comes through here** — `links-conversion.ts` marks a
   * space by calling this function, which is why this is not simply deleted. What refuses an API caller
   * is the `'nobody'` row in `auth/space-field-rights.ts`, above the instance-admin shortcut, so the
   * refusal is declared in the table the totality gate reads rather than as a branch nothing can see.
   */
  if (updates.completeLinkage !== undefined) space.completeLinkage = updates.completeLinkage || undefined;

  if (updates.meta !== undefined) {
    const now = new Date().toISOString();
    const prev = space.meta;
    const prevVersion = prev?.version ?? 0;
    const newVersion = prevVersion + 1;

    // Preserve previous version history (capped)
    const history = prev?.previousVersions ?? [];
    if (prev) {
      const { previousVersions: _drop, ...snapshot } = prev;
      history.unshift({ version: prevVersion, meta: snapshot, updatedAt: prev.updatedAt ?? now });
      if (history.length > META_VERSION_CAP) history.length = META_VERSION_CAP;
    }

    space.meta = {
      ...updates.meta,
      version: newVersion,
      updatedAt: now,
      previousVersions: history.length > 0 ? history : undefined,
    };

    // P6: a change to the type schemas may add or remove filterable `properties.*` paths, so the
    // $vectorSearch indexes must be re-shaped to match. Rebuild off the request path
    // (`waitForReady:false`); `ensureVectorSearchIndex` diffs each index's definition and only
    // touches the ones whose filter-field set actually changed. Gated on the schema genuinely
    // changing so an unrelated meta edit (purpose, tag suggestions) does no index work.
    const schemaChanged = JSON.stringify(prev?.typeSchemas ?? null) !== JSON.stringify(updates.meta.typeSchemas ?? null);
    if (schemaChanged) {
      buildSpaceVectorIndexes(spaceId, false).catch(err =>
        log.warn(`P6: vector filter-field rebuild after schema change on '${spaceId}': ${err}`));
    }
  }

  saveConfig(cfg);
  // Fire-and-forget schema file sync
  syncSchemaFiles(spaceId, space.meta).catch(err => log.warn(`syncSchemaFiles: ${err}`));
  return space;
}

/** Reorder spaces in config to match the provided ordered list of IDs.
 *  IDs not present in the list are appended at the end (preserving relative order).
 *  Returns the reordered list of SpaceConfigs, or null if any provided ID is unknown. */
export function reorderSpaces(orderedIds: string[]): SpaceConfig[] | null {
  const cfg = getConfig();
  const idSet = new Set(orderedIds);
  // Validate all provided IDs exist
  for (const id of orderedIds) {
    if (!cfg.spaces.some(s => s.id === id)) return null;
  }
  // Build new order: provided IDs first (in given order), then any remaining spaces
  const reordered: SpaceConfig[] = [];
  for (const id of orderedIds) {
    reordered.push(cfg.spaces.find(s => s.id === id)!);
  }
  for (const space of cfg.spaces) {
    if (!idSet.has(space.id)) reordered.push(space);
  }
  cfg.spaces = reordered;
  saveConfig(cfg);
  return reordered;
}

/**
 * The `description` alias was removed in 3.0, and this is what stops that removal being SILENT.
 *
 * The top-level space bodies are not `.strict()` — they drop an unknown key — so without this a caller who
 * kept sending `description` would get a `200` and no directive written. MCP's `additionalProperties: false`
 * refuses it outright, so the same request would 400 on one door and quietly do nothing on the other: one
 * rule, two implementations, and the weaker one winning silently.
 *
 * It lives in the shared planners because both surfaces reach the store through them, and it names the
 * replacement rather than the removal — a caller reading `description is not a field` has to go and look up
 * what is.
 */
export function refuseRemovedDescription(body: unknown): { status: 400; body: { error: string } } | undefined {
  if (body && typeof body === 'object' && !Array.isArray(body) && 'description' in body) {
    return {
      status: 400,
      body: { error: '`description` was removed in 3.0 — send `meta.purpose` instead. It is the same directive, under the one name that was ever editable.' },
    };
  }
  return undefined;
}
