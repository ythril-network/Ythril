/**
 * Every environment variable the SERVER reads is documented, and every one the docs name is read there or is listed as
 * not a setting.
 *
 * ## What "the code" is here, and what it is not
 *
 * The scan reads `server/src`, the sidecars, the root compose file and the Dockerfile. It does not read `scripts/`,
 * `testing/`, the test compose file or the benchmarks, so it says nothing about the variables the maintainer tooling
 * reads. They were undocumented for as long as they existed, with this gate green throughout, because its title said
 * "the code" and its body read the server. Those variables are held by their own gate,
 * `scripts-and-test-runners-document-their-env-vars`, which derives them from `scripts/` and `testing/_init/` and
 * requires each on `docs/testing-guide.md`. The testing guide names them, so the reverse check below meets them and
 * needs a `NOT_A_SETTING` row for each: that is the reverse check working, not a hole in it.
 *
 * Written during the pre-release doc audit, and kept as a gate rather than thrown away: the audit
 * found seven user-facing local-connector settings (token, port, tunnel name, cloudflared path…) that
 * existed only in the source. An undocumented setting is not a missing feature — it is a feature
 * nobody can find, and nothing anywhere reports it.
 *
 * The reverse direction matters as much. A variable named in the docs but absent from the code is
 * worse than an omission: a reader copies it into their compose file or `.env`, it does nothing, and
 * there is no error to explain why. Renames are the usual cause.
 *
 * ── Two false-positive classes this scanner had to learn ────────────────────────────────────────
 *
 * The first version reported three variables as absent from the code that are read on every request,
 * because it only matched `process.env[...]` and missed reads routed through an `envTrue(...)` helper.
 * The second reported `YTHRIL_PORT` as absent because it only looked at `server/src` — that one is a
 * docker-compose variable (`"${YTHRIL_PORT:-3200}:3200"`), never read by the server at all.
 *
 * Both are why compose files count as "code" here and why helper calls are matched. A scanner that
 * under-detects usage manufactures findings, and findings that turn out to be noise are how a check
 * like this gets ignored and then deleted.
 *
 * Run: node --test testing/standalone/env-var-docs-coverage.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry !== 'node_modules' && entry !== 'dist') walk(p, out);
    } else out.push(p);
  }
  return out;
}

/**
 * Which variables are ours to document: everything the scan finds, minus an explicit ambient list.
 *
 * It used to be an allowlist of four namespaces — `YTHRIL_`/`MONGO_`/`MCP_`/`OIDC_` — which is the wrong
 * polarity for a completeness gate. **No model-endpoint variable was ever in scope**: not `EMBEDDING_URL`,
 * not `DOC_VLM_URL`, not one of the ten slots. That blind spot let three names that do not exist
 * (`EMBEDDING_BASE_URL`, `RERANK_BASE_URL`, `NLI_BASE_URL` — the real ones drop the `BASE_`) ship in the
 * integration guide's egress matrix, where a reader would set them and watch nothing happen.
 *
 * A denylist fails the right way round. A new variable in a namespace nobody anticipated is now *in* scope
 * and has to be documented or explicitly excused; under the allowlist it was silently exempt. Widening it
 * brought 40 more variables into scope and cost 9 doc entries, which is the ratio that makes a gate worth
 * having rather than worth suppressing.
 */
const AMBIENT = new Set([
  // The runtime's and the shell's, not ours.
  'NODE_ENV', 'NODE_OPTIONS', 'PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'HOSTNAME', 'TZ', 'LANG', 'SHELL',
  'PWD', 'COMSPEC', 'SYSTEMROOT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  // CI-provided.
  'CI', 'GITHUB_TOKEN', 'GITHUB_ACTIONS', 'FORCE_JAVASCRIPT_ACTIONS_TO_NODE24',
]);

const TOOLING_REASON = 'read by the test and maintenance tooling (scripts/, testing/, the test compose file), never by the server; '
  + 'named in docs/testing-guide.md, where scripts-and-test-runners-document-their-env-vars requires the ones scripts/ and '
  + 'testing/_init/ read, and this gate (which scans the server) cannot see them';
