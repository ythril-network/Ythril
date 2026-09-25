/**
 * Every peer URL a request can supply is admitted by ONE declaration.
 *
 * ## The rule, and where it was written four times
 *
 * A peer URL has to clear three checks before it is stored or connected to: it must parse, it must not point
 * somewhere SSRF-unsafe (loopback, RFC-1918, IMDS, ULA, embedded credentials), and its SCHEME must be
 * permitted — `https://` always, `http://` only when the operator has set `allowInsecurePeers` and
 * `requireEncryptedTransport` is off.
 *
 * `SSRF_SAFE_URL` in `api/networks/_shared.ts` is that rule, and its own comment calls the chain
 * security-critical because *"a bare `z.string()` still compiles and still type-checks, but silently accepts
 * loopback/IMDS/ULA peers"*. Three other places declared their own version:
 *
 * | site | parses | SSRF | scheme |
 * |---|---|---|---|
 * | `SSRF_SAFE_URL` — members, join's member body, topology | yes | yes | yes |
 * | `INVITE_SSRF_SAFE_URL` in `api/invite.ts` | yes | yes | yes — a byte-identical COPY |
 * | `inviteUrl` in `api/networks/join.ts` | yes | yes | **no** |
 * | `myUrl` in `api/networks/join.ts` | yes | **no** | **no** |
 *
 * The identical copy is the one that would drift; the two in `join.ts` had already diverged.
 *
 * ## What the divergence actually did
 *
 * `inviteUrl` is the URL the JOINING instance POSTs its handshake to. With no scheme gate, an instance whose
 * `allowInsecurePeers` is off — documented as *"peer URLs must be `https://`, regardless of address"* — would
 * still open a plaintext handshake to an `http://` inviter. Not a credential leak: the sync token comes back
 * RSA-wrapped, and `peerSafeFetch` logs its once-per-host plaintext warning. But instance ids, labels, the
 * network id and a public key cross the wire in the clear, and the operator learns about it from a log line
 * AFTER the fact rather than from a refusal before it. A transport policy that does not cover the one URL a
 * join reaches out to is not the policy the setting describes.
 *
 * `myUrl` is the joiner's own address, passed on to the inviter, which validates it with the full chain — so
 * that one surfaced as a remote `400` where a local one belonged.
 *
 * ## Why this gate reads the SHAPE and not a list of names
 *
 * A list of field names is the same defect one level up: the next route to take a peer URL under a new name
 * is exactly the one that will forget the chain, and a name list cannot see it. So the check finds every zod
 * `.url()` in the network and invite surface and requires each to resolve to the shared declaration. Adding
 * a field is then free; adding one with its own chain is what fails.
 *
 * Run: node --test testing/standalone/one-definition-of-a-peer-url.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { stripComments } from './_strip-comments.mjs';
import { trackedSources } from './_sources.mjs';

/**
 * The surface a peer or instance URL can arrive on. Derived from the files, not hand-listed: anything under
 * the networks router plus the invite route, which is the other half of the same handshake.
 */
function peerSurfaceFiles() {
  // A glob and one named file, so the floor is 2 rather than the default 100 — a floor above what a scan
  // can ever return fails on correct code, which is how a guard gets deleted instead of corrected.
  // `server/src/networks/` too: the join and member bodies moved there when they became acts both doors call
  // (`F-36`), and a surface that stopped at `api/` would have concluded about peer URLs it no longer read.
  return trackedSources(['server/src/api/networks/*.ts', 'server/src/api/invite.ts', 'server/src/networks/*.ts'], { floor: 2 });
}

const THE_DECLARATION = 'server/src/api/networks/_shared.ts';

describe('the gate reads the surface it claims to', () => {
  it('finds the files, and the declaration among them', () => {
    const files = peerSurfaceFiles();
    assert.ok(files.length >= 5, `only found ${files.length} files on the peer surface: ${files.join(', ')}`);
    assert.ok(files.includes(THE_DECLARATION), `${THE_DECLARATION} is not on the list this gate scans`);
  });

  it('the one declaration still carries all three checks', () => {
    /*
     * The inverse of everything below. Every other assertion here is "resolve to this declaration" — which
     * is satisfied just as well by a declaration that checks nothing. Its own comment says a bare
     * `z.string()` type-checks and silently accepts loopback, so the chain is asserted piece by piece.
     */
    const src = stripComments(readFileSync(THE_DECLARATION, 'utf8'));
    const at = src.indexOf('export const SSRF_SAFE_URL');
    assert.notEqual(at, -1, 'SSRF_SAFE_URL is gone — every assertion below is now vacuous');
    const decl = src.slice(at, src.indexOf(';', at));
    assert.match(decl, /\.url\(\)/, 'the URL must still have to parse');
    assert.match(decl, /isSsrfSafeUrl/, 'the SSRF check is what stops a loopback or IMDS peer');
    assert.match(decl, /isPeerSchemeAllowed/,
      'the scheme check is what makes `allowInsecurePeers` mean anything at admission');
  });
});

