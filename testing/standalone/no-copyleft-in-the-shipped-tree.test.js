/**
 * No copyleft licence anywhere in the redistributed tree — direct or transitive — without a recorded election.
 *
 * ## The gap this closes, and why it was a reasonable gap
 *
 * `notice-coverage.test.js` checks that every **direct** dependency of both workspaces is attributed, and it says
 * plainly why it stops there:
 *
 *   > Transitive dependencies are also out of scope here. That is a deliberate limit, not an oversight: the full
 *   > transitive set is thousands of packages, and a gate nobody can satisfy is a gate that gets deleted.
 *
 * That is correct for **attribution**. It is not correct for **copyleft**, and the difference is the whole point of
 * this file: attributing 1,147 MIT packages individually would be unsatisfiable busywork, but the number of
 * packages in that tree with a restrictive licence is *two*. That set is small, it is checkable in seconds, and it
 * is the one that carries legal consequence.
 *
 * ## What the audit lens found
 *
 * `jszip` is offered as `MIT OR GPL-3.0-or-later`. It is pulled in transitively by `exceljs` and **ships in the
 * browser bundle** — so a GPL arm was being redistributed to every user with no record of which arm applied.
 * `docs/dependencies.md` meanwhile stated that exactly *one* package was dual-licensed with a copyleft arm and
 * concluded that "no copyleft restrictions apply to any redistributed npm package". The conclusion held, because
 * MIT is available; the reasoning did not, because nobody had looked.
 *
 * Nothing was wrong in the product. What was wrong is that the claim could not be checked.
 *
 * ## Scope
 *
 * Everything present in `node_modules` after an install, which is a superset of what ships. A `devDependency` with
 * a copyleft licence is not a redistribution problem — so a hit that is build-time only can be recorded as such in
 * `DEV_ONLY` rather than needing a NOTICE entry it does not deserve.
 *
 * Run: `npm ci` first, then
 *      node --test testing/standalone/no-copyleft-in-the-shipped-tree.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { escapeRegExp } from '../../scripts/_shared/escape-regexp.mjs';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { markdownSectionFrom } from './_structural-window.mjs';

const ROOT = process.cwd();

/**
 * Licence identifiers that impose source-disclosure or use restrictions on a distributor.
 *
 * LGPL is deliberately excluded from the `GPL` match: it is a weak copyleft that dynamic linking satisfies, and
 * Ythril links no LGPL code into its own binary (ffmpeg is LGPL and runs as a separate process — see NOTICE).
 * Anything matching here needs either a recorded permissive election or a documented reason it is safe.
 */
const RESTRICTIVE = /\b(AGPL|GPL-[23](\.0)?(-only|-or-later)?|SSPL|BUSL|CC-BY-NC|Commons Clause|EUPL|OSL|CDDL)\b/i;
const NOT_RESTRICTIVE = /\bLGPL\b/i;

/** Packages whose restrictive arm is fine because they never reach a user. Each needs a reason, not just a name. */
const DEV_ONLY = {
  // (empty today — every hit so far is redistributed. Kept so the exemption is a decision, not an edit.)
};

/** Every package installed under node_modules, with its declared licence. */
function installed() {
  const out = new Map();
  const read = (dir) => {
    try {
      const p = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      const license = typeof p.license === 'string'
        ? p.license
        : (p.license && p.license.type)
          || (Array.isArray(p.licenses) ? p.licenses.map(l => l.type).join(' OR ') : 'UNKNOWN');
      if (p.name) out.set(p.name, { version: p.version, license });
    } catch { /* not a package dir */ }
  };
  const scan = (root) => {
    if (!existsSync(root)) return;
    for (const entry of readdirSync(root)) {
      if (entry.startsWith('.')) continue;
      const dir = join(root, entry);
      if (!statSync(dir).isDirectory()) continue;
      if (entry.startsWith('@')) for (const s of readdirSync(dir)) read(join(dir, s));
      else read(dir);
    }
  };
  scan(join(ROOT, 'node_modules'));
  for (const ws of ['server', 'client']) scan(join(ROOT, ws, 'node_modules'));
  return out;
}

describe('the licence classifier, before it is trusted to judge anything', () => {
  it('flags the licences that constrain a distributor', () => {
    for (const l of ['AGPL-3.0', 'GPL-3.0-or-later', 'GPL-2.0-only', 'SSPL-1.0', 'BUSL-1.1',
      'CC-BY-NC-4.0', 'MIT OR GPL-3.0-or-later', 'EUPL-1.2', 'CDDL-1.0']) {
      assert.ok(RESTRICTIVE.test(l) && !NOT_RESTRICTIVE.test(l), `${l} should be flagged`);
    }
  });

  it('does not flag the permissive ones, or LGPL', () => {
    for (const l of ['MIT', 'Apache-2.0', 'ISC', '0BSD', 'BSD-3-Clause', 'BSD-2-Clause', 'Unlicense',
      'MPL-2.0 OR Apache-2.0', 'CC0-1.0', 'Python-2.0', 'BlueOak-1.0.0']) {
      assert.ok(!RESTRICTIVE.test(l) || NOT_RESTRICTIVE.test(l), `${l} should NOT be flagged`);
    }
    // LGPL is weak copyleft satisfied by separate-process use; ffmpeg is the case in point and is not linked in.
    for (const l of ['LGPL-2.1-or-later', 'LGPL-3.0']) {
      assert.ok(NOT_RESTRICTIVE.test(l), `${l} must be excluded as LGPL`);
    }
  });
});