/** Variables the testing guide names that this gate's scan does not read. Each is a row below, with the reason above. */
const TOOLING_VARS = [
  'YTHRIL_TEST_MONGO_HOST', 'YTHRIL_TEST_MONGO_PORT', 'YTHRIL_TEST_WAIT_TIMING_FILE',
  'YTHRIL_TEST_RUNS_URL', 'YTHRIL_TEST_RUNS_TOKEN', 'GH_TOKEN', 'GITHUB_API_URL', 'GITHUB_STEP_SUMMARY',
  'YTHRIL_TEST_APP_CPUS', 'YTHRIL_TEST_APP_MEM', 'YTHRIL_TEST_APP_A_MEM',
  'YTHRIL_TEST_MONGO_CPUS', 'YTHRIL_TEST_MONGO_MEM', 'YTHRIL_TEST_MONGO_A_MEM', 'YTHRIL_TEST_MONGOT_A_HEAP',
  'YTHRIL_TEST_DOCRENDER_CPUS', 'YTHRIL_TEST_DOCRENDER_MEM', 'YTHRIL_TEST_DOCRENDER_PIDS',
  'YTHRIL_TEST_DOCOFFICE_CPUS', 'YTHRIL_TEST_DOCOFFICE_MEM', 'YTHRIL_TEST_DOCOFFICE_PIDS',
  'BENCH_REPEATS', 'TODO_CHECK_DIR',
];

/**
 * `SCREAMING_CASE` in the docs that is deliberately **not** a setting of ours.
 *
 * Each is listed with why, because an unexplained exemption is how a real finding gets waved through
 * later by someone extending the list. Nothing here may be a variable this codebase reads — the check
 * below asserts exactly that, so an entry added to silence a genuine finding fails.
 */
const NOT_A_SETTING = new Map([
  ...TOOLING_VARS.map((name) => [name, TOOLING_REASON]),
  // Source identifiers of the test tooling, named in prose where the guide points at the one description of a record.
  ['TIMING_SCHEMA', 'an exported constant of testing/_shared/timing-reporter.mjs: the one description of a timing line'],
  ['TIMING_END_SCHEMA', 'an exported constant of testing/_shared/timing-reporter.mjs: the one description of the closing line'],
  ['TEST_RUN_SCHEMA', 'an exported constant of scripts/test-times.mjs: the one description of a Test-Run entry'],
  ['ONNXRUNTIME_NODE_INSTALL_CUDA', "a third-party package's install-time variable, set to skip by every npm ci in CI (docs/testing-guide.md says why); the server never reads it"],
  // API error codes, documented so a client can branch on them.
  ['INFRA_MANAGED', 'API error code'],
  ['FEATURE_DISABLED', 'API error code'],
  ['MFA_REQUIRED', 'API error code'],
  ['MERKLE_DIVERGENCE', 'sync conflict code'],
  ['FILE_REPLACED', 'sync log code: a peer edit replaced an untouched local file'],
  ['REPARENT_REVERT_AVAILABLE', 'network notification code'],
  ['ERR_ERL_UNEXPECTED_X_FORWARDED_FOR', 'an express-rate-limit error code, quoted in a troubleshooting note'],
  // Source identifiers named in prose.
  ['EGRESS_SLOTS', 'a TypeScript constant the egress matrix is checked against'],
  ['FETCH_TIMEOUT_MS', 'a sync-engine constant, not settable'],
  ['BATCH_FETCH_TIMEOUT_MS', 'a sync-engine constant, not settable'],
  ['REPLICATED_FAMILIES', 'a TypeScript constant: the order a sender pushes record families, named in sync-protocol.md as its source'],
  // Placeholders in copy-paste examples.
  ['YOUR_TENANT_ID', 'placeholder in an OIDC example'],
  ['YOUR_CLIENT_ID', 'placeholder in an OIDC example'],
  ['YOUR_API_IDENTIFIER', 'placeholder in an OIDC example'],
  ['YOUR_PASSWORD', 'placeholder in a login example'],
  ['YOUR_TOKEN', 'placeholder in a curl example'],
  // Other processes' environment, documented because an operator has to set them somewhere else.
  ['DOCKERHUB_USERNAME', 'a GitHub Actions secret, not read by the app'],
  ['DOCKERHUB_TOKEN', 'a GitHub Actions secret, not read by the app'],
  ['NUMBA_CACHE_DIR', "a third-party library's env, set in a sidecar image"],
  ['YTHRIL_MCP_TOKEN', 'the MCP CLIENT\'s variable, expanded by the assistant when it builds the Authorization header — the server never reads it. Named in the userguide\'s scoped-token example. The YTHRIL_ prefix is what real operators use (one per instance, e.g. YTHRIL_<INSTANCE>_MCP_TOKEN), which is exactly why this gate flagged it: in a doc, that prefix reads as a setting of ours'],
  // `HF_HUB_OFFLINE` used to sit here, exempted as "a third-party library's env, set in a sidecar image".
  // That was true and became false: the Node process reads it now, because transformers.js does NOT (it is
  // Python's variable) and an operator who sets it stack-wide has every right to expect the embedding model
  // to obey. This gate is what noticed — the exemption's stated reason stopped matching the code, and the
  // fix is a documented setting rather than a wider allowlist.
  ['XDG_CACHE_HOME', "a third-party library's env, set in a sidecar image"],
  // Removed settings the docs still name so an upgrader can find out they are gone.
  ['MEDIA_EMBEDDING_ENABLED', 'removed in 2.0.0; documented as a breaking change'],
]);

