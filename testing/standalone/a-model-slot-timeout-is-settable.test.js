/**
 * Every model slot's call budget is operator-settable, and the stall floor sees whatever the operator set.
 *
 * ## The defect
 *
 * The canary operator asked why they could not configure the vision deadline (2026-08-29T1445Z). It is not one
 * constant. The **document** pipeline is fully settable — `pageTimeoutMs` / `ocrTimeoutMs` /
 * `describeTimeoutMs`, each with a config field and an admin PATCH. Every other model slot is a literal:
 *
 * | slot | where | value |
 * |---|---|---|
 * | `vision` | `files/media/providers.ts` `VISION_TIMEOUT_MS` | 120 s |
 * | `vision` (external leg) | `EXTERNAL_VISION_TIMEOUT_MS` | 60 s ← the one they asked about |
 * | `stt` | `STT_TIMEOUT_MS` | 300 s |
 * | `faceExternal` | `files/media/face-external.ts` `FACE_TIMEOUT_MS` | 30 s |
 * | `nli` | `brain/nli-client.ts`, inline | 20 s |
 * | `rerank` | `brain/rerank-client.ts`, inline | 20 s |
 * | `embedding` | `brain/embedding.ts`, inline | 30 s |
 * | `docVlm` / `docRepair` / `docVerify` / `assist` | `converters/vlm-client.ts`, `?? 60_000` **five times** | 60 s |
 *
 * No env var, no config field, no admin control for any of them.
 *
 * ## Why the stall floor is half of this test and not a separate concern
 *
 * `hopBudgets()` feeds the stall detector the longest thing one job step may take, and `stall-floor.ts` raises
 * the stall timeout above it — which is what stops a long call being re-queued mid-flight, abandoning its work
 * and reaching the same step again for ever. Today it is fed the CONSTANTS. The moment a slot becomes settable
 * and the floor still reads the constant, an operator raising their vision timeout to 10 minutes gets exactly
 * that loop back, and gets it silently.
 *
 * So "settable" and "the floor sees it" are one property, asserted together. A slot that is settable and
 * invisible to the floor is worse than one that is not settable at all.
 *
 * ## What this file does NOT check, and the gate that does
 *
 * It checks that no call site holds a LITERAL and that the resolver is reached. Both stayed true while four
 * slots were inert: the document pipeline passed `timeoutMs: cfg.pageTimeoutMs` and the clients resolved
 * `opts.timeoutMs ?? slotTimeoutMs(…)`, so the caller's number won every time. The title of this file claims
 * the property; the body checks a proxy for it, and the proxy held.
 *
 * `a-slot-budget-is-not-shadowed.test.js` asserts the property itself — that what the operator set is what
 * bounds the call — and that every slot has a control to set it with.
 *
 * ## Why one resolver rather than a field on each provider block
 *
 * `MediaProviderConfig` covers vision, stt, nli and rerank — four of the ten. `embedding` has its own shape,
 * face uses an inline literal, and the four document slots are flat keys inside `DocumentProcessingConfig`. A
 * `timeoutMs` on the provider interface would need five more homes, which is the two-implementations defect by
 * construction. `EGRESS_SLOTS` already names all ten and is reused rather than duplicated — a third slot
 * vocabulary is the same defect one level up.
 *
 * Run: node --test testing/standalone/a-model-slot-timeout-is-settable.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf } from './_structural-window.mjs';

const { EGRESS_SLOTS } = await import('../../server/dist/config/model-egress-policy.js');
const { PINNABLE_FIELD_PATHS } = await import('../../server/dist/config/pinned-fields.js');
const { mergeModelSlots } = await import('../../server/dist/api/media-config.js');

/*
 * The module under construction, imported TOLERANTLY.
 *
 * A bare top-level `await import` of a module that does not exist yet throws before any test runs, so the whole
 * file reports one opaque "test failed" — which is a red that proves nothing and, written test-first, hides the
 * failures that are supposed to be driving the implementation. Absent, the source-reading checks below still
 * run and name the real call sites; the resolver checks report the module as missing, which is the accurate
 * statement of what is wrong.
 */
let SLOTS = null;
try { SLOTS = await import('../../server/dist/config/model-slots.js'); } catch { /* not built yet */ }
const MODEL_SLOT_DEFAULT_MS = SLOTS?.MODEL_SLOT_DEFAULT_MS ?? {};
const slotTimeoutMs = SLOTS?.slotTimeoutMs
  ?? (() => { throw new Error('config/model-slots.ts does not exist yet'); });

const src = (p) => stripComments(readFileSync(p, 'utf8'));

