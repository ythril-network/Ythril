/**
 * The decision half of creating a space: every refusal, and the arguments `createSpace()` must be called with.
 *
 * ## Why this is a function and not a route
 *
 * B-2's last two capabilities are `save_space` and `reindex`. `createSpace()` already exists in `lifecycle.ts`, so
 * a tool could call it today — and that is the problem. `POST /api/spaces` wraps it in checks that would all be
 * skipped: the retired-field refusal, the schema-library `$ref`, and the strict-flag seeding. A token holding
 * `createSpaces` would then get a *weaker* create over MCP than over REST, which is the *two surfaces, one rule, one
 * weaker* defect this whole item exists to close, reintroduced by the fix for it.
 *
 * So the chain lives here and both surfaces call it. Same split as `meta-update.ts`: decisions here, side effects at
 * the caller, and the refusal carries its HTTP status because the status IS the contract —
 * `space-create-contract.test.js` pins five of them and an MCP tool maps them rather than re-deriving them.
 *
 * ## The ordering that is part of the contract
 *
 * Parse, then the retired-field check, then the `$ref` check, and **only then** the create. Every refusal happens before
 * anything is written, which is what makes "a refused create leaves no space behind" true — asserted on every
 * refusal in the contract suite, because the natural way to get this wrong is to create first and validate after,
 * which returns the right status while stranding a space the caller has to clean up.
 */
import type { SpaceConfig, SpaceMeta } from '../config/types.js';
import { refusalOfParse } from '../util/log.js';
import type { z } from 'zod';
import { slugify } from './_shared.js';
import { createSpace, type SpaceCreator } from './lifecycle.js';
import {
  CreateSpaceBody, TypeSchemasZ, libraryRefRefusal, parseSpaceMeta, stripServerOwnedSpace,
} from './body-schemas.js';
import { refuseRemovedDescription } from './spaces.js';
import { schemaRoomRefusal, type SchemaRoomRefusal } from './schema-room.js';
import { RDF_BASE_NEEDED_STATUS, RDF_BASE_STANDS_STATUS, settleRdf, sharedRdfBaseRefusal } from './rdf-settle.js';
import { getConfig } from '../config/loader.js';
import type { TokenRights } from '../config/rights-shape.js';
import { getPublicBaseUrl, publicBaseUrlIsFallback } from '../config/public-url.js';
import { termClashes } from '../rdf/term-iri.js';
import { inlineResolvableRefs } from './schema-validation.js';
import { retiredSpaceFieldError } from '../brain/retired-write-fields.js';
import { ReservedSpaceIdError } from './unknown-space.js';
import { refusalText } from '../brain/store-failure.js';
import { reportServerFailure } from '../util/report-failure.js';
import { SpaceStillBeingRemoved, SPACE_STILL_BEING_REMOVED, SPACE_STILL_BEING_REMOVED_RETRY_AFTER_S } from './search-index-drops-in-flight.js';

/** The status of a new space whose terms would share one RDF address: understood, and not storable (as on PATCH). */
const TERM_CLASH_STATUS = 422 as const;

