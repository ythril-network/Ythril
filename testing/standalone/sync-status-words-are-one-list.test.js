/**
 * The sync cycle's status words and a member's outcome words are ONE list each, the server's, and every copy of them agrees with it
 * (bundle-231, Q-681).
 *
 * ## The defect this holds
 *
 * The cycle's status words (`success`, `partial`, `failed`, `refused`) are declared once, as `SYNC_CYCLE_STATUSES` in `metrics/registry.ts`
 * (the metric's label values, the history row's `status`, every door's `outcome` read it). The client carries FIVE hand copies of them, and
 * the docs a sixth: `KNOWN_STATUS` in the history component (a word not in it is shown raw), the `STATUSES` of that component's spec, the
 * `sync.status.<word>` keys of the three shipped languages, the `status` union of `SyncHistoryRecord` in `api.types.ts`, and the metric's row in
 * `docs/integration-guide/11-setup-api.md`. A word added to the server list (a `deferred` cycle, say) would be badge-less raw text in the
 * client, untranslated in two languages and absent from the docs, and nothing failed. The member outcome words
 * (`SYNC_MEMBER_OUTCOMES`) had one test copy (`sync-verdict-is-one-table`'s `WORDS`) and a docs row.
 *
 * ## The rule
 *
 * - every copy of the status words is the server's list as a SET: nothing missing, nothing extra (a word the client knows that the server
 *   never answers is as stale as one it lacks);
 * - every shipped language has a non-empty text for every status word;
 * - the docs' metric rows name every word of their list;
 * - the member outcome words in the build are the one list the classifier reads (`MEMBER_OUTCOMES` is `SYNC_MEMBER_OUTCOMES`), and no
 *   tracked test file carries that list by hand (an array literal naming every one of its words): a test reads it from the build.
 *
 * The copies are read as data by `testing/_shared/client-copy.mjs`, which throws where a copy is not found, so a renamed constant fails here by
 * name instead of comparing an empty list.
 *
 * Seen red by drift: drop a word from `KNOWN_STATUS`, from one language file, from the union or from the docs row (a scratch copy under the
 * cwd this test runs from), and the matching case names the copy and the word. On the unchanged tree the copies agree, and the one case that
 * is red is the hand-held member-outcome list in `sync-verdict-is-one-table.test.js` (until it reads the build's list).
 *
 * Run: node --test testing/standalone/sync-status-words-are-one-list.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { clientConstList, clientUnionWords, i18nKeysUnder, docsRowCodeSpans } from '../_shared/client-copy.mjs';

const COMPONENT = 'client/src/app/pages/settings/network-sync-history.component.ts';
const SPEC = 'client/src/app/pages/settings/network-sync-history.component.spec.ts';
const API_TYPES = 'client/src/app/core/api.types.ts';
const DOCS = 'docs/integration-guide/11-setup-api.md';

let STATUSES, OUTCOMES, cycle;

/** `copy` against `list`, as sets: what is missing and what is extra, by identity. */
function drift(list, copy) {
  const have = new Set(copy);
  const want = new Set(list);
  return {
    missing: [...want].filter(w => !have.has(w)),
    extra: [...have].filter(w => !want.has(w)),
    duplicated: copy.filter((w, i) => copy.indexOf(w) !== i),
  };
}

function assertSameWords(what, list, copy) {
  const d = drift(list, copy);
  assert.deepEqual(d, { missing: [], extra: [], duplicated: [] },
    `${what} does not hold the server's list [${list.join(', ')}]: missing [${d.missing.join(', ')}], extra [${d.extra.join(', ')}], duplicated [${d.duplicated.join(', ')}]`);
}

