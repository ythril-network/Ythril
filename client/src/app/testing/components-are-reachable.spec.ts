/**
 * Every component must be reachable — routed, or imported by another component.
 *
 * ## The bug this exists for
 *
 * `pages/settings/schema-library.component.ts` had **no route and no importer**, and a class name that collided
 * with the live Schema Library page. It was deleted in #662 — but not before it had made **four other things
 * wrong**, which is the argument for detecting this automatically rather than trusting a reader to notice:
 *
 *  1. A Help anchor had been written for the URL that dead file *implied* (`/settings/schema-library`, which
 *     nothing routes to), so the **live** page — a top-level nav item — resolved to no guide section at all,
 *     while the anchor table looked complete.
 *  2. A standalone gate pinned it, so that gate had been guarding a file nobody could open.
 *  3. Two i18n keys existed in all three locales with the dead file as their only consumer.
 *  4. An hour of work fixing a component no user can reach.
 *
 * An unreachable file still reads as documentation. The next person — or the next gate, or the next anchor
 * table — takes its existence as evidence that its route, its keys and its behaviour are real.
 *
 * ## What "reachable" means here
 *
 * A component is reachable if its exported class is named by `app.routes.ts` (directly or in a `loadComponent`),
 * or appears in another component's `imports` array, or is used as a selector in another component's template.
 * Anything else has exactly one reference — its own declaration — and is dead.
 *
 * Comments are stripped first. Seven gates in this repo have now fired on the comment explaining their own
 * subject, and the comment above literally names a deleted component.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CLIENT_ROOT as CLIENT, trackedAppSources } from './tracked-sources';

/**
 * Components that are legitimately not referenced from another component or a route.
 *
 * Each is asserted below to still exist and still be unreferenced, so a component that gains a caller cannot
 * linger here — an allowlist is a ceiling, not a licence.
 */
const EXEMPT: Record<string, string> = {
  'app.component.ts':
    'The application root. Bootstrapped by main.ts rather than routed or imported, which is exactly why it has '
    + 'no referrer — and why every other component having none is a defect.',
};

const strip = (src: string): string => src
  // Only block comments that START a line: a `/*` inside a string literal (a glob, a cron expression) opens a
  // fake comment that runs to the next `*​/` and eats real code. That mistake produced a false PASS in a sibling
  // gate — it reported a file as having no call it was asserting on.
  .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

interface Comp {
  /** Repo-relative path. */
  path: string;
  /** File name only, for the EXEMPT map. */
  base: string;
  /** Exported class names declared in the file. */
  classes: string[];
  /** `selector: '…'` values declared in the file. */
  selectors: string[];
}

/** Every tracked source file. `git ls-files`, not readdir — a gitignored or generated file is not the app. */
function allSources(): string[] {
  return trackedAppSources();
}

function tracked(): string[] {
  return allSources().filter(p => p.endsWith('.component.ts'));
}

function parse(path: string): Comp {
  const code = strip(readFileSync(resolve(CLIENT, path), 'utf8'));
  return {
    path,
    base: path.split('/').pop()!,
    classes: [...code.matchAll(/export class (\w+)/g)].map(m => m[1]),
    selectors: [...code.matchAll(/selector:\s*'([^']+)'/g)].map(m => m[1]),
  };
}

describe('every component is reachable', () => {
  const comps = tracked().map(parse);
  const routes = strip(readFileSync(resolve(CLIENT, 'src/app/app.routes.ts'), 'utf8'));
  /**
   * Every source file’s stripped text, so "who references X" is one pass rather than N reads.
   *
   * ALL sources, not just components — the first version scanned `*.component.ts` only and reported
   * `ConfirmDialogComponent` as dead. It is instantiated dynamically by `ConfirmDialogService`, which is a
   * perfectly good reachability path that a component-only scan cannot see. A checker whose scope is narrower
   * than reality reports the gap as a defect.
   */
  const sources = new Map(allSources().map(p => [p, strip(readFileSync(resolve(CLIENT, p), 'utf8'))]));

  it('found the components and the router (guards against a vacuous pass)', () => {
    expect(comps.length).toBeGreaterThan(40);
    expect(comps.every(c => c.classes.length > 0)).toBe(true);
    expect(routes).toContain('loadComponent');
  });

  /** Is `c` named by the router, or by any component other than itself? */
  const referrers = (c: Comp): string[] => {
    const out: string[] = [];
    if (c.classes.some(cls => routes.includes(cls))) out.push('app.routes.ts');
    for (const [path, src] of sources) {
      if (path === c.path) continue;
      const byClass = c.classes.some(cls => new RegExp(`\\b${cls}\\b`).test(src));
      // A selector counts as a reference only as an ELEMENT — matching the bare string would let a CSS rule
      // or a stray mention keep a dead component alive.
      const bySelector = c.selectors.some(sel => src.includes(`<${sel}`));
      if (byClass || bySelector) out.push(path);
    }
    return out;
  };

  it('no component has only its own declaration referring to it', () => {
    const dead = comps
      .filter(c => !(c.base in EXEMPT))
      .filter(c => referrers(c).length === 0)
      .map(c => `${c.path}  (class ${c.classes.join(', ')})`);

    expect(
      dead,
      'These components are unreachable — no route, no importer, no template usage. An unreachable file still '
      + 'reads as documentation: #662 found one that had already caused a stale Help anchor, a gate guarding a '
      + 'file nobody could open, and two orphaned i18n keys.\n'
      + dead.map(d => `  - ${d}`).join('\n')
      + '\n\nDelete it, or wire it up. If it is genuinely meant to be unreferenced, add it to EXEMPT with the reason.',
    ).toEqual([]);
  });

  it('no exemption outlives its reason', () => {
    for (const [base, reason] of Object.entries(EXEMPT)) {
      const c = comps.find(x => x.base === base);
      expect(c, `EXEMPT lists ${base}, which is not a tracked component — renamed or deleted?`).toBeDefined();
      expect(
        referrers(c!),
        `${base} now HAS a referrer, so its exemption is stale — delete the entry. Reason given: ${reason}`,
      ).toEqual([]);
      expect(reason.length, `EXEMPT ${base} needs a real reason, not a placeholder.`).toBeGreaterThan(40);
    }
  });

  it('no two components share an exported class name', () => {
    // The collision that made #662's dead file look real: two `SchemaLibraryComponent`s, one routed and one
    // not, so a reader (and an anchor table) could not tell which was the live page.
    const byName = new Map<string, string[]>();
    for (const c of comps) for (const cls of c.classes) {
      byName.set(cls, [...(byName.get(cls) ?? []), c.path]);
    }
    const clashes = [...byName.entries()].filter(([, paths]) => paths.length > 1)
      .map(([cls, paths]) => `${cls}: ${paths.join(' + ')}`);
    expect(clashes, `two components exporting one class name is how a dead file passes for a live one:\n  ${clashes.join('\n  ')}`)
      .toEqual([]);
  });
});
