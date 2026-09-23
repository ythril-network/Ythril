/**
 * An unacknowledged face endpoint is STORED and UNUSED — it no longer refuses unrelated writes.
 *
 * ## The change, and the property that must survive it
 *
 * The canary operator, 2026-08-20T1155Z §5, arguing for a principle rather than reporting a bug:
 * *"the acknowledgement should gate USE of the endpoint, not VALIDITY of the config."*
 *
 * The write-time gate keyed off the endpoint EXISTING (`if (effBaseUrl)`), resolved from patch-or-stored. So
 * once an endpoint was stored unacknowledged, every subsequent patch to the route was refused whatever it
 * touched — their owner met it raising an image level, which has nothing to do with face egress.
 *
 * **The property that must not move: no face crop is ever sent to an unacknowledged host.** That is what makes
 * this change safe rather than a relaxation, and it is why this file asserts the SEND SITE first and the route
 * second. If the send-site check ever goes, the write-time gate is no longer there to catch it.
 *
 * It was already enforced there and always has been — `detectFacesExternal` returns null unless
 * `egressConsented` matches, and its own comment says why: *"a config edited on disk (bypassing the API)
 * still cannot silently egress biometric data."* So the write-time refusal protected nothing the use-time one
 * does not. That is the finding, and it is what turned their principle from defensible into obvious.
 *
 * ## What is still refused
 *
 * A patch that TOUCHES `externalModel` without a matching acknowledgement — the moment the operator is present
 * and deciding. They asked us not to weaken that and were right to: it caught a real mistake of theirs within
 * minutes, and it names the exact host:port.
 *
 * Run: node --test testing/standalone/face-egress-consent-gates-use-not-validity.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { blockAfter, statementFrom } from './_structural-window.mjs';

const strip = (t) => t.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const API = strip(readFileSync('server/src/api/media-config.ts', 'utf8'));
// The refusal helper itself moved to the shared consent module (F-31), where the decision slot reuses it.
const HELPER = strip(readFileSync('server/src/config/egress-consent.ts', 'utf8'));
const EXT = strip(readFileSync('server/src/files/media/face-external.ts', 'utf8'));

let egressConsented, detectFacesExternal;
before(async () => {
  ({ detectFacesExternal } = await import('../../server/dist/files/media/face-external.js'));
  // The rule is shared by every egressing slot since F-31 (`config/egress-consent.ts`); the face model is one.
  ({ egressConsented } = await import('../../server/dist/config/egress-consent.js'));
});

describe('THE PROPERTY: no crop is sent to an unacknowledged host', () => {
  it('consent requires the acknowledged host to MATCH the host it would send to', () => {
    // Exercised, not read. An acknowledgement for a different host is the interesting case: it is what an
    // operator produces by acknowledging once and then repointing the endpoint.
    assert.equal(egressConsented({ baseUrl: 'https://faces.example.com/embed', acknowledgedHost: 'faces.example.com' }), true);
    assert.equal(egressConsented({ baseUrl: 'https://faces.example.com/embed', acknowledgedHost: 'other.example.com' }), false,
      'an acknowledgement for another host must not carry over when the endpoint is repointed');
    assert.equal(egressConsented({ baseUrl: 'https://faces.example.com/embed' }), false,
      'no acknowledgement at all is not consent');
    assert.equal(egressConsented({ acknowledgedHost: 'faces.example.com' }), false,
      'an acknowledgement with no endpoint is not a usable endpoint');
    assert.equal(egressConsented(undefined), false);
  });

  it('a port is part of the host, so acknowledging the bare name is not consent', () => {
    // Their own first mistake, and the error message is what corrected them: they wrote the acknowledgement as
    // a bare host copying the assist model's shape. The rule must stay strict about it.
    assert.equal(egressConsented({ baseUrl: 'http://face-embed.svc:3120/embed', acknowledgedHost: 'face-embed.svc' }), false);
    assert.equal(egressConsented({ baseUrl: 'http://face-embed.svc:3120/embed', acknowledgedHost: 'face-embed.svc:3120' }), true);
  });

  it('the SEND SITE refuses before it does anything else', () => {
    /*
     * This is the assertion the whole change rests on. The write-time gate no longer catches an unacknowledged
     * endpoint on an unrelated patch, so the send site is the only thing standing between a stored endpoint and
     * a face crop on the wire.
     *
     * Asserted as ORDER inside the function: the consent check must precede the fetch. A check that ran after
     * would satisfy any test looking only for its presence.
     */
    const at = EXT.indexOf('export async function detectFacesExternal');
    assert.ok(at > -1, 'detectFacesExternal is gone — re-anchor this gate');
    const body = blockAfter(EXT, EXT.indexOf(')', at), 'detectFacesExternal');
    const guard = body.indexOf('externalFaceReady()');
    const send = body.indexOf('ssrfSafeFetch(');
    assert.ok(guard > -1, 'the send site does not check consent at all');
    assert.ok(send > guard, 'consent must be checked BEFORE the request is made');
    assert.match(statementFrom(body, guard, 'the consent guard'), /return null/,
      'and an unconsented endpoint must return rather than continue');
  });

  it('the caller is told to fall back rather than being thrown at', () => {
    // Asserted from the CONTRACT rather than exercised, and the first draft got this wrong: it called
    // `detectFacesExternal` with no config loaded and expected null, which throws `Config not loaded` because
    // the consent read goes through `getConfig()`. That is not a defect — the media worker runs long after
    // boot — but the test was asserting something untrue, so it says what it can prove instead.
    //
    // The behaviour that matters is exercised above through `egressConsented`, which is the rule; this
    // pins that the function REPORTS a refusal rather than raising one, because a throw here would take the
    // media job down instead of letting it fall back in-process.
    const at = EXT.indexOf('export async function detectFacesExternal');
    const body = blockAfter(EXT, EXT.indexOf(')', at), 'detectFacesExternal');
    assert.match(body, /if \(!externalFaceReady\(\)\) return null;/,
      'an unconsented endpoint must return null, not throw — the caller decides what to do about it');
  });
});

