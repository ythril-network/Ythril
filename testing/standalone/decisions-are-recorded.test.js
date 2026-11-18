/**
 * The reasoning behind an irreversible call has to ship with the code.
 *
 * ## The finding — Documentation & DX audit lens
 *
 * The reasoning existed; it just did not ship. This codebase's comments carry an unusual amount of *why*, and the
 * working trackers carry more — but **`todo/` is gitignored** (`.gitignore:51`), so `_REFERENCE.md` and
 * `_PARKED-DECISIONS.md` are invisible to anyone who clones the repository. A contributor could read every comment in
 * the tree and still not know why PDF rasterisation avoids the obvious library.
 *
 * The cost is not only onboarding. A decision nobody can see gets **accidentally reversed** — by a dependency bump
 * that swaps in an AGPL library, by a tidy-up that deletes a "redundant" security check, by unsetting a flag to make a
 * failed model load succeed. Each record names the reversal it exists to prevent, because that is the part a reviewer
 * needs at the moment it matters.
 *
 * ## What this gate holds
 *
 * That the folder exists, that each record actually reasons (context, decision, consequences, and a pointer to where
 * the detail lives, so it never becomes a second source of truth), and that the index lists every file. It cannot
 * judge whether a *new* irreversible decision got a record — nothing can — but it makes the absence of the folder,
 * or a record that is a stub, a build failure.
 *
 * ## Also checked, and CLEAN
 *
 * Three of this lens's own notes were stale, which is recorded in `_REFERENCE.md`:
 *
 *   - "an in-product `/help` endpoint / help surface — *currently missing*" — it exists at `/settings/help`, ships all
 *     27 doc pages (the integration guide as 17 `parts`), and already has a coverage test that fails when a doc is
 *     added to `docs/` and not offered;
 *   - "a stale comment naming a removed lib (the PyMuPDF comment was)" — the only surviving mentions of `PyMuPDF` and
 *     `qrcode` are deliberate historical notes explaining what was *not* chosen and what a test survived;
 *   - orphaned doc pages — **zero**: all 27 pages are reachable by link.
 *
 * Run: node --test testing/standalone/decisions-are-recorded.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';

const DIR = join('docs', 'decisions');
/**
 * The index is a FLAT top-level file, not `decisions/README.md`.
 *
 * The in-product Help page requires every entry's `file:` to be a flat `docs/*.md` — nesting belongs in `parts:`,
 * which is how the 17-part integration guide is offered as one nav entry. Keeping the index at `docs/decisions.md`
 * means one index, a stable `decisions.md#…` link target, and no second copy to drift.
 */
const INDEX = join('docs', 'decisions.md');

describe('the folder exists and is reachable', () => {
  it('there is a decisions folder with an index', () => {
    assert.ok(existsSync(DIR), 'docs/decisions is gone — the rationale for the irreversible calls ships nowhere again');
    assert.ok(existsSync(INDEX), 'the index is gone');
  });

  it('the index explains why the folder exists, not just what is in it', () => {
    // Without the reason, the next person adds a record for a styling preference and the folder becomes noise.
    const idx = readFileSync(INDEX, 'utf8');
    assert.match(idx, /gitignored/i,
      'the index should say why the rationale did not already ship — todo/ is gitignored');
    assert.match(idx, /irreversible|expensive to reverse/i, 'it must say what belongs here');
    assert.match(idx, /reversal/i, 'it must say that each record names the reversal it prevents');
  });
});

