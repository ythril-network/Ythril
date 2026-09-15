/**
 * The decision half of creating a space: every refusal, and the arguments `createSpace()` must be called with.
 *
 * ## Why this is a function and not a route
 *
 * B-2's last two capabilities are `save_space` and `reindex`. `createSpace()` already exists in `lifecycle.ts`, so
 * a tool could call it today — and that is the problem. `POST /api/spaces` wraps it in checks that would all be
 * skipped: the two proxy refusals, the schema-library `$ref`, and the strict-flag seeding. A token holding
 * `createSpaces` would then get a *weaker* create over MCP than over REST, which is the *two surfaces, one rule, one
 * weaker* defect this whole item exists to close, reintroduced by the fix for it.
 *
 * So the chain lives here and both surfaces call it. Same split as `meta-update.ts`: decisions here, side effects at
 * the caller, and the refusal carries its HTTP status because the status IS the contract —
 * `space-create-contract.test.js` pins five of them and an MCP tool maps them rather than re-deriving them.
 *
 * ## The ordering that is part of the contract
 *
 * Parse, then the proxy checks, then the `$ref` check, and **only then** the create. Every refusal happens before
 * anything is written, which is what makes "a refused create leaves no space behind" true — asserted on every
 * refusal in the contract suite, because the natural way to get this wrong is to create first and validate after,
 * which returns the right status while stranding a space the caller has to clean up.
 */
import type { SpaceConfig, SpaceMeta } from '../config/types.js';
import type { z } from 'zod';
import { getConfig } from '../config/loader.js';
import { slugify } from './_shared.js';
import { createSpace } from './lifecycle.js';
import { CreateSpaceBody, TypeSchemasZ, findBrokenLibraryRefs, brokenRefsError, stripServerOwnedSpace } from './body-schemas.js';
import { refuseRemovedDescription } from './spaces.js';

/** A refusal, carrying the status the contract suite pins. */
export type SpaceCreateRefusal = {
  status: 400 | 422;
  body: { error: string };
};

/** Exactly the arguments `createSpace()` takes, with the id resolved and the meta seeded. */
export type SpaceCreatePlan = {
  args: Parameters<typeof createSpace>[0];
};

export type SpaceCreateDecision =
  | { ok: false; refusal: SpaceCreateRefusal }
  | { ok: true; plan: SpaceCreatePlan };

/**
 * Decide a space creation: refuse it, or return the call that makes it.
 *
 * Reads config (the space list, the schema library) and writes nothing, so the refusal chain is reachable without a
 * request and testable without standing up Docker.
 */
