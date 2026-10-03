/**
 * Enforce a tool's advertised `inputSchema` on incoming CallTool arguments (F1).
 *
 * Before this, `inputSchema` was ADVISORY: the MCP dispatcher validated only the JSON-RPC envelope, and
 * each handler hand-checked its own args — so `additionalProperties`, `enum`, `minimum`/`maximum`,
 * `pattern`, `maxItems` etc. were documentation an agent could ignore with no error. This compiles the
 * SAME schema `tools/list` publishes and rejects non-conforming arguments, so the advertised contract is
 * the real contract (handlers keep their semantic checks — e.g. the query operator allowlist, "at least
 * one field", strict-linkage UUID rules — which JSON Schema can't express).
 *
 * A tool's schema is a pure function of (tool, the ids the token reaches, IN LIST ORDER): no `inputSchema`
 * builder reads config, env or rights (a derived gate holds that). So a validator is built once per reach
 * and kept in a bounded LRU (`validatorFor`), not once per call — building one cost about 3.6 ms of main
 * thread per tool call (`Q-114`).
 */
import { Ajv, type ValidateFunction } from 'ajv';
import type { ToolHandler, ToolSchemas } from './tools/types.js';
import { materialisedSchema, toolSchemasFor } from './tool-schema.js';
import { retiredWriteFieldHint } from '../brain/retired-write-fields.js';
import { toolValidatorCacheTotal } from '../metrics/registry.js';
import { log } from '../util/log.js';
import { LruMap } from '../util/lru-map.js';

export interface ArgsValidator {
  /** The schemas `tools/list` advertises for this reach: the SAME objects this validator compiles from. */
  readonly schemas: ToolSchemas;
  /** Returns a human-readable error message if `args` violate the tool's schema, else `null`. */
  validate(tool: ToolHandler, args: Record<string, unknown>): string | null;
}

/** Schema compiles done by this process, for the test accessor: the count the once-per-reach test asserts on. */
let compiles = 0;

/**
 * @param accessibleSpaceIds the spaces THIS token reaches. It decides whether `space` is required —
   see `materialisedSchema` — so it has to reach the compile, not just the enum inside `schemas`.
 */
export function makeArgsValidator(schemas: ToolSchemas, accessibleSpaceIds: readonly string[]): ArgsValidator {
  // strict:false — don't throw on benign schema constructs (e.g. `default` with no useDefaults);
  // allowUnionTypes — TTL_DAYS_SCHEMA is `type: ['integer','null']`. Validation itself stays strict.
  // The ONE Ajv construction in the server (a derived gate holds that): an Ajv keeps every schema it has
  // compiled for its whole life, so this instance lives and dies with the validator that owns it.
  const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
  const cache = new Map<string, ValidateFunction>();

  return {
    schemas,
    validate(tool, args) {
      // The per-tool cache is keyed by tool NAME and belongs to THIS validator, which `validatorFor` hands
      // out only to a caller with exactly the reach it was built for. Nothing here is shared across reaches:
      // a module-level cache keyed by tool name would serve one token's schema to another, now that the
      // schema depends on who is asking.
      let validate = cache.get(tool.name);
      if (!validate) {
        // The same materialisation `tools/list` advertises, not a second call to `inputSchema` — see B-6.
        validate = ajv.compile(materialisedSchema(tool, schemas, accessibleSpaceIds) as object);
        cache.set(tool.name, validate);
        compiles++;
      }
      if (validate(args)) return null;
      // Formatted in this same synchronous step: `validate.errors` is one property on a function shared by
      // every call on this reach, so any await between the call and this read would let an overlapping call
      // overwrite it.
      const detail = (validate.errors ?? []).slice(0, 6).map(e => {
        const at = e.instancePath || '(arguments)';
        const p = e.params as Record<string, unknown>;
        switch (e.keyword) {
          case 'additionalProperties': {
            // A name this tool USED to take is answered with the sentence the REST doors use, from one
            // module — otherwise the same mistake is a helpful 400 on one door and 'unexpected property'
            // on the other, and which one a caller meets depends on the client they picked.
            const prop = String(p['additionalProperty']);
            const retired = retiredWriteFieldHint(prop);
            return retired ?? `${at}: unexpected property '${prop}'`;
          }
          case 'required':             return `(arguments): missing required property '${String(p['missingProperty'])}'`;
          case 'enum':                 return `${at}: ${e.message} (${(p['allowedValues'] as unknown[] ?? []).join(', ')})`;
          case 'propertyNames':        return `${at}: property name is not allowed here`;
          default:                     return `${at}: ${e.message}`;
        }
      }).join('; ');
      return `Invalid arguments for '${tool.name}': ${detail}`;
    },
  };
}