describe('every record reasons, rather than announcing', () => {
  const records = readdirSync(DIR).filter(f => /^\d{2}-.+\.md$/.test(f));

  it('found the records', () => {
    assert.ok(records.length >= 3, `expected the decision records, found ${records.length}`);
  });

  it('each has context, decision, consequences and a pointer to the detail', () => {
    const thin = [];
    for (const f of records) {
      const src = readFileSync(join(DIR, f), 'utf8');
      const missing = [];
      if (!/##\s*Context/i.test(src)) missing.push('Context');
      if (!/##\s*Decision/i.test(src)) missing.push('Decision');
      if (!/##\s*Consequences/i.test(src)) missing.push('Consequences');
      if (!/##\s*Where the detail lives/i.test(src)) missing.push('Where the detail lives');
      if (missing.length) thin.push(`${f}: missing ${missing.join(', ')}`);
      // A record shorter than this is an announcement, not a reason.
      if (src.length < 1200) thin.push(`${f}: only ${src.length} chars — too thin to carry a why`);
    }
    assert.deepEqual(thin, [], `these records do not reason:\n  ${thin.join('\n  ')}`);
  });

  it('each names the reversal it prevents', () => {
    // The distinguishing feature of a useful record. "We chose X" is a fact; "do not swap in Y, here is what breaks"
    // is what stops the decision being undone inside an unrelated change.
    const silent = records.filter(f => !/reversal to prevent/i.test(readFileSync(join(DIR, f), 'utf8')));
    assert.deepEqual(silent, [], 'these do not say what they exist to prevent, which is the part a reviewer needs '
      + `at the moment it matters:\n  ${silent.join('\n  ')}`);
  });

  it('each cites where the detail lives, so it is not a second source of truth', () => {
    const uncited = [];
    for (const f of records) {
      const src = readFileSync(join(DIR, f), 'utf8');
      const at = src.search(/##\s*Where the detail lives/i);
      const section = src.slice(at);
      // At least two real pointers: a source path, a doc, a gate.
      const pointers = (section.match(/`[^`]*\.(ts|js|md|json)`|`Dockerfile`|`NOTICE`/g) ?? []).length;
      if (pointers < 2) uncited.push(`${f}: ${pointers} pointer(s)`);
    }
    assert.deepEqual(uncited, [], 'a record with no pointers becomes the second place the truth lives, and then the '
      + `stale one:\n  ${uncited.join('\n  ')}`);
  });

  it('the index lists every record', () => {
    // An unlisted record is an orphan, which is the failure this lens asks about for docs generally.
    const idx = readFileSync(INDEX, 'utf8');
    const unlisted = records.filter(f => !idx.includes(f));
    assert.deepEqual(unlisted, [], `these exist but the index does not mention them:\n  ${unlisted.join('\n  ')}`);
  });
});

describe('the records point at things that are actually there', () => {
  it('every cited repository path is a file or a folder the repository tracks', () => {
    // The failure mode for a retrospective record: it cites a file that has since moved, and now the pointer is
    // worse than no pointer. Checked against the TRACKED tree from the repository root (Q-870), never the disk: a record
    // that cites a build output (`server/dist`) passes where a build exists and fails in a fresh checkout, and that
    // made the file a build-dependent test, which cannot run in the preflight's source stage before the builds.
    const tracked = new Set();
    for (const file of trackedSources('.', { ext: null, floor: 500 })) {
      tracked.add(file);
      for (let at = file.lastIndexOf('/'); at > 0; at = file.lastIndexOf('/', at - 1)) tracked.add(file.slice(0, at));
    }
    const missing = [];
    for (const f of readdirSync(join(REPO_ROOT, DIR)).filter(x => /^\d{2}-.+\.md$/.test(x))) {
      const src = readFileSync(join(REPO_ROOT, DIR, f), 'utf8');
      for (const m of src.matchAll(/`((?:server|client|testing|docs|sidecars)\/[A-Za-z0-9._\-/]+|Dockerfile|NOTICE)`/g)) {
        const p = m[1];
        // Skip globby or illustrative references.
        if (p.includes('*')) continue;
        if (!tracked.has(p.replace(/\/$/, ''))) missing.push(`${f} → ${p}`);
      }
    }
    assert.deepEqual(missing, [], `these citations point at paths the repository does not track (a build output is not one; cite the source):\n  ${missing.join('\n  ')}`);
  });
});