describe('no route declares its own peer-URL chain', () => {
  /** Every zod `.url()` outside the shared declaration, with its line, so a failure says where to look. */
  function localUrlChains() {
    const found = [];
    for (const file of peerSurfaceFiles()) {
      if (file === THE_DECLARATION) continue;
      const lines = stripComments(readFileSync(file, 'utf8')).split(/\r?\n/);
      lines.forEach((text, i) => {
        if (/z\s*\.\s*string\s*\(\s*\)\s*\.\s*url\s*\(\s*\)/.test(text)) found.push(`${file}:${i + 1}: ${text.trim()}`);
      });
    }
    return found;
  }

  it('every peer or instance URL field uses the shared declaration', () => {
    const found = localUrlChains();
    assert.deepEqual(found, [],
      'These build their own peer-URL validator instead of using SSRF_SAFE_URL:\n  '
      + `${found.join('\n  ')}\n\n`
      + 'A local chain is one rule with two implementations, and the copy that is wrong is invisible: the two '
      + 'in join.ts had already dropped the scheme check, so an instance with `allowInsecurePeers` off would '
      + 'still open a plaintext handshake. Import SSRF_SAFE_URL from ./_shared.js.');
  });

  it('and the check can fire — a local chain in the surface is caught', () => {
    // Mutation-check on the predicate: a rule that cannot fire looks exactly like a clean surface.
    const spellings = [
      'inviteUrl: z.string().url().refine(isSsrfSafeUrl, { message: SSRF_SAFE_MESSAGE }),',
      '  myUrl: z.string().url(),',
      'const X = z.string() .url()',
    ];
    const re = /z\s*\.\s*string\s*\(\s*\)\s*\.\s*url\s*\(\s*\)/;
    for (const s of spellings) assert.match(s, re, `must flag: ${s}`);
    // And must not fire on the shared declaration's own multi-line form, which is why it is skipped by path
    // rather than by pattern — asserted so nobody "simplifies" the skip away.
    assert.doesNotMatch('  .url()', re, 'the multi-line declaration must not be matched by this predicate');
  });
});

describe('the shared declaration is imported, not re-declared', () => {
  it('no file declares a second chain under its own name', () => {
    /*
     * `INVITE_SSRF_SAFE_URL` was a byte-identical copy of `SSRF_SAFE_URL`, in the other half of the same
     * handshake. Identical copies are the ones that get missed: the next change to the rule fixes the one
     * whose name you searched for, and the surface keeps two answers with no test disagreeing.
     */
    const offenders = [];
    for (const file of peerSurfaceFiles()) {
      if (file === THE_DECLARATION) continue;
      const src = stripComments(readFileSync(file, 'utf8'));
      for (const m of src.matchAll(/(?:const|let)\s+([A-Z_][A-Z0-9_]*URL[A-Z0-9_]*)\s*=/g)) {
        offenders.push(`${file}: declares ${m[1]}`);
      }
    }
    assert.deepEqual(offenders, [],
      `${offenders.join('\n  ')}\n\nImport SSRF_SAFE_URL instead of naming a second copy of it.`);
  });

  it('and the files that need it import it', () => {
    // The other half: satisfying the two assertions above by deleting validation altogether would leave a
    // surface with no chains at all, which is the state that produced the loopback finding in the first place.
    const importers = peerSurfaceFiles()
      .filter(f => f !== THE_DECLARATION)
      .filter(f => /SSRF_SAFE_URL/.test(stripComments(readFileSync(f, 'utf8'))));
    assert.ok(importers.length >= 4,
      `only ${importers.length} file(s) reference SSRF_SAFE_URL — a peer URL is admitted somewhere without it: `
      + importers.join(', '));
  });
});
