/**
 * Every dependency Ythril redistributes is attributed in NOTICE.
 *
 * ## Why this exists
 *
 * NOTICE was last touched on 2026-07-20. Six packages had been added since and **none of them was in
 * it** — `ajv`, `marked`, `mermaid`, `exceljs`, `uqr`, and `dompurify`. Nothing anywhere reported that.
 *
 * The last of those is the one that made this a licence question rather than a courtesy: `dompurify` is
 * `MPL-2.0 OR Apache-2.0`, the **only** copyleft-carrying package in the redistributed tree, and it was
 * the unattributed one. Meanwhile `docs/dependencies.md` stated that every npm package is "MIT, Apache
 * 2.0, 0BSD, BSD-3-Clause, or ISC" with "no copyleft restrictions" — a claim that was reached before that
 * package existed and was never rechecked.
 *
 * Attribution is the obligation that survives every permissive licence. A NOTICE that is merely *stale*
 * is a NOTICE that is wrong, and it goes wrong silently: adding a dependency is a one-line change that
 * nothing connects to a legal file.
 *
 * ## Scope, and why it stops where it does
 *
 * `dependencies` of `server/` ship inside the image. `dependencies` of `client/` are compiled into the
 * browser bundle a user downloads. Both are redistribution.
 *
 * `devDependencies` are **not** in scope. They are build-time only and reach no user, and listing them
 * would make NOTICE *less* accurate — it would claim to distribute things it does not. The audit lens
 * names that failure explicitly: "whether we accidentally ship something we only use at build time".
 *
 * Transitive dependencies are also out of scope here. That is a deliberate limit, not an oversight: the
 * full transitive set is thousands of packages, and a gate nobody can satisfy is a gate that gets
 * deleted. Direct dependencies are the set a human chose, and the set a human can keep honest.
 *
 * Run: node --test testing/standalone/notice-coverage.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { markdownSectionFrom } from './_structural-window.mjs';

const NOTICE = readFileSync('NOTICE', 'utf8');
const NOTICE_LC = NOTICE.toLowerCase();

/**
 * Every package name present after an install, across the root and both workspaces.
 *
 * Used only by the stale-entry check at the bottom: "is this thing still here at all?" needs the installed set,
 * not the declared one, because a heading may legitimately name a transitive package (`jszip`).
 */
const INSTALLED = (() => {
  const out = new Set();
  const scan = (root) => {
    if (!existsSync(root)) return;
    for (const entry of readdirSync(root)) {
      if (entry.startsWith('.')) continue;              // .bin, .package-lock.json, … npm internals
      const dir = join(root, entry);
      if (!statSync(dir).isDirectory()) continue;
      if (entry.startsWith('@')) for (const s of readdirSync(dir)) out.add(`${entry}/${s}`);
      else out.add(entry);
    }
  };
  scan('node_modules');
  scan('server/node_modules');
  scan('client/node_modules');
  return out;
})();

const MANIFESTS = [
  ['server', 'server/package.json'],
  ['client', 'client/package.json'],
];

/** Direct, redistributed dependencies of both workspaces. */
function redistributed() {
  const out = [];
  for (const [where, file] of MANIFESTS) {
    const pkg = JSON.parse(readFileSync(file, 'utf8'));
    for (const name of Object.keys(pkg.dependencies ?? {})) out.push({ where, name });
  }
  return out;
}

/** The declared licence of an installed package, from wherever npm put it. */
function licenseOf(name, where) {
  for (const base of [`${where}/node_modules`, 'node_modules']) {
    const p = `${base}/${name}/package.json`;
    if (!existsSync(p)) continue;
    const m = JSON.parse(readFileSync(p, 'utf8'));
    if (m.license) return String(m.license);
    if (Array.isArray(m.licenses)) return m.licenses.map(l => l.type).join(' OR ');
    return '';
  }
  return null;   // not installed — see the note in the test below
}

