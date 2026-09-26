/**
 * Every path that mints a token stores a rights matrix.
 *
 * ## Why this is a gate and not a note
 *
 * `createToken` was given an unconditional matrix because the load-time backfill runs once, over the tokens
 * already in the config — so a token minted afterwards had none until the next restart. Its comment records
 * what that cost: *"a plain non-admin token deleted a memory over REST with a 204 where a rights-bearing
 * `write` token got a 403 for the same call."*
 *
 * **That fix was applied to one of the two minting paths.** `createOAuthToken` kept storing no matrix at all,
 * so every MCP connector token was matrix-less. It stayed invisible because a missing matrix meant "fall back
 * to the legacy flags" — and stopped being invisible the moment `toolIsVisible` began failing closed, at which
 * point a freshly minted connector could not call a single mutating tool.
 *
 * One rule, applied to the instance that was reported and not to the other one. This file is the sweep that
 * should have accompanied the original fix: it derives the minting paths from the SOURCE rather than from a
 * list somebody remembered to update.
 *
 * Run: node --test testing/standalone/every-minted-token-has-rights.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);

const strip = s => s.replace(/(^|[^:])\/\/.*/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
const SRC = strip(readFileSync('server/src/auth/tokens.ts', 'utf8'));

/**
 * Every `const record: TokenRecord = { … }` literal in the token store, with its enclosing function name.
 *
 * Derived from the source, so a THIRD minting path added tomorrow is covered without anybody remembering
 * this file exists — which is the whole failure being gated against.
 */
