/**
 * What an operator sets for a slot is what bounds that slot's call — and every slot has a door to set it.
 *
 * ## The defect, and why nothing ever contradicted it
 *
 * `a-model-slot-timeout-is-settable.test.js` is titled *"every model slot's call budget is
 * operator-settable"*. Its body checks that no call site holds a LITERAL and that `slotTimeoutMs(` appears
 * somewhere in each file. Both were true of the document pipeline and the budget was still unreachable:
 *
 * ```
 * // vlm-client.ts               opts.timeoutMs ?? slotTimeoutMs(slot, getModelSlots())
 * // vlm-extract.ts, four sites  transcribePageImage(img, { ...ep, timeoutMs: cfg.pageTimeoutMs })
 * ```
 *
 * `??` takes the left side whenever it is present, so `pageTimeoutMs` won every time and the resolver was
 * dead code on that path. Four slots — `docVlm`, `docRepair`, `docVerify` and `assist` — were documented in
 * the field table, accepted by the admin PATCH, pinnable through `YTHRIL_PINNED_FIELDS`, and had no effect
 * whatsoever.
 *
 * **The two defaults are both 60 000 ms.** So the number an operator read and the number the code used
 * agreed exactly until somebody changed one, which is why a gate, a field table and a canary report could
 * all coexist with it for a release. This is the shape the y-flows convention `convention-a-test-derives-its-set` calls a gate concluding about more than
 * it checks: the title claims the property, the body checks a proxy for it, and the proxy stayed true.
 *
 * ## So this gate asserts the RULE, at the point where the number is used
 *
 * Not "the resolver is mentioned" — that is what was already checked. The budget handed to `AbortSignal` has
 * to be one the operator's setting can win, which means the caller's own number may only be a DEFAULT.
 * `slotTimeoutMsOr` is the one place that ordering lives, and a `??` in front of a resolver call is the
 * shadowing spelled out.
 *
 * ## And the door, because a reachable setting nobody can reach is the same defect one layer up
 *
 * Reported by the canary operator 2026-09-06 §6(c): the ten per-slot budgets had seven doors. `rerank` was
 * among the seven and is the one they needed — the reranker switching itself off on large spaces was traced
 * to the 20 s default — but `docVlm`, `docRepair` and `docVerify` had none, and `05b-media-embedding.md`
 * states there is deliberately no environment variable for these, which makes that screen the only door.
 *
 * The set is derived from `MODEL_SLOTS`, never listed here: a corrected list is the same defect with a
 * later expiry date, and this repository has paid for that twice in one sweep already.
 *
 * Run: node --test testing/standalone/a-slot-budget-is-not-shadowed.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

const { MODEL_SLOTS } = await import('../../server/dist/config/model-slots.js');

let SLOTS = null;
try { SLOTS = await import('../../server/dist/config/model-slots.js'); } catch { /* not built yet */ }
const slotTimeoutMsOr = SLOTS?.slotTimeoutMsOr
  ?? (() => { throw new Error('slotTimeoutMsOr does not exist yet'); });
const MODEL_SLOT_DEFAULT_MS = SLOTS?.MODEL_SLOT_DEFAULT_MS ?? {};

const src = (p) => stripComments(readFileSync(p, 'utf8'));

describe('the resolver puts the operator first and the caller second', () => {
  it('the operator\'s slot value wins over the caller\'s default', () => {
    assert.equal(slotTimeoutMsOr('docVlm', { docVlm: { timeoutMs: 300_000 } }, 60_000), 300_000);
  });

  it('the caller\'s default is used when the operator set nothing', () => {
    // This is what keeps `pageTimeoutMs` meaningful for the operators who never open the slot controls.
    assert.equal(slotTimeoutMsOr('docVlm', undefined, 90_000), 90_000);
    assert.equal(slotTimeoutMsOr('docVlm', {}, 90_000), 90_000);
    assert.equal(slotTimeoutMsOr('docVlm', { docRepair: { timeoutMs: 5_000 } }, 90_000), 90_000);
  });

  it('the built-in default is the floor under both', () => {
    assert.equal(slotTimeoutMsOr('docVlm', undefined, undefined), MODEL_SLOT_DEFAULT_MS.docVlm);
  });

  it('an unusable number is refused on EITHER side rather than propagated', () => {
    // A hand-edited config.json does not pass the PATCH schema, and `pageTimeoutMs` reaches here from a
    // config block too. A NaN would arrive at `AbortSignal.timeout`, where every comparison against it is
    // false — the same failure `slotTimeoutMs` already refuses one argument at a time.
    for (const bad of [NaN, 0, -5, null, '90000']) {
      assert.equal(slotTimeoutMsOr('docVlm', { docVlm: { timeoutMs: bad } }, 90_000), 90_000,
        `a slot value of ${String(bad)} must fall through to the caller's default`);
      assert.equal(slotTimeoutMsOr('docVlm', undefined, bad), MODEL_SLOT_DEFAULT_MS.docVlm,
        `a caller default of ${String(bad)} must fall through to the built-in`);
    }
  });
});