/** How many reaches keep a validator. A COUNT, not bytes: an entry grows with tools times reachable spaces. */
export const VALIDATOR_CACHE_LIMIT = 64;

const SAFE_ID = /^[a-z0-9-]+$/;
// Dropping an entry is what frees its Ajv; the count of drops is what the bound costs.
const entries = new LruMap<string, ArgsValidator>(VALIDATOR_CACHE_LIMIT, () => toolValidatorCacheTotal.inc({ result: 'evict' }));
let warnedUnkeyable = false;

/** `null` when any id is not a plain space id, so the caller takes the uncached path rather than use a key that could alias. */
function reachKey(ids: readonly string[]): string | null {
  for (const id of ids) if (!SAFE_ID.test(id)) return null;
  return ids.join('\0');
}

function buildValidator(ids: readonly string[]): ArgsValidator {
  // A copy: the caller's array may be reused or mutated, and the enum inside the schemas is built from it.
  const copy = [...ids];
  const schemas = toolSchemasFor(copy);
  // Only the two `space` schemas are frozen: every tool of this reach embeds the SAME objects, so a handler
  // mutating one would change what every later call is validated against. Nothing else is claimed frozen.
  Object.freeze(schemas.requiredSpace);
  Object.freeze(schemas.optionalSpace);
  return makeArgsValidator(schemas, copy);
}

/**
 * The validator for a token that reaches exactly `accessibleSpaceIds`, built once per reach.
 *
 * ## The key is exactly what the schema depends on
 *
 * `toolSchemasFor` and `materialisedSchema` read the id list and nothing else: the enum keeps the list ORDER
 * (it is printed in the refusal and in `tools/list`) and `space` stops being required at exactly one id. So
 * the key is the ids in order joined with NUL: never sorted (`a,b` and `b,a` print different text) and never
 * joined with a character an id can hold. `ajv-is-built-in-one-place-and-tool-schemas-read-nothing-else`
 * keeps that true when a tool is added.
 *
 * ## The guard inside
 *
 * Every id is asserted `^[a-z0-9-]+$` before it goes into a key. One that is not (it cannot happen for a
 * configured space, and NUL is the separator) gets an UNCACHED validator, logged once: it must neither throw
 * on the call path nor alias a real reach's entry.
 *
 * ## Bounds
 *
 * An LRU of {@link VALIDATOR_CACHE_LIMIT} entries, a count and not bytes. Each entry owns its own Ajv,
 * because Ajv never evicts a compiled schema, so dropping the entry is what frees them. More reaches in
 * rotation than the limit shows as `ythril_tool_validator_cache_total{result="evict"}`.
 */
export function validatorFor(accessibleSpaceIds: readonly string[]): ArgsValidator {
  const key = reachKey(accessibleSpaceIds);
  if (key === null) {
    if (!warnedUnkeyable) {
      warnedUnkeyable = true;
      log.warn('tool validator: a space id outside [a-z0-9-]+ was given; its validator is built per call and not cached');
    }
    return buildValidator(accessibleSpaceIds);
  }
  // `get` makes the entry the most recently used (`util/lru-map.ts`).
  const hit = entries.get(key);
  if (hit) {
    toolValidatorCacheTotal.inc({ result: 'hit' });
    return hit;
  }
  toolValidatorCacheTotal.inc({ result: 'miss' });
  const built = buildValidator(accessibleSpaceIds);
  entries.set(key, built);
  return built;
}

/** Test accessors: entries held, and schema compiles done by this process since the last reset. */
export function _validatorCacheStats(): { size: number; compiles: number } {
  return { size: entries.size, compiles };
}
export function _resetValidatorCache(): void {
  entries.clear();
  compiles = 0;
  warnedUnkeyable = false;
}
