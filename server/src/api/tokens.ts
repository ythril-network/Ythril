import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth, requireAdminOrSpaceAdmin, requireAdminOrSpaceAdminMfa, isInstanceAdmin } from '../auth/middleware.js';
import { authRateLimit, globalRateLimit } from '../rate-limit/middleware.js';
import { rateLimitRefusal } from '../rate-limit/per-token.js';
import { createToken, listTokens, revokeToken, regenerateToken, renameToken, setTokenRights, setTokenMfa, setTokenRateLimit } from '../auth/tokens.js';
import { isMfaEnabled, verifyMfaCode } from '../auth/totp.js';
import { z } from 'zod';
import { SPACE_AREAS, RUNGS, RUNG_IMPLICATIONS, DERIVED_RUNGS } from '../config/rights-shape.js';
import { ROUTE_RIGHTS, NOT_AREA_SCOPED } from '../auth/space-rights.js';
import { refusalsOutsideEditorScope, editorScopeFor } from '../auth/editor-scope.js';
import { capRights, describeExcess } from '../auth/mint-cap.js';
import { reportServerFailure } from '../util/report-failure.js';
import { refuseSelfFloorRaise } from '../auth/floor-guard.js';
import { migrateToken } from '../auth/rights-migration.js';
import { withInstanceAdminGrants } from '../auth/instance-admin-grants.js';
/**
 * What a request with NO authenticated token holds. Every field at its narrowest.
 *
 * Declared once rather than written `{}` twice, because `{}` is what the two call sites used to pass to
 * `migrateToken` — and an empty legacy record is the WIDEST thing that function can be handed.
 */
const NO_RIGHTS = { instanceAdmin: false, createSpaces: false, floor: null, perSpace: {} } as const;
import { canWriteAnywhere } from '../auth/write-anywhere.js';
import type { TokenRights } from '../config/rights-shape.js';

export const tokensRouter = Router();

/**
 * `readOnly`, DERIVED for the response — the field is no longer stored (D-8d).
 *
 * ## Why the response keeps a field the record has lost
 *
 * D-8d's goal is that nothing STORES the legacy flag and nothing DECIDES on it. Removing it from the API
 * response is a separate, breaking change to a published contract, and bundling the two would have broken
 * every client reading `token.readOnly` in a release whose point was internal cleanup. The integration suite
 * said so directly: a schema-library token is asserted to come back `readOnly: true`.
 *
 * So the split is deliberate — gone from the record, still answered on the wire — and the same shape the
 * `space.description` alias used while that field was on its way out.
 *
 * ## Derived is also MORE correct than the flag was
 *
 * A token is read-only exactly when its matrix grants no write rung anywhere. That is true for a token
 * nobody ever set the boolean on but which holds only `read` — a case the stored flag could not express, and
 * answered `false` for.
 */
function withReadOnlyAlias<T extends { rights?: unknown }>(t: T): T & { readOnly: boolean; admin: boolean } {
  const rights = t.rights as TokenRights | undefined;
  return {
    ...t,
    readOnly: !canWriteAnywhere(rights),
    // spaces joined the alias when it was deleted from the record, for the same reason as the other two:
    // the response shape is a published contract, and editorScopeFor gives the same answer the stored
    // array did — the spaces this token reaches, or undefined for unrestricted.
    spaces: editorScopeFor(t as { rights?: TokenRights | null }) as string[] | undefined,
    // `admin` joined the alias when it was deleted from the record, for the same reason and by the same
    // measurement: `schema-library.test.js` asserts a library token comes back `admin: false`, and that
    // assertion lives only in the Docker-only suite that `preflight` cannot run. Found by grepping those
    // suites BEFORE pushing this time, rather than by a red CI run as with `readOnly`.
    admin: rights?.instanceAdmin === true,
  };
}

// GET /api/auth/me — returns the current token's metadata (used by the Angular SPA to verify a PAT)
tokensRouter.get('/me', globalRateLimit, requireAuth, (req, res) => {
  res.json(req.authToken);
});

/**
 * GET /api/tokens/rights-catalog — what each area and rung actually GRANTS.
 *
 * The rights grid is four areas × four rungs of bare words, and nothing told an operator what any cell does.
 * The answer already exists and is authoritative: `ROUTE_RIGHTS` is the table the server ENFORCES against, so
 * it is the only description of a right that cannot be wrong. A list typed into the client would be a second
 * copy of a security control, and the copy that drifts is the one people read.
 *
 * **Authenticated, not admin.** It is capability documentation — every route in it is published in the
 * integration guide — and the caller who most needs it is the non-admin trying to understand the rights they
 * hold. Gating it to admins would withhold the explanation from exactly that person.
 *
 * The table is sent FLAT and the cumulative view is computed by the caller, because rungs contain the ones
 * below: `write` grants every `read` route as well. Sending pre-expanded lists would ship the same route many
 * times and put the containment rule in two places.
 *
 * `scope` is deliberately omitted — how a route learns which space it is about is internal, and a tooltip has
 * no use for it.
 *
 * `implications` is published for the same reason the routes are: `knowledge: write` entails `schema: read`
 * (`RUNG_IMPLICATIONS`), the server enforces it in `effectiveRung`, and a grid that hard-coded the pair would
 * be a second copy of a security rule. With it published, the matrix can hold the schema cell at the implied
 * rung and say why, instead of showing `none` while the server grants read.
 */
