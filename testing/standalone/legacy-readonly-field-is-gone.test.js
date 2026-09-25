/**
 * The first of the three pre-3.0 token fields is deleted: `TokenRecord.readOnly`.
 *
 * ## Why this one first, and why it is safe
 *
 * Nothing decided on it any more. `toolIsVisible` asks `canWriteAnywhere(rights)`, every REST guard asks
 * `effectiveRung`, and the `ToolContext.readOnly` that was threaded from the record through
 * `createGlobalMcpServer` into every tool's context was **read by no tool at all** — four layers of plumbing
 * carrying a value nobody consulted.
 *
 * D-8d is otherwise atomic: a field cannot be half-removed. But there are THREE fields, and per-field
 * measurement made a real scope cut available — `readOnly` was 6 type errors across 4 files, against 23 for
 * `spaces` and 13 for `admin`. One field, deleted completely, beats three fields half-done.
 *
 * ## What must NOT disappear with it
 *
 * A token minted before the matrix existed still has its scope derived from these fields at load, by
 * `migrateToken`. That reads `LegacyToken` — its own interface over raw stored config — so deleting the
 * runtime field cannot strand a pre-3.1 record. `createToken` also keeps `readOnly` as an INPUT, because
 * "mint a read-only token" is the commonest grant and forcing every caller to hand-build a matrix to say it
 * would be a worse API.
 *
 * The distinction this file pins: **gone as a stored field and as a decision input, kept as a migration
 * input and a mint parameter.**
 *
 * Run: node --test testing/standalone/legacy-readonly-field-is-gone.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { stripComments } from './_strip-comments.mjs';

const src = (p) => stripComments(readFileSync(p, 'utf8'));

let migrateToken;
before(async () => {
  ({ migrateToken } = await import('../../server/dist/auth/rights-migration.js'));
});

describe('the field is gone from the record and from the plumbing', () => {
  it('TokenRecord no longer declares it', () => {
    // Bounded by the interface's own braces. It was `slice(anchor, anchor + 400)`, and both halves of that
    // were wrong: the anchor sat inside a field that later got deleted, and a CHARACTER count covers a
    // different number of LINES in a CRLF working copy than in CI's LF checkout. A sibling gate passed here
    // and failed in CI on exactly that difference. See the same helper in
    // `legacy-admin-field-is-gone.test.js`.
    const types = src('server/src/config/types.ts');
    const at = types.indexOf('export interface TokenRecord {');
    assert.ok(at > 0, 'the TokenRecord interface was not found — the scanner is wrong, not the code');
    const block = types.slice(at, types.indexOf('\n}', at));
    assert.match(block, /\bid: string;/, 'and this really is TokenRecord, not an empty slice');
    assert.doesNotMatch(block, /readOnly\?: boolean;/, 'the stored field must be gone');
  });

  it('nothing writes it onto a record', () => {
    // Indentation is the discriminator, and it has to be: the record literal and the `migrateToken` argument
    // are the same text — `readOnly: opts.readOnly ?? false,` — and only one of them may survive. Record
    // fields sit at four spaces, the migrate call's arguments at six.
    const tokens = src('server/src/auth/tokens.ts');
    assert.doesNotMatch(tokens, /^ {4}readOnly:/m, 'a record literal must not carry it');
    assert.match(tokens, /^ {6}readOnly: opts\.readOnly \?\? false,/m,
      'while the migrateToken argument must remain — that is the whole safety property');
  });

  it('ToolContext no longer declares it, and the MCP server no longer takes it', () => {
    assert.doesNotMatch(src('server/src/mcp/tools/types.ts'), /readOnly\?: boolean;/,
      'four layers of plumbing for a value no tool read');
    assert.doesNotMatch(src('server/src/mcp/router.ts'), /createGlobalMcpServer\(tokenSpaces\?: string\[\], readOnly/,
      'the parameter must be gone from the signature');
  });

  it('and no tool reads it — which is what made this safe', () => {
    // Asserted rather than assumed. If a tool starts consulting a `readOnly` on its context, this fails
    // before the field can be reintroduced to feed it.
    // `git grep` exits 1 when it finds nothing, and `|| true` is not cmd.exe syntax — so the shell form is
    // not portable here. Catch the exit code instead: no match IS the passing case.
    let out = '';
    try {
      out = execSync('git grep -l "ctx.readOnly" -- server/src', { encoding: 'utf8', stdio: 'pipe' }).trim();
    } catch {
      out = ''; // exit 1 = no matches
    }
    assert.equal(out, '', `these read a context flag that no longer exists: ${out}`);
  });
});

describe('the API response still carries readOnly, derived', () => {
  /**
   * The contract this nearly broke, and why the assertion belongs HERE.
   *
   * Removing the stored field also removed it from `GET /api/tokens`, and the only thing pinning that shape
   * was an INTEGRATION test — Docker-only, so `preflight` cannot run it and the break reached CI.
   *
   * D-8d's goal is that nothing STORES the flag and nothing DECIDES on it. Dropping it from a published
   * response is a separate, breaking change to a contract clients read, and it does not belong in the same
   * release as an internal cleanup. So the response keeps it, derived — the same shape the
   * `space.description` alias used while that field was on its way out.
   */
  it('every response path applies the alias', () => {
    const api = src('server/src/api/tokens.ts');
    assert.match(api, /listTokens\(\)\.map\(withReadOnlyAlias\)/, 'the list');
    assert.match(api, /withReadOnlyAlias\(safeRecord\)/, 'the create response');
    assert.match(api, /withReadOnlyAlias\(updated\)/, 'the patch response');
  });

  it('and it is derived from the matrix, not from a stored flag', () => {
    assert.match(src('server/src/api/tokens.ts'), /readOnly: !canWriteAnywhere\(/,
      'read-only means "no write rung anywhere", which is the honest definition');
  });

  it('the derived answer matches what the flag said, for every legacy shape', async () => {
    // The agreement that makes the alias a faithful replacement rather than a plausible one — a
    // schema-library token in particular is asserted `readOnly: true` by the integration suite.
    const { canWriteAnywhere } = await import('../../server/dist/auth/write-anywhere.js');
    for (const [legacy, expected] of [
      [{ schemaLibrary: true, spaces: [] }, true],
      [{ readOnly: true, spaces: ['qa'] }, true],
      [{ readOnly: true }, true],
      [{ spaces: ['qa'] }, false],
      [{ admin: true }, false],
    ]) {
      assert.equal(!canWriteAnywhere(migrateToken(legacy)), expected,
        `${JSON.stringify(legacy)} should be readOnly=${expected}`);
    }
  });
});