describe('NOTICE covers everything we redistribute', () => {
  const deps = redistributed();

  it('finds the dependency set (the check itself works)', () => {
    // Without this, a manifest rename would reduce the sweep to zero and the assertion below would pass
    // by examining nothing — the failure mode every coverage gate in this repo has had at least once.
    assert.ok(deps.length >= 25, `expected the workspaces' dependencies, found ${deps.length}`);
    assert.ok(NOTICE.includes('## Bundled Components'), 'NOTICE should have a Bundled Components section');
  });

  it('attributes every redistributed dependency', () => {
    const missing = deps
      .filter(d => !NOTICE_LC.includes(d.name.toLowerCase()))
      .map(d => `  ${d.where}/${d.name}`);

    assert.deepEqual(missing, [],
      'These packages ship to users but are not attributed in NOTICE. Attribution is the obligation that\n' +
      'survives every permissive licence, and adding a dependency is a one-line change that nothing else\n' +
      'connects to a legal file:\n' + missing.join('\n') +
      '\nAdd an entry under Bundled Components with the package\'s licence and its copyright line(s).');
  });

  it('names the licence arm we elected for anything dual-licensed', () => {
    // A dual grant is a choice the DISTRIBUTOR makes. Leaving it unstated means a reader cannot tell
    // which set of obligations applies, and `docs/dependencies.md` cannot honestly conclude anything
    // about copyleft. This caught `dompurify` (`MPL-2.0 OR Apache-2.0`) being attributed with no
    // election recorded.
    const resolved = deps.map(d => ({ ...d, license: licenseOf(d.name, d.where) }));

    // Guard against the vacuous pass. `licenseOf` reads from `node_modules`, and npm's hoisting differs
    // between a local install and CI — if it resolved nothing, `dual` would be empty and this test would
    // report success having checked nothing. That is the exact failure mode this whole file was written
    // in response to, so it must not be reintroduced by the file itself.
    const unresolved = resolved.filter(d => d.license === null).length;
    assert.ok(unresolved < deps.length / 2,
      `could not resolve licences for ${unresolved} of ${deps.length} dependencies — run \`npm ci\`; ` +
      'this check is meaningless without them and must fail rather than pass quietly');

    const dual = resolved.filter(d => d.license && /\bOR\b/i.test(d.license));

    const unelected = dual
      .filter(d => {
        const at = NOTICE_LC.indexOf(`### ${d.name.toLowerCase()}`);
        if (at < 0) return true;                       // no entry at all — the check above reports it
        // The verb AND the licence it selects. A bare `/elect/i` was too loose to be worth having: it
        // matched the surrounding prose explaining *why* an election is recorded, so deleting the actual
        // election statement left the test green. Caught by mutating the entry.
        /*
         * The entry, bounded by the next `###` — so an entry that grows an explanation is still read whole.
         *
         * The `{0,40}` inside the pattern is an ADJACENCY CLAIM and stays: `[^.\n]` crosses neither a full stop
         * nor a line, so it asserts the verb and the licence it selects are in ONE clause. That is the rule the
         * comment above it already gives — a bare `/elect/i` matched the surrounding prose ABOUT elections, so
         * deleting the actual election statement left this green. Widening the gap would undo that fix.
         */
        return !/elects?\s+[^.\n]{0,40}(Apache|MIT|MPL|BSD|ISC|GPL)/i.test(markdownSectionFrom(NOTICE, at));
      })
      .map(d => `  ${d.name} (${d.license})`);

    assert.deepEqual(unelected, [],
      'These are offered under a choice of licences, and NOTICE does not say which one we took:\n' +
      unelected.join('\n') +
      '\nState the election in the entry — a reader should not have to infer which arm applies.');
  });

  it('does not claim to distribute build-time-only packages', () => {
    // The opposite error, and it makes NOTICE dishonest in the other direction. Checked against a small
    // set of unmistakable build tooling rather than all devDependencies, because some packages appear in
    // both lists legitimately (a type package that is also shipped, say) and a blanket rule would be wrong.
    const BUILD_ONLY = ['typescript', 'eslint', 'markdownlint-cli2', 'playwright', '@angular/cli'];
    const overclaimed = BUILD_ONLY.filter(n => NOTICE_LC.includes(`### ${n.toLowerCase()}\n`));
    assert.deepEqual(overclaimed, [],
      'NOTICE lists build tooling that is never redistributed — that overstates what ships');
  });

  it('does not attribute a package that is no longer here at all', () => {
    // The allowlist above catches build tooling. It cannot catch a dependency that was REMOVED and whose entry
    // was left behind — which is what happened: `qrcode` was swapped for `uqr` (the mfa spec documents the swap
    // in its own header), the dependency went, and the NOTICE entry stayed. Found by the Legal & Compliance audit
    // lens, not by this file.
    //
    // Generalisable and satisfiable, unlike a full transitive audit: every package-shaped heading must name
    // something actually installed. 43 headings, and it found exactly one stale entry.
    const stale = [];
    for (const heading of [...NOTICE.matchAll(/^### (.+)$/gm)].map(m => m[1].trim())) {
      // Headings that are not packages: licence texts, pulled images, model weights, the typeface, Ythril itself,
      // and code VENDORED into ours — copied, not installed, so the attribution stays after the package goes.
      if (/^(MIT|Apache License|BSD-|ISC|0BSD|Runtime Dependency|Bundled model|Inter |Ythril|SIL |Mozilla|Eclipse|GNU|Vendored:)/i.test(heading)) continue;
      // One heading may list several packages, and several carry a parenthetical gloss —
      // `mongodb (Node.js Driver)`, `jszip (transitive, via exceljs)`. ANY trailing parenthetical is stripped
      // rather than a hardcoded list of the two that exist today: the third one would otherwise fail the gate for
      // no reason, and an npm name can contain neither a space nor a paren, so this can never hide a real name.
      const names = heading
        .replace(/\s*\([^)]*\)\s*$/, '')
        .split(',').map(s => s.trim()).filter(Boolean);
      for (const name of names) {
        if (!INSTALLED.has(name) && !INSTALLED.has(name.toLowerCase())) {
          stale.push(`${name}  (heading: "${heading}")`);
        }
      }
    }
    assert.deepEqual(stale, [], 'NOTICE attributes packages that are not installed. Either they were removed and '
      + 'the entry was left behind — which claims we redistribute something we do not — or a heading is spelled '
      + `differently from the package name:\n  ${stale.join('\n  ')}`);
  });
});