tokensRouter.get('/rights-catalog', globalRateLimit, requireAuth, (_req, res) => {
  res.json({
    areas: SPACE_AREAS,
    rungs: RUNGS,
    implications: RUNG_IMPLICATIONS,
    // The states the matrix expresses without naming. `spaceAdmin` has been enforced since #937 and was
    // findable nowhere: an operator saw four independent rungs and nothing said that all four at `admin` IS
    // administering that space. Published here for the same reason `routes` is — this is the description that
    // cannot be wrong, because `requires` is computed from `SPACE_AREAS` rather than restated.
    derivedRungs: DERIVED_RUNGS,
    routes: ROUTE_RIGHTS.map(r => ({ area: r.area, method: r.method, route: r.route, needs: r.needs })),
    // Space-scoped routes governed by NO area, each with the reason. Same argument as `routes` and
    // `derivedRungs`: a route absent from `routes` was indistinguishable to a caller from one we forgot to
    // classify, so "the matrix does not govern renaming a space" was a fact only the server source held. Four
    // rows, and they are the difference between a complete grid and a grid with an unexplained gap. No method:
    // an exemption is a claim about the route rather than about one verb of it — see NOT_AREA_SCOPED.
    notAreaScoped: NOT_AREA_SCOPED.map(r => ({ route: r.route, why: r.why })),
  });
});

/**
 * Fields the SERVER owns on a token record. A client that posts a token it read back — `id`, `hash`,
 * `prefix` — is round-tripping, not attacking, and being told "unknown key" for a field we ourselves emitted
 * would be a worse answer than ignoring it.
 *
 * Same shape as `SERVER_OWNED_META_FIELDS` in `api/spaces.ts`: strip exactly the server-owned set, then let
 * a STRICT schema refuse everything else. The two halves are the point — the strip keeps a round-trip
 * working, and the strictness is what stops `spaceIds` minting an unscoped token in silence.
 *
 * A red-team test (`mass-assignment.test.js`) pins the strip; `credential-bodies-are-strict.test.js` pins
 * the strictness. Neither is sufficient alone, which is exactly how the first attempt at this fix broke: it
 * added `.strict()` and turned the round-trip into a 400.
 */
// `rateLimitEffective` is DERIVED for the response (see `listTokens`) and is not a field anybody may set.
// It joins the strip list for exactly the reason the list exists: a client that reads a token back and posts
// it is round-tripping, and being told "unknown key" for a field we ourselves emitted is a worse answer than
// ignoring it. Without this the new field would 400 every round-trip — the defect this list was created for,
// reintroduced by the next response field somebody adds.
const SERVER_OWNED_TOKEN_FIELDS = ['id', 'hash', 'prefix', 'rateLimitEffective'] as const;

function stripServerOwnedToken(body: unknown): unknown {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) return body;
  const copy: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  for (const f of SERVER_OWNED_TOKEN_FIELDS) delete copy[f];
  return copy;
}

/**
 * The rights matrix, as either door accepts it. ONE declaration, used by the mint route and the edit
 * route — it was written out twice, identically, and `CLAUDE.md` names one rule with two
 * implementations as the defect this repo produces most.
 *
 * **`perSpace` IS CAPPED, and the cap is why this was extracted now.** The `spaces` array it replaces
 * carried `.max(1000)`. Removing that array in 4.0 (`D-5`) would have taken the size protection with it:
 * `z.record` accepts a hundred thousand keys as readily as one, and each is stored on the token record
 * and walked on every scope decision.
 *
 * The number is the one the array had, deliberately — this is the same limit expressed against the field
 * that now carries scope, not a new policy arriving under cover of a refactor.
 *
 * **The space id is `.min(1)` for the same reason.** `spaces` was `z.array(z.string().min(1))`, so an
 * empty id was refused; `z.record(z.string(), …)` accepts `''` as a key, which is a grant to a space that
 * cannot exist. Two protections were riding on the array's element schema and both would have been lost
 * silently by removing it.
 *
 * Both were found by red-team cases whose SUBJECT had moved out from under them — each asserts a 400,
 * and a removed field answers 400 too, so each would have gone on passing while the thing it guarded
 * disappeared. That is the shape to watch when a field is retired: a test on its validation keeps
 * passing on the refusal that replaced it.
 *
 * The array-bomb red-team case is what surfaced it, and it would have passed either way: it asserts a
 * `400` for 1001 spaces, and a removed field answers `400` too. A test that keeps passing while its
 * subject disappears is the reason that case now names the matrix.
 */
const MAX_SCOPED_SPACES = 1000;

/**
 * Areas added AFTER the matrix shipped — optional in a body, and `none` when absent.
 *
 * Every area the matrix shipped with is required: a partial matrix is a 400, the safe direction, and that is
 * unchanged. But an area added later cannot be required, or every client written before it breaks at once — zod 4
 * makes an enum-keyed record exhaustive, so when `networks` joined the areas (`F-34`) a four-area mint became a
 * 400 for every integrator. Absent reads as `none`, which grants nothing: the same safe direction as refusing,
 * without breaking a caller who never heard of the area. A future area goes on this list for the same reason.
 */
const AREAS_ADDED_LATER: readonly string[] = ['networks'];
const rung = z.enum(RUNGS);
const AreaRungsBody = z.object(
  // Built from SPACE_AREAS, so a new area is validated the moment it exists; the cast is only for the compiler,
  // which cannot see a record's keys through `fromEntries` — every value parses to a rung either way.
  Object.fromEntries(SPACE_AREAS.map(a => [a, AREAS_ADDED_LATER.includes(a) ? rung.default('none') : rung])) as unknown as
    Record<(typeof SPACE_AREAS)[number], typeof rung>,
)
  // Strict, so an area NAME the server does not know is still refused rather than stored and granting nothing.
  .strict();