/** A refusal, carrying the status the contract suite pins. */
export type SpaceCreateRefusal = {
  status: 400 | typeof RDF_BASE_STANDS_STATUS | 422 | SchemaRoomRefusal['status'];
  body: { error: string; code?: string; storageExceeded?: true };
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
 * Reads config (the space list, the schema library) and the storage usage, and writes nothing, so the refusal chain is reachable without a
 * request and testable without standing up Docker.
 */
export async function planSpaceCreate(body: unknown, caller?: { rights?: TokenRights | null }): Promise<SpaceCreateDecision> {
  const removed = refuseRemovedDescription(body);
  if (removed) return { ok: false, refusal: removed };
  // `proxyFor` is retired (6.0): a proxy is a personal view now, made with `POST /api/views` / `view_create`. Refused BY NAME before the
  // parse, so the sentence says what to do instead and no space is created.
  const retired = retiredSpaceFieldError(body);
  if (retired) return { ok: false, refusal: { status: 400, body: { error: retired } } };

  // Strip, THEN be strict — the same pair the update path uses, and the same reason. `CreateSpaceBody` is
  // `.strict()` as of the P-4 ruling, so without this a caller copying a space out of `GET /api/spaces` and
  // posting it as a template gets a 400 for `builtIn`/`usageGiB`/`indexStatus` — fields WE emit and they
  // cannot know to remove.
  //
  // Only the emitted-never-accepted set is dropped here, not the create-only fields: `id` and `folders`
  // are real inputs to a create, and stripping `id` would silently replace a caller's chosen
  // space id with a generated slug. `mass-assignment.test.js` is the gate on both halves — it posts
  // `builtIn: true` and requires a 201 with the flag not injectable.
  const parsed = CreateSpaceBody.safeParse(stripServerOwnedSpace(body));
  if (!parsed.success) {
    return { ok: false, refusal: { status: 400, body: refusalOfParse(parsed.error) } };
  }
  const { id: rawId, label, folders, maxGiB, meta, faceDescriptorDims } = parsed.data;
  const id = rawId ?? slugify(label);

  const requestMeta = meta as SpaceMeta | undefined;

  // The same broken-`$ref` refusal the three UPDATE routes make, which creation once did not.
  //
  // Reported by an operator setting up a NEW space: a type declared `{"$ref": "library:…"}` came back as an empty
  // schema and the create reported success. It matters most in a `strict` space — which is the posture seeded a few
  // lines below — because one mistyped ref leaves that type with no constraints at all while its schema looks
  // authored. The check must stay AHEAD of the create, or a rejected schema leaves a space behind.
  // A reference to an entry of another kind would carry fields that never apply (`Q-215`): refused too, by the same one refusal.
  const refRefusal = libraryRefRefusal(requestMeta?.typeSchemas as z.infer<typeof TypeSchemasZ> | undefined);
  if (refRefusal) return { ok: false, refusal: { status: 422, body: { error: refRefusal.message } } };

  // New user-created spaces default to a fully-strict schema posture (owner decision 2026-07-25):
  // `validationMode: 'strict'` + `strictLinkage: true`, so a space enforces its schema and referential integrity
  // from day one. An explicit value in the request wins (spread last). The federation-join path calls `createSpace`
  // directly and is intentionally NOT affected — defaulting strict there would reject incoming off-schema federated
  // records on ingest. With no typeSchemas yet defined, 'strict' still accepts every type/label, so this never blocks
  // a brand-new empty space.
  const seededMeta: SpaceMeta = { validationMode: 'strict', strictLinkage: true, ...(requestMeta ?? {}) };
  // Q-748: a new space's RDF setting is its first set, settled by the one rule (`rdf-settle.ts`): the base filled from the public URL or
  // refused, the write-only `rebase` never stored.
  if (seededMeta.rdf !== undefined) {
    const rdf = settleRdf(undefined, seededMeta.rdf, 'local', { spaceId: id, ...(publicBaseUrlIsFallback() ? {} : { publicBaseUrl: getPublicBaseUrl() }) });
    // Nothing is stored yet, so the only refusal is the first set's (`rdf_base_needed`, 400).
    if (!rdf.ok) return { ok: false, refusal: { status: RDF_BASE_NEEDED_STATUS, body: { error: rdf.error, code: rdf.code } } };
    if (rdf.rdf === undefined) delete seededMeta.rdf; else seededMeta.rdf = rdf.rdf;
    // A base another space of this instance holds with RDF on is refused at the save (bundle-269 slice F), as on PATCH: the new space holds
    // nothing yet, so whatever base it takes is a move. The refusal leaves no space behind.
    const shared = sharedRdfBaseRefusal(getConfig(), id, undefined, seededMeta.rdf, caller?.rights);
    if (shared) return { ok: false, refusal: { status: shared.status, body: { error: shared.error, code: shared.code } } };
    // Q-748 rule 5 at create too (review finding 9): a space stored with two terms of one address would answer rdf_term_clash to every
    // later library write that touches it. Asked of the resolved schema, as on PATCH.
    const clashes = seededMeta.rdf?.enabled === true && seededMeta.rdf.base ? termClashes(inlineResolvableRefs(seededMeta)) : [];
    if (clashes.length > 0) {
      return { ok: false, refusal: { status: TERM_CLASH_STATUS, body: { code: 'rdf_term_clash', error: `two terms of this space would have one RDF address: ${clashes.map(c => c.message).join('; ')}` } } };
    }
  }

  // What `createSpace` stores is parsed: the seeded meta is the caller's parsed meta with two defaults laid under it, and it
  // goes through the one parse again so the plan carries the brand a store takes (`Q-216`).
  const minted = parseSpaceMeta(seededMeta);
  if (!minted.ok) {
    return { ok: false, refusal: { status: 400, body: { error: minted.message } } };
  }

  // Room for the schema the new space starts with (Q-981), as every schema write door asks it: its text within the size bound and its bytes
  // within the storage quota. After every other refusal and before the plan, so a refused create leaves no space behind.
  const room = await schemaRoomRefusal(undefined, minted.meta);
  if (room) return { ok: false, refusal: room };

  return {
    ok: true,
    plan: { args: { id, label, folders, maxGiB, meta: minted.meta, faceDescriptorDims } },
  };
}

/**
 * What happened, in terms both surfaces can report.
 *
 * `conflict` is separated from `failed` because they mean opposite things to a caller: the id is taken (pick another,
 * or you already have it), versus something broke (retry, or read the log). REST maps them to 409 and 500; a tool
 * says which one. Collapsing them would make "already exists" indistinguishable from a storage failure, and the
 * first is often a successful retry of a request whose response was lost.
 *
 * `retry` is a third thing again: the id is free in the config but the search-index drop of the space that held it is still running
 * (`search-index-drops-in-flight.ts`), so nothing was written and the same request will do in a few seconds. REST answers `503` with
 * `Retry-After`, a tool says `retryable` beside the code, on both the body `{ error, code, retryable }`.
 */
export type SpaceCreateOutcome =
  | { outcome: 'created'; space: SpaceConfig }
  | { outcome: 'conflict'; error: string }
  | { outcome: 'retry'; error: string; code: typeof SPACE_STILL_BEING_REMOVED; retryAfterSeconds: number }
  | { outcome: 'failed'; error: string };

/**
 * Apply a plan. The only failures here are the ones that can only be discovered by attempting the write.
 *
 * `createSpace` signals a taken id by throwing with `already exists` in the message, which is matched rather than
 * typed — that is how the route did it, and changing it in an extraction would be changing behaviour under cover of
 * moving it. Worth a typed error eventually; not in a PR whose value is being provably behaviour-preserving.
 */
export async function applySpaceCreate(plan: SpaceCreatePlan, creator: SpaceCreator): Promise<SpaceCreateOutcome> {
  try {
    const space = await createSpace(plan.args, creator);
    return { outcome: 'created', space };
  } catch (err) {
    // The deleted space's index drop has not settled: retryable, nothing written (`createSpace` refused before it wrote anything).
    if (err instanceof SpaceStillBeingRemoved) {
      return { outcome: 'retry', error: err.message, code: err.code, retryAfterSeconds: SPACE_STILL_BEING_REMOVED_RETRY_AFTER_S };
    }
    // A pre-6.0 proxy's reserved id: the id is not free, which is a conflict in our words (an instance admin purges it first).
    if (err instanceof ReservedSpaceIdError) return { outcome: 'conflict', error: err.message };
    // The store's failure is not this function's to word: `refusalText` rethrows it, so each door answers it as every
    // door does (bundle-30 I12), and only then is the wording read (bundle-53 G7, Q-335) — a driver text that holds
    // "already exists" was a 409 in the driver's own words while the store was failing.
    const msg = refusalText(err);
    if (msg.includes('already exists')) return { outcome: 'conflict', error: msg };
    // Anything else keeps its generic sentence — and is logged, where it used to be discarded with nothing left behind.
    reportServerFailure(`space create '${plan.args.id}'`, err);
    return { outcome: 'failed', error: 'Failed to create space' };
  }
}
