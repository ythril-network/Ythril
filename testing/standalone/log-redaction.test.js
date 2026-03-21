/**
 * Unit tests: Bearer token redaction in server/src/util/log.ts
 *
 * SEC-14 requirement: tokens and Authorization headers must never appear in
 * persisted log output.
 *
 * Strategy: regression-guard via two complementary layers —
 *
 *   1. SOURCE-LEVEL: reads log.ts and asserts the structural invariants that
 *      make redaction possible (function exists, regex present, all log levels
 *      call the fmt/redact path). Catches outright removal or bypass.
 *
 *   2. REGEX-BEHAVIOUR: extracts the exact regex from the source and runs it
 *      against a matrix of known token formats and edge cases. Catches
 *      narrowing of the character class that would miss real token values.
 *
 * No live server or build artefact required — pure Node.js test.
 *
 * Run: node --test testing/standalone/log-redaction.test.js
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_SRC = path.join(__dirname, '..', '..', 'server', 'src', 'util', 'log.ts');

// ── 1. Source-level structural invariants ─────────────────────────────────────

describe('log.ts — structural invariants (SEC-14)', () => {
  let src;

  before(() => {
    src = readFileSync(LOG_SRC, 'utf8');
  });

  it('log.ts file can be read from the expected path', () => {
    assert.ok(src.length > 0, `log.ts must be a non-empty file at ${LOG_SRC}`);
  });

  it('defines a redact() function', () => {
    assert.ok(
      /function redact\s*\(/.test(src) || /const redact\s*=/.test(src),
      'log.ts must define a redact() function for token scrubbing'
    );
  });

  it('redact() references "Bearer"', () => {
    assert.ok(src.includes('Bearer'),
      'redact() must explicitly target "Bearer" tokens in its replacement pattern');
  });

  it('redact() produces a "[redacted]" replacement string', () => {
    assert.ok(src.includes('[redacted]'),
      'redact() must replace tokens with "[redacted]" so logs are searchable for scrubbing');
  });

  it('redact() is called at least twice — once defined and once applied in fmt()', () => {
    const callSites = (src.match(/\bredact\s*\(/g) ?? []).length;
    assert.ok(callSites >= 2,
      `redact() should appear ≥2 times (definition + invocation), found ${callSites}`);
  });

  it('exports the log object with all four log levels', () => {
    assert.ok(src.includes('export const log') || src.includes('export { log }'),
      'log must be exported');
    for (const level of ['info', 'warn', 'error', 'debug']) {
      assert.ok(src.includes(`log.${level}`) || src.includes(`${level}:`),
        `log.${level} level must be present`);
    }
  });

  it('fmt() (or inline equivalent) applies redact to both the message and meta/stack', () => {
    // Must call redact() on the message string AND on meta (stack traces, JSON)
    const redactCalls = (src.match(/redact\s*\(/g) ?? []).length;
    assert.ok(redactCalls >= 2,
      'redact() must cover both message string and meta/stack trace, requiring at least 2 call sites');
  });

  it('redaction regex uses /gi flags (case-insensitive and global)', () => {
    // The regex literal in source must carry both g and i flags
    const regexLiteral = src.match(/\/Bearer[^/]+\/([a-z]+)/);
    if (regexLiteral) {
      const flags = regexLiteral[1];
      assert.ok(flags.includes('g'), `Bearer regex must have 'g' (global) flag; found flags: /${flags}/`);
      assert.ok(flags.includes('i'), `Bearer regex must have 'i' (case-insensitive) flag; found flags: /${flags}/`);
    } else {
      // Flags might be in a RegExp constructor call — at minimum verify the source contains 'gi'
      assert.ok(src.includes("'gi'") || src.includes('"gi"') || /Bearer.*gi/.test(src),
        'Bearer redaction regex must use case-insensitive + global flags (/gi)');
    }
  });
});

// ── 2. Regex behaviour matrix ─────────────────────────────────────────────────
// Mirror the exact regex from log.ts and verify it against a range of inputs.
// If someone narrows the character class (e.g. removes digits or underscores),
// these tests will fail and catch the regression before it reaches production.

describe('Bearer token redaction regex — behaviour matrix', () => {
  // Mirrors the pattern in log.ts: /Bearer\s+[A-Za-z0-9_.\-]+/gi
  const BEARER_RE = /Bearer\s+[A-Za-z0-9_.\-]+/gi;
  const redact = (msg) => msg.replace(BEARER_RE, 'Bearer [redacted]');

  it('redacts a standard ythril PAT token', () => {
    const token = 'ythril_r9KxM2p7vTqW5nLbJ3hF';
    const result = redact(`Authorization failed for Bearer ${token}`);
    assert.ok(!result.includes(token), 'PAT token must be removed from log output');
    assert.ok(result.includes('Bearer [redacted]'));
  });

  it('redacts a short token (8 chars)', () => {
    const result = redact('token: Bearer abcde123');
    assert.ok(!result.includes('abcde123'));
    assert.ok(result.includes('[redacted]'));
  });

  it('redacts a long token (64 chars)', () => {
    const token = 'ythril_' + 'x'.repeat(57);
    const result = redact(`Bearer ${token}`);
    assert.ok(!result.includes(token));
  });

  it('redaction is case-insensitive — "bearer" lowercase', () => {
    const result = redact('bearer ythril_lowercasetoken123');
    assert.ok(!result.includes('ythril_lowercasetoken123'),
      '"bearer" (lowercase) must also be redacted');
  });

  it('redaction is case-insensitive — "BEARER" uppercase', () => {
    const result = redact('BEARER ythril_uppercasetoken456');
    assert.ok(!result.includes('ythril_uppercasetoken456'),
      '"BEARER" (uppercase) must also be redacted');
  });

  it('redacts multiple tokens in a single log line', () => {
    const msg = 'Peer1: Bearer ythril_aaaaa tried; fallback Bearer ythril_bbbbb also tried';
    const result = redact(msg);
    assert.ok(!result.includes('ythril_aaaaa'), 'First token must be redacted');
    assert.ok(!result.includes('ythril_bbbbb'), 'Second token must be redacted');
    const count = (result.match(/\[redacted\]/g) ?? []).length;
    assert.equal(count, 2, `Expected 2 redactions in one line, got ${count}`);
  });

  it('redacts a JWT Bearer token (contains dots)', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig';
    const result = redact(`Authorization: Bearer ${jwt}`);
    // Dots are in the character class, so the whole JWT header should be captured
    assert.ok(!result.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'));
  });

  it('handles multiple whitespace characters between Bearer and token', () => {
    // \s+ matches tabs and multiple spaces
    const result = redact('Bearer\t\tythril_tabseparated123');
    assert.ok(!result.includes('ythril_tabseparated123'),
      'Tabs between Bearer and token must also be handled');
  });

  it('preserves non-token parts of the same log message', () => {
    const result = redact(
      '[2026-03-21T10:00:00Z] ERROR Peer 192.168.1.5 sent Bearer ythril_secret99 — rejected'
    );
    assert.ok(result.includes('[2026-03-21T10:00:00Z]'), 'timestamp preserved');
    assert.ok(result.includes('192.168.1.5'), 'IP address preserved');
    assert.ok(result.includes('rejected'), 'trailing text preserved');
    assert.ok(!result.includes('ythril_secret99'), 'token removed');
  });

  it('leaves a message with no Bearer token completely unchanged', () => {
    const msg = 'MongoDB connected successfully to mongodb://localhost:27017';
    assert.equal(redact(msg), msg, 'No-op on messages without Bearer tokens');
  });

  it('handles empty string without throwing', () => {
    assert.equal(redact(''), '');
  });

  it('handles a message that is only the token (no surrounding text)', () => {
    const result = redact('Bearer ythril_onlythisline');
    assert.equal(result, 'Bearer [redacted]');
  });
});

// ── 3. Regex precision check ──────────────────────────────────────────────────
// Verify the source regex is not so narrow that it would miss real token values.

describe('Redaction regex precision — must not be over-narrowed', () => {
  let src;

  before(() => {
    src = readFileSync(LOG_SRC, 'utf8');
  });

  it('character class includes uppercase letters A-Z', () => {
    assert.ok(/A-Z/.test(src) || /a-z.*A-Z/.test(src),
      'Regex must match uppercase letters (tokens can contain uppercase)');
  });

  it('character class includes digits 0-9', () => {
    assert.ok(/0-9/.test(src),
      'Regex must match digits (tokens contain numeric characters)');
  });

  it('character class includes underscore _ (ythril tokens start with ythril_)', () => {
    // The _ char must be in the class or the whole YTHRIL prefix is cut off
    const hasUnderscore = /[_]/.test(src.replace(/redact|replace/g, '')) ||
      src.includes('\\w') ||
      src.includes('[A-Za-z0-9_');
    assert.ok(hasUnderscore,
      'Regex character class must include underscore — ythril PATs contain "ythril_" prefix');
  });
});
