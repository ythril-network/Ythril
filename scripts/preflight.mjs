/**
 * Pre-push structural gates — one command, so "which check applies to this change?" stops being a
 * judgement call.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────────────────────────
 *
 * A PR shipped `icon="activity"`, which is not in the ICONS registry. `PhIconComponent` resolves an
 * unknown name to an empty string, so it rendered as a blank space with no error and no build failure.
 * Docs lint passed, all 685 client tests passed, the production AOT build passed. The one check that
 * catches it — `icon-registry-coverage` — was the one not run, because remembering which gate matches
 * which change is exactly the kind of thing a person gets wrong at the end of a long task.
 *
 * Every gate below shares that shape: it catches something that produces NO error, NO failed build and
 * NO failed unit test. A blank icon, an undocumented setting, a documented endpoint that 404s, a
 * scheduler nobody starts, a route nobody audits. They are cheap to run and impossible to remember.
 *
 * ── What this is not ────────────────────────────────────────────────────────────────────────────
 *
 * Not a replacement for CI. It deliberately skips everything needing Docker or a live instance
 * (integration, sync, red-team), because a gate that takes fifteen minutes is a gate people stop
 * running. This is the fast half: seconds, no containers, run it before every push.
 *
 * Usage:  npm run preflight
 */
import { execSync, execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';

import { join } from 'node:path';
import { Socket } from 'node:net';
import { splitStandalone, batched } from '../testing/_shared/standalone-split.mjs';

/** Gates that read SOURCE only — no build required, so they run first and fail fastest. */
const SOURCE_GATES = [
  ['icon-registry-coverage', 'an unregistered icon renders as a blank space, silently'],
  ['scheduler-wiring', 'a background scheduler nobody starts looks exactly like one with nothing to do'],
  ['route-guard-coverage', 'an unguarded route is only visible by reading every router'],
  ['env-var-docs-coverage', 'a setting no doc mentions is one nobody can find'],
  ['config-key-docs-coverage', 'a wrong key in a config example is IGNORED at runtime — no error to search for'],
  ['route-path-docs-coverage', 'a documented endpoint that does not exist 404s with nothing to explain it'],
  ['mcp-tool-docs-coverage', 'a tool documented as blocked for read-only tokens that is not actually blocked'],
  ['doc-cited-constants', 'a number the docs quote that no longer matches the constant it quotes'],
  ['help-docs-coverage', 'a guide that ships but the in-product Help page never offers, or offers and cannot load'],
  ['help-anchor-coverage', 'a help link whose anchor matches no heading — it opens the guide and scrolls nowhere'],
  ['console-redaction-coverage', 'an error written straight to the console, bypassing the redaction log.* applies'],
];

/** Gates that import from server/dist and therefore need a build. */
const BUILT_GATES = [
  ['audit-route-coverage', 'a mutating route with no audit rule leaves no trace of who changed what'],
];

const run = (cmd, opts = {}) => execSync(cmd, { stdio: 'inherit', ...opts });

const failures = [];

function gate(name, why, file) {
  process.stdout.write(`\n── ${name} ──\n`);
  try {
    run(`node --test testing/standalone/${file}.test.js`);
  } catch {
    failures.push({ name, why });
  }
}

console.log('Preflight — the checks that catch failures with no error message.\n');

for (const [file, why] of SOURCE_GATES) gate(file, why, file);

// Build UNCONDITIONALLY before anything that imports from server/dist.
//
// This used to build only when `server/dist` was missing, which made every gate below it a check on
// whatever was compiled last — a different branch, a different commit, code that no longer exists. It
// cost a red CI run: a PR changed `toRecallRecord`'s output, preflight reported PASSED, and the
// standalone test that contradicts the change had been run against the PREVIOUS build. A stale pass is
// worse than no check, because it is indistinguishable from a real one. A `tsc` run is cheap; being
// told the wrong answer is not.
console.log('\n── building server (the gates below import from server/dist) ──');
try { run('npm run build:server'); } catch { failures.push({ name: 'build:server', why: 'the server does not compile' }); }

for (const [file, why] of BUILT_GATES) gate(file, why, file);

// Every standalone test that does NOT need a running instance, rather than the curated handful above.
//
// `npm run test:standalone` assumes the Docker stack — a handful of those files drive a live server on
// :3200. The rest are pure: they import from `server/dist` and assert on logic. Those had no reason to
// wait for CI, and waiting for CI is exactly how a PR that changed `toRecallRecord`'s output shipped
// with the test contradicting it still asserting the old shape.
//
// THE SPLIT AND THE BATCHING MOVED TO `testing/_shared/standalone-split.mjs`, whole, with the
// measurements that produced them. `test:standalone` asks the same question, and two copies of it is two
// places for preflight and the suite to disagree about which gates exist — which is the one divergence
// that makes a green preflight worthless.
const { all: allStandalone, offline: pure } = splitStandalone();
console.log(`
── standalone tests that need no running instance (${pure.length} of ${allStandalone.length}; `
  + `${allStandalone.length - pure.length} declare @needs-instance and run in CI) ──`);
/** How many standalone suites stood down for want of the test database. Reported in the verdict. */
let skippedForDb = 0;

/*
 * DEFAULT CONCURRENCY — one worker per core — and the flag that was here is gone.
 *
 * `--test-concurrency=1` is right for a suite sharing ONE live instance: `testing/integration` run
 * concurrently latches maintenance mode and reports 314 false failures. These files have no instance to
 * share; that is what `@needs-instance` declares, and the ones that do are not in this list.
 *
 * Measured over the 591 offline files on this machine: 191.0s serialised, 46.6s parallel, both green.
 * Preflight ran them serially too, so the offline set cost about three and a half minutes twice per
 * cycle — once here and once in `test:all:core`.
 */
const batches = batched(pure.map(f => `testing/standalone/${f}`));
let standaloneFailed = false;
for (const [i, batch] of batches.entries()) {
  if (batches.length > 1) console.log(`  batch ${i + 1}/${batches.length} — ${batch.length} file(s)`);
  try { run(`node --test ${batch.join(' ')}`); } catch {
    // Keep going: one batch failing must not hide a second failure in a later batch, which is exactly the
    // information a single all-or-nothing invocation used to give.
    standaloneFailed = true;
  }
}
if (standaloneFailed) {
  failures.push({ name: 'test:standalone (offline subset)', why: 'server contracts and pure logic — no Docker needed, so no reason to learn this from CI' });
}

/*
 * ── how many of those suites could not actually run ──
 *
 * `_mongo-harness.mjs` skips its suite with an actionable message when the test database is down, and THROWS
 * in CI rather than reporting a green no-op. That is the right split. What was missing is here: preflight said
 * "PASSED" while thirty-one suites had quietly stood down, and "passed" read as "everything ran".
 *
 * It cost a 21-minute CI round trip on A-3. Removing one positional from `remember()` shifted the argument
 * after it, and the only suites that call `remember()` with that many positionals are database ones — so the
 * seven failures were invisible locally and arrived as behaviour failures ("waitForEmbedding still fails
 * loudly") rather than as a signature mismatch.
 *
 * Derived from IMPORTS plus one TCP probe rather than by parsing test output: a suite that needs the harness
 * cannot have run if the port is closed, and that is knowable without reading a single line of the report.
 */
{
  const needsDb = pure.filter(f => {
    try { return readFileSync(`testing/standalone/${f}`, 'utf8').includes('_mongo-harness'); }
    catch { return false; }
  });
  const port = Number(process.env['YTHRIL_TEST_MONGO_PORT'] ?? 27117);
  const host = process.env['YTHRIL_TEST_MONGO_HOST'] ?? '127.0.0.1';

  const reachable = await new Promise(resolve => {
    const sock = new Socket();
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(1500);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
    sock.connect(port, host);
  });

  if (reachable) {
    console.log(`  ${needsDb.length} database suite(s) ran — the test stack is up on ${host}:${port}.`);
  } else if (needsDb.length > 0) {
    console.log(`
  ${needsDb.length} standalone suite(s) SKIPPED themselves: no test database on ${host}:${port}.`);
    console.log('  They run in CI, where the harness throws rather than skipping. `npm run test:up` runs them here.');
    skippedForDb = needsDb.length;
  }
}

// ── every test file PARSES, including the ones only CI runs ────────────────────────────────────────────────
//
// The offline subset above executes ~250 standalone files, so a syntax error in one of those fails loudly
// here. The Docker-dependent suites — integration, sync, red-team — are never even PARSED locally, so a
// broken one is invisible until CI, and it does not fail as an assertion: node reports a module-load error
// at `line 1:1` with an import stack, which reads nothing like the test that is actually broken.
//
// Paid for on 2026-08-06: an apostrophe lost its backslash on the way through a shell heredoc, the file
// stopped parsing, local preflight was green, and CI spent a full Docker run to say so. `node --check` over
// every test file costs about a second and would have said it immediately.
console.log('\n── every test file parses (incl. the Docker-only suites CI runs) ──');
{
  const testFiles = execSync('git ls-files "testing/**/*.js" "testing/**/*.mjs"', { encoding: 'utf8' })
    .split(/\r?\n/).filter(Boolean);

  // A leading UTF-8 BOM makes `node --check` reject a file that node RUNS perfectly — verified with a
  // fixture rather than assumed, because the first version of this gate flagged `testing/_init/seed-brain.js`
  // and that file is fine. `node --check` chokes on BOM-then-shebang; the runtime strips the BOM first.
  //
  // So the BOM is removed before checking. Do not "simplify" this back into a bare `node --check` — it will
  // fail the whole gate on a working file, which is how a gate gets switched off.
  const check = (p) => {
    try { execSync(`node --check ${JSON.stringify(p)}`, { stdio: 'pipe' }); return null; }
    catch (e) { return String(e.stderr ?? e).split('\n').find(l => /Error/.test(l)) ?? 'unparseable'; }
  };

  const unparseable = [];
  for (const f of testFiles) {
    const err = check(f);
    if (!err) continue;

    // A leading UTF-8 BOM makes `node --check` reject a file node RUNS fine (verified with a fixture: BOM,
    // then shebang, checks as a SyntaxError and executes without complaint). Many files here carry one, so a
    // bare check would fail the gate on working code — which is how a gate gets switched off.
    //
    // The retry copy MUST stay inside the repo. The first version wrote it to the OS temp dir, where no
    // `package.json` applies, so node parsed it under different rules and a genuinely broken file came back
    // clean — a gate with a silent-success path, which is worse than no gate. Caught by planting a syntax
    // error and watching the gate pass.
    const src = readFileSync(f, 'utf8');
    if (src.charCodeAt(0) === 0xfeff) {
      const sibling = `${f}.parse-check.tmp.mjs`;
      try {
        writeFileSync(sibling, src.slice(1));
        const retry = check(sibling);
        if (retry) unparseable.push(`${f}\n      ${retry}`);
      } finally {
        rmSync(sibling, { force: true });
      }
      continue;
    }
    unparseable.push(`${f}\n      ${err}`);
  }

  if (unparseable.length > 0) {
    console.log(`  ${unparseable.length} file(s) do not parse:\n    ${unparseable.join('\n    ')}`);
    failures.push({ name: 'test files parse', why: 'a Docker-only test that does not even load — CI reports it as a module error, not as a failing test' });
  } else {
    console.log(`  ${testFiles.length} test files parse.`);
  }
}

/*
 * ── the route list, checked against what express actually serves ──
 *
 * Every gate that says "every route" reads one module, and that module reads SOURCE. This is the only check
 * in the repository that compares it against the live express router objects — the one thing that cannot be
 * wrong about what is served — so it is the check that catches the module being wrong.
 *
 * It is here because nothing ran it. Left as a manual script it rotted into reporting all 46 tools as
 * unmapped (it grepped a file the map had moved out of) and one route as unserved (its own scan could not
 * resolve a router passed as a parameter). Forty-seven false findings is worse than no audit: the next
 * person to run it stops trusting the tooling. A check nobody runs is a claim.
 */
console.log('\n── the route list agrees with what express serves ──');
try { run('node scripts/surface-matrix-audit.mjs'); } catch {
  failures.push({ name: 'surface-matrix-audit', why: 'the static route list and the live express routers disagree' });
}

console.log('\n── docs lint ──');
try { run('npm run lint:docs'); } catch { failures.push({ name: 'lint:docs', why: 'markdown that will fail CI' }); }

// The owner reads todo/ directly, and the release cadence is "cut the tag when _TODO-ORDERED.md is empty" — so a
// domain tracker holding an item the ordered list never mentions makes "empty" a claim about one file rather than
// about the work. todo/ is gitignored, so this can only ever run here; the script exits 0 when the folder is
// absent, which is what makes it safe in a clean checkout.
console.log('\n── todo/ is open items only, all indexed ──');
try { run('npm run todo:check'); } catch {
  failures.push({ name: 'todo:check', why: 'a tracker holds closed work, or an open item the ordered list never references' });
}

// CI has run this since it was written; preflight never did. So eleven PRs in a row passed locally with an entry, and
// the twelfth — the only one in that run to change access rules — got as far as a red CI job before anyone noticed the
// CHANGELOG had no line for it. A gate that only exists after the push is a gate that teaches you to push and see.
//
// It works locally for the same reason CI can run it: the comparison is against `origin/main`, which is already
// fetched. Nothing about it needed the runner.
console.log('\n── CHANGELOG entry for shipped changes ──');
try { run('node ./scripts/check-changelog.mjs'); } catch {
  failures.push({ name: 'check-changelog', why: 'a file that changes what ships, with no [Unreleased] line' });
}

/*
 * ── client type-check, BOTH projects ──
 *
 * Neither gate around this one asks the question. `test:client` runs vitest, which transpiles without
 * type-checking; the production build below compiles `tsconfig.app.json` only. So the SPEC project was never
 * checked, and it had 122 type errors — among them a fixture using a vote status the API cannot return, six
 * fixtures omitting a field whose branch no test therefore covered, an assertion message silently discarded
 * because `toBeNull()` takes no arguments, and three client interfaces missing a field the server always sends.
 *
 * Checking the ROOT `tsconfig.json` is what hid it: that config includes the specs without the vitest types,
 * so it reported 297 errors of which 175 were `Cannot find name 'expect'` — noise a real error hides inside.
 * The two real projects are the question worth asking.
 */
console.log('\n── client type-check (app + spec projects) ──');
try { run('npm run typecheck:client'); } catch {
  failures.push({ name: 'typecheck:client', why: 'types the test run transpiles past and the AOT build never sees' });
}

console.log('\n── client unit tests (includes i18n key coverage) ──');
try { run('npm run test:client'); } catch {
  failures.push({ name: 'test:client', why: 'component behaviour, and translation keys missing from de/pl' });
}

// The production build type-checks TEMPLATES (AOT) and compiles under the app's own tsconfig, neither of
// which the unit-test run does. It caught a `[...NodeList]` spread that every test passed straight over,
// and it is where an unknown element, a bad binding or a broken inline template surfaces. ~7 seconds.
console.log('\n── client production build (AOT template type-check) ──');
let buildOut = '';
try {
  // Captured, not inherited, so the chunk table below can be read — then printed, because a build whose
  // output vanishes is a build nobody can debug.
  buildOut = execSync('npm run build:prod --workspace=client', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  process.stdout.write(buildOut);
} catch (e) {
  buildOut = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  process.stdout.write(buildOut);
  failures.push({ name: 'build:prod', why: 'AOT template errors and tsconfig differences the unit tests never see' });
}

// A `bundle`-type budget names a chunk. Angular does NOT complain when that name matches nothing — the
// budget is simply never evaluated, the build stays green, and the chunk it was meant to guard grows
// without limit. That is the same silent no-op the budgets exist to prevent, one level up, and the only
// place it can be checked is against the real chunk table the build just printed.
console.log('\n── bundle budgets bind to real chunks ──');
try {
  const cfg = JSON.parse(readFileSync('client/angular.json', 'utf8'));
  const project = cfg.projects[Object.keys(cfg.projects)[0]];
  const named = (project.architect.build.configurations.production.budgets ?? [])
    .filter(b => b.type === 'bundle').map(b => b.name);
  const plain = buildOut.replace(/\x1b\[[0-9;]*m/g, '');
  const unmatched = named.filter(n => !new RegExp(`\\|\\s*${n}\\s*\\|`).test(plain));
  if (unmatched.length) {
    console.log(`  budgets naming no emitted chunk: ${unmatched.join(', ')}`);
    failures.push({
      name: 'bundle-budgets',
      why: `${unmatched.join(', ')} — Angular evaluates these against nothing, so the build stays green while the chunk grows`,
    });
  } else {
    console.log(`  ${named.length} bundle budget(s) matched an emitted chunk.`);
  }
} catch (e) {
  failures.push({ name: 'bundle-budgets', why: `could not verify budget names: ${e}` });
}

console.log('\n' + '='.repeat(76));
if (failures.length === 0) {
  console.log('Preflight PASSED. Docker-dependent suites (integration, sync, red-team) still run in CI.');
  if (skippedForDb > 0) {
    console.log(`  ...but ${skippedForDb} standalone suite(s) did NOT run — no test database. `
      + '`npm run test:up`, then re-run, if this change touches a signature or a stored shape.');
  }
  process.exit(0);
}
console.log(`Preflight FAILED — ${failures.length} gate(s):\n`);
for (const f of failures) console.log(`  ${f.name}\n      ${f.why}`);
console.log('\nEach of these catches something that produces no error on its own. Fix before pushing.');
process.exit(1);