const RightsMatrix = z.object({
  instanceAdmin: z.boolean(),
  createSpaces: z.boolean(),
  floor: AreaRungsBody.nullable(),
  perSpace: z.record(z.string().min(1), AreaRungsBody)
    .refine(m => Object.keys(m).length <= MAX_SCOPED_SPACES,
      { message: `perSpace may name at most ${MAX_SCOPED_SPACES} spaces` }),
  /*
   * The spaces this token administers — the rung an operator grants in ONE action.
   *
   * Optional, because every matrix minted before it existed is still valid and must stay valid; `.strict()`
   * below means an absent field is absent rather than silently dropped.
   *
   * Bounded by the same ceiling as `perSpace` and for the same reason: the array-bomb case. A cap on one
   * list and not the other is the cap written twice with one of them forgotten.
   */
  spaceAdmin: z.object({
    /** Administers every space, including ones created later — the floor form. */
    floor: z.boolean(),
    spaces: z.array(z.string().min(1)).max(MAX_SCOPED_SPACES,
      { message: `spaceAdmin.spaces may name at most ${MAX_SCOPED_SPACES} spaces` }),
  }).strict().optional(),
}).strict();
/**
 * `.strict()`, and it is the most important word in this file.
 *
 * Zod drops unknown keys by default, so `{ spaceIds: ['qa'] }` minted a token with NO `spaces` field and
 * returned 201. The caller is told the operation succeeded, their own notes say the token is scoped, and it
 * reaches every space on the instance. Nothing in the response, the record or the logs tells the two apart.
 *
 * Reported by an operator on 2026-08-09 who probed four plausible spellings — `allowedSpaces`, `scope`,
 * `spaceIds`, `denySpaces` — and got 201 from every one. They found it by reading the stored token back and
 * noticing four of five probes had no `spaces` at all. Their words: "somebody guessing the field name gets a
 * token that looks scoped, reports success, and is not scoped at all."
 *
 * A permissive body schema is a silent failure anywhere. On the endpoint that mints CREDENTIALS it hands out
 * access nobody intended and reports success while doing it.
 */
const CreateTokenBody = z.object({
  name: z.string().min(1).max(200),
  expiresAt: z.string().datetime().nullish(),
  /*
   * `spaces`, `admin` and `readOnly` ARE GONE FROM THIS SCHEMA (`D-5`). The per-space matrix has been
   * the permission model since 2.6 and `rights` expresses everything the three could — proven by the
   * code rather than asserted: `migrateToken` maps every legacy shape to a matrix and `grantsMoreThan`
   * holds that mapping to never widening.
   *
   * They survive as INPUTS to `createToken` itself, which is a different question: internal callers
   * (first-run setup, OIDC) still say "read-only" and let it build the matrix. What 4.0 removes is
   * the HTTP door accepting them, because that is the one an integrator writes against.
   */
  peerInstanceId: z.string().uuid().optional(),
  schemaLibrary: z.boolean().optional(),
  /**
   * This token's relationship to the second factor: `inherit` (default), `exempt`, or `required`.
   * See `TokenRecord.mfa` for why it is three states.
   */
  mfa: z.enum(['inherit', 'exempt', 'required']).optional(),
  /**
   * This token's own request quota, per minute. Absent = inherit the instance value.
   *
   * Deliberately NOT bounded here. The bounds and the instance ceiling live in
   * `rate-limit/per-token.ts` because the MCP tool enforces the same rule, and a `z.number().max(…)` in this
   * schema would be a second copy of a number infra owns — the one that goes stale when the env changes.
   * See `rateLimitRefusal`.
   */
  rateLimitPerMinute: z.number().int().optional(),
  /**
   * The per-space rights matrix for the new token.
   *
   * Mutually exclusive with `spaces` / `admin` / `readOnly` — see the refusal below. Accepting both would
   * put two descriptions of the same thing in one request, and the loser would be silent.
   */
  rights: RightsMatrix.optional(),
}).strict();

/**
 * Granting an MFA exemption always costs a live second factor.
 *
 * `requireAdminMfa` on this route is satisfied by an admin token that is ITSELF exempt — which is correct for
 * ordinary work and catastrophic here: one exemption could mint another, and another, until the instance-wide
 * switch protected nothing. Exemptions must not be able to widen themselves.
 *
 * So when the instance switch is on and the request is trying to create an exempt token, a valid TOTP code is
 * demanded on THIS request regardless of who is asking. An operator who holds the exempt automation token and
 * not the authenticator cannot escalate; the human who set it up can.
 */
function exemptionNeedsLiveCode(req: Request, res: Response, mfa: string | undefined): boolean {
  if (mfa !== 'exempt' || !isMfaEnabled()) return true;
  const code = (req.headers['x-totp-code'] as string | undefined ?? '').trim();
  if (!code || !verifyMfaCode(code)) {
    res.status(403).json({
      error: 'MFA_REQUIRED',
      message: 'Granting an MFA exemption requires a current TOTP code, even from a token that is itself exempt',
    });
    return false;
  }
  return true;
}

