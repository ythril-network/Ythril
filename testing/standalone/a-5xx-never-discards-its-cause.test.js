/**
 * A route that answers 5xx from a `catch` must read the exception it caught.
 *
 * ## The finding
 *
 * The canary operator hit `DELETE /api/tokens/:id`, got `HTTP 500` in 6 ms, and asked us for the cause twice
 * over ten days. When they captured the pod log for that exact second it held **three unrelated OIDC warnings
 * and nothing else** — no line for the DELETE at all. So they built a hypothesis on the only evidence present
 * (that an expired session answers 500 where 401 belongs) and it was wrong; `resolveBearer` returning null
 * writes `401 Invalid or expired token`, and a throw reaches `app.ts`'s handler, which logs `Unhandled error:`.
 *
 * They were reasoning correctly from an empty log. Producing the empty log was ours.
 *
 * ## The shape, which is mechanically exact
 *
 * ```ts
 * } catch (err) {
 *   res.status(500).json({ error: 'Internal error' });   // `err` bound, and never read
 * }
 * ```
 *
 * **A catch that binds the error, answers 5xx, and never reads the binding has destroyed the only account of
 * what happened.** Nothing else in the system holds it: the response body is generic on purpose (see
 * `public-probes-leak-nothing.test.js`), and the global handler in `app.ts` never sees an exception that a
 * route already caught. Seven sites were in that state, `brain/entities.ts` among them — an entity write could
 * fail and leave no trace anywhere.
 *
 * ## Why the rule is "reads the binding" and not "calls the logger"
 *
 * Because both discharges are legitimate and the gate must accept either:
 *
 * - **report it** — `reportServerFailure('…', err)`, for a generic body (the operator gets it, the caller does
 *   not);
 * - **return it** — `res.status(507).json({ error: err.message, storageExceeded: true })`, where the caller is
 *   the one who has to act and the exception is already a refusal in words.
 *
 * A gate demanding a `log.` call would fail the second and push a quota refusal into the error log. What both
 * have in common — and what the defect lacks — is that **the binding is read**. That is the assertion.
 *
 * The rule is deliberately scoped to catch blocks that answer 5xx. An unread binding elsewhere is a different
 * and much larger question, and widening this gate to it would make it about tidiness rather than about
 * evidence.
 *
 * Run: node --test testing/standalone/a-5xx-never-discards-its-cause.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { trackedSources } from './_sources.mjs';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { blockAfter, enclosingBlockMatching } from './_structural-window.mjs';

/**
 * Every route file, tracked AND untracked-but-not-ignored.
 *
 * `git ls-files` alone cannot see a file added in the same change as the gate, which has bitten this repo
 * three times — a new router would be exempt on the commit that introduced it, which is the commit that
 * matters most.
 */
function routeFiles() {
  // `untracked: true` is the paragraph above, said at the call. The floor is 10 rather than the default 100
  // because this is one directory, and a floor above what a scan can ever return fails on correct code.
  return trackedSources('server/src/api', { untracked: true, floor: 10 });
}

const FIVE_XX = /res\.status\((5\d\d)\)/g;

/*
 * Both spellings of catching, because both discard a cause the same way.
 *
 * `catch (err) { … }` is the statement; `.catch((err: unknown) => { … })` is the promise handler, and
 * `spaces.ts` uses the second on the space-delete path. Matching only the statement form read that block as
 * `catch { }` — a binding of `null`, reported as the *worse* defect on a site that reads its error correctly.
 */