const OURS = (name) => !AMBIENT.has(name);

const NAME = '([A-Z][A-Z0-9_]{2,})';
const READ_PATTERNS = [
  new RegExp(`process\\.env\\[['"]${NAME}['"]\\]`, 'g'),
  new RegExp(`process\\.env\\.${NAME}`, 'g'),
  new RegExp(`os\\.environ\\.get\\(\\s*['"]${NAME}['"]`, 'g'),
  new RegExp(`os\\.getenv\\(\\s*['"]${NAME}['"]`, 'g'),
  // Reads via helpers. Omitting these made the first run of this scan produce three false findings.
  new RegExp(`\\b(?:envTrue|envFalse|envInt|envNum|envStr|envList|readEnv|getEnv)\\(\\s*['"]${NAME}['"]`, 'g'),
];

/** Where a variable can legitimately be "used": source, plus compose/Dockerfile interpolation. */
function collectUsage() {
  const files = [
    ...walk(join(ROOT, 'server', 'src')).filter(f => f.endsWith('.ts')),
    ...walk(join(ROOT, 'sidecars')).filter(f => f.endsWith('.py')),
    ...['docker-compose.yml', 'Dockerfile'].map(f => join(ROOT, f)).filter(existsSync),
  ];

  const used = new Map();
  const add = (name, file) => {
    if (!used.has(name)) used.set(name, new Set());
    used.get(name).add(file.replace(ROOT, '').replace(/\\/g, '/').replace(/^[/\\]/, ''));
  };

  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const re of READ_PATTERNS) for (const m of src.matchAll(re)) add(m[1], f);

    // Env names held in a lookup table and read as `process.env[TABLE[key]]`.
    //
    // Same class of miss as the helper calls above, and added for the same reason. The per-slot egress
    // permissions are ten variables whose names live in one `Record<Slot, string>`; every one is really
    // read, just not at a `process.env['LITERAL']` site. Without this the scan would call all ten
    // phantoms and the honest fix — writing the names out so an operator can grep them — would be what
    // triggered the failure.
    //
    // Gated on the file actually indexing `process.env` with a non-literal, so a module that merely
    // MENTIONS a variable name in prose or an error message does not get credit for reading it.
    if (/process\.env\[\s*[A-Za-z_$]/.test(src)) {
      for (const m of src.matchAll(/['"]([A-Z][A-Z0-9_]{2,})['"]/g)) add(m[1], f);
    }

    // Compose / Dockerfile interpolation: ${VAR} and ${VAR:-default}.
    //
    // ONLY for those files. Applying it to TypeScript matches ordinary template-literal
    // interpolation of SCREAMING_CASE constants — it reported `OIDC_HTTP_TIMEOUT_MS` and
    // `OIDC_PRIVATE_ISSUER_HINT` as undocumented settings when both are `export const` values that
    // happen to be interpolated into an error message.
    if (/(docker-compose\.ya?ml|Dockerfile)$/i.test(f)) {
      for (const m of src.matchAll(/\$\{([A-Z][A-Z0-9_]{2,})(?::-[^}]*)?\}/g)) add(m[1], f);
    }
  }
  return used;
}

/**
 * What the docs *name as a setting*, as opposed to what they merely capitalise.
 *
 * `SCREAMING_CASE` in prose is not only env vars — the guides are full of `HTTP`, `JSON`, `OCR`, `VLM`,
 * `TOTP`, `SSRF`. While the scope was four namespaces the prefix filtered those out for free; a denylist
 * does not, so the shape of the token has to.
 *
 * The rule: an underscore, **or** a name the code actually reads. An env var in this project either
 * carries an underscore (`EMBEDDING_URL`, `RENDER_MAX_BYTES`) or is a single well-known word the code
 * demonstrably reads (`PORT`, `DEBUG`). An acronym has neither. That keeps the phantom check pointed at
 * the class of mistake it exists for — `EMBEDDING_BASE_URL` for `EMBEDDING_URL`, a name shaped exactly
 * like a setting and belonging to nothing.
 */
function collectDocumented(used) {
  const docs = new Map();
  // Recursive. The integration guide is 17 files in a subdirectory now, and it documents most of the
  // env vars — a one-level listing would report almost all of them as undocumented.
  const mdUnder = (dir, prefix = '', out = []) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) mdUnder(join(dir, e.name), `${prefix}${e.name}/`, out);
      else if (e.name.endsWith('.md')) out.push(`${prefix}${e.name}`);
    }
    return out;
  };
  for (const f of mdUnder(join(ROOT, 'docs'))) {
    const src = readFileSync(join(ROOT, 'docs', f), 'utf8');
    for (const m of src.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)) {
      if (!OURS(m[1])) continue;
      if (!m[1].includes('_') && !used.has(m[1])) continue;
      // A trailing underscore is never a real variable — it is the stub left behind when prose names a
      // FAMILY of them, `YTHRIL_ALLOW_PRIVATE_<SLOT>` or `YTHRIL_ALLOW_PRIVATE_*`, and the word-boundary
      // match keeps only the prefix. Counting those as documented settings makes the reverse check report
      // a phantom for every family the docs describe, which is a finding about the scanner, not the docs.
      if (m[1].endsWith('_')) continue;
      if (!docs.has(m[1])) docs.set(m[1], new Set());
      docs.get(m[1]).add(f);
    }
  }
  return docs;
}

