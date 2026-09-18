/**
 * What schema a given token is shown — the question, answered once, for advertising AND for enforcing.
 *
 * ## Why these two functions live together
 *
 * They make the same decision from the same fact. `toolSchemasFor` narrows `space`'s ENUM to the spaces a
 * token reaches; `materialisedSchema` decides, from that same list, whether `space` is REQUIRED. Split
 * across two modules they would drift, and the drift is invisible from either side: a token shown an enum
 * of one and a `required` that still lists `space` is told to send the only value it could have meant.
 *
 * ## Why it is its own module and not part of `call-tool.ts`
 *
 * It was, and it made a cycle: `validate-args.ts` needs the materialisation to compile a validator, and
 * `call-tool.ts` needs the validator to run a call. A leaf both can import breaks it — and the cycle was
 * the honest signal that this is a third thing rather than part of either.
 */
import type { ToolSchemas } from './tools/types.js';

/**
 * The `space` schemas injected into every tool's `inputSchema`.
 *
 * Built from the spaces THIS token reaches, so the enum a caller reads is the set it may actually name.
 * Exported because `tools/list` needs the same object the validator was built from — two builders would be
 * a schema advertised that the validator does not enforce.
 */
export function toolSchemasFor(accessibleSpaceIds: readonly string[]): ToolSchemas {
  const spaceEnumBase = accessibleSpaceIds.length > 0 ? { enum: [...accessibleSpaceIds] } : {};
  return {
    requiredSpace: { type: 'string' as const, ...spaceEnumBase, description: 'Space ID to operate on. Use list_spaces to discover available spaces. OPTIONAL when your token reaches exactly one space — there is no other space the call could mean, so it is filled in for you.' },
    optionalSpace: {
      oneOf: [
        { type: 'string' as const, ...spaceEnumBase },
        { type: 'array' as const, items: { type: 'string' as const, ...spaceEnumBase }, minItems: 1 },
      ],
      description: 'Optional space. ONE name searches that space; a LIST of names searches exactly those, '
        + 'and one you cannot reach refuses the whole call rather than quietly returning less — a short '
        + 'answer and a filtered one are indistinguishable. Omit it to search every space this token can '
        + 'reach. An empty list is refused rather than read as "all".',
    },
  };
}

/**
 * A tool's schema as THIS token is shown it.
 *
 * ## Why `required` depends on the token
 *
 * `B-6`. With exactly one reachable space there is no other space a call could mean, so `space` is filled
 * in by the dispatcher — and the schema has to say so or the behaviour is undiscoverable. A tool that
 * accepts the omission while advertising `space` as required tells every caller who reads the schema to
 * send something they need not, which is the documented-but-inert defect in reverse.
 *
 * ## Why both readers call THIS
 *
 * `tools/list` advertises and `makeArgsValidator` enforces. Two materialisations would be a schema
 * advertised that the validator does not enforce — and for this change that is bad in both directions: a
 * caller told they may omit `space` and then refused, or told to send it and silently not needing to.
 */
export function materialisedSchema(
  tool: { inputSchema: (s: ToolSchemas) => Record<string, unknown> },
  schemas: ToolSchemas,
  accessibleSpaceIds: readonly string[],
): Record<string, unknown> {
  const schema = tool.inputSchema(schemas);
  if (accessibleSpaceIds.length !== 1) return schema;
  const required = schema['required'];
  if (!Array.isArray(required) || !required.includes('space')) return schema;
  // A COPY. The tool objects are module-level singletons shared by every connection, so mutating one
  // would let the first token to call it decide what every later token is shown.
  return { ...schema, required: required.filter(k => k !== 'space') };
}
