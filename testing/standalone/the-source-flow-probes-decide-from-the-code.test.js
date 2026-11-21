/**
 * The flow-check probes for the compose, client, import-graph, literal and licence checks decide from the repository, and a planted copy of each defect fails them.
 *
 * ## The failure this prevents (Q-876, split from Q-875, YF-123)
 *
 * Eight lens checks the plan and verify phases name had no probe, so `project-check.mjs` answered "cannot answer" and each was judged by reading, every bundle:
 *
 * - `check-i-security-containers-hardened`: every service of a shipped compose file drops capabilities, has a read-only root, no new privileges, a
 *   non-root user, resource ceilings, and a parser sits on internal-only networks. Who a parser is comes from the topology (the database is the mongo
 *   image, the app shares a network with it), so a new sidecar is held to the rule the day it is added.
 * - `check-i-security-same-host-not-trusted`: each tenant (an app that shares a network with a database) has its own database process, its own volume and an
 *   encryption setting.
 * - `check-i-ux-env-only-config-surfaced`: a field an environment pin refuses to write is not shown as an editable control without a lock marker.
 * - `check-i-ux-unsaved-changes-guard`: every route table is built through `guardEveryPage`, and every component with an editable control holds its draft.
 * - `check-i-architecture-dependency-direction`: no import leaves its package, only the transports and the wiring import a transport, no converter imports
 *   the database, no utility imports half the app, and the cycles do not grow.
 * - `check-i-code-quality-values-named`: the unnamed number literals and the comments repeating a constant's value do not grow.
 * - `check-i-legal-about-page-attribution`: NOTICE names every package that needs attribution, and the About page names it or points to the notices.
 * - `check-i-legal-build-time-only-not-shipped`: the shipped Dockerfile stage takes a production-only install, and no shipped source or production closure
 *   meets a devDependency.
 *
 * Each rule is proven on a planted copy of the defect taken from the repository's own text (a real line removed, a real import line copied into another
 * layer), and on the real repository, which must answer `holds:` with its allow list in use. An exception is an entry of the probe's `.allow.json` with a reason
 * and a reviewBy date; one without either, past its date, or excusing nothing any more fails the probe.
 *
 * Run: node --test testing/standalone/the-source-flow-probes-decide-from-the-code.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, posix } from 'node:path';
import { testChildEnv } from '../_shared/test-child-env.mjs';
import { REPO_ROOT, SERVER_SOURCE_ROOT } from './_sources.mjs';
import { SCHEMA_PACKAGE_NAME } from './_relative-specifier.mjs';

/** The server's own source root, the key the import-graph probe files its server modules under. */
const SERVER = SERVER_SOURCE_ROOT;
import * as containers from '../../tools/flow-checks/check-i-security-containers-hardened.mjs';
import * as sameHost from '../../tools/flow-checks/check-i-security-same-host-not-trusted.mjs';
import * as envOnly from '../../tools/flow-checks/check-i-ux-env-only-config-surfaced.mjs';
import * as unsaved from '../../tools/flow-checks/check-i-ux-unsaved-changes-guard.mjs';
import * as arch from '../../tools/flow-checks/check-i-architecture-dependency-direction.mjs';
import * as quality from '../../tools/flow-checks/check-i-code-quality-values-named.mjs';
import * as about from '../../tools/flow-checks/check-i-legal-about-page-attribution.mjs';
import * as buildTime from '../../tools/flow-checks/check-i-legal-build-time-only-not-shipped.mjs';
import { composeReader, rolesOf } from '../../tools/flow-checks/_compose-probe.mjs';
import { readAllow, allowProblem, applyAllow, applyCeilings, today } from '../../tools/flow-checks/_allow.mjs';
import { graphOf, reachableFrom, cyclicSets } from '../../tools/flow-checks/_import-graph.mjs';
import { CannotAnswer } from '../../tools/flow-checks/_verdict.mjs';

const PROBES_DIR = join(REPO_ROOT, 'tools', 'flow-checks');
const probeFile = (name) => join(PROBES_DIR, `${name}.mjs`);
const allowOf = (name) => readAllow(probeFile(name).replace(/\.mjs$/, '.allow.json'));
const TODAY = today();

const run = (name, args = []) => {
  const r = spawnSync(process.execPath, [probeFile(name), ...args], { encoding: 'utf8', env: testChildEnv({}, process.env), timeout: 180_000 });
  const lines = (r.stdout ?? '').trim().split('\n');
  return { code: r.status, last: lines[lines.length - 1] };
};

const reader = await composeReader({});
const realCompose = () => [{ file: 'docker-compose.yml', doc: structuredClone(reader.loadCompose('docker-compose.yml')) }];
const dockerfileOf = (file, svc) => containers.readDockerfile(file, svc);