// GET /api/tokens — list tokens (hashes excluded) — admin only
tokensRouter.get('/', requireAdminOrSpaceAdmin, (req, res) => {
  // A space-restricted administrator sees only the tokens it could act on.
  //
  // It used to receive every token on the instance — names, prefixes, scopes and rights for spaces it cannot reach.
  // Nothing secret leaks (`listTokens()` omits the hash by its own type), but it is an inventory of the instance's
  // access, and the same token is now refused when it tries to EDIT any of those rows. A list that shows what you
  // cannot touch is an invitation to try.
  //
  // Unrestricted admins are unaffected. A `schemaLibrary` token has no space access, so it is inside every scope.
  //
  // Scope comes from `editorScopeFor`, which reads the RIGHTS MATRIX and nothing else — it answers `[]` for
  // a token with no matrix rather than falling back to anything. This line said *"and falls back to the
  // legacy allowlist"*, which was true until 4.0 removed the fallback and is now the opposite of what the
  // function does.
  //
  // Reading `spaces` directly here meant a token minted with a matrix and no allowlist — every token minted
  // since 2.6 — answered `undefined` and was treated as an unrestricted instance administrator.
  const callerSpaces = editorScopeFor(req.authToken);
  const all = listTokens().map(withReadOnlyAlias);
  const visible = callerSpaces
    // `editorScopeFor` rather than the raw allowlist: it is the same resolution the mint and edit guards
    // use, and reading `spaces` here would show a space-restricted admin every modern token as unrestricted
    // and therefore hide all of them.
    ? all.filter(t => t.schemaLibrary || ((editorScopeFor(t) ?? []).every(s => callerSpaces.includes(s))
      && editorScopeFor(t) !== undefined))
    : all;
  res.json({ tokens: visible });
});

// POST /api/tokens — create a new PAT — admin + MFA
// admin:true may only be set when the calling token is itself admin (enforced by requireAdminMfa above)
/**
 * The three inputs 4.0 removed, and what to send instead.
 *
 * `.strict()` alone would answer `Unrecognized key(s) in object: 'spaces'`, which tells a caller they
 * are wrong and not what to do — and this endpoint is the one an integrator meets first. Checked on the
 * RAW body before parsing, so the message names the field and its replacement.
 */
const REMOVED_MINT_OPTIONS: Record<string, string> = {
  spaces: 'use `rights.perSpace`, keyed by space id',
  admin: 'use `rights.instanceAdmin`',
  readOnly: 'use `rights.floor` with read rungs',
};