describe('what it is replaced BY still answers the question', () => {
  it('the token listing derives read-only from the matrix', () => {
    // Better than the flag it replaces: correct for a token that was never given the boolean but holds only
    // `read`, which the old display called nothing at all.
    assert.match(src('server/src/mcp/tools/spaces.ts'), /canWriteAnywhere\(t\.rights/,
      'read-only is now a property of the rights, not a boolean somebody set');
  });
});

/*
 * ── A PRE-MATRIX TOKEN KEEPS ITS SCOPE ───────────────────────────────────────────────────────
 *
 * The safety property of the whole deletion: `LegacyToken` is its own interface over raw stored config, so
 * the runtime field going away cannot strand a record written before the matrix existed. That
 * `migrateToken` still reads `readOnly` — rows at `read`, a `read` floor when unscoped, `write` when neither
 * flag is set — is asserted per shape in `rights-migration-never-widens.test.js`, the one home of the
 * legacy-field mapping (`Q-45.4`).
 */

describe('minting a read-only token is still sayable', () => {
  it('createToken keeps it as an input', () => {
    // Dropping the parameter too would have forced every caller to hand-build a matrix to express the
    // commonest grant there is.
    const tokens = src('server/src/auth/tokens.ts');
    assert.match(tokens, /readOnly\?: boolean;/, 'still a parameter');
    assert.match(tokens, /readOnly: opts\.readOnly \?\? false,\s*\n\s*spaces: opts\.spaces,/,
      'and still feeds migrateToken, which is the only thing it does now');
  });
});