const CATCH_HEAD = /catch\s*(\(|\{)/;
const CATCH_BINDING = /catch\s*\(\s*\(?\s*([A-Za-z_$][\w$]*)/;

/**
 * Every 5xx response that sits inside a `catch`, with the block it sits in.
 *
 * Comments are stripped first: a `catch` written in prose above a handler would otherwise register as an
 * enclosing block, and — the direction that actually matters — the word `err` inside the comment EXPLAINING
 * that the cause is discarded would satisfy the assertion on the very code the gate exists to catch.
 */
function catchesAnswering5xx() {
  const out = [];
  for (const file of routeFiles()) {
    const src = stripComments(readFileSync(file, 'utf8'));
    for (const m of src.matchAll(FIVE_XX)) {
      const at = m.index;
      // The innermost enclosing CATCH, body included — not the innermost block of any kind. A 504 written
      // inside `catch (err) { if (err === SENTINEL) { … } }` sits in the `if`, and reading that block would
      // report a site that reads its binding one line up as one that never reads it at all.
      const block = enclosingBlockMatching(src, at, CATCH_HEAD, `${file} @${at}`);
      if (block === null) continue;                         // not in a catch — a deliberate status, not a swallow
      const binding = CATCH_BINDING.exec(block)?.[1] ?? null;
      out.push({ file, status: m[1], binding, block });
    }
  }
  return out;
}

describe('a 5xx never discards the exception that caused it', () => {
  it('finds the sites at all, so an empty sweep cannot pass', () => {
    // The failure mode this repo keeps meeting: a scan whose glob or matcher silently returns nothing reads
    // exactly like a clean codebase. 5xx-from-a-catch is a shape the API layer will always have some of.
    const sites = catchesAnswering5xx();
    assert.ok(
      sites.length >= 15,
      `only ${sites.length} 5xx-inside-catch sites found across the API — the scan has broken, not the codebase`,
    );
  });

  it('every one of them reads its binding', () => {
    const discarded = [];
    for (const site of catchesAnswering5xx()) {
      if (site.binding === null) {
        // `catch { … }` with no binding at all: there is nothing to read and nothing to report, so the cause is
        // gone before the handler starts. Worse than the unread binding, and rarer.
        discarded.push(`${site.file}: a ${site.status} inside \`catch { }\` — no binding, so the cause is unrecoverable`);
        continue;
      }
      // The head itself contains the binding, so count occurrences beyond the declaration.
      const uses = site.block.split(new RegExp(`\\b${site.binding}\\b`)).length - 1;
      if (uses < 2) {
        discarded.push(
          `${site.file}: a ${site.status} in a \`catch (${site.binding})\` that never reads \`${site.binding}\``,
        );
      }
    }
    assert.deepEqual(
      discarded, [],
      'These catch blocks answer 5xx and throw the exception away. Nothing else holds it — the response body '
      + 'is generic by design and app.ts never sees an exception a route already caught, so the failure exists '
      + 'only as a status code. Either report it to the operator with `reportServerFailure(where, err)` or '
      + 'return it to the caller in the body:\n  ' + discarded.join('\n  '),
    );
  });

  it('the helper reports the stack, not only the message', () => {
    // "Cannot read properties of undefined" without a stack sends the reader back to grep for which of eleven
    // `undefined`s it was — and the reader is an operator on another team who cannot grep this source at all.
    const helper = stripComments(readFileSync('server/src/util/report-failure.ts', 'utf8'));
    assert.match(helper, /cause\.stack/, 'reportServerFailure must include the stack');
    assert.match(helper, /log\.error\(/, 'a 5xx is an error, not a warning — it must be findable at that level');
    assert.match(
      // `where` is named through the bounded renderer (`peerText`, `Q-231`): the same operation, one rule under two spellings.
      helper, /\$\{(?:peerText\()?where\)?\}/,
      'the report must name the operation, or an operator greping for the route they called finds nothing',
    );
  });

  it('the revoke route reports its unreachable branch', () => {
    /*
     * The specific site the canary hit, pinned by name rather than left to the sweep.
     *
     * It has no `catch` — nothing throws — so the general rule above does not reach it: `listTokens()` found
     * the id and `revokeToken()` then removed nothing, which means the two disagreed about `config.tokens`
     * between one statement and the next. A branch that should be unreachable and fires anyway is the single
     * most valuable thing to have in a log, and this one had nothing.
     */
    const tokens = stripComments(readFileSync('server/src/api/tokens.ts', 'utf8'));
    /*
     * Anchored on `if (!removed)` and read FORWARD, not on the message and read outward. Reading outward from
     * the message lands in the object literal passed to `.json(…)`, whose innermost enclosing block is that
     * literal — so the window was three lines wide and could never have contained the call, whether or not it
     * was there. It passed nothing and failed everything, which is the same bug as a window that is too wide.
     */
    const at = tokens.indexOf('if (!removed)');
    assert.notEqual(at, -1, 'the revoke inconsistency branch is gone — re-point this gate');
    const block = blockAfter(tokens, at, 'the revoke !removed branch');
    assert.match(block, /was listed but could not be removed/, 'wrong `if (!removed)` — re-point this gate');
    assert.match(
      block, /reportServerFailure\(/,
      'the revoke 500 must leave a log line. It did not, and that is the whole reason a canary operator spent '
      + 'ten days attributing it to an expired OIDC session.',
    );
  });
});
