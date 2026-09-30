/**
 * What one MCP tool call pays for validation, against a validator built once (`Q-114`).
 *
 * A call used to build an Ajv and compile the tool's schema on the main thread (about 3.6 ms measured for recall
 * and save_entity); a reused validator answers in about 1 us. This prints microseconds per call and asserts
 * nothing: it is the measurement the change is priced on, not evidence. The evidence is
 * `a-tool-schema-is-built-once-per-reach.test.js`, which counts compiles.
 *
 * Run (requires a prior `npm run build` in server/):  node testing/bench/tool-call-setup-cost.mjs
 */
import { performance } from 'node:perf_hooks';
const root = new URL('../../server/dist/mcp/', import.meta.url).href;
const { ALL_TOOLS } = await import(root + 'tools/index.js');
const { makeArgsValidator } = await import(root + 'validate-args.js');
const { toolSchemasFor } = await import(root + 'tool-schema.js');

const ids = ['general', 'y-flows', 'y-tickets', 'swamp', 'registries', 'distillery'];
const tool = name => ALL_TOOLS.find(t => t.name === name);
const args = { space: 'general', query: 'hello', topK: 5 };
const N = 300;

function time(label, fn) {
  for (let i = 0; i < 20; i++) fn();
  const t0 = performance.now();
  for (let i = 0; i < N; i++) fn();
  const per = (performance.now() - t0) / N;
  console.log(`${label.padEnd(44)} ${(per * 1000).toFixed(0).padStart(7)} µs/call`);
  return per;
}

const perCall = time('today: new validator + schemas per call', () =>
  makeArgsValidator(toolSchemasFor(ids), ids).validate(tool('recall'), args));
const once = makeArgsValidator(toolSchemasFor(ids), ids);
const cached = time('validator built once (cache hit)', () => once.validate(tool('recall'), args));
const big = tool('save_bulk') ? tool('save_entity') : tool('recall');
const perCallBig = time('today, save_entity', () =>
  makeArgsValidator(toolSchemasFor(ids), ids).validate(tool('save_entity'), { space: 'general', name: 'a', type: 'b' }));
console.log(`ratio recall: ${(perCall / cached).toFixed(0)}x; tools: ${ALL_TOOLS.length}`);
void big; void perCallBig;