tokensRouter.post('/', authRateLimit, requireAdminOrSpaceAdminMfa, async (req, res) => {
  const removed = Object.keys(REMOVED_MINT_OPTIONS)
    .filter(k => (req.body as Record<string, unknown> | undefined)?.[k] !== undefined);
  if (removed.length > 0) {
    res.status(400).json({
      error: 'The legacy token options were removed in 4.0: '
        + removed.map(k => `\`${k}\` — ${REMOVED_MINT_OPTIONS[k]}`).join('; ') + '.',
      removed,
    });
    return;
  }
  const parsed = CreateTokenBody.safeParse(stripServerOwnedToken(req.body));
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { name, expiresAt, peerInstanceId, schemaLibrary, mfa, rights, rateLimitPerMinute } = parsed.data;

  /*
   * The both-descriptions refusal that stood here is GONE, and its absence is the point: there is only
   * one description of access on this route now. It refused a body carrying `rights` AND a legacy field,
   * because whichever lost would lose silently. `REMOVED_MINT_OPTIONS` above refuses the legacy fields
   * outright and earlier, so the ambiguity it guarded cannot be expressed.
   */

  // A token may never mint above itself. Enforced HERE and not only in the UI: the grid is one API call away
  // from being bypassed, and the API is exactly where a token would be used to widen itself.
  if (rights) {
    // OIDC records carry no `rights` — they are built per request and never pass through the config
    // backfill — so the minter's matrix is derived on the spot from the same legacy fields. Deriving is the
    // same answer, not a weaker one; treating a missing matrix as "unrestricted" would be the widening.
    const held = (req.authToken as { rights?: unknown } | undefined)?.rights;
    /*
     * NO TOKEN AT ALL REACHES NOTHING — `?? {}` was the wrong default and it failed OPEN.
     *
     * `migrateToken({})` returns a WRITE floor on every area of every space, including spaces created
     * later. That is correct for a real pre-3.0 token, where absence genuinely meant unrestricted, and it
     * is the widest possible answer to an input carrying no information. Used as the MINTER's ceiling, it
     * would let a request with no authenticated token mint an instance-wide write token.
     *
     * Not reachable today — this route sits behind auth, so `req.authToken` is set — which is exactly why
     * the `?? {}` was easy to write and would stay until something moved. Fixed HERE and not in
     * `migrateToken`, because that function's job is to read a legacy record faithfully: changing what it
     * answers for an empty one would change what a genuine old token gets on upgrade, and
     * `rights-reach-matches-legacy.test.js` holds it to the old semantics on purpose.
     */
    const minter = held ?? (req.authToken ? withInstanceAdminGrants(migrateToken(req.authToken)) : NO_RIGHTS);
    const excess = capRights(minter as never, rights as never);
    if (excess.length > 0) {
      res.status(403).json({
        error: `A token cannot mint rights it does not hold — ${describeExcess(excess)}`,
      });
      return;
    }
  }
  if (!exemptionNeedsLiveCode(req, res, mfa)) return;
  /*
   * The quota, checked with the SHARED refusal — the MCP tool calls the same function.
   *
   * `403` rather than `400` when it is the instance ceiling that refuses, matching what a pinned media-config
   * field answers: the request is well-formed and the caller is not allowed to ask for that number. A malformed
   * value is still a `400`. Never accepted-and-clamped: storing a smaller number than was asked for and
   * answering 201 is the defect this file's `.strict()` comment is about, one field over.
   */
  const quotaRefusal = rateLimitRefusal(rateLimitPerMinute);
  if (quotaRefusal) {
    res.status(quotaRefusal.includes('instance ceiling') ? 403 : 400).json({ error: quotaRefusal });
    return;
  }
  /*
   * `admin && readOnly` is gone with the inputs — a matrix cannot express the contradiction, so there
   * is nothing left to refuse.
   *
   * The schemaLibrary rule STAYS and is now asked of the matrix. A schema-library token has no space
   * access by definition, so a floor or any per-space grant contradicts it — the same statement the
   * old check made about `admin || spaces?.length`, read from the field that actually carries it.
   */
  if (schemaLibrary && rights
      && (rights.instanceAdmin || rights.floor || Object.keys(rights.perSpace ?? {}).length > 0)) {
    res.status(400).json({ error: 'A schemaLibrary token cannot have admin or space access' });
    return;
  }

  /*
   * Privilege-escalation guard: a space-restricted creator may only mint tokens confined to a SUBSET of
   * its own spaces.
   *
   * **THE SHARED FUNCTION, WHICH IT WAS NOT BEFORE.** The PATCH route's comment already said *"Same
   * rule the MINT route applies to a space-restricted creator, expressed once in
   * `refusalsOutsideEditorScope` so the two cannot drift"* — and this route ran its own inline check
   * instead. They had already drifted, and on the axis that matters: the copy here asked `!spaces`,
   * the deprecated allowlist, while the shared one reads the matrix.
   *
   * That was not only untidy. The token-create form in this product stopped sending `spaces` some
   * releases ago and mints with `rights` only — so `!spaces` was TRUE for every request the UI makes,
   * and a space-restricted administrator could not mint any token at all, refused with a message about
   * an unrestricted request that was not unrestricted. An unrestricted admin never saw it, because
   * `editorScopeFor` answers `undefined` for them and the block was skipped entirely — so the people
   * most likely to exercise the form are exactly the ones the defect could not reach.
   */
  const scopeRefusals = refusalsOutsideEditorScope({
    editorSpaces: editorScopeFor(req.authToken),
    target: { schemaLibrary, rights: (rights ?? null) as never },
    rights: rights as never,
  });
  if (scopeRefusals.length > 0) {
    res.status(403).json({
      error: `A space-restricted administrator cannot mint this token — ${scopeRefusals.join('; ')}.`,
      refusals: scopeRefusals,
    });
    return;
  }

  /*
   * `schemaLibrary` still implies read-only and no space access, and it is the one place this route
   * still speaks the shorthand — deliberately. It is not caller input here: it is derived from the
   * `schemaLibrary` flag, so there is no legacy option for an integrator to send.
   */
  const { record, plaintext } = await createToken({
    name,
    expiresAt: expiresAt ?? null,
    ...(schemaLibrary ? { spaces: [], readOnly: true } : {}),
    peerInstanceId,
    schemaLibrary,
    mfa,
    rights: rights as never,
    rateLimitPerMinute,
  });
  // Return plaintext only on creation — never retrievable again
  const { hash: _h, ...safeRecord } = record;
  res.status(201).json({ token: withReadOnlyAlias(safeRecord), plaintext });
});

/**
 * Fields `GET /api/tokens` emits that `PATCH` does not edit — and the remedy for each, where one exists.
 *
 * ## Why this list exists at all
 *
 * A reporter round-tripped a token — GET it, change the name, PATCH it back — and got
 * `Unrecognized key(s) in object: 'spaces'`. Their words: *"the shape you read is not the shape you may
 * write, and nothing says which fields are which."* The response carries twelve fields; PATCH accepted two.
 *
 * ## Why neither obvious fix is right
 *
 * **Stripping them** (the `SERVER_OWNED_TOKEN_FIELDS` treatment) recreates a bug this route already fixed:
 * a body carrying `spaces` or `admin` beside the name was dropped and answered **200**, so an attempt to
 * widen a token through the legacy field looked exactly like one that had worked.
 *
 * **Rejecting them** is what produced the report.
 *
 * So the rule distinguishes an ECHO from a CHANGE, which is the distinction both of those answers lose:
 * the same value back is a round-trip and is ignored; a different value is a refusal that names the field
 * to use instead. `spaces`/`admin`/`readOnly` have a real remedy in the rights matrix and say so — the rest
 * are set at mint and cannot be edited on any route, which the message states rather than implying.
 */
export const ECHOABLE: Record<string, string | null> = {
  spaces: 'set `rights.perSpace` (or `rights.floor` for every space)',

  admin: 'set `rights.instanceAdmin`',
  readOnly: 'set the area rungs in `rights` to `read`',
  createdAt: null,
  lastUsed: null,
  expiresAt: null,
  peerInstanceId: null,
  schemaLibrary: null,
  oauthClientId: null,
};

const ECHOABLE_FIELDS = Object.keys(ECHOABLE);

