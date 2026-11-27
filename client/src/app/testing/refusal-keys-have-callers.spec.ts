/**
 * Every refusal sentence the dictionaries carry has a caller that can show it (Q-762, bundle-273 drive finding).
 *
 * ## The defect shape
 *
 * `views.refusal.view_is_construct` and three sibling keys had words in en, de and pl and no caller that could reach them: the only
 * code that passed the `views.refusal` family to the refusal helpers was the views dialogs, which never read a view, while the page
 * that opens a CONSTRUCT view (a record tab, the files listing, the graph) worded its failed load with `httpErrorReason`, the
 * server's English. A dictionary key with no caller is a sentence nobody sees, and the page shows English to a German reader.
 *
 * ## The two rules, both derived
 *
 * 1. **A family has a caller.** The families are read from the dictionary (every key `<family>.refusal.<code>` of en.json); a family
 *    is called when its literal appears in a tracked, non-spec client source (passed to a refusal helper directly or through a
 *    constant). A family nobody passes is a set of keys no code can reach.
 * 2. **A failed load says it in words.** Every client source that stores a failed load in a `loadError` signal words it through
 *    `loadFailureText`, never `httpErrorReason` alone: `httpErrorReason` is the server's own sentence, so a coded refusal the client
 *    has words for would read in English. The sources below are the ones that keep `httpErrorReason`, each with the reason a view
 *    never reaches it; each is asserted below to still set a `loadError` AND still call `httpErrorReason`, so a fixed file cannot
 *    linger here.
 *
 * ## Seen red
 *
 * Rule 2 is red on a075fa803: record-tab-base.ts, file-listing.store.ts and graph.component.ts set `loadError` from `httpErrorReason`.
 * Rule 1 was green there (the views dialogs passed the family), which is why the callers were not enough on their own.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CLIENT_ROOT, trackedAppSources } from './tracked-sources';
import { stripComments } from './strip-comments';
import { dictionary } from './i18n-dictionary';

/** Sources that set a `loadError` from `httpErrorReason` and are allowed to: the page never loads a personal view's records. */
const EXEMPT: Record<string, string> = {
  'src/app/pages/brain/review-forks-state.ts': 'The Review tab is absent for a personal view; it lists one real space\'s forks.',
  'src/app/pages/files/conflicts.component.ts': 'File conflicts belong to one real space; a view has no files of its own to conflict.',
  'src/app/pages/schema-library/schema-library-namespace.component.ts': 'The schema library is instance-wide and names no space or view.',
  'src/app/pages/schema-library/schema-library.component.ts': 'The schema library is instance-wide and names no space or view.',
  'src/app/pages/settings/network-change-notes.component.ts': 'Network settings read a network, never a view.',
  'src/app/pages/settings/networks.component.ts': 'Network settings read networks, never a view.',
  'src/app/pages/settings/tokens.component.ts': 'The token list is instance-wide; a view is not a token.',
};

const source = (file: string): string => stripComments(readFileSync(resolve(CLIENT_ROOT, file), 'utf8'));
const setsLoadError = (src: string): boolean => /\bloadError\.set\(/.test(src);
const callsHttpErrorReason = (src: string): boolean => /\bhttpErrorReason\(/.test(src);

describe('every refusal key in the dictionaries has a caller that can show it', () => {
  const files = trackedAppSources();

  it('rule 1: every refusal family of en.json is passed to the refusal helpers by some client source', () => {
    const families = new Set<string>();
    for (const key of Object.keys(dictionary('en'))) {
      const m = /^(.+\.refusal)\.[A-Za-z0-9_]+$/.exec(key);
      if (m) families.add(m[1]!);
    }
    expect(families.size, 'no refusal family found in en.json: the pattern or the file moved').toBeGreaterThan(3);
    const text = files.map(source).join('\n');
    const uncalled = [...families].filter(f => !text.includes(`'${f}'`) && !text.includes(`"${f}"`) && !text.includes(`\`${f}`));
    expect(uncalled, `refusal families with words and no caller: ${uncalled.join(', ')}`).toEqual([]);
  });

  it('rule 2: a source that stores a failed load words it through loadFailureText, unless it is listed with its reason', () => {
    const setters = files.filter(f => setsLoadError(source(f)));
    expect(setters.length, 'no source sets a loadError: the pattern moved').toBeGreaterThan(5);
    const offenders = setters.filter(f => {
      const src = source(f);
      return !EXEMPT[f] && callsHttpErrorReason(src) && !/\bloadFailureText\(/.test(src);
    });
    expect(offenders, `these sources show the server's own sentence for a failed load: ${offenders.join(', ')}`).toEqual([]);
  });

  it('rule 2: the sources that must use loadFailureText do (the Brain tabs, the files listing, the graph)', () => {
    for (const f of ['src/app/pages/brain/record-list-state.service.ts', 'src/app/pages/files/file-listing.store.ts', 'src/app/pages/graph/graph.component.ts']) {
      expect(/\bloadFailureText\(/.test(source(f)), `${f} does not call loadFailureText`).toBe(true);
    }
  });

  it('each exemption still sets a loadError and still calls httpErrorReason', () => {
    for (const f of Object.keys(EXEMPT)) {
      const src = source(f);
      expect(setsLoadError(src) && callsHttpErrorReason(src), `${f} is exempt and no longer needs to be`).toBe(true);
    }
  });
});