describe('every slot has a default, and the list is the one that already exists', () => {
  it('covers every EGRESS_SLOTS entry — no slot silently unbudgeted', () => {
    // Exhaustive against the vocabulary the egress policy already uses, so an eleventh slot is covered on the
    // commit that adds it rather than whenever somebody notices.
    assert.deepEqual(Object.keys(MODEL_SLOT_DEFAULT_MS).sort(), [...EGRESS_SLOTS].sort());
  });

  // The shipped values themselves are held where the docs state them: `doc-cited-constants` pairs each slot's default with `05b-media-embedding.md`.
});

describe('the resolver', () => {
  it('returns the configured value when the operator set one', () => {
    assert.equal(slotTimeoutMs('vision', { vision: { timeoutMs: 240_000 } }), 240_000);
  });

  it('returns the built-in default when the slot is absent, and when only another slot is set', () => {
    // "Unset" must not be conflated with "zero": an absent block and a block for a different slot are both
    // "not configured", and both must land on the default rather than on 0 or undefined.
    assert.equal(slotTimeoutMs('vision', undefined), MODEL_SLOT_DEFAULT_MS.vision);
    assert.equal(slotTimeoutMs('vision', {}), MODEL_SLOT_DEFAULT_MS.vision);
    assert.equal(slotTimeoutMs('vision', { stt: { timeoutMs: 1_000 } }), MODEL_SLOT_DEFAULT_MS.vision);
  });

  it('ignores a value that is not a usable number rather than propagating it', () => {
    // A hand-edited config.json is not validated by the PATCH schema. NaN would reach AbortSignal.timeout and
    // every comparison against it is false — the failure `setting-bounds.ts` exists to prevent, one layer down.
    for (const bad of [NaN, 0, -5, undefined, null, '240000']) {
      assert.equal(slotTimeoutMs('vision', { vision: { timeoutMs: bad } }), MODEL_SLOT_DEFAULT_MS.vision,
        `${String(bad)} must fall back to the default`);
    }
  });
});

describe('no call site keeps its own budget', () => {
  /**
   * The call sites, derived from the shape rather than from a list of names: every `AbortSignal.timeout(x)` on
   * the model path, and every `timeoutMs:` handed to a provider client.
   *
   * A literal or a bare exported constant here means that slot's budget is unreachable from config, whatever
   * the config layer says it accepts.
   */
  const FILES = [
    'server/src/files/media/providers.ts',
    'server/src/files/media/face-external.ts',
    'server/src/brain/nli-client.ts',
    'server/src/brain/rerank-client.ts',
    'server/src/brain/embedding.ts',
    'server/src/files/converters/vlm-client.ts',
  ];

  it('no model-path timeout is a bare literal', () => {
    const offenders = [];
    for (const f of FILES) {
      for (const m of src(f).matchAll(/AbortSignal\.timeout\(\s*([^)]+?)\s*\)/g)) {
        if (/^[\d_]+$/.test(m[1])) offenders.push(`${f}: AbortSignal.timeout(${m[1]})`);
      }
      for (const m of src(f).matchAll(/timeoutMs\s*\?\?\s*([\d_]+)/g)) {
        offenders.push(`${f}: opts.timeoutMs ?? ${m[1]}`);
      }
    }
    assert.deepEqual(offenders, [],
      'these budgets are literals, so no operator can change them and no config field can reach them:\n  '
      + offenders.join('\n  '));
  });

  it('every slot budget resolves through the one resolver', () => {
    // Not merely "not a literal" — a per-file helper would satisfy that while being a second implementation.
    // `vlm-client.ts` had FIVE copies of `?? 60_000`, which is what that looks like when it happens.
    //
    // `slotTimeoutMsOr` counts, and it is the same resolver: it is what a caller with a default of its own
    // calls, and it ends in `MODEL_SLOT_DEFAULT_MS` like the other. Matching only `slotTimeoutMs(` failed
    // the document clients the day they stopped shadowing the operator, which would have read as the fix
    // breaking the gate rather than as the gate naming one spelling of one function.
    const offenders = [];
    for (const f of FILES) {
      const s = src(f);
      if (!/AbortSignal\.timeout|timeoutMs/.test(s)) continue;
      if (!/slotTimeoutMs(?:Or)?\(/.test(s)) offenders.push(f);
    }
    assert.deepEqual(offenders, [],
      'these bound a model call without going through slotTimeoutMs(), so their budget is resolved a second '
      + 'way:\n  ' + offenders.join('\n  '));
  });
});