describe('the ROUTE gates on the patch, not on the stored state', () => {
  it('the refusal fires when the caller TOUCHES externalModel', () => {
    // The one condition that changed. `facePatch !== undefined` means "the caller is configuring the
    // endpoint"; the old `if (effBaseUrl)` meant "an endpoint exists", which is a fact about the config
    // rather than about the request.
    assert.match(API, /facePatch !== undefined \|\| facesRunAt\(patchedImageLevel\)/,
      'the face consent block no longer gates on the patch — an unrelated write can be refused again');
    assert.match(HELPER, /needsAcknowledgment: host/,
      'it must still name the host, which is the affordance a client acts on');
    assert.match(API, /face crops \(biometric data\)/,
      'and still say WHY in plain language — they asked for that not to be weakened');
    assert.match(API, /document content \(OCR text/,
      'and the assist endpoint must still say what IT sends');
  });

  it('neither endpoint refuses on the STORED state', () => {
    /*
     * The regression this file exists to catch: a consent gate keyed on the config rather than on the request,
     * which brings back the whole-page failure by whichever route it reappears on.
     *
     * BOTH endpoints, because the assist model had the identical shape and its own comment said so out loud —
     * the trigger was the rung "in the same or an EARLIER save". A test naming only the face endpoint would
     * have passed while document content had the same defect on the same page.
     *
     * Comments stripped at the top of this file, deliberately: the account of the defect quotes the old
     * conditions, and a naive search would find the explanation and report the fix as missing.
     */
    assert.doesNotMatch(API, /if \(effBaseUrl\) \{/,
      'a gate keyed on the endpoint existing refuses every unrelated patch again');
    assert.doesNotMatch(API, /if \(repairReachable && effBaseUrl\)/,
      'the assist gate is keyed on the stored rung alone again');
    /*
     * And the positive half, asserted on the PROPERTY rather than on the name.
     *
     * The first version counted `const activatedByThisPatch =` and required two — and SURVIVED rewriting the
     * assist one back to the defective `rungActivatesAssist && !!effBaseUrl`, because that is still an
     * assignment to that name. Counting a variable proves it exists, not that it means anything.
     *
     * What makes activation about the REQUEST is that touching the endpoint counts on its own. So each
     * assignment must name its own patch, and must not be gated on the stored endpoint existing.
     */
    const caused = [...API.matchAll(/const causedByThisPatch = [^;]*;/g)].map(m => m[0]);
    assert.equal(caused.length, 2,
      `both endpoints must decide causation from this patch; found ${caused.length}`);
    for (const a of caused) {
      assert.match(a, /Patch !== undefined \|\|/,
        `causation must include "the caller touched the endpoint" as sufficient on its own: ${a}`);
      assert.doesNotMatch(a, /effBaseUrl|activeCfg/,
        `causation must read the request only — no stored state: ${a}`);
    }
  });

  it('a RUNG raise causes consent, which is the owner ruling', () => {
    // P-12, ruled A + C on 2026-08-20: consent is accepted — and therefore demanded — from the pipeline entry
    // point as well as the endpoint's own control, because raising an image level to its recognition rung is
    // equally an act of switching faces on.
    //
    // `auto` must count. It resolves to the recognition rung, which is why images default to `caption` — so a
    // check for `'recognition'` alone would let `auto` switch on a biometric pipeline without asking.
    assert.match(API, /lvl === 'recognition' \|\| lvl === 'auto'/,
      'raising the image ceiling must demand consent, and `auto` resolves to recognition');
    assert.match(API, /m === 'repair' \|\| m === 'auto'/,
      'and the same for the extraction mode that reaches the assist model');
    // CAUSATION comes from the request only. This is the half the old gate had.
    for (const src of [/const causedByThisPatch = facePatch !== undefined \|\| facesRunAt\(patchedImageLevel\)/,
      /const causedByThisPatch = assistPatch !== undefined \|\| repairRunsAt\(patchedMode\)/]) {
      assert.match(API, src, 'causation must read the PATCHED rung, not the stored one');
    }
    assert.match(API, /const patchedImageLevel = parsed\.data\.levels\?\.images;/,
      'and the patched rung must be read without a fallback, or causation includes an earlier save');
  });

  it('and REACHABILITY is a separate question, read from the effective state', () => {
    /*
     * THIS IS THE ASSERTION THAT WAS MISSING, AND CI PAID FOR IT.
     *
     * The first version of this file asserted only causation — and worse, asserted
     * `doesNotMatch(/parsed.data.levels?.images ?? activeCfg/)` on the grounds that reading the stored level
     * "reintroduces the defect". That forbade the correct code. Reading the stored level to decide WHO CAUSED
     * a change is wrong; reading it to decide WHETHER THE ENDPOINT IS REACHABLE is required.
     *
     * `media-config.test.js` in the Docker suite names the contract that collapse broke: *"configuring the
     * endpoint BELOW the repair rung is allowed (not reachable yet) and round-trips"*. Setting up an endpoint
     * while the rung that uses it is off has always been permitted, deliberately — nothing can be sent at that
     * rung, so there is nothing to consent to yet. Three integration tests went red.
     *
     * Preflight cannot run the Docker suites, which is the standing reason to grep them by hand before
     * changing a contract. This gate now holds the property locally so the next change fails here first.
     */
    for (const [label, pat] of [
      ['face', /const reachableAfterThisPatch = facesRunAt\(effImageLevel\) && !!effBaseUrl/],
      ['assist', /const reachableAfterThisPatch = repairRunsAt\(effMode\) && !!effBaseUrl/],
    ]) {
      assert.match(API, pat,
        `${label}: reachability must be the rung AND the endpoint, from the effective state`);
    }
    // The effective reads are what make "below the rung" allowed. Their ABSENCE is the regression.
    assert.match(API, /const effImageLevel = parsed\.data\.levels\?\.images \?\? activeCfg\.levels\?\.images;/,
      'the face rung must fall back to the stored level for REACHABILITY');
    assert.match(API, /const effMode = parsed\.data\.documentProcessing\?\.mode \?\? activeCfg/,
      'and so must the extraction mode');
  });

  it('the refusal needs BOTH, and the helper says so with one &&', () => {
    // Either half alone is a shipped bug, and both have now happened: reachable-without-caused refused every
    // unrelated write, and caused-without-reachable made setting up an endpoint impossible. The conjunction is
    // the rule, so it is asserted as one expression rather than as two facts about the file.
    assert.match(HELPER, /if \(!reachableAfterThisPatch \|\| !causedByThisPatch \|\| !effBaseUrl\) return null;/,
      'the helper must require reachability AND causation; either alone has already shipped as a defect');
  });

  it('SSRF is checked when the endpoint is TOUCHED, independently of consent', () => {
    // Two different rules that used to share one `if`. A private-address endpoint is refused even from a
    // caller who has acknowledged it, and consent is demanded even when the URL is fine — collapsing them
    // means whichever check came first hid the other.
    for (const slot of ['faceExternal', 'assist']) {
      const at = API.indexOf(`allowPrivateForSlot('${slot}')`);
      assert.ok(at > -1, `${slot}: the SSRF check is gone`);
      const stmt = statementFrom(API, API.lastIndexOf('if (', at), `${slot} SSRF guard`);
      assert.match(stmt, /Patch !== undefined/,
        `${slot}: SSRF must be gated on the caller touching the endpoint, not on consent`);
    }
  });

  it('one helper, called twice — not two copies of the rule', () => {
    // The defect this codebase produces most, and on a consent rule the weaker copy means data on the wire.
    const calls = [...API.matchAll(/refuseUnacknowledgedEgress\(\{/g)];
    assert.equal(calls.length, 2, `expected both endpoints to call the shared helper; found ${calls.length}`);
    assert.doesNotMatch(API, /effAck !== host/,
      'an inline host comparison is a second copy of the consent rule');
  });

  it('the unacknowledged state is REPORTED on the GET', () => {
    // Because it is now reachable and silent. "Falls back quietly" is right for an unreachable endpoint — a
    // runtime condition nobody chose — and wrong for an unacknowledged one, which is a decision waiting on a
    // person.
    assert.match(API, /faceEndpointAwaitingAcknowledgment/,
      'the UI cannot say "configured, not in use" unless the server says so');
    const at = API.indexOf("masked['faceEndpointAwaitingAcknowledgment']");
    assert.ok(at > -1, 're-anchor this gate');
    const stmt = statementFrom(API, at, 'the awaiting-acknowledgment derivation');
    assert.match(stmt, /egressConsented/,
      'derived from the shared rule, not from a second comparison that could disagree with it');
    assert.match(stmt, /baseUrl/,
      'and only when an endpoint is actually configured — an empty slot is not awaiting anything');
  });

  it('the route and the send site read ONE consent rule', () => {
    // Two implementations of "is this endpoint consented to" is the defect this codebase produces most, and on
    // this rule the weaker one would mean biometric data on the wire.
    assert.match(API, /egressConsented/, 'the route must import the shared predicate');
    assert.doesNotMatch(API, /acknowledgedHost === new URL/,
      'a second copy of the comparison in the route is how the two drift');
  });
});

/**
 * THE TRUTH TABLE, exercised — because reading the source is what let the first draft through.
 *
 * Every assertion above this block reads `media-config.ts` and checks the shape of the decision. All of them
 * passed on a version that broke three integration tests, because the shape was right and the RULE was wrong:
 * it demanded consent for configuring an endpoint below the rung that uses it, which has always been allowed.
 *
 * The Docker suite catches that (`media-config.test.js` has a test named after the contract) and preflight
 * cannot run the Docker suite. So the rule itself is exercised here, against the exported helper, with one row
 * per scenario those tests cover plus the one this change exists for.
 *
 * `effBaseUrl`/`effAck` are the effective endpoint and acknowledgement; the two booleans are what the route
 * computes from the patch and the stored config. Naming the scenarios after the integration tests is
 * deliberate — if one of these rows ever disagrees with its namesake, the two are describing different rules.
 */
describe('the consent rule, one row per scenario the Docker suite covers', () => {
  let refuseUnacknowledgedEgress;
  before(async () => {
    ({ refuseUnacknowledgedEgress } = await import('../../server/dist/api/media-config.js'));
  });

  const ask = (over) => refuseUnacknowledgedEgress({
    what: 'external assist model',
    sends: 'document content',
    effBaseUrl: 'https://assist.example.com',
    effAck: undefined,
    reachableAfterThisPatch: false,
    causedByThisPatch: false,
    ...over,
  });

  const CASES = [
    // ── the three integration tests this change broke on its first attempt ──
    ['configuring the endpoint BELOW the repair rung is allowed (not reachable yet)',
      { reachableAfterThisPatch: false, causedByThisPatch: true }, 'allow'],
    ['a mode-only PATCH below the rung is allowed',
      { reachableAfterThisPatch: false, causedByThisPatch: true }, 'allow'],
    ['setting an apiKey on a stored endpoint below the rung is allowed',
      { reachableAfterThisPatch: false, causedByThisPatch: true }, 'allow'],

    // ── the one it must keep refusing ──
    ['making an endpoint REACHABLE without acknowledgment is rejected',
      { reachableAfterThisPatch: true, causedByThisPatch: true }, 'refuse'],

    // ── the one this whole change exists for ──
    ['an unrelated patch, while a reachable-but-unacknowledged endpoint is stored, is allowed',
      { reachableAfterThisPatch: true, causedByThisPatch: false }, 'allow'],

    // ── and consent, once given, stops the refusal ──
    ['a matching acknowledgement allows a reachable endpoint',
      { reachableAfterThisPatch: true, causedByThisPatch: true, effAck: 'assist.example.com' }, 'allow'],
    ['an acknowledgement for ANOTHER host does not',
      { reachableAfterThisPatch: true, causedByThisPatch: true, effAck: 'other.example.com' }, 'refuse'],

    // ── no endpoint at all is nothing to consent to, whatever the flags say ──
    ['no endpoint is never a refusal',
      { reachableAfterThisPatch: true, causedByThisPatch: true, effBaseUrl: undefined }, 'allow'],
  ];

  for (const [name, over, expected] of CASES) {
    it(`${expected}s: ${name}`, () => {
      const r = ask(over);
      if (expected === 'allow') {
        assert.equal(r, null, `expected no refusal, got ${JSON.stringify(r)}`);
      } else {
        assert.ok(r, 'expected a refusal');
        assert.equal(r.status, 400);
        assert.equal(r.body.needsAcknowledgment, 'assist.example.com',
          'the refusal must name the host, which is what a client acts on');
      }
    });
  }

  it('the table covers BOTH truth values of both flags', () => {
    // Anti-vacuity, and the specific way this file was weak before: a table that only ever varied one flag
    // would pass on a helper that ignored the other, which is precisely the bug that reached CI.
    const seen = new Set(CASES.map(([, o]) => `${!!o.reachableAfterThisPatch}/${!!o.causedByThisPatch}`));
    for (const combo of ['true/true', 'true/false', 'false/true']) {
      assert.ok(seen.has(combo), `no row exercises reachable/caused = ${combo}`);
    }
  });

  it('a malformed URL is reported as such, not as missing consent', () => {
    // Otherwise a typo in the endpoint reads as a consent problem and the operator acknowledges harder.
    const r = ask({ reachableAfterThisPatch: true, causedByThisPatch: true, effBaseUrl: 'not a url' });
    assert.ok(r);
    assert.match(r.body.error, /not a valid URL/);
    assert.ok(!('needsAcknowledgment' in r.body), 'nothing to acknowledge when there is no host to name');
  });
});
