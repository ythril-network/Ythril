/**
 * Every existing test, spec or test helper that names a proxy symbol, and what Q-531 does to it (bundle-100, plan rev 3.2).
 *
 * ## Why a list, and why it is held by a gate
 *
 * Q-531 turns a proxy space into a personal view: a view is never in `config.spaces`, `proxyFor` and `targetSpace` are retired
 * fields refused by name, and `isProxy`, `concreteSpaces`, the `memberSpaces*` helpers and `resolveWriteTarget` are deleted. The tests
 * that encode the old rule are the "flip set". Rev 2 listed them by hand and the testing vet found the list short by the gates that
 * encode proxies indirectly (`every-concrete-space-loop-uses-one-helper`, `concrete-space-ids`, the client specs). So the set is
 * DERIVED (`PROXY_SYMBOL` over the tracked test files and test helpers), and this list only says what each one becomes:
 *
 * - `rewrite`: the file stays and must change. `base` is the sha256 prefix of its content (line endings normalised) at the commit the
 *   tests were written on (`18e8d598`); the gate fails while the file still has that content, so a rewrite cannot be forgotten.
 * - `delete`: the file goes; the gate fails while it exists.
 * - `unaffected`: the file names a symbol and needs nothing (a historical note, not a use).
 *
 * `every-proxy-test-is-classified.test.js` holds it: a derived file with no row fails, so a new test naming a proxy symbol is
 * classified before it lands. `why` is one line a reviewer can check against the file.
 */
import { execFileSync } from 'node:child_process';
import { readTrackedSources, REPO_ROOT } from '../standalone/_sources.mjs';

/**
 * The commit the list was classified against: every `rewrite` row's `base` hashes its file as it was here. It is on `main`, so the
 * gate derives the flip set AS IT WAS and holds the list to it, which is what keeps a correct rewrite from lowering the gate's floor.
 */
export const CLASSIFIED_AT = '18e8d598';

/** The symbols the plan names, as stems (the retired fields and the families it deletes by name). */
const PLAN_STEMS = Object.freeze(['proxyFor', 'isProxy', 'concreteSpace', 'memberSpaces', 'targetSpace', 'resolveWriteTarget']);
const PLAN_PATTERN = String.raw`\bproxyFor\b|\bisProxy\w*|\bconcreteSpace\w*|\bmemberSpaces\w*|\btargetSpace\b|\bresolveWriteTarget\b`;

/** The server modules that WERE the proxy rule at `CLASSIFIED_AT`: every source whose file name names a proxy. */
const PROXY_MODULE = /^server\/src\/(?:.+\/)?[^/]*proxy[^/]*\.ts$/;
/** An exported declaration's name. */
const EXPORTED = /^export\s+(?:async\s+)?(?:function\*?|const|let|class|type|interface|enum)\s+(\w+)/gm;
const PROXY_EXPORTS_FLOOR = 10;

const git = (...args) => execFileSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
const exportsOf = (text) => [...text.matchAll(EXPORTED)].map(m => m[1]);

let retired;
/**
 * Every proxy-era symbol, DERIVED (b100 row G): each name a proxy module exported at `CLASSIFIED_AT` that no server source exports today.
 * The plan's stems alone missed `resolveMemberSpaces`, so `space-guard-reads-rights` - which named it - escaped the flip set. A symbol
 * that only MOVED (`findSpace`, now in `spaces/space-lookup.ts`) is still exported and is not proxy-era. Throws rather than answering
 * empty: a scan that found no proxy module, or too few names, is broken (needs the history `CLASSIFIED_AT` is in).
 * @returns {string[]}
 */
export function retiredProxyExports() {
  if (retired) return retired;
  const modules = git('ls-tree', '-r', '--name-only', CLASSIFIED_AT, '--', 'server/src').split('\n').filter(f => PROXY_MODULE.test(f));
  const then = new Set(modules.flatMap(f => exportsOf(git('show', `${CLASSIFIED_AT}:${f}`))));
  const now = new Set(readTrackedSources('server/src', { floor: 300, specs: false }).flatMap(s => exportsOf(s.text)));
  const names = [...then].filter(n => !now.has(n)).sort();
  if (modules.length === 0 || names.length < PROXY_EXPORTS_FLOOR) {
    throw new Error(`derived ${names.length} retired proxy export(s) from ${modules.length} proxy module(s) at ${CLASSIFIED_AT}; the scan is broken`);
  }
  retired = names;
  return retired;
}

