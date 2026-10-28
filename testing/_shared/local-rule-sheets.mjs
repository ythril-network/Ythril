/**
 * The agents' rule sheets present in THIS checkout: `CLAUDE.md` where it exists, nothing in a clean clone.
 *
 * ## What it prevents
 *
 * `CLAUDE.md` is the owner's working notes and is not tracked (Q-632: the repository is public). Several gates check its
 * prose the way they check `docs/` — the sentences that rot are the ones it repeats — and each read it as a required
 * file, so every one of them would fail with ENOENT in CI's clean clone. Asked here once: a gate reads what this
 * returns and checks the sheet where it exists, and a clone without one is simply a clone with no sheet to check.
 *
 * Paths are relative to the repository root, as `git ls-files` spells them.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const SHEETS = ['CLAUDE.md'];

/** The rule sheets that exist under `root` (the repository root, default the working directory). */
export function localRuleSheets(root = process.cwd()) {
  return SHEETS.filter(f => existsSync(join(root, f)));
}
