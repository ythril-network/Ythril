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
 * Schemas are per-connection (the `space` enum is token-scoped), so a validator is built per connection
 * with a lazily-compiled, per-tool cache.
 */
import { Ajv, type ValidateFunction } from 'ajv';
import type { ToolHandler, ToolSchemas } from './tools/types.js';
import { materialisedSchema } from './tool-schema.js';

export interface ArgsValidator {
  /** Returns a human-readable error message if `args` violate the tool's schema, else `null`. */
  validate(tool: ToolHandler, args: Record<string, unknown>): string | null;
}

/**
 * @param accessibleSpaceIds the spaces THIS token reaches. It decides whether `space` is required —
   see `materialisedSchema` — so it has to reach the compile, not just the enum inside `schemas`.
 */
export function makeArgsValidator(schemas: ToolSchemas, accessibleSpaceIds: readonly string[]): ArgsValidator {
  // strict:false — don't throw on benign schema constructs (e.g. `default` with no useDefaults);
  // allowUnionTypes — TTL_DAYS_SCHEMA is `type: ['integer','null']`. Validation itself stays strict.
  const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
  const cache = new Map<string, ValidateFunction>();

  return {
    validate(tool, args) {
      // The cache is keyed by tool NAME and this validator is built per call, so it never serves one
      // token's schema to another. Hoisting it to module scope would do exactly that, now that the
      // schema depends on who is asking.
      let validate = cache.get(tool.name);
      if (!validate) {
        // The same materialisation `tools/list` advertises, not a second call to `inputSchema` — see B-6.
        validate = ajv.compile(materialisedSchema(tool, schemas, accessibleSpaceIds) as object);
        cache.set(tool.name, validate);
      }
      if (validate(args)) return null;
      const detail = (validate.errors ?? []).slice(0, 6).map(e => {
        const at = e.instancePath || '(arguments)';
        const p = e.params as Record<string, unknown>;
        switch (e.keyword) {
          case 'additionalProperties': return `${at}: unexpected property '${String(p['additionalProperty'])}'`;
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
