/**
 * A rate limit an admin sets per token, under a ceiling infra sets instance-wide.
 *
 * Owner request 2026-08-20, in two parts: *"ratelimit should be settable on token by instance admin"* and *"and
 * instancewide by infra"*.
 *
 * ## What is worth testing, and what is a Docker suite's job
 *
 * Not "does a 429 arrive after N requests" — that needs a running instance and belongs in the integration
 * suite. What is cheap and exact here is the part that decides WHICH number applies, and the part that decides
 * whether a write is allowed to set it. Both are pure, and both have a wrong answer that is silent:
 *
 *  - a resolution that reads the wrong tier gives a token a quota nobody granted;
 *  - a refusal that clamps instead of refusing tells an admin their number was accepted when a smaller one was
 *    stored, which is the defect `api/tokens.ts` already carries a long comment about one field over.
 *
 * ## And the structural half, which is the part that rots
 *
 * The quota is metered in `attachToken`, the one function every auth entry point calls. That is deliberate:
 * there are nine such entry points and wiring the limiter at any subset leaves the rest uncounted. So this file
 * asserts that arrangement directly — a tenth auth path added without metering is exactly the regression that
 * would produce a quota with a hole in it and no failing test.
 *
 * Run: node --test testing/standalone/per-token-rate-limit.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf, balancedFrom } from './_structural-window.mjs';

let resolveLimitFor, rateLimitRefusal, instanceCeiling, DEFAULT_PER_MINUTE, MAX_PER_MINUTE;

const ENV = 'YTHRIL_RATE_LIMIT_PER_MINUTE';
const original = process.env[ENV];

before(async () => {
  ({ resolveLimitFor, rateLimitRefusal, instanceCeiling, DEFAULT_PER_MINUTE, MAX_PER_MINUTE } =
    await import('../../server/dist/rate-limit/per-token.js'));
});

beforeEach(() => { delete process.env[ENV]; });
after(() => { if (original === undefined) delete process.env[ENV]; else process.env[ENV] = original; });

describe('which number applies', () => {
  it('nothing configured anywhere: the number the global limiter has always used', () => {
    // The point of this default. A deployment that sets neither tier must behave exactly as it does today —
    // a lower number here would silently tighten every existing instance on upgrade.
    assert.equal(resolveLimitFor(undefined), 300);
    assert.equal(resolveLimitFor({}), 300);
    assert.equal(DEFAULT_PER_MINUTE, 300);
  });

  it('infra sets it: every token inherits that', () => {
    process.env[ENV] = '50';
    assert.equal(instanceCeiling(), 50);
    assert.equal(resolveLimitFor({}), 50);
  });

  it('the token wins over infra — that is what "settable per token" means', () => {
    process.env[ENV] = '50';
    assert.equal(resolveLimitFor({ rateLimitPerMinute: 20 }), 20);
  });

  it('absence on the token means INHERIT, not unlimited', () => {
    /*
     * The distinction the whole design rests on. If absence meant unlimited, every token minted before this
     * feature would become unthrottled on upgrade — a change nobody asked for, applied to every existing
     * deployment, and invisible until something floods.
     */
    process.env[ENV] = '50';
    for (const shape of [{}, { rateLimitPerMinute: undefined }, undefined]) {
      assert.equal(resolveLimitFor(shape), 50, `${JSON.stringify(shape)} must inherit, not escape`);
    }
  });

  it('a stored value that is not a usable number falls back rather than throwing', () => {
    // A hand-edited config is a real input. `max: NaN` in express-rate-limit rejects EVERY request, so the
    // failure mode of trusting it is an instance that serves nothing.
    process.env[ENV] = '50';
    for (const bad of [0, -1, NaN, Infinity, 'many', null]) {
      assert.equal(resolveLimitFor({ rateLimitPerMinute: bad }), 50, `${String(bad)} must not be honoured`);
    }
  });

  it('an unusable ENV value falls back to the default rather than to NaN', () => {
    // `envIntOpt` returns undefined for anything it cannot parse, and the boot check reports it separately.
    process.env[ENV] = 'three hundred';
    assert.equal(instanceCeiling(), undefined);
    assert.equal(resolveLimitFor({}), 300);
  });
});