/**
 * Is this the value already stored, or an attempted change?
 *
 * `spaces` is compared as a SET, because a round-trip may reorder it and an allowlist has no order — but
 * `undefined` is only ever equal to `undefined`. Absent means "all spaces" and `[]` means "no spaces", the
 * conflation this repo has now fixed in four separate files, and it must not come back inside an equality
 * check where reading them as the same would let a token be widened to the whole instance in silence.
 */
export function isEcho(field: string, sent: unknown, stored: unknown): boolean {
  if (field === 'spaces') {
    if (sent === undefined || stored === undefined) return sent === stored;
    if (!Array.isArray(sent) || !Array.isArray(stored) || sent.length !== stored.length) return false;
    return [...sent].sort().join(' ') === [...stored].sort().join(' ');
  }
  // `admin: false` and an absent `admin` are the same token. Only the booleans get this reading.
  if (typeof stored === 'boolean' || typeof sent === 'boolean') return !!sent === !!stored;
  return JSON.stringify(sent ?? null) === JSON.stringify(stored ?? null);
}

const RenameTokenBody = z.object({
  // Same bound as create's `name`, so a label can't be edited to something the create flow would reject.
  name: z.string().min(1).max(200).optional(),
  // `.strict()` for the same reason as create, and here the edge is sharper: this route once accepted a
  // rename ONLY. A body carrying `spaces` or `admin` beside the name was dropped and answered 200, so an
  // attempt to widen a token through it looked exactly like one that had worked.
  //
  // `rights` is now a legitimate field, and `name` is optional so an edit can change either or both. The
  // refine below keeps an empty body from being a silent no-op reported as success.
  rights: RightsMatrix.optional(),
  /**
   * This token's relationship to the second factor — editable HERE and nowhere else.
   *
   * It used to be settable only while minting, which put the decision before there was a token to decide it
   * about: an operator who wanted their scheduler exempt had to revoke it and mint a replacement, rotating a
   * secret to change a flag. It is a property of the token, so it is set on the token.
   *
   * Granting `exempt` costs a live TOTP code on THIS request when the instance switch is on — the same rule
   * create has, applied here for the same reason. `requireAdminMfa` is satisfied by an admin token that is
   * itself exempt, so without it one exemption could grant another by the shorter route, and editing yourself
   * is shorter still than minting.
   */
  mfa: z.enum(['inherit', 'exempt', 'required']).optional(),
  /**
   * This token's own request quota, per minute. Absent = inherit the instance value.
   *
   * Deliberately NOT bounded here. The bounds and the instance ceiling live in
   * `rate-limit/per-token.ts` because the MCP tool enforces the same rule, and a `z.number().max(…)` in this
   * schema would be a second copy of a number infra owns — the one that goes stale when the env changes.
   * See `rateLimitRefusal`.
   */
  rateLimitPerMinute: z.number().int().optional(),
  // ── The rest of the record, accepted ONLY unchanged ──────────────────────────────────────────────
  //
  // These are declared so that echoing back a token you just read does not 400 on the first field the
  // schema had never heard of. They are NOT editable here; the handler compares each one it was sent
  // against what is stored, and a DIFFERENT value is a 400 that names what to write instead. See
  // `ECHOABLE` below for why "ignore it" and "reject it" are both wrong answers on their own.
  ...Object.fromEntries(ECHOABLE_FIELDS.map(f => [f, z.unknown()])),
}).strict();