/** Every probe, on the real tree, answers `holds:` with its exceptions in use. */
describe('on the real repository every probe holds, and each one runs as a script', () => {
  for (const name of [
    'check-i-security-containers-hardened',
    'check-i-security-same-host-not-trusted',
    'check-i-ux-env-only-config-surfaced',
    'check-i-ux-unsaved-changes-guard',
    'check-i-architecture-dependency-direction',
    'check-i-code-quality-values-named',
    'check-i-legal-about-page-attribution',
    'check-i-legal-build-time-only-not-shipped',
  ]) {
    it(`${name} answers holds`, () => {
      const r = run(name);
      assert.equal(r.code, 0, r.last);
      assert.match(r.last, /^holds: /);
    });
  }

  it('every allow file holds only entries with a reason and a reviewBy that has not passed', () => {
    for (const name of [
      'check-i-security-containers-hardened', 'check-i-security-same-host-not-trusted', 'check-i-ux-env-only-config-surfaced',
      'check-i-architecture-dependency-direction', 'check-i-code-quality-values-named', 'check-i-legal-about-page-attribution',
      'check-i-legal-build-time-only-not-shipped',
    ]) assert.equal(allowProblem(allowOf(name), TODAY), null, name);
  });
});

describe('the allow-list rule, once, for every probe that keeps exceptions', () => {
  const entry = { id: 'x', max: 1, reason: 'a reason of more than twenty characters', reviewBy: '2099-01-01' };

  it('refuses an entry with no reason, a malformed or past reviewBy, no id, or that excuses nothing', () => {
    assert.match(allowProblem([{ ...entry, reason: '' }], TODAY), /reason/);
    assert.match(allowProblem([{ ...entry, reason: 'too short' }], TODAY), /reason/);
    assert.match(allowProblem([{ ...entry, reviewBy: '' }], TODAY), /reviewBy/);
    assert.match(allowProblem([{ ...entry, reviewBy: '2026-01-01' }], TODAY), /past its reviewBy/);
    assert.match(applyAllow([{ id: 'a', text: 'a' }], [{ ...entry, id: '' }], TODAY).problem, /no id/);
    assert.match(applyAllow([{ id: 'a', text: 'a' }], [{ ...entry, id: 'b' }], TODAY).problem, /excuses nothing/);
    assert.match(applyAllow([{ id: 'a', text: 'a' }], [{ ...entry, id: 'a' }, { ...entry, id: 'a' }], TODAY).problem, /share the id/);
  });

  it('excuses exactly the finding it names, and a ceiling is a ratchet', () => {
    const r = applyAllow([{ id: 'a', text: 'a' }, { id: 'b', text: 'b' }], [{ ...entry, id: 'a' }], TODAY);
    assert.deepEqual(r.open.map((f) => f.id), ['b']);
    const c = applyCeilings([{ id: 'm', value: 3, text: 'three' }], [{ ...entry, id: 'm', max: 2 }], TODAY);
    assert.deepEqual(c.over.map((m) => m.id), ['m']);
    assert.equal(applyCeilings([{ id: 'm', value: 3, text: 'three' }], [{ ...entry, id: 'm', max: 3 }], TODAY).over.length, 0);
    assert.match(applyCeilings([{ id: 'm', value: 0, text: 'none' }], [{ ...entry, id: 'm', max: 3 }], TODAY).problem, /0 or no longer exists/);
    assert.equal(applyCeilings([{ id: 'm', value: 2, text: 'two' }], [{ ...entry, id: 'm', max: 3 }], TODAY).slack.length, 1);
  });
});