describe('what an admin may set', () => {
  it('absent is always fine — it is the default state', () => {
    assert.equal(rateLimitRefusal(undefined), null);
    assert.equal(rateLimitRefusal(null), null);
  });

  it('a sane number with no ceiling set is accepted', () => {
    assert.equal(rateLimitRefusal(1), null);
    assert.equal(rateLimitRefusal(10_000), null);
  });

  it('a non-integer or out-of-range value is refused, and says which', () => {
    for (const bad of [1.5, '100', {}, true]) {
      assert.match(String(rateLimitRefusal(bad)), /whole number/, `${JSON.stringify(bad)} was accepted`);
    }
    assert.match(String(rateLimitRefusal(0)), /between/);
    assert.match(String(rateLimitRefusal(MAX_PER_MINUTE + 1)), /between/);
  });

  it('THE POINT: above the infra ceiling is REFUSED, not clamped', () => {
    /*
     * If the infra value were only a default, an admin could set a per-token value above it and infra's
     * control would be decorative. And it must REFUSE rather than store a smaller number: accepting 500,
     * storing 50 and answering 201 tells the admin their quota is 500 when it is not — the same defect the
     * `.strict()` comment in `api/tokens.ts` exists for, one field over.
     */
    process.env[ENV] = '50';
    const refusal = rateLimitRefusal(500);
    assert.ok(refusal, 'a value above the ceiling must be refused');
    assert.match(refusal, /exceeds the instance ceiling of 50/, 'the refusal must NAME the ceiling');
    assert.match(refusal, new RegExp(ENV), 'and name the env var, so the reader knows who owns it');
    assert.match(refusal, /refused rather than silently reduced/, 'and say it was not clamped');
  });

  it('at the ceiling exactly is fine — the bound is inclusive', () => {
    process.env[ENV] = '50';
    assert.equal(rateLimitRefusal(50), null);
  });

  it('and with no ceiling set, a large value is not refused for that reason', () => {
    // Infra not having an opinion is not the same as infra saying no.
    assert.equal(rateLimitRefusal(100_000), null);
  });
});