export function planSpaceCreate(body: unknown): SpaceCreateDecision {
  const removed = refuseRemovedDescription(body);
  if (removed) return { ok: false, refusal: removed };

  // Strip, THEN be strict — the same pair the update path uses, and the same reason. `CreateSpaceBody` is
  // `.strict()` as of the P-4 ruling, so without this a caller copying a space out of `GET /api/spaces` and
  // posting it as a template gets a 400 for `builtIn`/`usageGiB`/`indexStatus` — fields WE emit and they
  // cannot know to remove.
  //
  // Only the emitted-never-accepted set is dropped here, not the create-only fields: `id`, `folders` and
  // `proxyFor` are real inputs to a create, and stripping `id` would silently replace a caller's chosen
  // space id with a generated slug. `mass-assignment.test.js` is the gate on both halves — it posts
  // `builtIn: true` and requires a 201 with the flag not injectable.
  const parsed = CreateSpaceBody.safeParse(stripServerOwnedSpace(body));
  if (!parsed.success) {
    return { ok: false, refusal: { status: 400, body: { error: parsed.error.message } } };
  }
  const { id: rawId, label, folders, maxGiB, proxyFor, meta, faceDescriptorDims } = parsed.data;
  const id = rawId ?? slugify(label);

  // Validate proxy members exist and are not themselves proxies.
  //
  // `['*']` is the wildcard SENTINEL, not a member list, so per-member validation is skipped for it. Treating it as
  // an id would refuse every wildcard proxy space with "space '*' not found" — pinned in the contract suite for
  // exactly that reason.
  if (proxyFor && !(proxyFor.length === 1 && proxyFor[0] === '*')) {
    const cfg = getConfig();
    for (const memberId of proxyFor) {
      const member = cfg.spaces.find(s => s.id === memberId);
      if (!member) {
        return { ok: false, refusal: { status: 400, body: { error: `Proxy member space '${memberId}' not found` } } };
      }
      if (member.proxyFor) {
        return {
          ok: false,
          refusal: { status: 400, body: { error: `Proxy member '${memberId}' is itself a proxy space (nesting not allowed)` } },
        };
      }
    }
  }

  const requestMeta = meta as SpaceMeta | undefined;

  // The same broken-`$ref` refusal the three UPDATE routes make, which creation once did not.
  //
  // Reported by an operator setting up a NEW space: a type declared `{"$ref": "library:…"}` came back as an empty
  // schema and the create reported success. It matters most in a `strict` space — which is the posture seeded a few
  // lines below — because one mistyped ref leaves that type with no constraints at all while its schema looks
  // authored. The check must stay AHEAD of the create, or a rejected schema leaves a space behind.
  if (requestMeta?.typeSchemas) {
    const brokenRefs = findBrokenLibraryRefs(requestMeta.typeSchemas as z.infer<typeof TypeSchemasZ>);
    if (brokenRefs.length > 0) {
      return { ok: false, refusal: { status: 422, body: { error: brokenRefsError(brokenRefs) } } };
    }
  }

  // New user-created spaces default to a fully-strict schema posture (owner decision 2026-07-25):
  // `validationMode: 'strict'` + `strictLinkage: true`, so a space enforces its schema and referential integrity
  // from day one. An explicit value in the request wins (spread last). Proxy spaces hold no data of their own, so
  // they are left un-defaulted. The federation-join path calls `createSpace` directly and is intentionally NOT
  // affected — defaulting strict there would reject incoming off-schema federated records on ingest. With no
  // typeSchemas yet defined, 'strict' still accepts every type/label, so this never blocks a brand-new empty space.
  const seededMeta: SpaceMeta | undefined = proxyFor
    ? requestMeta
    : { validationMode: 'strict', strictLinkage: true, ...(requestMeta ?? {}) };

  return {
    ok: true,
    plan: { args: { id, label, folders, maxGiB, proxyFor, meta: seededMeta, faceDescriptorDims } },
  };
}

/**
 * What happened, in terms both surfaces can report.
 *
 * `conflict` is separated from `failed` because they mean opposite things to a caller: the id is taken (pick another,
 * or you already have it), versus something broke (retry, or read the log). REST maps them to 409 and 500; a tool
 * says which one. Collapsing them would make "already exists" indistinguishable from a storage failure, and the
 * first is often a successful retry of a request whose response was lost.
 */
export type SpaceCreateOutcome =
  | { outcome: 'created'; space: SpaceConfig }
  | { outcome: 'conflict'; error: string }
  | { outcome: 'failed'; error: string };

/**
 * Apply a plan. The only failures here are the ones that can only be discovered by attempting the write.
 *
 * `createSpace` signals a taken id by throwing with `already exists` in the message, which is matched rather than
 * typed — that is how the route did it, and changing it in an extraction would be changing behaviour under cover of
 * moving it. Worth a typed error eventually; not in a PR whose value is being provably behaviour-preserving.
 */
export async function applySpaceCreate(plan: SpaceCreatePlan): Promise<SpaceCreateOutcome> {
  try {
    const space = await createSpace(plan.args);
    return { outcome: 'created', space };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('already exists')) return { outcome: 'conflict', error: msg };
    return { outcome: 'failed', error: 'Failed to create space' };
  }
}
