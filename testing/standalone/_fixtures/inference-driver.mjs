/**
 * A stand-alone parent process for the tests that have to watch a parent end.
 *
 * Three facts about the inference child cannot be observed from inside the process that owns it:
 *
 *  - `orphan`      the child must exit when its PARENT is killed without a chance to say goodbye (`kill -9`, the
 *                  OOM killer, `process.exit(1)` in a crash handler). The test SIGKILLs this process and then
 *                  looks for the child.
 *  - `finishes`    a script that awaits one embed and does nothing else must end by ITSELF afterwards. If the host
 *                  kept the child or its IPC channel referenced while idle, this process would wait for the ten
 *                  minute idle timer, and the test would time out.
 *  - `holds`       and the converse: while a request is pending the process must NOT end. Nothing else keeps this
 *                  event loop alive, so if the host had unref'd the child too early the process would exit
 *                  before the reply and print nothing.
 *
 * Output is one JSON object per line on stdout. Not run by the test runner; `_`-prefixed and not a `.test.js`.
 *
 * usage: node inference-driver.mjs <orphan|finishes|holds> <pipelineModule>
 */
const [scenario, pipelineModule] = process.argv.slice(2);
const dist = (p) => new URL(`../../../server/dist/${p}`, import.meta.url).href;

const { createLocalInference } = await import(dist('brain/local-inference.js'));
const say = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

const host = createLocalInference({ pipelineModule, log: () => {} });

if (scenario === 'orphan') {
  await host.request({ input: 'hello', lane: 'document', modelId: 'fixture/a' });
  say({ ready: true, parentPid: process.pid, childPid: host.state().pid });
  // Stay alive, doing nothing useful, until the test kills us.
  setInterval(() => {}, 1_000);
} else if (scenario === 'finishes') {
  const r = await host.request({ input: 'hello', lane: 'document', modelId: 'fixture/a' });
  say({ done: true, vector: r.vector, childPid: host.state().pid });
  // Falls off the end of the module. No process.exit, no stop(): the loop must drain by itself.
} else if (scenario === 'holds') {
  const pending = host.request({ input: 'slow [busy:400]', lane: 'document', modelId: 'fixture/a' });
  pending.then((r) => say({ done: true, vector: r.vector }), (e) => say({ failed: String(e?.message ?? e) }));
} else {
  say({ error: `unknown scenario ${scenario}` });
  process.exitCode = 2;
}