describe('the metering cannot be forgotten on a new auth path', () => {
  const mw = stripComments(readFileSync('server/src/auth/middleware.ts', 'utf8'));

  it('attachToken is what meters, so attaching without metering is not expressible', () => {
    /*
     * There are nine auth entry points. Wiring the limiter at a subset of them leaves the rest uncounted, and
     * a quota with a hole in it is not a quota — so the function that ATTACHES a token is the function that
     * METERS it, and it consumes `next` so a caller has no `next()` left to reach around it.
     */
    const fn = bodyOf(mw, 'attachToken');
    assert.match(fn, /tokenRateLimit\(req, res, next\)/,
      'attachToken must meter — otherwise each auth path has to remember, and the tenth will not');
    assert.match(fn, /next: NextFunction/, 'and it must take next, so proceeding REQUIRES going through it');
  });

  it('no auth path calls next() beside an attach — that would bypass the meter', () => {
    /*
     * The regression this forbids: someone restores the old two-line shape, `attachToken(...)` followed by
     * `next()`. The token is attached, the request proceeds, and it is counted against nothing.
     */
    /*
     * Counted, not windowed. My first version excluded the DECLARATION — whose parameter list is typed rather
     * than a call's bare arguments — with `slice(Math.max(0, i - 12), i)`, which is a backwards magic window
     * and is refused by `gates-bound-their-subject-structurally.test.js`. Two counts say the same thing with no
     * bound at all: every occurrence except the declaration must hand over `res` and `next`.
     */
    const total = [...mw.matchAll(/attachToken\(/g)].length;
    const metered = [...mw.matchAll(/attachToken\(req, res, next,/g)].length;
    assert.ok(total >= 9, `expected the declaration plus the auth paths, found ${total} occurrences`);
    assert.equal(metered, total - 1,
      `${total - 1 - metered} attachToken call(s) do not hand over res and next, so those requests are attached `
      + 'to a token and counted against nothing');
    assert.doesNotMatch(mw, /attachToken\([^)]*\);\s*next\(\);/,
      'an auth path attaches a token and then calls next() itself, so that request is never metered');
  });

  it('it keys on the token ID, not the credential hash', () => {
    const rl = stripComments(readFileSync('server/src/rate-limit/middleware.ts', 'utf8'));
    const limiter = balancedFrom(rl, rl.indexOf('export const tokenRateLimit'), 'tokenRateLimit');
    assert.match(limiter, /t:\$\{token\.id\}/,
      'a rotated token is a new credential and the same grant — keying on the hash would hand every rotation '
      + 'a fresh bucket, which turns a quota into an inconvenience');
  });

  it('the pre-auth limiter is untouched and still keyed the old way', () => {
    // It has to be: it throttles requests carrying no valid credential, which is the only thing standing in
    // front of admin TOTP. This change must not have made it token-aware.
    const rl = stripComments(readFileSync('server/src/rate-limit/middleware.ts', 'utf8'));
    const global = balancedFrom(rl, rl.indexOf('export const globalRateLimit'), 'globalRateLimit');
    assert.match(global, /keyGenerator: clientRateLimitKey/, 'the pre-auth limiter must still key on the client');
    assert.doesNotMatch(global, /authToken/, 'it runs before auth — it cannot read a resolved token');
  });
});

describe('one rule, both write paths, and the read surface agrees', () => {
  const routes = stripComments(readFileSync('server/src/api/tokens.ts', 'utf8'));

  it('create and PATCH both use the SHARED refusal', () => {
    // Two copies of "what is an acceptable quota" is the defect the y-flows convention `convention-find-every-instance` names, and here the
    // weaker copy would be handing out quota nobody granted.
    assert.equal([...routes.matchAll(/rateLimitRefusal\(/g)].length, 2,
      'both write paths must consult the shared refusal — no more, no fewer');
    assert.doesNotMatch(routes, /instanceCeiling\(\)/,
      'the route must not read the ceiling itself; that is a second copy of a rule infra owns');
  });

  it('the body schema does not restate the bounds', () => {
    // A `z.number().max(…)` here would be a second copy of a number infra owns — and the one that goes stale
    // the moment the env changes, since a schema is built at import.
    assert.doesNotMatch(routes, /rateLimitPerMinute: z\.number\(\)\.int\(\)\.(min|max)\(/,
      'the bounds belong to rate-limit/per-token.ts, not to the request schema');
  });

  it('the effective limit is derived where BOTH doors read it', () => {
    /*
     * `listTokens` is what the REST list and the MCP `list_tokens` tool both call. Deriving the effective
     * number at one door would give the two doors different answers to the same question.
     */
    const tokens = stripComments(readFileSync('server/src/auth/tokens.ts', 'utf8'));
    assert.match(bodyOf(tokens, 'listTokens'), /rateLimitEffective: resolveLimitFor\(/,
      'the resolved limit must ride along from listTokens, so both surfaces answer alike');
  });

  it('the MCP tool description explains which of the two fields to read', () => {
    // A schema description is authoritative reference — `help()` says so — and "absent means inherit" is
    // exactly the kind of thing a caller gets wrong by guessing.
    const mcp = readFileSync('server/src/mcp/tools/spaces.ts', 'utf8');
    assert.match(mcp, /rateLimitEffective/, 'the tool must name the derived field');
    assert.match(mcp, /absent means "inherit the instance value"/,
      'and say what absence means, because absent-versus-unlimited is the reading that goes wrong');
  });

  it('the env var is registered so a typo stops the boot', () => {
    // `max: NaN` in express-rate-limit rejects every request. An instance that serves nothing because somebody
    // wrote `3OO` must fail loudly at startup, not silently at the first request.
    const env = readFileSync('server/src/config/env-num.ts', 'utf8');
    assert.match(env, new RegExp(`name: '${ENV}'`), 'the quota env var must be in NUMERIC_SETTINGS');
  });

  it('a cleared quota is expressible — null means inherit again', () => {
    const tokens = stripComments(readFileSync('server/src/auth/tokens.ts', 'utf8'));
    assert.match(bodyOf(tokens, 'setTokenRateLimit'), /if \(perMinute === null\) delete/,
      'there must be a way back to inheriting, or a quota set once can never be unset');
  });
});
