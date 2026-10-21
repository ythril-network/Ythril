/**
 * Every refusal code the server answers about personal views has a sentence in en, de and pl under each family that shows it, and a
 * list in the refusal reaches the sentence (Q-531, bundle-100, plan rev 3.2 "Client": "Refusal codes for views get en/de/pl keys
 * under the families that show them; RefusalBody and its params gain a list parameter through formatList; a static-key test covers
 * runtime refusal codes").
 *
 * ## The rules
 *
 * 1. **The codes are the server's, read from its source** - every `code: '<x>'` the views store and the views routes answer
 *    (`server/src/config/views.ts`, `server/src/api/views.ts`), plus `space_retired`, which any door answers for a retired proxy id. A
 *    list typed here would be the second copy that goes stale; a static key test is how a runtime code without a sentence is caught
 *    before a user sees the raw code.
 * 2. **The families are the client's, read from its source** - every key prefix the client passes to `refusalText(` /
 *    `describeRefusal(` (and the default `networks.refusal`). A view code needs its key under `views.refusal` (the family the My views
 *    dialog and the copy control show), and `space_retired` under EVERY family, because a retired id can be named on any page.
 * 3. **en, de and pl** each hold every one of those keys.
 * 4. **A list parameter reaches the sentence**: a refusal body carrying `members: ['qa', 'ops']` is rendered with the list joined by
 *    `formatList` in the active language (`{{members}}` -> "qa and ops").
 *
 * ## Seen red at 18e8d598
 *
 * The two server files do not exist (no view code at all, below the floor); no `views.refusal` family; `members` is not passed to the
 * sentence (it renders empty).
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CLIENT_ROOT, trackedAppSources } from '../testing/tracked-sources';
import { describeRefusal } from './refusal-text';
import { formatList } from './list-format';

const REPO = resolve(CLIENT_ROOT, '..');
const VIEW_SOURCES = ['server/src/config/views.ts', 'server/src/api/views.ts'];
const LANGS = ['en', 'de', 'pl'] as const;
const dict = Object.fromEntries(LANGS.map(l => [l, JSON.parse(readFileSync(resolve(CLIENT_ROOT, `public/assets/i18n/${l}.json`), 'utf8')) as Record<string, string>]));

const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

/** The refusal codes the views store and routes answer. */
function viewCodes(): string[] {
  const codes = new Set<string>();
  for (const f of VIEW_SOURCES) {
    const p = resolve(REPO, f);
    if (!existsSync(p)) continue;
    for (const m of stripComments(readFileSync(p, 'utf8')).matchAll(/\bcode\s*:\s*'([a-z][a-z0-9_]*)'/g)) codes.add(m[1]!);
  }
  return [...codes].sort();
}

/**
 * The refusal families the client shows: every literal key prefix ending in `.refusal` in its source (handed to the refusal helpers
 * directly, or through a named constant such as `FILE_REFUSAL_PREFIX`), and the helpers' default.
 */
function families(): string[] {
  const out = new Set<string>(['networks.refusal']);
  for (const file of trackedAppSources()) {
    const src = stripComments(readFileSync(resolve(CLIENT_ROOT, file), 'utf8'));
    for (const lit of src.matchAll(/'([a-z][\w]*(?:\.[\w]+)*\.refusal)'/g)) out.add(lit[1]!);
  }
  return [...out].sort();
}

describe('refusal sentences for personal views (Q-531)', () => {
  it('the server answers view refusal codes (derived, floor), and space_retired', () => {
    const codes = viewCodes();
    expect(codes.length, `found ${codes.length} view refusal code(s) in ${VIEW_SOURCES.join(', ')}: ${codes.join(', ')}`).toBeGreaterThanOrEqual(3);
    const anywhere = trackedServerHas(/\bcode\s*:\s*'space_retired'/);
    expect(anywhere, 'no server source answers code space_retired').toBe(true);
  });

  it('the views UI has its own family, views.refusal', () => {
    expect(families()).toContain('views.refusal');
  });

  for (const lang of LANGS) {
    it(`${lang}: every view code under views.refusal, and space_retired under every family`, () => {
      const wanted = [...viewCodes().map(c => `views.refusal.${c}`), ...families().map(f => `${f}.space_retired`)];
      const missing = wanted.filter(k => typeof dict[lang]![k] !== 'string' || dict[lang]![k]!.trim() === '');
      expect(missing, `${lang}.json lacks sentences for runtime refusal codes`).toEqual([]);
    });
  }

  it('a list in the refusal reaches the sentence, joined by formatList', () => {
    const t = {
      translate: (key: string, params?: Record<string, unknown>) =>
        key === 'views.refusal.view_member_unreadable' ? 'Cannot read {{members}}'.replace('{{members}}', String(params?.['members'] ?? '')) : key,
      getActiveLang: () => 'en',
    };
    const err = { status: 400, error: { error: 'x', code: 'view_member_unreadable', members: ['qa', 'ops'] } };
    const view = describeRefusal(t as never, 'en', err as never, 'views.refusal.failed', 'views.refusal');
    expect(view.text).toBe(`Cannot read ${formatList(['qa', 'ops'], 'en')}`);
  });
});

/** Does any tracked server source (comments stripped) match? */
function trackedServerHas(re: RegExp): boolean {
  const files = execFileSync('git', ['ls-files', 'server/src'], { cwd: REPO, encoding: 'utf8' }).split('\n').map(s => s.trim()).filter(f => f.endsWith('.ts'));
  if (files.length < 300) throw new Error(`git ls-files found ${files.length} server sources: the listing failed`);
  return files.some(f => re.test(stripComments(readFileSync(resolve(REPO, f), 'utf8'))));
}
