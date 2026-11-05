/**
 * The child process `the-from-typescript-entry-loads-typescript-only-when-called.test.js` runs its loading scenarios in (Q-687).
 *
 * ## Why a child
 *
 * "The compiler cannot be found" cannot be staged in the test's own process: it has `typescript` loaded for the other tests, and a
 * hook that refuses it would refuse it for the rest of the file. Here the hook is registered before anything is imported (precedent:
 * `_cel-boot-child.mjs`), and it reports every request for `typescript` over a message port, so "the main entry never loads it" is read
 * off the hook (a request that was made and swallowed would still show) and not off an absence of errors.
 *
 * ## The spec (argv[2], JSON)
 *
 * `{ "scenario": "<name>", "source": "<TypeScript source>" }`. The hook's mode follows from the scenario:
 *
 * - `main-entry`: refuse `typescript`. Imports `dist/index.js` and `dist/internal.js`, calls the converter and the validator, then
 *   TRIPWIRES: a direct `import('typescript')` must see the hook's error, and the entry, imported and called, must reject naming the
 *   install. A hook that never fired would make "never asked" true of anything.
 * - `missing`: refuse. Calls the entry; prints the rejection.
 * - `too-large`: refuse. Calls the entry with a source over SOURCE_MAX; the size refusal comes before the compiler loads.
 * - `ts7` / `ts7-named`: `typescript` resolves to a module with no `createProgram` (a default export / a namespace only).
 * - `other-error`: the hook throws an error that is not "not found".
 * - `fail-then-succeed`: refuse the FIRST request only. Two concurrent calls (one in-flight import, so one request, both rejected), then
 *   a third (a second request, the real compiler, a read).
 * - `default-load`: no hook interference; the entry loads the real compiler itself and reads.
 *
 * It prints one JSON line.
 */
import { register } from 'node:module';
import { MessageChannel, receiveMessageOnPort } from 'node:worker_threads';

const DIST = new URL('../../schema/dist/', import.meta.url);
const spec = JSON.parse(process.argv[2]);
const SOURCE = spec.source ?? 'export interface SpaceTypes {\n  "entity": { "thing": { properties: { name: string; } } };\n}\n';

/** What the hook does with a request for `typescript`, by scenario. */
const MODE = {
  'main-entry': 'refuse', missing: 'refuse', 'too-large': 'refuse', ts7: 'stub-default', 'ts7-named': 'stub-named',
  'other-error': 'other-error', 'fail-then-succeed': 'refuse-once', 'default-load': 'pass',
}[spec.scenario];
if (MODE === undefined) throw new Error(`unknown scenario ${spec.scenario}`);

const { port1, port2 } = new MessageChannel();
const hooks = `
let port; let mode; let seen = 0;
export async function initialize(data) { port = data.port; mode = data.mode; }
export async function resolve(specifier, context, next) {
  if (specifier !== 'typescript') return next(specifier, context);
  seen++;
  port.postMessage({ specifier, parent: context.parentURL, n: seen });
  if (mode === 'refuse' || (mode === 'refuse-once' && seen === 1)) {
    const e = new Error("Cannot find package 'typescript' imported from " + context.parentURL + ' (refused by the test hook)');
    e.code = 'ERR_MODULE_NOT_FOUND';
    throw e;
  }
  if (mode === 'other-error') { const e = new Error('the disk is on fire (raised by the test hook)'); e.code = 'EIO'; throw e; }
  if (mode === 'stub-default') return { url: 'data:text/javascript,export default { version: "7.0.0" };', shortCircuit: true };
  if (mode === 'stub-named') return { url: 'data:text/javascript,export const version = "7.0.0";', shortCircuit: true };
  return next(specifier, context);
}`;
register(`data:text/javascript,${encodeURIComponent(hooks)}`, { data: { port: port2, mode: MODE }, transferList: [port2] });

/** The requests for `typescript` the hook has reported so far (it posts before it answers, so a short wait lets the port deliver). */
async function asked() {
  // waits-differently: the loader's hook thread posts before it answers; the port delivers a message in a later turn of the event loop, not after a time the subject owns
  await new Promise(resolve => setTimeout(resolve, 40));
  const out = [];
  for (let m = receiveMessageOnPort(port1); m; m = receiveMessageOnPort(port1)) out.push(m.message.parent);
  return out;
}

const describeError = (e) => ({ isError: e instanceof Error, name: e?.name, code: e?.code, message: String(e?.message ?? e) });
const settle = (p) => p.then(value => ({ resolved: value }), error => ({ rejected: describeError(error) }));
const brief = (answer) => answer === undefined ? undefined : { ok: answer.ok, reasons: answer.refusals?.map(r => r.reason), tables: answer.meta && Object.keys(answer.meta.typeSchemas ?? {}) };

const out = { scenario: spec.scenario };
if (spec.scenario === 'main-entry') {
  const main = await import(new URL('index.js', DIST).href);
  await import(new URL('internal.js', DIST).href);
  main.typesOfSpaceMeta({ typeSchemas: { entity: { thing: { propertySchemas: { name: { type: 'string' } } } } } });
  main.validateSpaceMeta({ typeSchemas: { entity: { thing: { propertySchemas: { name: { type: 'string' } } } } } });
  out.askedByMainEntry = (await asked()).length;
  out.tripwireDirect = await import('typescript').then(() => 'loaded', describeError);
  const mod = await import(new URL('from-typescript.js', DIST).href).then(m => m, error => ({ importFailed: describeError(error) }));
  out.entry = mod.importFailed ? { importFailed: mod.importFailed } : await settle(mod.spaceMetaFromTypeScript(SOURCE));
} else {
  const mod = await import(new URL('from-typescript.js', DIST).href).catch(error => ({ importFailed: describeError(error) }));
  if (mod.importFailed) out.importFailed = mod.importFailed;
  else if (spec.scenario === 'too-large') {
    out.sourceMax = mod.SOURCE_MAX;
    out.answer = await settle(mod.spaceMetaFromTypeScript(`// ${'x'.repeat(mod.SOURCE_MAX)}\n${SOURCE}`));
    if (out.answer.resolved) out.answer.resolved = brief(out.answer.resolved);
    out.asked = (await asked()).length;
  } else if (spec.scenario === 'fail-then-succeed') {
    const both = await Promise.all([settle(mod.spaceMetaFromTypeScript(SOURCE)), settle(mod.spaceMetaFromTypeScript(SOURCE))]);
    out.concurrent = both;
    out.askedAfterConcurrent = (await asked()).length;
    const third = await settle(mod.spaceMetaFromTypeScript(SOURCE));
    out.third = third.resolved ? brief(third.resolved) : third;
    out.askedAfterThird = (await asked()).length;
  } else {
    const answer = await settle(mod.spaceMetaFromTypeScript(SOURCE));
    out.answer = answer.resolved ? { resolved: brief(answer.resolved) } : answer;
    out.asked = (await asked()).length;
  }
}
console.log(JSON.stringify(out));
port1.close();
process.exit(0);