describe('the stall floor sees what the operator set', () => {
  it('hopBudgets feeds resolved values, not the constants', () => {
    /*
     * The half that turns a settable timeout from a feature into a defect if it is missed. `stall-floor.ts`
     * raises the stall timeout above the longest hop; fed a constant, it would keep protecting the DEFAULT
     * while the operator's larger value ran unprotected — and a call longer than the stall timeout is re-queued
     * mid-flight, abandons its work, and reaches the same call again. The loop that never finishes, re-armed
     * by the very control that was supposed to help.
     */
    const body = bodyOf(src('server/src/files/media/worker.ts'), 'hopBudgets');

    /*
     * EVERY slot, named individually — not "the resolver appears somewhere in the body".
     *
     * The weaker version was written first and a mutation walked straight through it: replacing just
     * `slotTimeoutMs('vision', cfg)` with `120_000` left the other two resolver calls in place, so the match
     * succeeded and no old constant name was present either. The vision hop was hard-coded again and the gate
     * said nothing — the precise failure this test exists to catch, passing because the assertion was about
     * the file rather than about each slot.
     */
    for (const slot of ['vision', 'stt', 'faceExternal']) {
      assert.match(body, new RegExp(`slotTimeoutMs\\('${slot}'`),
        `hopBudgets does not resolve ${slot} — the floor would protect the default while the configured value `
        + 'runs unprotected');
    }
    assert.doesNotMatch(body, /\b(?:VISION|EXTERNAL_VISION|STT|FACE)_TIMEOUT_MS\b/,
      'a constant here means the floor protects the default while the configured value runs unprotected');
    // And no bare literal as a hop value, which is what a half-reverted slot looks like.
    assert.deepEqual([...body.matchAll(/^\s*\w+:\s*([\d_]+),/gm)].map(m => m[1]), [],
      'a hop budget is a literal again, so that slot is unreachable from config');
  });
});

describe('the operator surfaces', () => {
  it('the admin PATCH accepts a timeout for every slot', () => {
    // The schemas are `.strict()`, so a slot the schema does not list is a 400 on the whole body rather than a
    // silently ignored field — "settable" has to mean every slot or it is a trap for the ones left out.
    const admin = src('server/src/api/media-config.ts');
    assert.match(admin, /ModelSlotsPatchSchema/, 'no model-slot block in the PATCH schema');
    for (const slot of EGRESS_SLOTS) {
      assert.match(admin, new RegExp(`\\b${slot}\\s*:\\s*SlotTuningPatchSchema`), `${slot} is not patchable`);
    }
  });

  it('a patch naming one slot leaves the others alone', () => {
    /*
     * The trap `mergeLevelCeilings` documents one screen away: `{...existing, ...patch}` at the top level
     * replaces the whole `modelSlots` object, so a patch touching one slot silently returns the other nine to
     * their defaults. There it is compensated for by the client always sending all four classes — a
     * compensation that holds only while somebody remembers it.
     */
    const before = { vision: { timeoutMs: 240_000 }, stt: { timeoutMs: 600_000 } };
    assert.deepEqual(mergeModelSlots(before, { nli: { timeoutMs: 45_000 } }), {
      vision: { timeoutMs: 240_000 }, stt: { timeoutMs: 600_000 }, nli: { timeoutMs: 45_000 },
    });
  });

  it('null clears a slot back to its default, and absent is not null', () => {
    // The distinction the schema's `.nullable()` exists for. Without it there is no way to undo a setting: an
    // absent field means "unchanged", so clearing would need a magic value.
    const before = { vision: { timeoutMs: 240_000 }, stt: { timeoutMs: 600_000 } };
    assert.deepEqual(mergeModelSlots(before, { vision: { timeoutMs: null } }), { stt: { timeoutMs: 600_000 } });
    assert.deepEqual(mergeModelSlots(before, {}), before);
  });

  it('merging onto nothing works, which is the first write on a fresh instance', () => {
    assert.deepEqual(mergeModelSlots(undefined, { rerank: { timeoutMs: 30_000 } }), { rerank: { timeoutMs: 30_000 } });
  });

  it('every slot is pinnable, so infra can fix a budget it owns', () => {
    // A field an operator can set and infra cannot lock is the asymmetry `YTHRIL_PINNED_FIELDS` exists to
    // remove. Pinned at the slot, matching how `documentProcessing.assistModel` pins a whole block.
    const missing = EGRESS_SLOTS.filter(s => !PINNABLE_FIELD_PATHS.includes(`modelSlots.${s}`));
    assert.deepEqual(missing, [], `these slots cannot be pinned: ${missing.join(', ')}`);
  });
});