describe('the sync status words are one list, and every copy of it agrees', () => {
  before(async () => {
    const registry = await import('../../server/dist/metrics/registry.js');
    cycle = await import('../../server/dist/sync/cycle-outcome.js');
    STATUSES = [...registry.SYNC_CYCLE_STATUSES];
    OUTCOMES = [...registry.SYNC_MEMBER_OUTCOMES];
    assert.ok(STATUSES.length >= 4, `SYNC_CYCLE_STATUSES lists ${STATUSES.length} words: the export moved or shrank`);
    assert.ok(OUTCOMES.length >= 7, `SYNC_MEMBER_OUTCOMES lists ${OUTCOMES.length} words: the export moved or shrank`);
  });

  it('KNOWN_STATUS of the history component is the server\'s list', () => {
    assertSameWords(`KNOWN_STATUS in ${COMPONENT}`, STATUSES, clientConstList(COMPONENT, 'KNOWN_STATUS'));
  });

  it('STATUSES of the history component\'s spec is the server\'s list', () => {
    assertSameWords(`STATUSES in ${SPEC}`, STATUSES, clientConstList(SPEC, 'STATUSES'));
  });

  it('the status union of SyncHistoryRecord is the server\'s list', () => {
    const words = clientUnionWords(API_TYPES, /export interface SyncHistoryRecord\s*\{[\s\S]*?\bstatus\??:/);
    assertSameWords(`the status union of SyncHistoryRecord in ${API_TYPES}`, STATUSES, words);
  });

  it('every shipped language has a text for every status word, and for no other', () => {
    const byLang = i18nKeysUnder('sync.status.');
    assert.deepEqual(Object.keys(byLang), ['en', 'de', 'pl'], 'the shipped languages changed: re-anchor this gate');
    for (const [lang, words] of Object.entries(byLang)) {
      assertSameWords(`the sync.status.* keys of ${lang}.json`, STATUSES, Object.keys(words));
      for (const [word, text] of Object.entries(words)) {
        assert.ok(typeof text === 'string' && text.trim().length > 0, `sync.status.${word} in ${lang}.json has no text`);
      }
    }
  });

  it('the docs row of ythril_sync_cycles_total names every status word', () => {
    const spans = docsRowCodeSpans(DOCS, 'ythril_sync_cycles_total');
    const missing = STATUSES.filter(w => !spans.includes(w));
    assert.deepEqual(missing, [], `${DOCS}: the row of ythril_sync_cycles_total does not name the status word(s) ${missing.join(', ')} (it names ${spans.join(', ')})`);
  });

  it('the docs row of ythril_sync_member_outcomes_total names every member outcome word', () => {
    const spans = docsRowCodeSpans(DOCS, 'ythril_sync_member_outcomes_total');
    const missing = OUTCOMES.filter(w => !spans.includes(w));
    assert.deepEqual(missing, [], `${DOCS}: the row of ythril_sync_member_outcomes_total does not name the outcome word(s) ${missing.join(', ')} (it names ${spans.join(', ')})`);
  });

  it('the classifier reads the metric\'s member outcome list (one list, not two)', () => {
    assert.deepEqual([...cycle.MEMBER_OUTCOMES], OUTCOMES, 'cycle-outcome MEMBER_OUTCOMES is not SYNC_MEMBER_OUTCOMES: the classifier and the metric disagree on the words');
  });

  it('no tracked test file carries the member outcome list by hand: an array literal naming every word is a copy', () => {
    // The root is the cwd the run starts from (the project root, as every copy above is read), so a scratch copy of the tree is judged by the same code.
    const files = trackedSources(['testing'], { ext: ['.js', '.mjs'], floor: 200, root: process.cwd() });
    const copies = [];
    for (const file of files) {
      if (file === 'testing/standalone/sync-status-words-are-one-list.test.js') continue;
      const src = stripComments(readFileSync(file, 'utf8'));
      for (const m of src.matchAll(/\[([^\[\]]*)\]/g)) {
        const words = new Set([...m[1].matchAll(/'([^'\\]*)'|"([^"\\]*)"/g)].map(x => x[1] ?? x[2]));
        if (OUTCOMES.every(w => words.has(w))) copies.push(`${file}: [${m[1].replace(/\s+/g, ' ').trim().slice(0, 120)}]`);
      }
    }
    assert.deepEqual(copies, [], `these test files hold the member outcome list as an array literal; read MEMBER_OUTCOMES from server/dist/sync/cycle-outcome.js instead:\n  ${copies.join('\n  ')}`);
  });
});
