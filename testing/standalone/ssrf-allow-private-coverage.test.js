/**
 * Every `ssrfSafeFetch` call decides `allowPrivate` on purpose — passing it, or writing down why not.
 *
 * `ssrfSafeFetch(url, init)` is a perfectly well-typed call that silently means "refuse private
 * addresses". That default is the right one, but it makes an *omission* indistinguishable from a
 * *decision*, and the omission is invisible at the call site: nothing is missing, nothing is red, the
 * code reads as complete.
 *
 * That is exactly how the model-endpoint probe shipped broken. `probeModelStages` gate-checked the URL
 * with `allowPrivateModelEndpoints()` and then called a probe that dropped the flag one line later, so
 * an operator who had correctly enabled the opt-in was told every self-hosted endpoint was SSRF-blocked
 * — while inference on those same endpoints would have worked, because every real provider client did
 * pass it. The bug lived entirely in the surface built to tell them whether it worked.
 *
 * A type cannot catch this (the parameter is optional by design, and must stay optional). A reviewer
 * catches it only by knowing which of two near-identical URL classes a given call belongs to. So the
 * rule is written down instead: pass the flag, or say `allowPrivate stays false` and give the reason.
 *
 * The distinction the reason has to make:
 *   - MODEL egress — an endpoint the operator chose to send work to. The opt-in governs it.
 *   - NOTIFICATION / CATALOG egress — a URL this server POSTs to or pulls from on an event. Pointing it
 *     inward IS the SSRF primitive, and no model-endpoint setting may relax it.
 *
 * Run: node --test testing/standalone/ssrf-allow-private-coverage.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { bodyOf } from './_structural-window.mjs';
import { SERVER_CODE_ROOTS, SERVER_SOURCE_ROOT } from './_sources.mjs';

const ROOT = SERVER_SOURCE_ROOT;
/** The guard's own module defines the parameter — it is not a caller. */
const SELF = 'server/src/util/ssrf.ts';
/** The written opt-out. Deliberately a sentence fragment, so it reads as prose in the comment. */
const OPT_OUT = 'allowPrivate stays false';
/** How far above a call an opt-out comment may sit. */
const COMMENT_WINDOW = 8;

function sources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = `${dir}/${name}`;
    if (statSync(p).isDirectory()) { sources(p, out); continue; }
    if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

/**
 * Extract each `ssrfSafeFetch(...)` call with balanced parentheses.
 *
 * A regex cannot do this: every one of these calls contains nested parens and object literals, and a
 * non-greedy match stops at the first `)` — which lands inside `AbortSignal.timeout(5_000)`, before the
 * third argument is ever reached. That truncation would make a *passing* call look like an omission and
 * an omitting call look fine depending only on how the init object was written.
 */
export function findCalls(src) {
  const calls = [];
  const NEEDLE = 'ssrfSafeFetch(';
  for (let i = src.indexOf(NEEDLE); i >= 0; i = src.indexOf(NEEDLE, i + 1)) {
    // Skip mentions in prose and in import statements — only a real invocation counts.
    const lineStart = src.lastIndexOf('\n', i) + 1;
    const before = src.slice(lineStart, i).trim();
    if (before.startsWith('*') || before.startsWith('//') || before.startsWith('import')) continue;

    let depth = 0;
    let end = -1;
    for (let j = i + NEEDLE.length - 1; j < src.length; j++) {
      if (src[j] === '(') depth++;
      else if (src[j] === ')' && --depth === 0) { end = j; break; }
    }
    if (end < 0) continue; // unbalanced — a syntax error the compiler will catch first
    calls.push({ line: src.slice(0, i).split('\n').length, text: src.slice(i, end + 1) });
  }
  return calls;
}