/**
 * A variable belongs on the page that documents the FEATURE it configures — not merely somewhere under `docs/`.
 *
 * ## Why "documented somewhere" was not enough
 *
 * `FACE_RECOGNITION_EXTERNAL_MODEL` was in `02-hosting.md`'s egress matrix and absent from `05c-face-recognition.md`.
 * This gate was green throughout, and it was right to be — it asked whether the variable was documented, and it was.
 * The canary operator, reading the face-recognition page while configuring face recognition, could not find it, told us it
 * did not exist, and we agreed with them. A variable on a page nobody has reason to open is as good as absent.
 *
 * So the prefix decides the page. The map is small on purpose: it covers the families where a wrong page is a real
 * discoverability failure, and a prefix that is not listed keeps the old "documented anywhere" rule rather than inventing
 * an owner for it.
 *
 * ## Mutation-tested, and the first attempt was too weak
 *
 * Deleting the variable's TABLE ROW from 05c does **not** fail this check, because the page also names it in prose — and
 * that is correct: the property is *"a reader searching the page they are configuring finds it"*, which a prose mention
 * satisfies. Stripping all six mentions from 05c reproduces the original state exactly and fails with
 * `documented in 02-hosting.md but on none of 05c-face-recognition.md`.
 *
 * Recorded because the weaker mutation passing looks like a broken gate until you see what the check actually claims.
 *
 * ## The direction this must fail in
 *
 * Stricter, always. If a variable is on the right page, this passes and says nothing new; the only way to make it green
 * by weakening it is to delete a row, which is visible in a diff. Widening what counts as documented would be the wrong
 * repair — the failure being prevented is a green gate over a variable an operator cannot find.
 */
const OWNER_PAGES = {
  // Single owner, and the case this check exists for: a face variable belongs on the face page.
  'FACE_RECOGNITION_': ['integration-guide/05c-face-recognition.md'],
  // These families are configured from more than one page for real reasons -- the hosting matrix carries the egress
  // policy, the pipeline pages carry the per-stage settings -- so the owner is a SET.
  //
  // A set is not a loophole: it says "one of the pages that documents this feature", and every entry had to be justified
  // when it was added. A prefix that needs three pages is a hint the docs could be tightened, not permission to add a
  // fourth. Adding a page here to make a failure go away is the one edit this check cannot defend against, so it should
  // be visible in review as exactly that.
  // 05b is the SETTINGS page for these three; 02-hosting carries the egress matrix, which is a different question about
  // the same slots. Naming 02-hosting alone was my first attempt and it failed on nine variables that were all on the
  // right page -- the map was wrong, not the docs, which is the failure mode a check like this has to survive without
  // being loosened into uselessness.
  'EMBEDDING_': ['integration-guide/05b-media-embedding.md', 'integration-guide/02-hosting.md'],
  'RERANK_': ['integration-guide/05b-media-embedding.md', 'integration-guide/02-hosting.md'],
  'NLI_': ['integration-guide/05b-media-embedding.md', 'integration-guide/02-hosting.md'],
  'DOC_': ['integration-guide/02-hosting.md', 'integration-guide/05a-conversion-pipeline.md',
    'integration-guide/05b-media-embedding.md'],
  'STT_': ['integration-guide/02-hosting.md', 'integration-guide/05b-media-embedding.md'],
  'MONGO_': ['integration-guide/02-hosting.md', 'dependencies.md'],
};

