/**
 * Standalone tests: PER-ENDPOINT private-address permission.
 *
 * The deployment that motivated this (owner, 2026-07-30): *"all on own infra except one that is on
 * external"*. Nine model endpoints on a private cluster, one genuine public vendor. Under the
 * instance-wide `allowPrivateModelEndpoints`, reaching the nine required turning the flag on — which also
 * relaxed the private-address rejection on the tenth, the single endpoint where a private resolution means
 * something has gone wrong rather than "this is my cluster". The flag made the estate's security posture a
 * function of its least-strict member.
 *
 * So the permission is resolved per SLOT, and a per-slot value beats the global **in both directions**.
 * That second direction is the whole feature: `{ assist: false }` under a global `true` is what keeps the
 * one external endpoint strict, and a design where per-slot could only widen would not have helped at all.
 *
 * What per-slot must NOT be able to do:
 *   - reach a crown jewel (loopback, link-local / cloud IMDS, unspecified) — those are refused whatever any
 *     setting says, at both admission points
 *   - become settable from the admin API — an endpoint that turns into an egress target must not be
 *     widenable by the instance's own admin, which is the same rule the global flag has always had
 *
 * Run: node --test testing/standalone/per-endpoint-egress.test.js
 */

import { describe, it, before, beforeEach, afterEach } from 'node:test';
import { trackedSources } from './_sources.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let allowPrivateForSlot;
let allowPrivateModelEndpoints;
let egressSlotOverrides;
let privateAddressHint;
let slotEnvVar;
let EGRESS_SLOTS;
let isSsrfSafeUrl;
let assertUrlSafeResolved;

const GLOBAL_KEY = 'YTHRIL_ALLOW_PRIVATE_MODEL_ENDPOINTS';

/** Must stay blocked with every setting on — these are what SSRF actually targets. */
const CROWN_JEWELS = [
  'http://127.0.0.1:8080',
  'http://localhost:8080',
  'http://169.254.169.254/latest/meta-data/',
  'http://metadata.google.internal/computeMetadata/v1/',
  'http://[::1]:8080',
  'http://0.0.0.0:8080',
];

const resolvesTo = (address, family = 4) => async () => [{ address, family }];