describe('ssrfSafeFetch callers decide allowPrivate deliberately', () => {
  const files = SERVER_CODE_ROOTS.flatMap(root => sources(root)).filter(f => f !== SELF);

  it('finds the call sites at all', () => {
    const total = files.reduce((n, f) => n + findCalls(readFileSync(f, 'utf8')).length, 0);
    // Guards the scanner itself: a broken matcher would make this whole suite vacuously green.
    assert.ok(total >= 10, `expected the guard to be widely used, found ${total} call sites`);
  });

  it('every call passes allowPrivate or documents why it does not', () => {
    const offenders = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const lines = src.split('\n');
      for (const call of findCalls(src)) {
        if (call.text.includes('allowPrivate')) continue;
        const window = lines.slice(Math.max(0, call.line - 1 - COMMENT_WINDOW), call.line).join('\n');
        if (window.includes(OPT_OUT)) continue;
        offenders.push(`${f}:${call.line}  ${call.text.replace(/\s+/g, ' ').slice(0, 90)}`);
      }
    }
    assert.deepEqual(offenders, [],
      `these omit allowPrivate without saying why. Omitting it means "refuse private addresses" — ` +
      `correct for a webhook or a catalog, and a broken self-hosted deployment for a model endpoint. ` +
      `Pass { allowPrivate: ... }, or write "${OPT_OUT}" with the reason above the call:\n` +
      offenders.join('\n'));
  });

  it('the model-endpoint probe passes it — the regression that motivated this rule', () => {
    // Named explicitly. The generic rule above is satisfied by any mention of allowPrivate, and this is
    // the one call site where a future "simplification" back to a two-argument call breaks a documented
    // deployment shape rather than merely loosening a convention.
    const src = readFileSync(`${ROOT}/api/media-config.ts`, 'utf8');
    const body = bodyOf(src, 'probeModelEndpoint');
    // Per SLOT, not instance-wide. The probe has to resolve the same permission the inference client will,
    // and those two now differ per endpoint: an operator who kept one slot strict must see that slot's
    // probe refuse, and an operator who widened another must see that one go through.
    assert.match(body, /ssrfSafeFetch\([^;]*allowPrivate:\s*allowPrivateForSlot\(opts\.slot\)/s,
      'probeModelEndpoint must honour the egress permission of the slot it is probing, or it reports a ' +
      'private self-hosted endpoint as blocked while inference against it actually works (or the reverse)');
  });

  it('the probe cannot be called without naming its slot', () => {
    // The failure this forecloses is a silent default. If `slot` were optional with a fallback, a new
    // caller would inherit whichever slot the fallback names — and the probe would report a verdict
    // computed under a policy belonging to a different endpoint. Making it required turns that into a
    // compile error at the call site, where the answer is known.
    const src = readFileSync(`${ROOT}/api/media-config.ts`, 'utf8');
    const at = src.indexOf('export async function probeModelEndpoint');
    const sig = src.slice(at, src.indexOf('): Promise<ProbeResult>', at));
    assert.match(sig, /slot:\s*EgressSlot/, 'probeModelEndpoint must take a required `slot`');
    assert.ok(!/slot\?:/.test(sig), '`slot` must not be optional — a default would probe under another endpoint\'s policy');
  });

  it('webhook delivery does NOT inherit the model opt-in', () => {
    // The opposite failure: someone reads this test, sees "pass allowPrivate", and threads the model
    // flag into the webhook dispatcher to make it green. That would turn an operator's inference
    // preference into an outbound SSRF primitive.
    //
    // Comment lines are skipped, and the reason is not cosmetic: the comment that explains this very
    // rule names the flag, so a naive substring check fails on the prose defending the invariant. A gate
    // that trips on its own justification teaches people to delete the justification.
    const src = readFileSync(`${ROOT}/webhooks/dispatcher.ts`, 'utf8');
    const code = src.split('\n')
      .filter(l => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); })
      .join('\n');
    // Both spellings: the per-slot resolver is the one a future change would actually reach for, and a
    // check that names only the old function would wave it through.
    for (const banned of ['allowPrivateModelEndpoints', 'allowPrivateForSlot']) {
      assert.ok(!code.includes(banned),
        `webhook delivery must not consult ${banned} — a self-hosted model endpoint says nothing about ` +
        'where a webhook may point');
    }
  });
});
