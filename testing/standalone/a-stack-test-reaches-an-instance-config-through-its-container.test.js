/**
 * A stack-suite test reaches an instance's `config.json` or `secrets.json` through the instance's container (`docker exec`, the helpers of
 * `testing/sync/helpers.js`: `readContainerConfig`, `patchContainerNetwork`, `injectPeerToken`), never through the host path of the stack's bind
 * mount (`testing/sync/configs/<x>/config.json`).
 *
 * ## What it prevents
 *
 * The instance writes both files as the container's `node` user with mode 0600 (`server/src/config/loader.ts`). On a Windows host the bind mount
 * ignores the mode, so a host read passes locally; on CI's Linux runner the runner's user is not the container's, and the read fails. Bundle-284's
 * `steps-a-relayer-adds-are-not-applied` read A's config through the bind mount and timed out "waiting for a whole read of
 * .../testing/sync/configs/a/config.json" in CI run 44354113429, and every case after it waited minutes for a round that was never altered.
 *
 * ## The rule
 *
 * In every tracked `.js` and `.mjs` under the stack suites (`testing/sync`, `testing/integration`, `testing/red-team-tests`), a string literal in
 * the file's syntax tree (a comment is not read) that names `config.json` or `secrets.json` as a host path is refused: the literal is the file
 * name, or ends in it, and does not hold the container's own path (`/config/`, which a `docker exec` names). A file that reads the host path on
 * purpose (a Windows-only branch beside its `docker exec` one) is named in the `.allow.json` beside this file with a reason and a reviewBy date.
 *
 * The scope is the repository's tracked files, so a new suite file is covered without editing this one. The allowlist is read as data: an entry
 * with no reason, a past reviewBy, or a file that no longer holds such a literal fails, and the count of entries is printed. The proof plants the
 * line the defect was (`path.join(CONFIGS, x, 'config.json')`) in a copy of a real suite file and sees it refused.
 *
 * Run: node --test testing/standalone/a-stack-test-reaches-an-instance-config-through-its-container.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, readTrackedSources } from './_sources.mjs';
import { ts, parseSource, lineOf, walkEveryNode } from '../_shared/syntax-tree.mjs';

const ALLOW = JSON.parse(readFileSync(new URL('./a-stack-test-reaches-an-instance-config-through-its-container.allow.json', import.meta.url), 'utf8')).entries;
const STACK_SUITES = ['testing/sync', 'testing/integration', 'testing/red-team-tests'];
const FLOOR = 100;
const FILES = ['config.json', 'secrets.json'];
/** The container's own directory of the two files: a literal that holds it is a `docker exec` path, not a host one. */
const CONTAINER_DIR = '/config/';

/** Does this literal text name one of the two files as a host path? */
const namesHostFile = (text) => FILES.some(f => text === f || text.endsWith(`/${f}`)) && !text.includes(CONTAINER_DIR);

/** `{ file, lines }` for every source holding a string literal (a template's literal parts included) that names a host path of the two files. */
export function hostConfigReads(sources) {
  const out = [];
  for (const { file, text } of sources) {
    const sf = parseSource(file, text);
    const lines = [];
    walkEveryNode(sf, (n) => {
      const literal = ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n);
      if (literal && namesHostFile(n.text)) lines.push(lineOf(sf, n));
    });
    if (lines.length) out.push({ file, lines });
  }
  return out;
}

const suites = () => readTrackedSources(STACK_SUITES, { ext: ['.js', '.mjs'], floor: FLOOR });

describe('a stack test reaches an instance config through its container', () => {
  it('no stack-suite file reads an instance config through the bind mount, but those the allowlist explains', () => {
    const allowed = new Set(ALLOW.map(e => e.file));
    const offenders = hostConfigReads(suites()).filter(o => !allowed.has(o.file));
    assert.deepEqual(offenders.map(o => `${o.file}:${o.lines.join(',')}`), [],
      'these name an instance\'s config.json or secrets.json by its host path, which CI\'s runner user cannot read (0600, the container\'s node user): '
      + 'use readContainerConfig / patchContainerNetwork / injectPeerToken (testing/sync/helpers.js), or add the file to the .allow.json with a reason');
  });

  it('every allowlist entry has a reason, a future reviewBy, and a file that still reads the host path', () => {
    const today = new Date().toISOString().slice(0, 10);
    const holding = new Set(hostConfigReads(suites()).map(o => o.file));
    for (const e of ALLOW) {
      assert.ok(typeof e.reason === 'string' && e.reason.length >= 20, `${e.file}: a reason of at least 20 characters`);
      assert.match(e.reviewBy ?? '', /^\d{4}-\d{2}-\d{2}$/, `${e.file}: reviewBy`);
      assert.ok(e.reviewBy > today, `${e.file}: reviewBy ${e.reviewBy} has passed`);
      assert.ok(holding.has(e.file), `${e.file} no longer reads the host path: drop its entry`);
    }
    console.log(`host config read allowlist: ${ALLOW.length} entries`);
  });

  it('fails on a planted copy of the defect, and passes the container path and a comment', () => {
    const real = readFileSync(join(REPO_ROOT, 'testing/sync/helpers.js'), 'utf8');
    assert.deepEqual(hostConfigReads([{ file: 'real.mjs', text: real }]), [], 'the helpers that read through the container are clean');
    const planted = `${real}\nconst file = path.join(CONFIGS, x, 'config.json');\n`;
    assert.equal(hostConfigReads([{ file: 'planted.mjs', text: planted }]).length, 1, 'the planted host read is caught');
    const secrets = `${real}\nconst s = \`\${CONFIGS}/a/secrets.json\`;\n`;
    assert.equal(hostConfigReads([{ file: 'planted.mjs', text: secrets }]).length, 1, 'a template that ends in the host path is caught');
    const comment = `// edits 'config.json' through the container\n${real}`;
    assert.deepEqual(hostConfigReads([{ file: 'c.mjs', text: comment }]), [], 'a comment naming the file is not a read');
  });
});