// PATCH /api/tokens/:id — rename a token's label (only) — admin + MFA
tokensRouter.patch('/:id', requireAdminOrSpaceAdminMfa, (req, res) => {
  const parsed = RenameTokenBody.safeParse(stripServerOwnedToken(req.body));
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const id = req.params['id'] as string;
  const { name, rights, mfa, rateLimitPerMinute } = parsed.data;
  const previous = listTokens().find(t => t.id === id);
  if (!previous) {
    res.status(404).json({ error: 'Token not found' });
    return;
  }

  // A SPACE-RESTRICTED administrator may only touch its own spaces' rows.
  //
  // `requireAdminMfa` admits a space-restricted admin, because it carries `admin: true` — so before this guard existed,
  // such a token could rename any token on the instance and write `rights.instanceAdmin` onto it. Measured, not
  // supposed: both answered 200 and the rights were stored. They were inert only because the admin routes still gate on
  // the legacy `admin` flag rather than on `rights`.
  //
  // Same rule the MINT route applies to a space-restricted creator, expressed once in `refusalsOutsideEditorScope` so
  // the two cannot drift into disagreeing about what "outside your scope" means.
  const scopeRefusals = refusalsOutsideEditorScope({
    editorSpaces: editorScopeFor(req.authToken),
    target: previous,
    rights: rights as never,
  });
  if (scopeRefusals.length > 0) {
    res.status(403).json({
      error: `A space-restricted administrator cannot make this edit — ${scopeRefusals.join('; ')}.`,
      refusals: scopeRefusals,
    });
    return;
  }

  // An echoed field is a round-trip and is ignored; a CHANGED one is refused by name. Presence is read off
  // the raw body rather than the parsed data, because `z.unknown()` cannot distinguish an absent key from
  // one explicitly set to `undefined` — and "absent" vs "present and null" is the whole question here.
  const sentBody = (stripServerOwnedToken(req.body) ?? {}) as Record<string, unknown>;
  const stored = previous as unknown as Record<string, unknown>;
  const attempted = ECHOABLE_FIELDS
    .filter(f => Object.prototype.hasOwnProperty.call(sentBody, f))
    .filter(f => !isEcho(f, sentBody[f], stored[f]));
  if (attempted.length > 0) {
    res.status(400).json({
      error: `Cannot change ${attempted.map(f => `\`${f}\``).join(', ')} on this route. `
        + attempted.map(f => ECHOABLE[f] ? `For \`${f}\`, ${ECHOABLE[f]}.` : `\`${f}\` is set when the token is minted.`).join(' ')
        + ' Sending these fields UNCHANGED is fine — a token you read back round-trips.',
    });
    return;
  }

  // Checked after the above so a body that only echoes the record gets the "nothing to change" answer
  // rather than a bare unknown-key refusal. It was a `.refine()` until the echo fields existed; a schema
  // cannot see the stored record, so it could not tell an echo from an edit.
  if (name === undefined && rights === undefined && mfa === undefined) {
    res.status(400).json({ error: 'Provide `name`, `rights`, `mfa`, or any combination' });
    return;
  }

  // The same live-code rule create has. `requireAdminMfa` is satisfied by an admin token that is itself
  // exempt, so without this one exemption could grant another — and editing yourself is a shorter route to
  // that than minting a replacement. Checked before anything is written, so a refused exemption leaves the
  // token exactly as it was rather than renamed-but-not-exempted.
  if (!exemptionNeedsLiveCode(req, res, mfa)) return;

  if (rights) {
    // A token may never GRANT above itself, edit or mint. Same rule, same function — a second
    // implementation here is how the two would come to disagree about what "above" means.
    // Same rule and the same fail-closed default as the mint route above — see the note there for why the
    // fix is at the call site rather than in `migrateToken`.
    const editorRights = (req.authToken as { rights?: unknown } | undefined)?.rights
      ?? (req.authToken ? withInstanceAdminGrants(migrateToken(req.authToken)) : NO_RIGHTS);
    const excess = capRights(editorRights as never, rights as never);
    if (excess.length > 0) {
      res.status(403).json({ error: `A token cannot grant rights it does not hold — ${describeExcess(excess)}` });
      return;
    }

    // And it may never raise its OWN floor. The mint cap stops handing more to a NEW token; without this
    // the same escalation is available by a shorter route — edit yourself, then use yourself — and nothing
    // about the result looks unusual afterwards.
    const raised = refuseSelfFloorRaise(
      (req.authToken as { id?: string } | undefined)?.id,
      editorRights as never,
      id,
      rights as never,
    );
    if (raised.length > 0) {
      res.status(403).json({
        error: `A token cannot raise its own floor — ${raised.join(', ')}. Ask another administrator.`,
      });
      return;
    }
  }

  // `mfa` is in the snapshot on both sides because an exemption is the most security-relevant thing this
  // route can change, and a diff that omitted it would record the rename beside it and not the exemption.
  // `previous.mfa` is absent on every token that follows the instance switch, which reads as `inherit`.
  req.auditSnapshots = {
    before: { name: previous.name, rights: previous.rights, mfa: previous.mfa ?? 'inherit' },
    after: {
      name: name?.trim() ?? previous.name,
      // What `setTokenRights` STORES, grant applied, not what was sent: an audit entry for a token made instance
      // admin must show the space-admin floor it now holds.
      rights: rights ? withInstanceAdminGrants(rights as never) : previous.rights,
      mfa: mfa ?? previous.mfa ?? 'inherit',
    },
  };

  if (name !== undefined && !renameToken(id, name.trim())) {
    res.status(404).json({ error: 'Token not found' });
    return;
  }
  if (rights && !setTokenRights(id, rights as never)) {
    res.status(404).json({ error: 'Token not found' });
    return;
  }
  if (mfa !== undefined && !setTokenMfa(id, mfa)) {
    res.status(404).json({ error: 'Token not found' });
    return;
  }
  /*
   * Same shared refusal as the create path, and the same status split: `403` when the instance ceiling is
   * what refuses, `400` when the value itself is malformed. One function, two surfaces, one answer.
   */
  if (rateLimitPerMinute !== undefined) {
    const refusal = rateLimitRefusal(rateLimitPerMinute);
    if (refusal) {
      res.status(refusal.includes('instance ceiling') ? 403 : 400).json({ error: refusal });
      return;
    }
    if (!setTokenRateLimit(id, rateLimitPerMinute)) {
      res.status(404).json({ error: 'Token not found' });
      return;
    }
  }

  const updated = listTokens().find(t => t.id === id);
  res.json({ token: updated ? withReadOnlyAlias(updated) : updated });
});

// POST /api/tokens/:id/regenerate — rotate a token's secret — admin + MFA
/**
 * POST /api/tokens/:id/regenerate — rotate a token's secret.
 *
 * ## It did not narrow by editor scope either, and the gate is what found that
 *
 * The DELETE route below was the reported one. `token-routes-narrow-by-one-rule.test.js` asserts the PROPERTY
 * — every route a space-restricted administrator can reach resolves its scope — rather than naming the route
 * somebody complained about, and it immediately flagged this one too.
 *
 * Rotation is as destructive as revocation and quieter about it: the old secret stops working instantly, and
 * the only party who learns the new one is the caller. So an administrator of one space could invalidate any
 * credential on the instance, for spaces it cannot see, and walk away holding the replacement.
 *
 * That is the argument for gating the set instead of the instance. A test naming DELETE would have passed here
 * for as long as this route has existed.
 *
 * The 404 stays where it is on purpose: the scope refusal has to come FIRST, or a caller learns whether an id
 * it may not touch exists.
 */
