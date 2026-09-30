/**
 * The answer to "what is this space like before I write to it" — declared AND actual — built once for both
 * doors.
 *
 * ## Why this exists (`Q-95`)
 *
 * `GET /api/spaces/:id/meta` and MCP `space_meta` each assembled this whole object by hand: the meta without its
 * history, five counts per member, `needsReindex` over the members, the actual schema per member, and the proxy
 * shape around them. Two copies of one answer is the shape this repo pays for most, and these had already
 * drifted on a parameter (below). `space-meta-is-one-answer-on-both-doors.test.js` holds both handlers to this
 * function, and the actual schema to `brain/space-shape.ts`, which caches it and is never behind a write.
 *
 * ## `resolve`, and why the two doors default differently (`Q-168`)
 *
 * With `resolve`, a type declared as a schema-library `{ $ref }` comes back as its effective schema; without it,
 * as the stored `$ref`. REST has taken `?resolve=` for years with a RAW default, and MCP had no parameter at all
 * and always resolved — so an agent could never see the stored `$ref`, and nothing compared the two.
 *
 * Both doors now take `resolve`. **Their defaults stay what each door has always done**, because either one
 * equalised breaks somebody silently: a REST integrator round-tripping `GET` → edit → `PUT` would start writing
 * expanded schemas and quietly detach every type from its library entry; an agent reading `space_meta` to
 * shape a write would start receiving a bare `$ref` where it read the fields. The difference is the door's USE,
 * not a scope: REST's reader edits and writes back, MCP's reads to act. Both defaults are written here, once, and
 * each door's description states its own and the other's.
 */
import type { SpaceConfig } from '../config/types.js';
import { needsReindex } from './_shared.js';
import { resolveMetaRefs } from './schema-validation.js';
import { actualSchemaOf, spaceStatsOf, type SpaceStats } from '../brain/space-shape.js';

/** What `resolve` is when the caller does not say, per door — see the module docblock for why they differ. */
export const META_RESOLVE_DEFAULT = Object.freeze({ rest: false, mcp: true });

/**
 * The space meta, as both doors return it.
 *
 * `memberIds` is resolved by the caller, because each door narrows a proxy by its own source of scope — REST by
 * request, MCP by the connection's accessible spaces — and re-deriving it here would be a second place for the
 * two to disagree about which spaces a caller may see.
 */
export async function spaceMetaAnswer(input: {
  spaceId: string;
  space?: SpaceConfig;
  memberIds: string[];
  resolveRefs: boolean;
}): Promise<Record<string, unknown>> {
  const { spaceId, space, memberIds, resolveRefs } = input;
  const rawMeta = space?.meta ?? {};
  const meta = resolveRefs ? resolveMetaRefs(rawMeta) : rawMeta;
  // History is served by its own endpoint, never inline.
  const { previousVersions: _pv, ...metaPublic } = meta;

  const [perMemberStats, actualPerMember] = await Promise.all([
    Promise.all(memberIds.map(mid => spaceStatsOf(mid))),
    Promise.all(memberIds.map(mid => actualSchemaOf(mid))),
  ]);
  const stats: SpaceStats = { facts: 0, entities: 0, edges: 0, chrono: 0, files: 0 };
  for (const s of perMemberStats) for (const k of Object.keys(stats) as (keyof SpaceStats)[]) stats[k] += s[k];

  return {
    spaceId,
    spaceName: space?.label ?? spaceId,
    ...metaPublic,
    stats,
    // Reindex state travels with the meta on BOTH doors: `reindex` tells a caller to poll `space_meta` after
    // starting a job. `.some()` over the members, like `GET /reindex-status` — a proxy needs one when any member does.
    needsReindex: memberIds.some(mid => needsReindex(mid)),
    /*
     * WHAT THE SPACE ACTUALLY HOLDS, beside what it declares, in the declared schema's own format so a type the
     * space really holds can be promoted into it. Per member on a proxy, never merged: two types sharing a name
     * mean different things in different spaces, and an edge cannot cross a space, so a union would invent
     * relationships that cannot exist.
     */
    actualSchema: memberIds.length === 1 && memberIds[0] === spaceId
      ? actualPerMember[0]
      : { spaceId, members: actualPerMember },
  };
}