describe('no call site shadows the operator', () => {
  /**
   * Derived from the shape: every module that resolves a slot budget at all. A file that calls the resolver
   * is a file whose budget an operator is promised control of, so it is exactly the set this rule governs —
   * and a new client is covered on the commit that writes it rather than when somebody notices.
   */
  const FILES = [
    'server/src/files/media/providers.ts',
    'server/src/files/media/face-external.ts',
    'server/src/brain/nli-client.ts',
    'server/src/brain/rerank-client.ts',
    'server/src/brain/embedding.ts',
    'server/src/files/converters/vlm-client.ts',
    'server/src/files/converters/vlm-extract.ts',
  ].filter(f => /slotTimeoutMs/.test(src(f)) || /timeoutMs\s*:/.test(src(f)));

  it('the set of budget-resolving modules is not empty', () => {
    // A floor, because an empty list passes every loop written over it — and the two loops below are the
    // whole gate.
    assert.ok(FILES.length >= 6, `only ${FILES.length} modules matched — the derivation is wrong, not the code`);
  });

  it('nothing takes a caller value in FRONT of the resolver, unless it says so out loud', () => {
    // `x ?? slotTimeoutMs(...)` reads as a fallback and IS an override: the right side runs only when the
    // left is absent, so a caller that always supplies one makes the operator's setting unreachable. Four
    // slots shipped that way. The ordering belongs in `slotTimeoutMsOr`, where it is written once.
    //
    // `hardTimeoutMs` is the one sanctioned left operand, and the exemption is a NAME rather than a file or
    // a line number: the Verify button must answer in seconds while a slot budget may legally be half an
    // hour, so a caller taking that power has to spell it. Any other identifier here is the defect back.
    const offenders = [];
    for (const f of FILES) {
      for (const m of src(f).matchAll(/(\S+)\s*\?\?\s*slotTimeoutMs(?:Or)?\(/g)) {
        if (/\bhardTimeoutMs$/.test(m[1])) continue;
        offenders.push(`${f}: ${m[1]} ?? slotTimeoutMs…(...)`);
      }
    }
    assert.deepEqual(offenders, [],
      'these hand the operator\'s setting to `??` as the RIGHT operand, so a caller that supplies a value '
      + 'always wins and the setting is inert:\n  ' + offenders.join('\n  '));
  });

  it('the document pipeline offers its page budget as a default, not as an override', () => {
    // The specific site, because this is the one that shipped wrong and a rule with no witness is a claim.
    // `pageTimeoutMs` is the DOCUMENTS section's per-page control and stays meaningful — as the default the
    // four document slots fall back to.
    const s = src('server/src/files/converters/vlm-extract.ts');
    assert.doesNotMatch(s, /timeoutMs:\s*cfg\.pageTimeoutMs/,
      'a document model call still passes `timeoutMs: cfg.pageTimeoutMs`, which overrides whatever the '
      + 'operator set for that slot — pass it as `defaultTimeoutMs` instead');
    assert.match(s, /defaultTimeoutMs:\s*cfg\.pageTimeoutMs/,
      'the page budget must still reach the document slots as their default');
  });
});

describe('every slot has a door an operator can open', () => {
  /**
   * `CARD_SLOT` maps a Models-tab card to the slot it tunes, and the card renders the control. A slot absent
   * from it is a slot with no door at all: `05b-media-embedding.md` states there is deliberately no
   * environment variable for these, so that screen is the only one.
   */
  const clientSrc = src('client/src/app/pages/settings/media-processing/media-processing.types.ts');
  const doored = [...clientSrc.matchAll(/slot:\s*'([A-Za-z]+)'/g)].map(m => m[1]);

  it('CARD_SLOT is read, not guessed', () => {
    assert.ok(doored.length >= 7, `only ${doored.length} card-to-slot rows found — re-anchor this gate`);
  });

  it('covers every slot the server declares', () => {
    // Derived from `MODEL_SLOTS`, so an eleventh slot needs a door on the commit that adds it.
    const missing = [...MODEL_SLOTS].filter(s => !doored.includes(s));
    assert.deepEqual(missing, [],
      `these slots are settable through the API and have no control on the Models tab: ${missing.join(', ')}`);
  });

  it('every card that owns a slot can be saved on its own', () => {
    // A control with no Save is the same inert door in a different costume. `cardBlock` is the switch that
    // builds one card's PATCH; a card id it does not handle cannot send its slot.
    const state = src('client/src/app/pages/settings/media-processing/media-processing-state.service.ts');
    const cards = [...clientSrc.matchAll(/^\s*'?([a-z-]+)'?:\s*\{\s*slot:/gm)].map(m => m[1]);
    assert.ok(cards.length >= 7, `only ${cards.length} card ids parsed from CARD_SLOT — re-anchor this gate`);
    const unsaveable = cards.filter(c => !new RegExp(`case '${c}':`).test(state));
    assert.deepEqual(unsaveable, [],
      `these cards render a slot control that no per-card save can send: ${unsaveable.join(', ')}`);
  });
});
