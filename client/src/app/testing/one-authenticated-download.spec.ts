/**
 * Handing the user a file happens in ONE module, and nothing else builds a bearer header by hand.
 *
 * ## Why this exists
 *
 * Q-92 added a sixth place that downloads with the caller's token (the query tab's spill download, which
 * has to page through `nextSkip` and send the bearer, so a plain `<a href>` cannot do it). The five before it
 * were each written by hand: `fetch` with an `Authorization` header built from `auth.token()`, then a
 * temporary object URL, an anchor with `.download`, a click and a revoke. Five copies of that drift — one
 * revokes immediately, one after ten seconds, one appends the anchor and one does not, one toasts its failure
 * and four have nothing to fail — and the sixth would have been the seventh variant.
 *
 * ## What it asserts, and why the sets are DERIVED
 *
 * Both sets are read out of the tracked sources rather than listed, so a download written next year by
 * somebody who never heard of this rule is still inside the net:
 *
 * - **a save site** is any source that both calls `URL.createObjectURL(` and assigns an anchor's
 *   `.download` — the only way a browser saves bytes under a file name. Exactly ONE file may do that.
 * - **a hand-built session bearer** is any source that reads the session token (`.token()`) and writes an
 *   `Authorization: \`Bearer …\`` header itself. The HttpClient interceptor is where that belongs; the one
 *   download module may do it too (a `fetch` for bytes). A token being TRIED — the login form, the OIDC
 *   callback — is not the session token and is not matched.
 *
 * Comments are stripped first, in both directions: a gate that reads its own subject's explanation fires on
 * the reasoning for the fix, or passes because of it.
 *
 * Run: npm run test --workspace=client
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CLIENT_ROOT, trackedAppSources } from './tracked-sources';

const stripComments = (src: string): string => src
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const sources = new Map(trackedAppSources()
  .map(p => [p, stripComments(readFileSync(resolve(CLIENT_ROOT, p), 'utf8'))] as const));

/** A browser save: bytes behind an object URL, an anchor told the file name. Both, in one file. */
const isSaveSite = (code: string) => /URL\.createObjectURL\s*\(/.test(code) && /\.download\s*=(?!=)/.test(code);

/** The session token read AND put into an Authorization header by hand. */
const buildsSessionBearer = (code: string) =>
  /\.token\(\)/.test(code) && /Authorization\s*:\s*`Bearer\s*\$\{/.test(code);

const INTERCEPTOR = 'src/app/core/auth.interceptor.ts';

function saveSites(): string[] {
  return [...sources].filter(([, code]) => isSaveSite(code)).map(([p]) => p).sort();
}

/** The module every download goes through: the single save site, once there is exactly one. */
function downloadModule(): string {
  const sites = saveSites();
  expect(sites, 'more than one file saves a blob to disk by hand — each is a copy of the download helper:\n  '
    + sites.join('\n  ')).toHaveLength(1);
  return sites[0]!;
}

/** Files importing a module, matched on the import SPECIFIER — a mention of its name in a string is not a use. */
function importersOf(modulePath: string): string[] {
  const base = modulePath.replace(/^.*\//, '').replace(/\.ts$/, '');
  const spec = new RegExp(`from\\s+['"][./]*(?:[\\w-]+/)*${base.replace(/[.-]/g, m => `\\${m}`)}['"]`);
  return [...sources].filter(([p, code]) => p !== modulePath && spec.test(code)).map(([p]) => p).sort();
}

describe('one authenticated download', () => {
  it('the rule reaches something: the interceptor is tracked and still attaches the bearer', () => {
    // The floor for the bearer half. If the interceptor moved, the allowance below exempts nothing and the
    // derivation has to be re-pointed — better to fail here than to let the gate go quietly blind.
    expect(sources.has(INTERCEPTOR), `${INTERCEPTOR} is not tracked — re-point this gate`).toBe(true);
    expect(buildsSessionBearer(sources.get(INTERCEPTOR)!),
      'the interceptor no longer matches the bearer pattern, so the pattern matches nothing real').toBe(true);
  });

  it('exactly one module saves a blob to the user\'s disk, and it is a shared module', () => {
    const mod = downloadModule();
    expect(mod, 'the one download module belongs with the other shared code, not inside a page')
      .toMatch(/^src\/app\/(core|shared)\//);
  });

  it('no source builds a session bearer header by hand, outside the interceptor and the download module', () => {
    const mod = saveSites().length === 1 ? saveSites()[0]! : null;
    const offenders = [...sources]
      .filter(([p, code]) => p !== INTERCEPTOR && p !== mod && buildsSessionBearer(code))
      .map(([p]) => p).sort();
    expect(offenders, 'these read auth.token() and attach it themselves — use the download module (or '
      + 'HttpClient, whose interceptor attaches it):\n  ' + offenders.join('\n  ')).toEqual([]);
  });

  it('every download site reaches it — the query tab\'s spill download among them', () => {
    const mod = downloadModule();
    const users = importersOf(mod);
    // The spill download is the sixth site, the one Q-92 adds: the notice ending that pages a spill and sends the
    // bearer. It lived in the query tab until the ending moved into a component of its own.
    expect(users, `${mod} is not imported by the spill download`).toContain('src/app/pages/brain/spill-ending.component.ts');
    // A FLOOR, not a count: five pages saved or fetched a download by hand before the module existed, plus the
    // query tab. Fewer importers than that means a site kept its own copy under a spelling this gate missed.
    expect(users.length, `only ${users.length} files import ${mod}:\n  ${users.join('\n  ')}`)
      .toBeGreaterThanOrEqual(5);
  });

  it('a failed download still tells the user — the file manager kept its error toast', () => {
    // The one thing the old file-manager copy did that the helper must not drop: a failed download is a toast,
    // not a click that did nothing.
    const fm = sources.get('src/app/pages/files/file-manager.component.ts');
    expect(fm, 'file-manager.component.ts moved — re-point this case').toBeDefined();
    // Either the page keeps it or the module took it over; both are fine, losing it is not.
    const sites = saveSites();
    const mod = sites.length === 1 ? sources.get(sites[0]!)! : '';
    expect(fm! + mod).toMatch(/'files\.downloadFailed'/);
  });
});