describe('check-i-security-containers-hardened', () => {
  const real = allowOf('check-i-security-containers-hardened');

  it('reads the roles from the topology: one database, the app on its network, every other service a parser', () => {
    const roles = rolesOf(realCompose()[0].doc);
    assert.deepEqual([...roles.database], ['ythril-mongo']);
    assert.deepEqual([...roles.app], ['ythril']);
    for (const parser of ['ollama', 'whisper', 'unstructured', 'doc-render', 'doc-office', 'doc-nlp']) assert.ok(roles.parsers.has(parser), parser);
    assert.ok(!roles.parsers.has('ythril'), 'the app is not a parser');
  });

  it('is violated when a sidecar drops no capabilities (a real cap_drop removed)', () => {
    const composes = realCompose();
    delete composes[0].doc.services['doc-render'].cap_drop;
    const v = containers.decide(composes, dockerfileOf, real, TODAY);
    assert.equal(v.holds, false);
    assert.match(v.reason, /doc-render does not drop all capabilities/);
  });

  it('is violated for each of the other controls when its real line is removed', () => {
    for (const [control, mutate, expected] of [
      ['read_only', (s) => { delete s.read_only; }, /doc-render has a writable root filesystem/],
      ['no-new-privileges', (s) => { delete s.security_opt; }, /doc-render does not set `security_opt/],
      ['limits', (s) => { delete s.pids_limit; delete s.cpus; }, /doc-render lacks cpus, pids_limit/],
    ]) {
      const composes = realCompose();
      mutate(composes[0].doc.services['doc-render']);
      const v = containers.decide(composes, dockerfileOf, real, TODAY);
      assert.equal(v.holds, false, control);
      assert.match(v.reason, expected, control);
    }
  });

  it('is violated when a parser is put on the media network (a real network name taken from ollama)', () => {
    const composes = realCompose();
    composes[0].doc.services.unstructured.networks = [...composes[0].doc.services.ollama.networks];
    const v = containers.decide(composes, dockerfileOf, real, TODAY);
    assert.equal(v.holds, false);
    assert.match(v.reason, /unstructured parses untrusted input yet is on a network that is not internal-only \(ythril-media\)/);
  });

  it('holds a service added tomorrow to the same rule: a new sidecar with nothing set is violated', () => {
    const composes = realCompose();
    composes[0].doc.services['new-sidecar'] = { image: 'example/parser:1', networks: ['ythril-convert'] };
    const found = containers.findings(composes, dockerfileOf).filter((f) => f.id.includes('#new-sidecar#')).map((f) => f.id.split('#')[2]);
    assert.deepEqual(found.sort(), ['cap_drop', 'limits', 'no-new-privileges', 'read_only', 'user']);
  });

  it('reads a built service\'s user from its Dockerfile: removing the real USER line is violated', () => {
    const composes = realCompose();
    const stripped = (file, svc) => (dockerfileOf(file, svc) ?? '').replace(/^USER .*$/gim, '');
    const v = containers.decide(composes, stripped, real, TODAY);
    assert.equal(v.holds, false);
    assert.match(v.reason, /doc-(render|nlp|office) does not run as a non-root user/);
    assert.equal(containers.dockerfileUser('FROM x\nUSER render\nUSER 0\n'), '0', 'the last USER decides');
  });

  it('fails an exception with no reason, one past its date and one that excuses nothing', () => {
    const composes = realCompose();
    assert.match(containers.decide(composes, dockerfileOf, [{ ...real[0], reason: '' }, ...real.slice(1)], TODAY).reason, /reason/);
    assert.match(containers.decide(composes, dockerfileOf, [{ ...real[0], reviewBy: '2026-01-01' }, ...real.slice(1)], TODAY).reason, /past its reviewBy/);
    assert.match(containers.decide(composes, dockerfileOf, [...real, { id: 'docker-compose.yml#ollama#cap_drop', reason: 'ollama drops all capabilities in the real file', reviewBy: '2099-01-01' }], TODAY).reason, /excuses nothing/);
  });

  it('reads its compose reader from --modules, and answers cannot answer from a folder without js-yaml', () => {
    const empty = mkdtempSync(join(tmpdir(), 'b324-source-'));
    try {
      mkdirSync(join(empty, 'node_modules'));
      const none = run('check-i-security-containers-hardened', ['--modules', join(empty, 'node_modules')]);
      assert.equal(none.code, 2, none.last);
      assert.match(none.last, /^cannot answer: js-yaml cannot be found/);
      const holder = dirname(dirname(createRequire(import.meta.url).resolve('js-yaml/package.json')));
      const real2 = run('check-i-security-containers-hardened', ['--modules', holder]);
      assert.equal(real2.code, 0, real2.last);
    } finally { rmSync(empty, { recursive: true, force: true }); }
  });
});

describe('check-i-security-same-host-not-trusted', () => {
  const real = allowOf('check-i-security-same-host-not-trusted');
  const decide = (composes, allow = real) => sameHost.decide(composes, reader.environmentOf, allow, TODAY);

  it('is violated when a second app shares the database (the real app service copied)', () => {
    const composes = realCompose();
    composes[0].doc.services['ythril-b'] = structuredClone(composes[0].doc.services.ythril);
    const v = decide(composes);
    assert.equal(v.holds, false);
    assert.match(v.reason, /tenant ythril shares the database ythril-mongo with ythril-b/);
    assert.match(v.reason, /tenant ythril-b shares the database ythril-mongo with ythril/);
  });

  it('is violated when another service mounts the database\'s volume (a real volume line copied)', () => {
    const composes = realCompose();
    const s = composes[0].doc.services;
    s.whisper.volumes = [...s.whisper.volumes, s['ythril-mongo'].volumes[0]];
    const v = decide(composes);
    assert.equal(v.holds, false);
    assert.match(v.reason, /whose volume ythril-mongo-data another service mounts/);
  });

  it('says what an encryption setting is: an exception that excuses a control now present fails, so the list is a ceiling', () => {
    const composes = realCompose();
    composes[0].doc.services.ythril.environment.YTHRIL_MASTER_KEY = '${YTHRIL_MASTER_KEY:?set a 32-byte base64 key}';
    const v = decide(composes);
    assert.equal(v.holds, false);
    assert.match(v.reason, /ythril#encryption-app excuses nothing any more/);
    composes[0].doc.services['ythril-mongo'].command = ['mongod', '--enableEncryption', '--encryptionKeyFile', '/run/secrets/k'];
    assert.match(decide(composes).reason, /excuses nothing any more/);
    assert.equal(sameHost.findings(composes, reader.environmentOf).length, 0, 'with both settings present no control is missing');
  });

  it('is cannot answer when no service shares a network with a database (no tenant to judge)', () => {
    const composes = realCompose();
    composes[0].doc.services['ythril-mongo'].networks = ['elsewhere'];
    assert.throws(() => decide(composes), CannotAnswer);
  });

  it('fails an exception with no reason or past its date', () => {
    const composes = realCompose();
    assert.match(decide(composes, [{ ...real[0], reason: '' }, ...real.slice(1)]).reason, /reason/);
    assert.match(decide(composes, [{ ...real[0], reviewBy: '2026-01-01' }, ...real.slice(1)]).reason, /past its reviewBy/);
  });
});

describe('check-i-ux-env-only-config-surfaced', () => {
  const inputs = envOnly.readInputs();
  const real = allowOf('check-i-ux-env-only-config-surfaced');
  const without = (text, needle) => text.split(needle).join('s.managed');
  const replaced = (list, needle) => list.map((s) => ({ ...s, code: without(s.code, needle) }));

  it('reads the pinnable paths from the one server list, a real number of them', () => {
    assert.ok(inputs.paths.length >= 30);
    for (const p of ['embedding.model', 'documentProcessing.renderDpi', 'visionProvider', 'faceRecognition.externalModel']) assert.ok(inputs.paths.includes(p), p);
  });

  it('is violated when a pinned field is shown with no lock marker (a real isLocked call replaced)', () => {
    const needle = "s.isLocked('vision.baseUrl')";
    assert.ok(inputs.sources.some((s) => s.code.includes(needle)), 'the real lock call is in the settings source');
    const v = envOnly.decide({ ...inputs, components: replaced(inputs.components, needle), sources: replaced(inputs.sources, needle) }, real, TODAY);
    assert.equal(v.holds, false);
    assert.match(v.reason, /vision\.baseUrl/);
  });

  // The real lock call of a document-processing knob, replaced as above: the probe must see the field open again.
  const dpiNeedle = "s.isLocked('documentProcessing.renderDpi')";
  const dpiOpen = () => ({ ...inputs, components: replaced(inputs.components, dpiNeedle), sources: replaced(inputs.sources, dpiNeedle) });

  it('finds an unlocked field (documentProcessing.renderDpi with its real lock call replaced), and embedding.model is locked through the area helper', () => {
    assert.ok(inputs.sources.some((s) => s.code.includes(dpiNeedle)), 'the real lock call is in the settings source');
    const planted = dpiOpen();
    const open = envOnly.findings(planted.paths, planted.components, planted.sources).map((f) => f.id);
    assert.ok(open.includes('documentProcessing.renderDpi'));
    assert.ok(!open.includes('embedding.model'));
    assert.ok(!open.includes('faceRecognition.confidenceThreshold'), 'locked through the area-wide lock call');
  });

  it('does not ask a lock of a field no component shows', () => {
    assert.equal(envOnly.isShown('maxFileSizeBytes', inputs.components), false);
    assert.equal(envOnly.isLockMarked('maxFileSizeBytes', inputs.sources), false);
    assert.ok(!envOnly.findings(['maxFileSizeBytes'], inputs.components, inputs.sources).length);
  });

  it('fails an exception for a field that is now locked, one with no reason and one past its date', () => {
    assert.match(envOnly.decide(inputs, [...real, { id: 'vision.baseUrl', reason: 'the vision endpoint input is locked, so this excuses nothing', reviewBy: '2099-01-01' }], TODAY).reason, /excuses nothing/);
    const entry = { id: 'documentProcessing.renderDpi', reason: 'a planted exception for the probe test, long enough to count', reviewBy: '2099-01-01' };
    assert.match(envOnly.decide(dpiOpen(), [{ ...entry, reason: '' }], TODAY).reason, /reason/);
    assert.match(envOnly.decide(dpiOpen(), [{ ...entry, reviewBy: '2026-01-01' }], TODAY).reason, /past its reviewBy/);
  });
});

describe('check-i-ux-unsaved-changes-guard', () => {
  const inputs = unsaved.readClient();

  it('is violated when the route table is not built through guardEveryPage (the real call removed)', () => {
    const tables = inputs.tables.map((t) => ({ ...t, code: t.code.replace(/\bguardEveryPage\s*\(/, '(') }));
    const v = unsaved.decide({ ...inputs, tables });
    assert.equal(v.holds, false);
    assert.match(v.reason, /not built through guardEveryPage/);
  });

  it('is violated when a route that loads a component stands outside the call (a real route copied after it)', () => {
    const table = inputs.tables[0];
    const route = /\{\s*path:\s*'login'[\s\S]*?\n  \},/.exec(table.code)?.[0];
    assert.ok(route, 'the real login route is in the table');
    const planted = `${table.code}\nconst stray = [${route}];\n`;
    assert.match(unsaved.unguardedRoutes(table.file, planted)[0].problem, /outside guardEveryPage/);
  });

  it('is violated when guardEveryPage no longer adds the guard as canDeactivate', () => {
    const v = unsaved.decide({ ...inputs, guardCode: inputs.guardCode.split('canDeactivate').join('canActivate') });
    assert.equal(v.holds, false);
    assert.match(v.reason, /guardEveryPage no longer adds unsavedEditsGuard/);
  });

  it('is violated when a component that holds its draft stops (a real holdUnsavedEdits call removed)', () => {
    const holder = inputs.components.find((c) => /\bholdUnsavedEdits\s*\(/.test(c.code) && /<(?:input|textarea|select)\b|\bcontenteditable\b/.test(c.code) && !inputs.listed.has(c.file));
    assert.ok(holder, 'a component with an editable control holds its draft');
    const components = inputs.components.map((c) => (c === holder ? { ...c, code: c.code.replace(/\bholdUnsavedEdits\s*\(/g, 'holdNothing(') } : c));
    const v = unsaved.decide({ ...inputs, components });
    assert.equal(v.holds, false);
    assert.ok(v.reason.includes(holder.file), v.reason);
  });

  it('is violated for a new component with an editable control and no draft, and holds one that is listed', () => {
    const fresh = { file: 'client/src/app/pages/new/new.component.ts', code: "template: `<input [(ngModel)]=\"x\" />`" };
    assert.deepEqual(unsaved.silentForms([fresh], inputs.listed), [fresh.file]);
    assert.deepEqual(unsaved.silentForms([fresh], new Set([fresh.file])), []);
    assert.deepEqual(unsaved.silentForms([{ ...fresh, code: `${fresh.code} holdUnsavedEdits(() => dirty)` }], inputs.listed), []);
  });

  it('reads the listed components from the spec\'s own NOT_A_DRAFT, a real number of them', () => {
    assert.ok(inputs.listed.size >= 20);
    assert.throws(() => unsaved.notADraft('const OTHER = {};'), CannotAnswer);
  });
});

describe('check-i-architecture-dependency-direction', () => {
  const byRoot = arch.readSources();
  const real = allowOf('check-i-architecture-dependency-direction');
  const decide = (planted) => arch.decide(arch.graphsOf(planted), real, TODAY);
  /** The sources with `extra` appended to the code of `file`. */
  const plant = (root, file, extra) => ({ ...byRoot, [root]: byRoot[root].map((s) => (s.file === file ? { ...s, code: `${s.code}\n${extra}` } : s)) });
  const lineOf = (root, file, re) => {
    const m = re.exec(byRoot[root].find((s) => s.file === file).code);
    assert.ok(m, `${file} has the line ${re}`);
    return m[0];
  };

  it('is violated when a utility imports a transport (the real import line of auth/middleware copied into a util)', () => {
    const line = lineOf(SERVER, 'server/src/auth/middleware.ts', /^import \{ mfaCodeHolds \}[^\n]*$/m);
    const v = decide(plant(SERVER, 'server/src/util/crypto.ts', line));
    assert.equal(v.holds, false);
    assert.match(v.reason, /server\/src\/util\/crypto\.ts imports the api transport/);
  });

  it('is violated when a converter imports the database (a real db import line copied into an extractor module)', () => {
    const dbLine = byRoot[SERVER].flatMap((s) => (s.file.startsWith('server/src/util/') ? [/^import [^\n]*from '\.\.\/db\/[^\n]*$/m.exec(s.code)?.[0]] : [])).find(Boolean);
    assert.ok(dbLine, 'a util module imports the db layer');
    const extractor = byRoot[SERVER].find((s) => /^server\/src\/extractor\/[^/]+\.ts$/.test(s.file)).file;
    const v = decide(plant(SERVER, extractor, dbLine));
    assert.equal(v.holds, false);
    assert.match(v.reason, /\(a converter\) imports the database layer/);
  });

  it('is violated when a utility imports more than half the app (one real file of fifteen folders imported)', () => {
    const folders = [...new Set(byRoot[SERVER].map((s) => s.file.split('/')[2]).filter((f) => f && !f.endsWith('.ts') && !['util', 'api', 'mcp'].includes(f)))];
    const lines = folders.slice(0, 15).map((f, i) => `import { a${i} } from '../${f}/${byRoot[SERVER].find((s) => s.file.startsWith(`server/src/${f}/`)).file.split('/').slice(3).join('/').replace(/\.ts$/, '.js')}';`);
    assert.ok(folders.length >= 15, 'the server has fifteen folders to import from');
    const v = decide(plant(SERVER, 'server/src/util/crypto.ts', lines.join('\n')));
    assert.equal(v.holds, false);
    assert.match(v.reason, /util\/crypto\.ts \(a utility\) imports 15 of \d+ server folders/);
  });

  it('is violated when the client reaches into the server (an import leaving the package)', () => {
    const v = decide(plant('client/src/app', 'client/src/app/app.config.ts', "import { x } from '../../../server/src/config/loader.js';"));
    assert.equal(v.holds, false);
    assert.match(v.reason, /client\/src\/app\/app\.config\.ts imports server\/src\/config\/loader\.js, outside client\/src\/app/);
  });

  it('is violated when a new import cycle appears (two schema modules importing each other)', () => {
    const [a, b] = byRoot['schema/src'].filter((s) => /^schema\/src\/[^/]+\.ts$/.test(s.file)).slice(0, 2).map((s) => s.file.split('/').pop().replace(/\.ts$/, '.js'));
    const planted = {
      ...byRoot,
      'schema/src': byRoot['schema/src'].map((s) => (s.file.endsWith(`/${a.replace('.js', '.ts')}`) ? { ...s, code: `${s.code}\nimport './${b}';` } : s.file.endsWith(`/${b.replace('.js', '.ts')}`) ? { ...s, code: `${s.code}\nimport './${a}';` } : s)),
    };
    const v = decide(planted);
    assert.equal(v.holds, false);
    assert.match(v.reason, /cyclic set\(s\) in schema\/src, above its ceiling/);
  });

  it('is violated when the largest server cycle grows (a module that imports into it is imported back by a member)', () => {
    const { edges } = graphOf(byRoot[SERVER]);
    const sets = cyclicSets(edges).sort((x, y) => y.length - x.length);
    const inside = new Set(sets.flat());
    // An outside module that reaches no cyclic module and that only one module imports: importing the member back then adds that one module to
    // the set. One that reached another set would merge it in (the server has several sets since Q-754 split the core one), and one that other
    // modules import (util/log.ts) would pull in every importer the member reaches.
    const importers = new Map();
    for (const [from, outs] of edges) for (const t of outs) importers.set(t, (importers.get(t) ?? 0) + 1);
    const alone = (t) => !inside.has(t) && importers.get(t) === 1 && ![...reachableFrom(edges, [t])].some((r) => inside.has(r));
    const member = sets[0].find((m) => (edges.get(m) ?? []).some(alone));
    assert.ok(member, 'a module of the big cycle imports a module outside every cycle that reaches none');
    const outside = edges.get(member).find(alone);
    const back = posix.relative(posix.dirname(outside), member).replace(/\.ts$/, '.js');
    const v = decide(plant(SERVER, outside, `import './${back}';`.replace("'./../", "'../")));
    assert.equal(v.holds, false);
    // The planted import adds one module to the set, so it measures one over the ceiling the allow file holds (the measure, since it only goes down).
    const ceiling = real.find((e) => e.id === 'cycles:server/src:largest').max;
    assert.equal(sets[0].length, ceiling, 'the largest set no longer measures its ceiling: lower the ceiling to the measure');
    assert.match(v.reason, new RegExp(`a cyclic set of ${ceiling + 1} modules in server/src, above its ceiling`), `planted ${outside} -> ${member}`);
  });

  it('counts a cycle by its strongly connected set, a chain of imports as none', () => {
    const g = graphOf([{ file: 'a.ts', code: "import './b'" }, { file: 'b.ts', code: "import './c'" }, { file: 'c.ts', code: '' }]);
    assert.deepEqual(arch.cycleMeasures('r', g).map((m) => m.value), [0, 0]);
    const loop = graphOf([{ file: 'a.ts', code: "import './b'" }, { file: 'b.ts', code: "import './a'" }]);
    assert.deepEqual(arch.cycleMeasures('r', loop).map((m) => m.value), [1, 2]);
  });

  it('fails an exception that excuses nothing: a real transport import fixed', () => {
    const fixed = { ...byRoot, [SERVER]: byRoot[SERVER].map((s) => (s.file === 'server/src/sync/trigger.ts' ? { ...s, code: s.code.replace(/^import \{ sendCaughtFailure[^\n]*$/m, '') } : s)) };
    const v = decide(fixed);
    assert.equal(v.holds, false);
    assert.match(v.reason, /transport:server\/src\/sync\/trigger\.ts->api excuses nothing any more/);
  });

  it('is cannot answer when the graph is broken (imports naming files no tracked source holds)', () => {
    const broken = { ...byRoot, [SERVER]: byRoot[SERVER].map((s, i) => (i < 400 ? { ...s, code: `${s.code}\nimport './no-such-module-${i}.js';` } : s)) };
    assert.throws(() => decide(broken), CannotAnswer);
  });
});

describe('check-i-code-quality-values-named', () => {
  const byRoot = quality.readSources();
  const real = allowOf('check-i-code-quality-values-named');
  const decide = (planted) => quality.decide(planted, real, TODAY);
  const appended = (root, file, extra) => ({ ...byRoot, [root]: byRoot[root].map((s) => (s.file === file ? { ...s, text: `${s.text}\n${extra}` } : s)) });

  it('counts a literal in code and not in a comment, a string, a named constant or 0 and 1', () => {
    const n = (text) => quality.unnamedLiterals(text).length;
    assert.equal(n('retry(5000);'), 1);
    assert.equal(n('// 5000 ms\nconst a = "5000"; const B = `x 7000`;'), 0);
    assert.equal(n('export const LIMIT_MS = 5000;\nreadonly cap = 200;\n  RETRY: 30,'), 0);
    assert.equal(n('x[0] = y + 1;'), 0);
    assert.equal(n('if (n > 0.75) { slice(0, 12); }'), 2);
  });

  it('is violated when a new unnamed literal is added (a real line with one copied into another module)', () => {
    const code = (l) => !/^\s*(\*|\/\/|\/\*)/.test(l) && quality.unnamedLiterals(l).length === 1;
    const source = byRoot[SERVER].find((s) => s.text.split('\n').some(code));
    const line = source.text.split('\n').find(code);
    const other = byRoot[SERVER].find((s) => s.file !== source.file).file;
    const v = decide(appended(SERVER, other, line));
    assert.equal(v.holds, false);
    assert.match(v.reason, /unnamed number literal\(s\) in server\/src/);
  });

  it('is violated when a comment repeats an exported constant\'s value (a real constant\'s number written in a new comment)', () => {
    const owner = byRoot[SERVER].find((s) => /^export const [A-Z][A-Z0-9_]* = \d{3,};/m.test(s.text) && quality.proseRepeats(s.text).length === 0);
    assert.ok(owner, 'a server module exports a numeric constant with no comment repeating it');
    const value = /^export const [A-Z][A-Z0-9_]* = (\d{3,});/m.exec(owner.text)[1];
    const v = decide(appended(SERVER, owner.file, `// the limit is ${value} here`));
    assert.equal(v.holds, false);
    assert.match(v.reason, /comment\(s\) in server\/src repeating the value of an exported constant/);
  });

  it('holds exactly at its ceilings, and a ceiling for a measure that fell to 0 is refused', () => {
    assert.equal(decide(byRoot).holds, true);
    const gone = { ...byRoot, 'schema/src': byRoot['schema/src'].map((s) => ({ ...s, text: '' })) };
    assert.match(decide(gone).reason, /limits a measure that is 0/);
  });

  it('fails an exception with no reason or past its date', () => {
    assert.match(quality.decide(byRoot, [{ ...real[0], reason: '' }, ...real.slice(1)], TODAY).reason, /reason/);
    assert.match(quality.decide(byRoot, [{ ...real[0], reviewBy: '2026-01-01' }, ...real.slice(1)], TODAY).reason, /past its reviewBy/);
  });
});

describe('check-i-legal-about-page-attribution', () => {
  const inputs = about.readInputs();
  const real = allowOf('check-i-legal-about-page-attribution');

  it('reads the production packages from the manifests and the lock, a real number of them', () => {
    assert.ok(inputs.pkgs.length >= 25);
    assert.ok(inputs.pkgs.some((p) => p.name === 'marked' && p.where === 'client'));
    assert.ok(!inputs.pkgs.some((p) => p.name === SCHEMA_PACKAGE_NAME), 'the repository\'s own package owes no attribution');
  });

  it('is violated when NOTICE stops naming a package (a real package\'s name removed from it)', () => {
    const name = '@jsverse/transloco';
    assert.ok(inputs.pkgs.some((p) => p.name === name) && inputs.notice.includes(name));
    const v = about.decide({ ...inputs, notice: inputs.notice.split(name).join('REMOVED') }, real, TODAY);
    assert.equal(v.holds, false);
    assert.match(v.reason, /NOTICE does not name @jsverse\/transloco/);
  });

  it('is violated for a new production dependency the lock licenses and NOTICE does not name', () => {
    const planted = [...inputs.pkgs, { where: 'client', name: 'brand-new-dependency', license: 'MIT' }];
    assert.match(about.decide({ ...inputs, pkgs: planted }, real, TODAY).reason, /NOTICE does not name brand-new-dependency \(MIT\)/);
  });

  /** The About page as it was before it had a card for the notices (Q-916): identity, disk use and component health, and no pointer. */
  const BARE_ABOUT = 'about.card.instance Instance. about.card.system System, runtime and storage. about.card.components Components, optional services and their status.';
  /** The exception that excused that page, kept as a planted entry now that the real list is empty. */
  const OLD_EXCEPTION = [{ id: 'about:unattributed', reason: 'the About page names no third party', reviewBy: '2099-01-01' }];

  it('is violated when the About page names none of them and carries no pointer (the page before Q-916), and an exception excuses exactly that', () => {
    const bare = { ...inputs, aboutText: BARE_ABOUT };
    const open = about.findings(bare.pkgs, bare.aboutText, bare.notice);
    assert.deepEqual(open.map((f) => f.id), ['about:unattributed']);
    assert.equal(about.decide(bare, [], TODAY).holds, false);
    assert.equal(about.decide(bare, OLD_EXCEPTION, TODAY).holds, true);
  });

  it('holds the About page that points to the notices or names every package, and an exception then excuses nothing', () => {
    assert.deepEqual(about.findings(inputs.pkgs, inputs.aboutText, inputs.notice), [], 'the repository\'s own About page no longer points to the notices');
    assert.equal(about.decide(inputs, real, TODAY).holds, true);
    assert.match(about.decide(inputs, OLD_EXCEPTION, TODAY).reason, /about:unattributed excuses nothing any more/);
    const pointing = { ...inputs, aboutText: `${BARE_ABOUT}\nSee the third-party notices in NOTICE.` };
    assert.deepEqual(about.findings(pointing.pkgs, pointing.aboutText, pointing.notice), []);
    const naming = { ...inputs, aboutText: `${BARE_ABOUT}\n${inputs.pkgs.map((p) => p.name).join(' ')}` };
    assert.deepEqual(about.findings(naming.pkgs, naming.aboutText, naming.notice), []);
  });

  it('does not take a substring for a name, and reads an alternative that needs no attribution as none', () => {
    assert.ok(about.findings([{ where: 'client', name: 'marked', license: 'MIT' }], 'remarked text', 'marked').some((f) => f.id === 'about:unattributed'));
    assert.equal(about.requiresAttribution('(MPL-2.0 OR Apache-2.0)'), true);
    assert.equal(about.requiresAttribution('MIT OR 0BSD'), false);
    assert.equal(about.requiresAttribution(null), true);
  });

  it('fails an exception with no reason or past its date', () => {
    // The real list is empty since the page points to the notices, so the planted entry and the page it excused stand in.
    const bare = { ...inputs, aboutText: BARE_ABOUT };
    assert.match(about.decide(bare, [{ ...OLD_EXCEPTION[0], reason: '' }], TODAY).reason, /reason/);
    assert.match(about.decide(bare, [{ ...OLD_EXCEPTION[0], reviewBy: '2026-01-01' }], TODAY).reason, /past its reviewBy/);
  });
});

describe('check-i-legal-build-time-only-not-shipped', () => {
  const inputs = buildTime.readInputs();
  const real = allowOf('check-i-legal-build-time-only-not-shipped');

  it('is violated when the production install loses its omit-dev flag (the real RUN line changed)', () => {
    const needle = '--workspace=schema --omit=dev';
    assert.ok(inputs.dockerfile.includes(needle), 'the real production install line is in the Dockerfile');
    const v = buildTime.decide({ ...inputs, dockerfile: inputs.dockerfile.replace(needle, '--workspace=schema') }, real, TODAY);
    assert.equal(v.holds, false);
    assert.match(v.reason, /the shipped stage copies node_modules from prod-deps, which is not a production-only install/);
  });

  it('is violated when the shipped stage copies node_modules from the build stage', () => {
    const planted = `${inputs.dockerfile}\nCOPY --from=builder /build/node_modules ./node_modules\n`;
    assert.match(buildTime.decide({ ...inputs, dockerfile: planted }, real, TODAY).reason, /copies node_modules from builder/);
  });

  it('is violated when a shipped source imports a devDependency (the real vitest import line of a harness copied into the server)', () => {
    const harness = readFileSync(join(REPO_ROOT, 'client/src/app/testing/schema-tab-harness.ts'), 'utf8');
    const line = /^import[^\n]*from 'vitest';/m.exec(harness)?.[0];
    assert.ok(line, 'the real harness imports vitest');
    const workspaces = inputs.workspaces.map((w) => (w.name === 'server' ? { ...w, sources: w.sources.map((s, i) => (i === 0 ? { ...s, code: `${s.code}\n${line}` } : s)) } : w));
    const v = buildTime.decide({ ...inputs, workspaces }, real, TODAY);
    assert.equal(v.holds, false);
    assert.match(v.reason, /imports vitest, which a package.json declares only as a devDependency/);
  });

  it('does not take a client test harness for shipped code: only what the browser entry reaches is read', () => {
    const client = inputs.workspaces.find((w) => w.name === 'client');
    assert.ok(client.sources.some((s) => s.file === buildTime.clientEntry(readFileSync(join(REPO_ROOT, 'client/angular.json'), 'utf8'))));
    assert.ok(!client.sources.some((s) => s.file === 'client/src/app/testing/schema-tab-harness.ts'));
    const g = graphOf(client.sources);
    assert.ok(reachableFrom(g.edges, ['client/src/main.ts']).size > 100);
  });

  it('is violated when a devDependency is in a workspace\'s production closure and nothing excuses it', () => {
    const v = buildTime.decide(inputs, [], TODAY);
    assert.equal(v.holds, false);
    assert.match(v.reason, /server declares @types\/node as a devDependency, yet its production closure in the lock holds it/);
  });

  it('reads a Dockerfile\'s stages and the install each stage runs', () => {
    const stages = buildTime.stagesOf('FROM a AS one\nRUN npm ci --omit=dev\nFROM one AS two\nCOPY x y\nFROM b AS three\nRUN npm ci\n');
    assert.deepEqual(stages.map((s) => s.name), ['one', 'two', 'three']);
    assert.equal(buildTime.installsProductionOnly(stages, 'one'), true);
    assert.equal(buildTime.installsProductionOnly(stages, 'two'), true, 'a stage inherits its base stage\'s install');
    assert.equal(buildTime.installsProductionOnly(stages, 'three'), false);
  });

  it('fails an exception with no reason or past its date', () => {
    assert.match(buildTime.decide(inputs, [{ ...real[0], reason: '' }], TODAY).reason, /reason/);
    assert.match(buildTime.decide(inputs, [{ ...real[0], reviewBy: '2026-01-01' }], TODAY).reason, /past its reviewBy/);
  });
});