/** What a flip-set scan greps for first (fixed strings): the plan's stems and every derived proxy-era symbol. */
export const proxySymbolStems = () => [...new Set([...PLAN_STEMS, ...retiredProxyExports()])];

/** A file naming one of these is in the flip set. Built fresh per use (a shared /g regex under-scans). */
export const proxySymbolPattern = () => new RegExp(`${PLAN_PATTERN}|${retiredProxyExports().map(n => String.raw`\b${n}\b`).join('|')}`);

/** Where the flip set is looked for: the test suites, their helpers, and the client specs. */
export const FLIP_SET_ROOTS = Object.freeze(['testing', 'client/src']);

export const PROXY_TEST_CLASSIFICATION = Object.freeze([
  { file: 'client/src/app/pages/brain/brain-reindex.spec.ts', verdict: 'rewrite', base: 'e7ce041a0a2fbf97',
    why: 'its proxy-space fixture drives the reindex-notes proxy branch, which goes; a view is not a reindex subject' },
  { file: 'client/src/app/pages/settings/space-create-dialog.component.spec.ts', verdict: 'rewrite', base: 'c64ca6c697404868',
    why: 'the create dialog loses its proxyFor block; the member-toggle cases become the My views create dialog\'s' },
  { file: 'client/src/app/pages/settings/space-schema-tab.component.spec.ts', verdict: 'rewrite', base: '392b7bfed61b1e18',
    why: 'the "on a proxy space" note case goes: a view never opens the schema tab' },
  { file: 'client/src/app/shared/proxy-space-badge.component.spec.ts', verdict: 'delete',
    why: 'the proxy badge component is deleted; the view marker has its own spec' },
  { file: 'testing/_shared/proxy-questions.mjs', verdict: 'delete',
    why: 'answers "is this space a proxy" for the isProxy gates, which are deleted with the question' },
  { file: 'testing/integration/actual-schema-both-doors.test.js', verdict: 'rewrite', base: '1d461ac7be991551',
    why: 'its comment names memberSpacesWithin as the tool\'s narrowing; that helper is deleted' },
  { file: 'testing/integration/brain-embed-jobs-both-surfaces.test.js', verdict: 'rewrite', base: 'be3d133c55e37de8',
    why: 'makes a proxy and retries through targetSpace; becomes a view read plus a member write' },
  { file: 'testing/integration/mcp-create-space.test.js', verdict: 'rewrite', base: 'dd807563d04d82c2',
    why: 'creates proxies through save_space; proxyFor is now refused by name there' },
  { file: 'testing/integration/mcp-reindex.test.js', verdict: 'rewrite', base: '02950b3c5784d3a6',
    why: 'reindexes through a proxy and reads memberSpaces/proxyFor off the answer; a view id is not a space there' },
  { file: 'testing/integration/proxy-spaces.test.js', verdict: 'rewrite', base: '229b30be39fbd370',
    why: 'the proxy contract suite; becomes the personal-views contract (plan rev 3 section 7)' },
  { file: 'testing/integration/query-skip-and-strict-bodies.test.js', verdict: 'rewrite', base: '81d2abbf3641aba3',
    why: 'pages a query across a proxy\'s members; becomes a view read' },
  { file: 'testing/integration/reindex-contract.test.js', verdict: 'rewrite', base: '465f54c6ceb69539',
    why: 'pins the proxy refusal body (proxyFor field); a view id answers as an unknown space' },
  { file: 'testing/integration/space-create-contract.test.js', verdict: 'rewrite', base: '4818195a0b21d307',
    why: 'creates proxies (missing member, nested, wildcard); proxyFor is refused by name on POST /api/spaces' },
  { file: 'testing/red-team-tests/auth-escalation.test.js', verdict: 'rewrite', base: '0c65f115d3c6f2e7',
    why: 'escalates through an admin-made proxy; becomes another token\'s view, answered as an unknown id' },
  { file: 'testing/standalone/_housekeeping-walks.mjs', verdict: 'rewrite', base: '8f46bb0ff29ee02f',
    why: 'its header lists concreteSpaces() among the space walks; that helper is deleted' },
  { file: 'testing/standalone/_inline-edge-doors.mjs', verdict: 'rewrite', base: '6906bb95dde96aef',
    why: 'builds proxies into the config and sends targetSpace; both are retired' },
  { file: 'testing/standalone/_oversize-files.mjs', verdict: 'unaffected',
    why: 'a historical note on why a size budget was raised; it names a helper, it calls none' },
  { file: 'testing/standalone/_route-accept-keys.mjs', verdict: 'rewrite', base: 'cc680e1dd7828ca8',
    why: 'its docblock names memberSpacesForRequest among the authToken readers; that helper is deleted' },
  { file: 'testing/standalone/a-conflict-resolution-never-replaces-an-unrelated-file-db.test.js', verdict: 'rewrite', base: '34275bbe857f35eb',
    why: 'pushes a proxy into the config for a save-to-space case; a view is not a destination' },
  { file: 'testing/standalone/a-file-stamp-report-takes-the-same-parameters-on-every-door-db.test.js', verdict: 'rewrite', base: '4b53f34059a01b90',
    why: 'pushes a proxy for a case; a view id answers as an unknown space on that write door' },
  { file: 'testing/standalone/a-hand-edited-empty-proxy-list-is-a-real-space.test.js', verdict: 'delete',
    why: 'Q-80\'s rule moves into the migration predicate (proxyFor: [] stays a space), held by proxies-migrate-to-personal-views' },
  { file: 'testing/standalone/a-proxy-is-asked-one-way.test.js', verdict: 'delete',
    why: 'isProxy is deleted with the question it answers' },
  { file: 'testing/standalone/a-proxy-is-never-a-link-conversion-subject.test.js', verdict: 'delete',
    why: 'no proxy reaches config.spaces after the migration, so link conversion has none to skip' },
  { file: 'testing/standalone/a-proxy-write-reaches-only-what-the-token-reaches-db.test.js', verdict: 'delete',
    why: 'no write goes through a view; the write-door refusal is held by a-personal-view-reads-alike-on-every-door' },
  { file: 'testing/standalone/a-route-judges-before-it-checks-the-body.test.js', verdict: 'rewrite', base: '8098baad381d836e',
    why: 'anchors on resolveWriteTarget( and isProxySpace(; the judge order anchors on the existence check instead' },
  { file: 'testing/standalone/a-route-reads-what-its-tool-declares.test.js', verdict: 'rewrite', base: 'a9cd2a914cf27bd4',
    why: 'lists targetSpace as a transport key; targetSpace is a retired field refused by name' },
  { file: 'testing/standalone/a-tool-and-its-route-agree-on-bounds.test.js', verdict: 'rewrite', base: '4f31e63a77482f7b',
    why: 'lists targetSpace as a transport key; targetSpace is a retired field refused by name' },
  { file: 'testing/standalone/a-tool-and-its-route-take-the-same-parameters.test.js', verdict: 'rewrite', base: '851101215039f497',
    why: 'lists targetSpace as a transport key; targetSpace is a retired field refused by name' },
  { file: 'testing/standalone/a-warn-space-and-an-unknown-field-are-answered-as-pinned-before-bundle-23-db.test.js', verdict: 'rewrite', base: '6e80601d693a2be0',
    why: 'a pinned allowed-keys text names targetSpace; it leaves the allowed list' },
  { file: 'testing/standalone/an-inline-edge-refused-writes-nothing-on-every-door-db.test.js', verdict: 'rewrite', base: '398a276a9823dee0',
    why: 'writes through proxies with targetSpace; those cases go, the member writes stay' },
  { file: 'testing/standalone/an-unknown-field-is-answered-alike-on-both-doors-db.test.js', verdict: 'rewrite', base: 'ed2a861d957386d9',
    why: 'addresses writes through targetSpace on both doors; those cases go' },
  { file: 'testing/standalone/an-unknown-field-rides-every-answer-after-the-judge-db.test.js', verdict: 'rewrite', base: 'b6c724e5ccab9d71',
    why: 'writes through a proxy with targetSpace; those cases go' },
  { file: 'testing/standalone/area-rung-is-staged.test.js', verdict: 'rewrite', base: '04e8d5bfbe108b3f',
    why: 'asserted spaceTargets calls resolveMemberSpaces (a proxy\'s members); found by the derived symbols (b100 row G), already rewritten' },
  { file: 'testing/standalone/column-filters.test.js', verdict: 'unaffected',
    why: 'a historical note on how the list routes paged (collectAcrossMembers) before the shared pager; it calls nothing' },
  { file: 'testing/standalone/chrono-retention-isolates-a-failing-space-db.test.js', verdict: 'rewrite', base: '585b42083db8c5ea',
    why: 'its comment says concreteSpaces() is the walked set; the walk reads config.spaces' },
  { file: 'testing/standalone/chrono-retention.test.js', verdict: 'rewrite', base: '362afb54a2dae74c',
    why: 'asserts eachSpace(..., concreteSpaces()); re-anchor on the spaces the walk is given' },
  { file: 'testing/standalone/concrete-space-ids.test.js', verdict: 'delete',
    why: 'concreteSpaceIds and concreteSpaces are deleted (every config.spaces entry is concrete)' },
  { file: 'testing/standalone/every-concrete-space-loop-uses-one-helper.test.js', verdict: 'delete',
    why: 'its rule (skip proxies through one helper) has no subject once no proxy is a space' },
  { file: 'testing/standalone/every-proxy-write-door-resolves-its-target-with-the-callers-grant.test.js', verdict: 'delete',
    why: 'resolveWriteTarget and the proxy write path are deleted' },
  { file: 'testing/standalone/every-space-act-goes-through-the-runner.test.js', verdict: 'rewrite', base: 'bcf295f11657be0a',
    why: 'its regex names concreteSpaces in the bare-loop pattern' },
  { file: 'testing/standalone/every-target-space-parameter-states-the-reach-rule.test.js', verdict: 'delete',
    why: 'no MCP tool takes targetSpace any more' },
  { file: 'testing/standalone/extract-view.test.js', verdict: 'rewrite', base: '7bdda6286f3f8d2f',
    why: 'asserts a loop over memberSpacesForRequest(req, spaceId); the read resolves through viewReadMembers' },
  { file: 'testing/standalone/file-mutation-tools-state-their-cascade.test.js', verdict: 'rewrite', base: '436de4b5a1dfb322',
    why: 'slices a tool\'s text at \'targetSpace\', which leaves the tool' },
  { file: 'testing/standalone/links-convert-runs-at-boot.test.js', verdict: 'rewrite', base: 'e2136d6ba8092944',
    why: 'its pending-filter anchor is the proxy check, which goes' },
  { file: 'testing/standalone/no-polling-a-deleted-space.test.js', verdict: 'rewrite', base: '922f59ae6ea65822',
    why: 'asserts concreteSpaceIds() in the walk; that helper is deleted' },
  { file: 'testing/standalone/proxy-fanout-inventory.test.js', verdict: 'delete',
    why: 'the inventory of proxy fan-out sites has no subject once no proxy is a space' },
  { file: 'testing/standalone/proxy-reach.test.js', verdict: 'delete',
    why: 'memberSpacesForToken is deleted; reach over a view\'s members is viewReadMembers, held by the parity test' },
  { file: 'testing/standalone/reindex-refuses-a-proxy.test.js', verdict: 'delete',
    why: 'reindex of a view id answers as an unknown space, held by the write-door parity test' },
  { file: 'testing/standalone/space-bodies-are-strict.test.js', verdict: 'rewrite', base: '7de08fa02f453f69',
    why: 'the create strip keeps proxyFor as a real input; it becomes a field refused by name' },
  { file: 'testing/standalone/space-guard-reads-rights.test.js', verdict: 'rewrite', base: '063b5da1e14b8f20',
    why: 'held the guard to "at least one member" through resolveMemberSpaces; escaped the plan\'s stems, found by the derived symbols (b100 row G)' },
  { file: 'testing/standalone/space-info-tools-orient-a-caller.test.js', verdict: 'rewrite', base: 'd8b3f16091cc8a5c',
    why: 'its docblock tells a caller a proxy write needs targetSpace; that is retired' },
  { file: 'testing/standalone/the-boot-suppression-sweep-isolates-a-failing-space-db.test.js', verdict: 'rewrite', base: 'd144454cae576f2a',
    why: 'its docblock names the concreteSpaces() loop; the walk reads config.spaces' },
  { file: 'testing/standalone/the-boot-sweep-waits-for-the-server-and-runs-one-space-at-a-time.test.js', verdict: 'rewrite', base: '28e2ebf5df371927',
    why: 'asserts the walk names concreteSpaces(); re-anchor on config.spaces' },
  { file: 'testing/standalone/the-embed-queue-lists-one-way-on-both-doors.test.js', verdict: 'rewrite', base: 'da5855baadaf8250',
    why: 'asserts list_embed_jobs uses memberSpacesWithin; it resolves a view through viewReadMembers' },
  { file: 'testing/standalone/the-retired-arrays-leave-the-disk-db.test.js', verdict: 'rewrite', base: '382475e685584071',
    why: 'seeds a proxy in its fixture config; the migration turns it into a view at load' },
  { file: 'testing/standalone/the-unknown-write-field-judge-answers-by-outcome-and-stays-bounded.test.js', verdict: 'rewrite', base: '54302bebbf9aa200',
    why: 'lists targetSpace as an addressing key; it is a retired field refused by name' },
  { file: 'testing/standalone/the-unknown-write-fields-setting-is-set-refused-and-governed-alike-on-both-doors-db.test.js', verdict: 'rewrite', base: '641e3bf4160c95b9',
    why: 'writes through a proxy with targetSpace on both doors; those cases go' },
  { file: 'testing/standalone/type-filters-are-indexed-db.test.js', verdict: 'rewrite', base: '93f0e69e566056ec',
    why: 'asserts eachSpace(QUERY_INDEXES_STEP, concreteSpaces()); re-anchor on config.spaces' },
  { file: 'testing/sync/helpers.js', verdict: 'rewrite', base: 'b27c22056b87437b',
    why: 'skips proxies when listing spaces to sync; no proxy is a space after the migration' },
  { file: 'testing/standalone/a-personal-view-has-one-home-in-the-source.test.js', verdict: 'unaffected',
    why: 'Q-531\'s own gate: names proxyFor/isProxy as what a config.spaces reader must no longer say' },
  { file: 'testing/standalone/a-personal-view-reads-alike-on-every-door-db.test.js', verdict: 'unaffected',
    why: 'Q-531\'s own test: sends targetSpace and proxyFor to see them refused by name' },
  { file: 'testing/standalone/proxies-migrate-to-personal-views.test.js', verdict: 'unaffected',
    why: 'Q-531\'s own test: feeds proxyFor configs to the migration that retires them' },
  { file: 'testing/standalone/a-restored-5x-config-is-backed-up-before-a-reload-converts-it.test.js', verdict: 'unaffected',
    why: 'Q-531\'s own test (b100 lens D3): reloads a 5.x proxyFor config to see the reload back it up before converting it' },
  { file: 'testing/sync/a-migrated-proxy-leaves-its-network-space-as-its-peers-see-it.test.js', verdict: 'unaffected',
    why: 'Q-531\'s own test: hand-edits a 5.x proxyFor into a config so the migration takes it out of its network' },
  { file: 'testing/standalone/rollback-is-documented.test.js', verdict: 'unaffected',
    why: 'names proxyFor as the key the 6.0 migration reads when it explains the rollback; a historical note, not a use' },
]);