/** Env keys this suite writes, restored wholesale so no test leaks into the next. */
let saved;
function snapshotEnv(keys) {
  saved = new Map(keys.map(k => [k, process.env[k]]));
}
function restoreEnv() {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

describe('per-endpoint egress permission', () => {
  let allKeys;

  before(async () => {
    ({
      allowPrivateForSlot, allowPrivateModelEndpoints, egressSlotOverrides,
      privateAddressHint, slotEnvVar, EGRESS_SLOTS,
    } = await import('../../server/dist/config/model-egress-policy.js'));
    ({ isSsrfSafeUrl, assertUrlSafeResolved } = await import('../../server/dist/util/ssrf.js'));
    allKeys = [GLOBAL_KEY, ...EGRESS_SLOTS.map(slotEnvVar)];
  });

  beforeEach(() => {
    snapshotEnv(allKeys);
    for (const k of allKeys) delete process.env[k];
  });
  afterEach(restoreEnv);

  describe('the slot vocabulary', () => {
    it('covers every model endpoint that can egress', () => {
      // Written down rather than derived, for the reason the pipeline board learned the hard way: a
      // reporter enumerated NINE endpoints from the Models screen and missed the tenth, because the
      // document stages build their keys as `doc-${slot}` and no literal exists to grep for. A set that is
      // silently short reports "nothing else is exposed" by omission.
      assert.deepEqual([...EGRESS_SLOTS].sort(), [
        'assist', 'decision', 'docRepair', 'docVerify', 'docVlm', 'embedding',
        'faceExternal', 'nli', 'rerank', 'stt', 'vision',
      ]);
    });

    it('derives a distinct, screaming-snake env var for each', () => {
      const names = EGRESS_SLOTS.map(slotEnvVar);
      assert.equal(new Set(names).size, names.length, 'two slots must never share an env var');
      assert.equal(slotEnvVar('docVlm'), 'YTHRIL_ALLOW_PRIVATE_DOC_VLM');
      assert.equal(slotEnvVar('vision'), 'YTHRIL_ALLOW_PRIVATE_VISION');
      assert.equal(slotEnvVar('faceExternal'), 'YTHRIL_ALLOW_PRIVATE_FACE_EXTERNAL');
      for (const n of names) assert.match(n, /^YTHRIL_ALLOW_PRIVATE_[A-Z_]+$/);
    });
  });

  describe('precedence: per-slot → global → closed', () => {
    it('is closed for every slot by default', () => {
      for (const slot of EGRESS_SLOTS) {
        assert.equal(allowPrivateForSlot(slot), false, `${slot} must default to strict`);
      }
    });

    it('inherits the global when the slot says nothing', () => {
      process.env[GLOBAL_KEY] = 'true';
      for (const slot of EGRESS_SLOTS) {
        assert.equal(allowPrivateForSlot(slot), true, `${slot} should inherit the instance-wide flag`);
      }
    });

    it('a per-slot true widens one slot without touching the others', () => {
      process.env[slotEnvVar('embedding')] = 'true';
      assert.equal(allowPrivateForSlot('embedding'), true);
      assert.equal(allowPrivateModelEndpoints(), false, 'the global flag must stay off');
      for (const slot of EGRESS_SLOTS.filter(s => s !== 'embedding')) {
        assert.equal(allowPrivateForSlot(slot), false, `${slot} must not be widened by embedding's setting`);
      }
    });

    it('a per-slot FALSE overrides a global true — the case this exists for', () => {
      // Everything on the operator's own infra except the assist model, which is a public vendor.
      process.env[GLOBAL_KEY] = 'true';
      process.env[slotEnvVar('assist')] = 'false';
      assert.equal(allowPrivateForSlot('assist'), false,
        'the one deliberately-external endpoint must stay strict under a permissive global');
      for (const slot of EGRESS_SLOTS.filter(s => s !== 'assist')) {
        assert.equal(allowPrivateForSlot(slot), true, `${slot} should still reach the operator's cluster`);
      }
    });

    it('only the exact strings "true" and "false" are settings — anything else defers', () => {
      // Same strictness the global flag has. A typo must not silently mean "closed" when the global says
      // open: that would be a per-slot value nobody set, quietly overriding one they did.
      process.env[GLOBAL_KEY] = 'true';
      for (const value of ['1', 'yes', 'TRUE', 'False', 'on', '']) {
        process.env[slotEnvVar('vision')] = value;
        assert.equal(allowPrivateForSlot('vision'), true, `"${value}" must not be read as a per-slot setting`);
      }
    });
  });

  describe('what the posture reports', () => {
    it('names nothing when every slot agrees with the global', () => {
      assert.deepEqual(egressSlotOverrides(), []);
      process.env[GLOBAL_KEY] = 'true';
      assert.deepEqual(egressSlotOverrides(), []);
    });

    it('names the strict slot under a permissive global', () => {
      // The invisible case: with the global on, nothing else in the posture would ever mention the one
      // endpoint the operator deliberately kept strict.
      process.env[GLOBAL_KEY] = 'true';
      process.env[slotEnvVar('assist')] = 'false';
      assert.deepEqual(egressSlotOverrides(), [{ slot: 'assist', allowPrivate: false }]);
    });

    it('names the widened slot under a strict global', () => {
      process.env[slotEnvVar('docVlm')] = 'true';
      assert.deepEqual(egressSlotOverrides(), [{ slot: 'docVlm', allowPrivate: true }]);
    });
  });

  describe('the rejection message', () => {
    it('names the exact knob for the slot that was refused', () => {
      const hint = privateAddressHint('rerank');
      assert.match(hint, /allowPrivateModelEndpointsBySlot\.rerank/);
      assert.match(hint, /YTHRIL_ALLOW_PRIVATE_RERANK=true/);
      assert.match(hint, /cloud-metadata addresses stay blocked/,
        'the message must not imply the setting unlocks everything');
    });

    it('says nothing when the slot ALREADY allows private addresses', () => {
      // Then the refusal was a crown jewel and no setting will lift it. Telling an operator to enable a
      // flag that is already on is how a support round-trip starts.
      process.env[slotEnvVar('rerank')] = 'true';
      assert.equal(privateAddressHint('rerank'), '');
    });
  });

  describe('crown jewels are not reachable through any slot', () => {
    it('are refused at save time with every slot permission on', () => {
      process.env[GLOBAL_KEY] = 'true';
      for (const slot of EGRESS_SLOTS) process.env[slotEnvVar(slot)] = 'true';
      for (const url of CROWN_JEWELS) {
        assert.equal(isSsrfSafeUrl(url, allowPrivateForSlot('vision')), false, `${url} must stay blocked`);
      }
    });

    it('are refused at resolution time too', async () => {
      process.env[slotEnvVar('vision')] = 'true';
      const allow = allowPrivateForSlot('vision');
      assert.equal(allow, true, 'precondition: the slot is permissive');
      // A hostname that resolves to the cloud metadata address — the DNS-rebinding shape the static check
      // cannot see. The permission relaxes ordinary private ranges; it does not touch this one.
      await assert.rejects(
        assertUrlSafeResolved('http://models.example.com/v1', { allowPrivate: allow, lookup: resolvesTo('169.254.169.254') }),
        /169\.254|blocked|refus/i,
      );
      await assert.rejects(
        assertUrlSafeResolved('http://models.example.com/v1', { allowPrivate: allow, lookup: resolvesTo('127.0.0.1') }),
        /127\.0\.0\.1|loopback|blocked|refus/i,
      );
    });

    it('a permissive slot DOES reach an ordinary private address — otherwise the setting is decorative', async () => {
      process.env[slotEnvVar('vision')] = 'true';
      await assert.doesNotReject(assertUrlSafeResolved(
        'http://vllm.models.svc.cluster.local:8080',
        { allowPrivate: allowPrivateForSlot('vision'), lookup: resolvesTo('10.1.2.3') },
      ));
    });
  });

  describe('it stays off the admin surface', () => {
    // The rule the global flag has always had, restated because per-slot multiplies the places it could
    // leak in: ten keys instead of one. An admin who can widen their own egress has an SSRF primitive, and
    // the config field is the only thing standing between the two.
    const CONFIG_KEY = 'allowPrivateModelEndpointsBySlot';

    it('is not accepted by the media-config PATCH schema', () => {
      const src = readFileSync('server/src/api/media-config.ts', 'utf8');
      const code = src.split('\n')
        .filter(l => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); })
        .join('\n');
      assert.ok(!code.includes(CONFIG_KEY),
        `${CONFIG_KEY} must never appear in the admin config route — env and config.json only`);
    });

    it('is not written by any route', () => {
      /*
       * Reading it is the point; assigning it from a request body is the hole. The whole reason this switch
       * is config-and-env only is that an operator must not be able to grant an egress exception through
       * the admin UI — see the block above.
       *
       * **DERIVED from the route directory, because "any route" is what the title says.** It named two
       * files, which were the two the reviewer had open; every other route in `server/src/api` was outside
       * everything this gate looked at while the sentence went on covering all of them. `Q-6`, 2026-09-07.
       */
      const src = readFileSync('server/src/config/model-egress-policy.ts', 'utf8');
      assert.match(src, new RegExp(`getConfig\\(\\)\\.${CONFIG_KEY}`),
        'the resolver should READ the config key');

      const routes = trackedSources('server/src/api', { floor: 10 });

      const writers = routes.filter(f => new RegExp(`${CONFIG_KEY}\\s*[=:]`).test(readFileSync(f, 'utf8')));
      assert.deepEqual(writers, [],
        `${writers.join(', ')} assigns ${CONFIG_KEY}. It is settable by environment and config.json only, `
        + 'because a route that writes it lets an operator grant an egress exception to a private address '
        + 'through the admin UI.');
    });
  });
});