describe('nothing copyleft is redistributed without a recorded election', () => {
  const pkgs = installed();
  const notice = readFileSync(join(ROOT, 'NOTICE'), 'utf8');

  it('the install is present — otherwise this checks nothing', () => {
    // A gate that silently passes on an empty node_modules is worse than no gate: it reads as "clean".
    assert.ok(pkgs.size >= 300, `only found ${pkgs.size} installed packages — run \`npm ci\` before this test`);
  });

  it('every restrictive licence in the tree is recorded in NOTICE with its election', () => {
    const hits = [...pkgs.entries()]
      .filter(([, v]) => RESTRICTIVE.test(v.license ?? '') && !NOT_RESTRICTIVE.test(v.license ?? ''))
      .filter(([name]) => !(name in DEV_ONLY));

    const unrecorded = [];
    for (const [name, v] of hits) {
      // A WINDOW, converted: the subject is the NOTICE entry, bounded by the next heading — so an entry that
      // grows an explanation is still read whole, and an entry that grows past 900 characters no longer has
      // its election cut off and fail for nothing.
      //
      // The other direction was 13 characters from being live. `### jszip` sits at offset 18040 and the NEXT
      // entry's election (`Ythril elects Apache License 2.0`, dompurify's) at 18953 — 913 characters, so the
      // 900 window stopped just short of letting a NEIGHBOUR'S election satisfy jszip's check. Nobody
      // maintains a 13-character margin, and nothing would have reported it once a line was added.
      const head = new RegExp(`^### ${escapeRegExp(name)}\\b`, 'm').exec(notice);
      if (!head) { unrecorded.push(`${name}@${v.version} (${v.license}) — no NOTICE entry`); continue; }
      const section = markdownSectionFrom(notice, head.index);
      // An entry that just names the dual grant is not an election. It has to say which arm Ythril takes.
      if (!/elects/i.test(section)) {
        unrecorded.push(`${name}@${v.version} (${v.license}) — NOTICE entry does not record which arm is elected`);
      }
    }

    assert.deepEqual(unrecorded, [], 'a licence with a copyleft or use-restricted arm is being redistributed '
      + 'without a recorded election. Whether it is safe may well be yes — but "no copyleft applies" has to be a '
      + `conclusion a reader can CHECK, not one they take on trust:\n  ${unrecorded.join('\n  ')}\n\n`
      + 'Add a NOTICE entry stating which arm Ythril elects, or add the package to DEV_ONLY with the reason it '
      + 'never reaches a user.');
  });

  it('the two known dual grants are still elected the permissive way', () => {
    // Named explicitly so a NOTICE rewrite cannot quietly drop an election and leave the generic check satisfied
    // by some other package's wording.
    for (const [name, arm] of [['dompurify', /elects Apache License 2\.0/], ['jszip', /elects the MIT License/]]) {
      // Bounded by the next heading, for the reason the comment above gives. A 900-character window contradicts
      // its own stated purpose: it reads into the NEXT entry, which is precisely "satisfied by some other
      // package's wording".
      const head = new RegExp(`^### ${name}\\b`, 'm').exec(notice);
      assert.ok(head, `NOTICE has no entry for ${name}`);
      assert.match(markdownSectionFrom(notice, head.index), arm,
        `${name}'s election is not recorded as expected`);
    }
  });

  it('the docs state the same count the tree does', () => {
    // The claim that drifted: dependencies.md said ONE package was dual-licensed with a copyleft arm. There were
    // two, and the second shipped in the browser bundle.
    const deps = readFileSync(join(ROOT, 'docs/dependencies.md'), 'utf8');
    assert.match(deps, /Two packages are dual-licensed with a copyleft arm/,
      'docs/dependencies.md must state the actual number of dual-licensed packages');
    // The TABLE ROW, not merely the name somewhere on the page. A first version matched `/jszip/` and stayed green
    // when the row was deleted, because the prose underneath still mentions it — the same fault as an assertion
    // satisfied by its own explanation.
    assert.match(deps, /\|\s*`jszip`\s*\|[^|]*GPL[^|]*\|\s*MIT\s*\|/,
      'the dual-grant table must carry a jszip row naming its offered licences and the elected arm');
    assert.match(deps, /\|\s*`dompurify`\s*\|[^|]*MPL[^|]*\|\s*Apache 2\.0\s*\|/,
      'the dual-grant table must carry a dompurify row');
  });

  it('every DEV_ONLY exemption names a real package and gives a reason', () => {
    for (const [name, reason] of Object.entries(DEV_ONLY)) {
      assert.ok(pkgs.has(name), `DEV_ONLY lists ${name}, which is not installed — drop the entry`);
      assert.ok(typeof reason === 'string' && reason.length > 30, `${name}'s exemption needs a real reason`);
    }
  });
});
