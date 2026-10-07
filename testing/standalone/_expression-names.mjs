/**
 * What an expression is CALLED, looking through the wrappers that do not change it.
 *
 * ## The question it answers
 *
 * *"What name does this expression end in?"* — `auth.peerInstanceId` is `peerInstanceId`, `(await deliveryOf(…))` is a
 * call named `deliveryOf`, `delivery!` and `delivery as Delivery` are `delivery`. The two source readers that ask
 * whether a tombstone's authority is spelled by hand (`_authority-comparisons.mjs`, `_delivery-arguments.mjs`) both
 * need it, and each had written the same wrapper list.
 *
 * ## What it prevents
 *
 * A reader that unwraps parentheses and forgets `await` or `as` stops seeing a call the moment someone writes it the
 * other way, and the gate built on it reports clean. One list of wrappers, so a new one (`satisfies`) is added once.
 */
import { ts } from '../_shared/syntax-tree.mjs';

/** The expression under any parentheses, `!`, `as`, `satisfies` and `await`. */
export function unwrapExpression(e) {
  while (e && (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e)
    || ts.isSatisfiesExpression(e) || ts.isAwaitExpression(e))) e = e.expression;
  return e;
}

/** The last name of an identifier or property access (`a.b.c` is `c`), or `undefined` for anything else. */
export function lastName(e) {
  const x = unwrapExpression(e);
  return ts.isIdentifier(x) ? x.text : ts.isPropertyAccessExpression(x) ? x.name.text : undefined;
}

/** The last name of what a call calls: `deliveryOf` for `deliveryOf(…)` and for `ns.deliveryOf(…)`. */
export const calleeNameOf = (call) => lastName(call.expression);