describe('server env vars — docs and the server\'s code agree', () => {
  const used = collectUsage();
  const documented = collectDocumented(used);

  it('finds a meaningful number of variables (the scan itself still works)', () => {
    // Guards against a refactor silently breaking the patterns and turning both checks green by
    // finding nothing — the failure mode where a gate quietly stops gating.
    const ours = [...used.keys()].filter(n => OURS(n));
    assert.ok(ours.length >= 25, `expected the scan to find our env vars, found ${ours.length}`);
    assert.ok(documented.size >= 15, `expected docs to name our env vars, found ${documented.size}`);
  });

  it('every variable whose prefix names an owner page is documented ON that page', () => {
    // The check `FACE_RECOGNITION_EXTERNAL_MODEL` needed. Not "is it documented" — "is it where somebody configuring this
    // feature will look".
    const misplaced = [];
    for (const [name, files] of documented) {
      const prefix = Object.keys(OWNER_PAGES).find(p => name.startsWith(p));
      if (!prefix) continue;
      const pages = OWNER_PAGES[prefix];
      // `split/join` rather than a regex: the escaping for a backslash-matching literal is exactly what got mangled
      // writing this line, and a broken regex here is a syntax error rather than a wrong answer only by luck.
      const onPage = [...files].some(f => pages.includes(f.split('\\').join('/')));
      if (!onPage) misplaced.push(`${name} is documented in ${[...files].join(', ')} but on none of ${pages.join(', ')}`);
    }
    assert.deepEqual(misplaced, [],
      'these variables are documented on a page nobody configuring their feature would open, which is how '
      + 'FACE_RECOGNITION_EXTERNAL_MODEL came to be reported to us as nonexistent while this gate was green');
  });

  it('the owner pages all exist, so a typo cannot silently exempt a whole family', () => {
    // A misspelled page name would make `onPage` false for every variable in that family and produce a wall of failures
    // -- loud, so not the dangerous direction. A page that exists but is renamed later is the quiet one: the map would
    // point at nothing and the check above would fail for a real reason nobody could act on. Assert the paths resolve.
    for (const [prefix, pages] of Object.entries(OWNER_PAGES)) {
      for (const page of pages) {
        assert.ok(existsSync(join(ROOT, 'docs', page)), `${prefix} names a page that does not exist: ${page}`);
      }
    }
  });

  it('the placement check actually covers something (it is not vacuous)', () => {
    // Without this, a change to `documented`'s shape could make the loop iterate nothing and the assertion above would
    // pass for ever while measuring zero variables.
    const covered = [...documented.keys()].filter(n => Object.keys(OWNER_PAGES).some(p => n.startsWith(p)));
    assert.ok(covered.length >= 10,
      `expected the owner-page map to cover a meaningful number of variables, it covers ${covered.length}`);
    assert.ok(covered.includes('FACE_RECOGNITION_EXTERNAL_MODEL'),
      'the variable this check exists for must be among the ones it covers');
  });

  it('every variable the code reads is documented', () => {
    const missing = [...used.entries()]
      .filter(([name]) => OURS(name) && !documented.has(name))
      .map(([name, files]) => `  ${name}  (read in ${[...files].slice(0, 2).join(', ')})`);

    assert.equal(missing.length, 0,
      `These settings exist but no doc mentions them, so nobody can find them:\n${missing.join('\n')}\n` +
      'Document them (docs/workstation-mode-guide.md or integration-guide.md), or rename them out of ' +
      'our namespaces if they are genuinely internal.');
  });

  it('the not-a-setting list never hides a real setting', () => {
    // The failure this forecloses: a genuine undocumented variable gets silenced by adding it to the
    // exemption list rather than documenting it. If the code reads a name on that list, the list is
    // wrong, not the finding.
    const wrong = [...NOT_A_SETTING.keys()].filter(n => used.has(n));
    assert.deepEqual(wrong, [],
      'these are exempted as "not a setting" but the code reads them — document them instead');
  });

  it('every variable the docs name actually exists', () => {
    // The nastier direction: a reader copies it into .env, it does nothing, and nothing explains why.
    const phantom = [...documented.entries()]
      .filter(([name]) => !used.has(name) && !NOT_A_SETTING.has(name))
      .map(([name, docs]) => `  ${name}  (documented in ${[...docs].join(', ')})`);

    assert.equal(phantom.length, 0,
      `These are documented but read nowhere — a reader would set them and see no effect:\n${phantom.join('\n')}\n` +
      'Fix the doc, or restore the variable if it was renamed.');
  });
});
