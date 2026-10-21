/**
 * Whether a caller is an OIDC session is asked through ONE test, `isOidc` (`auth/oidc-caller.ts`), and how it authenticated is derived for
 * the audit trail by ONE pair, `auditAuthMethod` / `auditOidcSubject` (`audit/middleware.ts`) (Q-531, bundle-100 row 8).
 *
 * ## The rule
 *
 * The audit trail asked `source === 'oidc'`; the view owner key (`viewOwnerOf`), the MCP view acts' MFA rule and the view stream asked
 * `oidcIssuer !== undefined`; and the MCP views door re-derived `authMethod` and `oidcSubject` from the record while REST's view routes
 * asked the audit pair. Two tests agree only while every record that carries an issuer is a session and every session carries one, so a
 * view act could be audited as one kind of caller and owned as the other.
 *
 * Asserted over every tracked server source (derived, floor inside `trackedSources`):
 *
 * 1. no source outside `auth/oidc-caller.ts` tests the kind itself (`source === 'oidc'`, `oidcIssuer !== undefined`/`=== undefined`);
 * 2. no source outside `audit/middleware.ts` turns a caller into `'oidc' : 'pat'` itself - a door hands on what the audit pair derived.
 *
 * ## Seen red at 743562a5
 *
 * Rule 1 named `audit/middleware.ts` (its own `source === 'oidc'`), `config/view-shape.ts`, `mcp/tools/views.ts` and
 * `spaces/view-stream.ts`; rule 2 named `mcp/tools/views.ts`.
 *
 * Run: node --test testing/standalone/whether-a-caller-is-oidc-is-asked-once.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const TEST_HOME = 'server/src/auth/oidc-caller.ts';
const AUDIT_HOME = 'server/src/audit/middleware.ts';

const sources = readTrackedSources('server/src', { specs: false, untracked: true }).map(s => ({ file: s.file, code: stripComments(s.text) }));

describe('whether a caller is OIDC is asked once (Q-531)', () => {
  it('the kind of caller is tested by isOidc alone', () => {
    const home = sources.find(s => s.file === TEST_HOME);
    assert.ok(home && /export function isOidc\b/.test(home.code), `${TEST_HOME} no longer defines isOidc: the rule has lost its home`);
    const own = sources
      .filter(s => s.file !== TEST_HOME)
      .filter(s => /\bsource\s*[!=]==?\s*'oidc'|\.oidcIssuer\s*[!=]==?\s*undefined/.test(s.code))
      .map(s => s.file);
    assert.deepEqual(own, [], 'sites that test whether a caller is OIDC themselves; ask isOidc');
  });

  it('a door hands on the audit pair instead of deriving the auth method', () => {
    const own = sources
      .filter(s => s.file !== AUDIT_HOME)
      .filter(s => /\?\s*'oidc'\s*:\s*'pat'/.test(s.code))
      .map(s => s.file);
    assert.deepEqual(own, [], 'sites that derive authMethod themselves; hand on auditAuthMethod / auditOidcSubject');
  });
});
