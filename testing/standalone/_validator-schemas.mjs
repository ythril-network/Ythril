/**
 * Every validator a door applies, as JSON Schema — the MCP tool schemas and every exported zod schema, one shape.
 *
 * ## Why a module
 *
 * Two gates ask about validators and ask different things of them: `every-quantity-a-caller-sends-has-a-bound`
 * wants every array and number to carry a bound, and `a-tool-and-its-route-agree-on-bounds` wants a tool's bound
 * and its route's bound for one parameter to be the same number. Both need the same derivation — the registry's
 * schemas, and every zod schema a module exports, rendered by `z.toJSONSchema` so one walker reads both doors — and
 * the second gate was the second site, which is when it stops being a copy and becomes a module.
 *
 * ## The guards a hand-written copy drops
 *
 * - **The module set is derived** — every tracked source that imports zod — so a validator in a new file is read
 *   the day it lands. The local-agent connector is the one exclusion, and it is a second process on its own port.
 * - **The floors.** A derivation that stopped matching returns a short list, and a short list passes every loop
 *   written over it. `toolValidators` and `zodValidators` throw below theirs.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { ALL_TOOLS } from '../../server/dist/mcp/tools/index.js';
import { REPO_ROOT, trackedSources } from './_sources.mjs';

/** What a tool schema's `space` parameter is built from — a fixed stand-in, since the gates read shape, not reach. */
const SPACE_SCHEMAS = { requiredSpace: { type: 'string' }, optionalSpace: { type: 'string' } };

/** The JSON Schema a tool declares, built the way the dispatcher builds it. */
export function toolSchema(tool) {
  return typeof tool.inputSchema === 'function' ? tool.inputSchema(SPACE_SCHEMAS) : tool.inputSchema;
}

/** Every MCP tool, as `{ door: 'MCP <name>', tool, schema }`. */
export function toolValidators({ floor = 60 } = {}) {
  const out = ALL_TOOLS.map(tool => ({ door: `MCP ${tool.name}`, tool, schema: toolSchema(tool) }));
  if (out.length < floor) throw new Error(`only ${out.length} tool schema(s) read, below ${floor} — the registry import broke`);
  return out;
}

/**
 * Every exported zod schema, as `{ door: 'REST <file>:<name>', file, name, zod, schema }` — `schema` being its JSON
 * Schema rendering. `name` is the export name, which is how a route handler refers to it.
 */
export async function zodValidators({ floor = 70 } = {}) {
  const files = trackedSources('server/src', { untracked: true, exclude: ['server/src/local-agent-connector/index.ts'] })
    .filter(f => /from ['"]zod['"]/.test(readFileSync(join(REPO_ROOT, f), 'utf8')));
  const out = [];
  for (const file of files) {
    const dist = join(REPO_ROOT, file.replace(/^server\/src\//, 'server/dist/').replace(/\.ts$/, '.js'));
    const mod = await import(pathToFileURL(dist).href);
    for (const [name, zod] of Object.entries(mod)) {
      if (!zod || typeof zod !== 'object' || !zod._zod) continue;
      out.push({ door: `REST ${file}:${name}`, file, name, zod, schema: z.toJSONSchema(zod, { unrepresentable: 'any', io: 'input' }) });
    }
  }
  if (out.length < floor) throw new Error(`only ${out.length} exported zod schema(s) read, below ${floor} — the module derivation broke`);
  return out;
}

/** Every array and number node of one validator, with its path. `seg` is the property it is declared under. */
export function quantities({ door, schema }) {
  const out = [];
  const walk = (node, path, seg) => {
    if (!node || typeof node !== 'object') return;
    const types = [node.type].flat();
    if (types.includes('array')) out.push({ door, path, seg, kind: 'array', node });
    if (types.includes('number') || types.includes('integer')) out.push({ door, path, seg, kind: 'number', node });
    for (const [k, v] of Object.entries(node.properties ?? {})) walk(v, `${path}.${k}`, k);
    if (node.items && !Array.isArray(node.items)) walk(node.items, `${path}[]`, seg);
    for (const key of ['oneOf', 'anyOf', 'allOf']) (node[key] ?? []).forEach((v, i) => walk(v, `${path}|${i}`, seg));
    if (node.additionalProperties && typeof node.additionalProperties === 'object') walk(node.additionalProperties, `${path}{*}`, seg);
  };
  walk(schema, '', '');
  return out;
}