tokensRouter.post('/:id/regenerate', authRateLimit, requireAdminOrSpaceAdminMfa, async (req, res) => {
  const id = req.params['id'] as string;
  const target = listTokens().find(t => t.id === id);
  if (!target) {
    res.status(404).json({ error: 'Token not found' });
    return;
  }

  // The shared rule, same call as PATCH and DELETE. `rights: undefined` because a rotation changes no rights,
  // so only the guard's TARGET half applies.
  const scopeRefusals = refusalsOutsideEditorScope({
    editorSpaces: editorScopeFor(req.authToken),
    target,
    rights: undefined,
  });
  if (scopeRefusals.length > 0) {
    res.status(403).json({
      error: `A space-restricted administrator cannot rotate this token — ${scopeRefusals.join('; ')}.`,
      refusals: scopeRefusals,
    });
    return;
  }

  const plaintext = await regenerateToken(id);
  if (!plaintext) {
    // Reachable only if the token was deleted between the read above and this write.
    res.status(404).json({ error: 'Token not found' });
    return;
  }
  res.json({ plaintext });
});

// DELETE /api/tokens/:id — revoke a token — admin + MFA
/**
 * DELETE /api/tokens/:id — revoke a token.
 *
 * ## Two things this route was missing, both found while investigating a revoke failure
 *
 * The canary operator reported a failed revoke on 2026-08-20 and were careful to say they had not read the
 * status code and would not guess it. Neither defect below is provably their cause — see the board reply — but
 * both are real and one is a privilege gap.
 *
 * **1. It did not narrow by editor scope, and the other three token routes do.** `requireAdminOrSpaceAdminMfa`
 * admits a space-restricted administrator. The LIST route filters by `editorScopeFor`, the MINT route refuses
 * out-of-scope grants, and PATCH runs `refusalsOutsideEditorScope` — with a comment recording that without it
 * "such a token could rename any token on the instance and write `rights.instanceAdmin` onto it". This route
 * resolved no scope at all, so an administrator of one space could revoke ANY token on the instance,
 * instance-admin tokens included. Revoking is strictly more destructive than renaming.
 *
 * One rule, four implementations, and the missing one on the most destructive verb. `refusalsOutsideEditorScope`
 * is called here rather than reimplemented, so the four cannot drift about what "outside your scope" means.
 *
 * `rights: undefined` is passed deliberately: a revoke changes no rights, so only the guard's TARGET half
 * applies. The guard is built for that — it returns early with just the target refusals.
 *
 * **2. It discarded `revokeToken`'s return value and always answered 204.** That boolean is the only report of
 * whether anything was actually removed; `revokeToken` filters `config.tokens` by id and returns false when the
 * filter matched nothing. Answering 204 to a revoke that removed nothing is the
 * "assert on the identity the operation returns" failure this codebase keeps paying for — a caller is told the
 * credential is gone while it still authenticates.
 *
 * It also means this handler cannot be the source of a *failure* on a token it found, which is evidence about
 * the report rather than about the code: whatever they hit came from the guard or from before the handler.
 */
tokensRouter.delete('/:id', requireAdminOrSpaceAdminMfa, async (req, res) => {
  const id = req.params['id'] as string;
  const all = listTokens();
  const target = all.find(t => t.id === id);
  if (!target) {
    res.status(404).json({ error: 'Token not found' });
    return;
  }

  // The same guard PATCH and the mint route use, on the verb that needed it most. See the note above.
  const scopeRefusals = refusalsOutsideEditorScope({
    editorSpaces: editorScopeFor(req.authToken),
    target,
    rights: undefined,
  });
  if (scopeRefusals.length > 0) {
    res.status(403).json({
      error: `A space-restricted administrator cannot revoke this token — ${scopeRefusals.join('; ')}.`,
      refusals: scopeRefusals,
    });
    return;
  }

  // Prevent locking out all admin access
  if (isInstanceAdmin(target) && all.filter(t => isInstanceAdmin(t)).length === 1) {
    res.status(409).json({ error: 'Cannot revoke the last admin token' });
    return;
  }

  // The boolean is the only report of whether anything was removed. Discarding it answered 204 for a revoke
  // that deleted nothing — the caller believing a live credential is gone.
  const removed = await revokeToken(id);
  if (!removed) {
    /*
     * This branch is the one the canary operator hit on 2026-08-29, and it wrote NOTHING to the log — which is
     * why they spent ten days and a morning reasoning from three unrelated OIDC warnings that happened to share
     * the second. A deliberate 500 that leaves no trace is indistinguishable from a crash, from a proxy fault,
     * and from an expired session; they picked the third and were wrong, on the only evidence available.
     *
     * There is no `catch` here because nothing threw: `listTokens()` found the id and `revokeToken` then failed
     * to filter it out, which means the two disagreed about `config.tokens` between one statement and the next.
     * That is worth a line at ERROR even though it should be unreachable — an unreachable branch that fires is
     * exactly the report you want, and the id is what makes it actionable.
     */
    reportServerFailure(`revoke token ${id}`, new Error(
      'listTokens() returned the token but revokeToken() removed nothing — the config list and the stored '
      + 'config disagree',
    ));
    res.status(500).json({
      error: `Token '${id}' was listed but could not be removed. It is still valid. This is a server-side `
        + 'inconsistency between the token list and the stored config, not something to retry.',
    });
    return;
  }
  res.status(204).end();
});