function mintedRecords() {
  const out = [];
  const re = /export async function (\w+)\(/g;
  const fns = [...SRC.matchAll(re)].map(m => ({ name: m[1], at: m.index }));
  for (let i = 0; i < fns.length; i++) {
    const body = SRC.slice(fns[i].at, i + 1 < fns.length ? fns[i + 1].at : SRC.length);
    if (/const record: TokenRecord = \{/.test(body)) out.push({ name: fns[i].name, body });
  }
  return out;
}

describe('no minting path can store a token without a matrix', () => {
  it('found the minting paths at all', () => {
    // A detector that finds nothing reports every codebase clean. Both known paths must be seen, and the
    // count is asserted loosely upward so adding one does not fail here — it fails the real check below.
    const names = mintedRecords().map(m => m.name).sort();
    assert.ok(names.includes('createToken'), `createToken not found; detector saw ${JSON.stringify(names)}`);
    assert.ok(names.includes('createOAuthToken'), `createOAuthToken not found; saw ${JSON.stringify(names)}`);
  });

  it('every one of them sets `rights` on the record it stores', () => {
    const missing = mintedRecords()
      .filter(m => !/^\s*rights: /m.test(m.body))
      .map(m => m.name);
    assert.deepEqual(missing, [],
      'a token stored without a matrix falls back to the legacy flags on every guard that tolerates an '
      + 'absent one, and is refused outright by every guard that fails closed');
  });

  it('and derives it from migrateToken rather than hand-rolling one', () => {
    // Two hand-written claims-to-rungs mappings is how the two halves of one migration ended up disagreeing
    // about whether `spaces: null` could happen. There is one mapping.
    for (const m of mintedRecords()) {
      assert.match(m.body, /rights: opts\.rights \?\? \(migrateToken\(\{/,
        `${m.name} must inherit an explicit matrix or derive one with migrateToken`);
    }
  });
});

describe('every write of a token\'s rights applies the instance-admin grant', () => {
  // Owner, 2026-09-26: granting instance admin SETS space admin on the floor. Stored, so every door that writes
  // rights must pass through the one function that states it — a minting path that skipped it would store an
  // instance admin that reaches nothing, which is exactly what was seen on ythril-home.
  it('every minting path stores withInstanceAdminGrants(...) as the record\'s rights', () => {
    for (const m of mintedRecords()) {
      assert.match(m.body, /withInstanceAdminGrants\(/, `${m.name} stores rights without the instance-admin grant`);
    }
  });

  it('setTokenRights applies it too', () => {
    const at = SRC.indexOf('export function setTokenRights(');
    assert.ok(at >= 0, 'setTokenRights not found');
    const body = SRC.slice(at, SRC.indexOf('\nexport ', at + 10));
    assert.match(body, /withInstanceAdminGrants\(/, 'editing a token to instance admin would store it without the floor');
  });
});

describe('every rights value DERIVED from legacy fields applies the instance-admin grant too', () => {
  // The minting paths above are not the only doors that produce a token's rights. An OIDC identity's rights are
  // derived per request by `migrateToken`, and so is the minter's own matrix when its record has none; both
  // skipped the grant, so an OIDC instance admin reached only the spaces its claim named — the S-11 symptom,
  // found by the pre-ship lens sweep. The derivation sites are found from the source, not listed.
  const { execFileSync } = require_('node:child_process');
  const files = execFileSync('git', ['grep', '-l', 'migrateToken(', '--', 'server/src'], { encoding: 'utf8' })
    .split('\n').map(s => s.trim().replace(/\\/g, '/')).filter(Boolean)
    // A comment naming the function is not a call.
    .filter(f => /migrateToken\(/.test(strip(readFileSync(f, 'utf8'))));
  // Each exemption carries its reason; a file that stops calling migrateToken fails below rather than lingering.
  const EXEMPT = new Map([
    ['server/src/auth/rights-migration.ts', 'defines migrateToken'],
    ['server/src/auth/backfill-token-rights.ts', 'runs in loadConfig; the instance-admin floor migration runs after it on the same tokens'],
    ['server/src/networks/network-spaces.ts', 'reads one perSpace row of a non-admin derivation; no identity carries it'],
  ]);

  it('found the derivation sites at all', () => {
    assert.ok(files.length >= 4, `git grep found only ${files.length} files calling migrateToken`);
  });

  it('every exemption still names a file that calls migrateToken', () => {
    for (const f of EXEMPT.keys()) assert.ok(files.includes(f), `${f} is exempt but no longer calls migrateToken`);
  });

  it('a rights edit is audited as stored, grant included', () => {
    const src = strip(readFileSync('server/src/api/tokens.ts', 'utf8'));
    const at = src.indexOf('req.auditSnapshots = {');
    assert.ok(at > -1, 'the token edit no longer records an audit snapshot — re-anchor this gate');
    assert.match(src.slice(at, src.indexOf('};', at)), /rights: rights \? withInstanceAdminGrants\(/,
      'the audit entry must show the rights as stored, not as submitted');
  });

  it('every other file that derives rights applies withInstanceAdminGrants', () => {
    const missing = files.filter(f => !EXEMPT.has(f)).filter(f => !/withInstanceAdminGrants\(/.test(strip(readFileSync(f, 'utf8'))));
    assert.deepEqual(missing, [], 'these derive a token\'s rights and store or use an instance admin without its space-admin floor');
  });
});

describe('the OAuth flow inherits the matrix rather than re-deriving it', () => {
  const OAUTH = strip(readFileSync('server/src/mcp/oauth.ts', 'utf8'));

  it('carries the authorising token\'s rights through the auth-code entry', () => {
    // Re-deriving from `admin`/`readOnly`/`spaces` WIDENS: those three cannot express a per-area grant, so a
    // PAT holding `{ knowledge: write, files: read }` on a space comes back as write in both. The connector
    // would be able to write files its authorising token could only read.
    assert.match(OAUTH, /rights: \(record as \{ rights\?: TokenRecord\['rights'\] \}\)\.rights/,
      'the auth-code entry must capture the matrix');
    assert.match(OAUTH, /\.\.\.\(entry\.identity\.rights \? \{ rights: entry\.identity\.rights \} : \{\}\)/,
      'and hand it to the mint call');
  });
});
