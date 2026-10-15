/**
 * The limits on a CEL rule, as the editor shows them (bundle-23, F-46).
 *
 * The Schema tab prints a counter beside the rule and the message ("characters used / limit") and offers no "add rule" past
 * the per-type and per-space caps. These numbers are a SECOND COPY of the constants the server enforces in
 * `server/src/spaces/schema-rules.ts`, and a copy is acceptable only while something compares it:
 * `testing/client-limits-match-the-server.spec.ts` reads both files and fails when they differ, so a counter reading 1000
 * against a server that stopped at 800 cannot ship (it would tell an operator a rule fits and then refuse the save).
 *
 * The keys are the contract: `ruleMax` / `messageMax` are the longest a rule and its message may be, `perType` and `perSpace`
 * the most rules a type and the space may hold, `perRecord` the most that may APPLY to one record (type rules plus the space
 * rules whose kinds include it), `namePattern` what a rule's name must match and `nameMax` the longest such name (one leading
 * letter plus a tail of at most `nameMax - 1`).
 */
export const RULE_LIMITS = {
  ruleMax: 1000,
  messageMax: 300,
  perType: 50,
  perSpace: 50,
  perRecord: 50,
  nameMax: 64,
  namePattern: '^[a-z][a-zA-Z0-9_-]{0,63}$',
} as const;

/**
 * Is `name` one a rule may not take: a key of every JS object (`toString`, `isPrototypeOf`, `__proto__`, ...), or `prototype`? A rule map is
 * read by name, so such a name would reach the object's internals. ASKED, never listed, and asked the way the server asks it
 * (`schema-rules.ts`: `name in Object.prototype || name === 'prototype'`): a list is a second copy that misses the next name the platform adds.
 */
export function isReservedRuleName(name: string): boolean {
  return name in Object.prototype || name === 'prototype';
}

/** Does `name` satisfy the server's rule-name rule? */
export function isValidRuleName(name: string): boolean {
  return new RegExp(RULE_LIMITS.namePattern).test(name) && !isReservedRuleName(name);
}
