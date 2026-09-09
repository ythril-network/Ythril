/**
 * The generic conversation knowledge schema, read out of the specification that defines it.
 *
 * ## The question this answers
 *
 * *"What shape should a conversation take inside Ythril, for ANY conversation?"* — and the answer is not
 * *one memory per chunk of transcript*, which is what every ingest rung in this folder had been doing.
 *
 * `INGESTION.md` specifies a product-grade schema: nine entity types — `person`, `place`, `organization`,
 * `work`, `object`, `activity`, `condition`, `project`, `animal` — and fourteen edge labels with both
 * endpoints pinned, so `works_at` runs from a person to an organization and an edge drawn any other way is
 * refused by the instance rather than quietly making a path read as something nobody wrote. It was produced
 * blind to the benchmark's questions on purpose, so it describes a corpus of any kind.
 *
 * **Nothing implemented it.** Every rung declared its own transcript-shaped schema — a single
 * `memory.utterance` carrying `session`, `turn`, `speaker`, `statedOn`, `turns` — and the one rung that
 * declared entities at all typed them `subject` with `namingPattern: ^[a-z]{4,}$`, which admitted
 * `anything`, `around` and `also` as nodes. So the graph claim had never been tested by anything, and the
 * specification sat in a document being true.
 *
 * ## Why it READS the spec instead of restating it
 *
 * A schema hand-copied out of `INGESTION.md` is the second copy of a rule, which is the defect this
 * repository produces most. It would be correct the day it was typed and would then drift — and it would
 * drift toward whatever the benchmark rewarded, which is precisely what the spec's question-blindness rule
 * exists to prevent. One source, and a gate that fails when the reading stops matching it.
 *
 * The cost is a markdown parse, and the parse is where this could go wrong quietly: a reader that finds
 * nothing returns an empty vocabulary, an empty vocabulary declares nothing, strict validation with nothing
 * declared validates NOTHING, and a corpus nobody validated scores badly and reads as a finding about
 * retrieval. Every function here throws instead.
 *
 * ## What is deliberately NOT in here
 *
 * The benchmark's own bookkeeping. `turn` is the scorer's join key — it exists so a result can be matched
 * against an answer key, and no product user has one. It is passed in by the caller through
 * `memoryProperties` rather than living in the shared vocabulary, so the thing every rung composes from
 * stays a description of conversations rather than of this benchmark.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = join(here, '..', '..', 'INGESTION.md');

/** A spec entry whose name starts with this is a RULE written as a pseudo-entry, not a type. */
const RULE_PREFIX = '__';

/**
 * The fenced JSON under one `##` heading of the specification.
 *
 * Throws on every way this can come back empty — a missing heading, a missing fence, a parse failure, or an
 * array with no real entries in it. An empty vocabulary is the failure mode that produces a plausible number
 * instead of an error.
 */
function specSection(heading, source) {
  const text = source ?? readFileSync(SPEC_PATH, 'utf8');
  const at = text.indexOf(`## ${heading}`);
  if (at < 0) {
    throw new Error(`_conversation-schema: INGESTION.md has no "## ${heading}" section. The schema is read `
      + 'from the specification, so a renamed heading silently empties the vocabulary rather than moving it.');
  }
  const open = text.indexOf('```json', at);
  const close = open < 0 ? -1 : text.indexOf('```', open + 7);
  if (open < 0 || close < 0) {
    throw new Error(`_conversation-schema: "## ${heading}" has no fenced JSON block.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text.slice(open + 7, close));
  } catch (err) {
    throw new Error(`_conversation-schema: the JSON under "## ${heading}" does not parse: ${err.message}`);
  }
  const real = (Array.isArray(parsed) ? parsed : []).filter(e => !String(e.type ?? e.label ?? RULE_PREFIX).startsWith(RULE_PREFIX));
  if (real.length === 0) {
    throw new Error(`_conversation-schema: "## ${heading}" defines no entries. A schema with no types `
      + 'declared validates NOTHING under strict mode, which reads as a retrieval result rather than a bug.');
  }
  return real;
}

/**
 * A property's declared type, inferred from what the specification says it holds.
 *
 * The spec documents each property as prose — `"firstSeenOn": "YYYY-MM-DD"`, `"year": "number"`,
 * `"kind": "city | country | region | venue | natural"`. Declared as strings across the board, a date could
 * not be range-queried and the declaration would buy almost nothing, so the shape of the description is read
 * rather than ignored.
 *
 * Conservative on purpose: anything not recognisably a date or a number is a string. A wrong `number` would
 * refuse a legitimate record at write time, which is far worse than a loose string.
 */
function propertyType(description) {
  const d = String(description ?? '').toLowerCase();
  if (/yyyy-mm-dd/.test(d)) return 'date';
  if (/^number\b/.test(d) || /\bordinal\b/.test(d)) return 'number';
  return 'string';
}

/** `"animal | object"` becomes `['animal', 'object']`, in the spec's own order. */
function endpointList(value) {
  return String(value ?? '').split('|').map(s => s.trim()).filter(Boolean);
}

function propertySchemasFrom(properties) {
  const out = {};
  for (const [key, description] of Object.entries(properties ?? {})) {
    // Nothing is `required`. The spec describes what a property MEANS, not whether an extractor could always
    // find it — and a required property an extractor cannot fill turns a partial extraction into a 400 and
    // loses the claim entirely. Provenance is the exception and it is declared where it is composed.
    out[key] = { type: propertyType(description) };
  }
  return out;
}

/**
 * The entity half of the vocabulary, as an instance `typeSchemas.entity` object.
 *
 * @param {{source?: string}} [opts] `source` overrides the spec text, for tests.
 */
export function conversationEntityTypes(opts = {}) {
  const out = {};
  for (const entry of specSection('Entity types', opts.source)) {
    out[entry.type] = { propertySchemas: propertySchemasFrom(entry.properties) };
  }
  return out;
}

/**
 * The edge half, as an instance `typeSchemas.edge` object.
 *
 * **`endpoints` is the reason this is worth declaring at all.** A label with both ends pinned makes the
 * graph enforce its own meaning: an `owns` edge drawn from an organization is a 400 at write time, not a
 * path that reads wrongly for ever. A label that arrives without them throws rather than being declared
 * unconstrained — an unconstrained label is indistinguishable from no schema, and it is the half a hand
 * copy would drop first because it looks like boilerplate.
 */
export function conversationEdgeLabels(opts = {}) {
  const out = {};
  for (const entry of specSection('Edge labels', opts.source)) {
    const from = endpointList(entry.from);
    const to = endpointList(entry.to);
    if (from.length === 0 || to.length === 0) {
      throw new Error(`_conversation-schema: edge label '${entry.label}' declares no endpoints in `
        + 'INGESTION.md. An unconstrained label enforces nothing, which is the same as having no schema.');
    }
    out[entry.label] = { endpoints: { from, to }, propertySchemas: propertySchemasFrom(entry.properties) };
  }
  return out;
}

/**
 * The whole thing, ready to POST as `{ typeSchemas }` when a space is created.
 *
 * @param {object} [opts]
 * @param {Record<string, object>} [opts.memoryProperties] extra properties for the claim type — where a
 *        caller puts anything that is ITS bookkeeping rather than a fact about conversations.
 * @param {string} [opts.source] overrides the spec text, for tests.
 *
 * A fresh object every call. Returning a shared one would let the first caller that adds a property change
 * the schema every later caller declares, and the symptom would be a space validating against another
 * rung's rules.
 */
export function conversationTypeSchemas(opts = {}) {
  return {
    entity: conversationEntityTypes(opts),
    edge: conversationEdgeLabels(opts),
    memory: {
      /*
       * One claim, one record — the spec's first invariant. The two properties here are provenance and they
       * are `required` because a claim nobody can date or attribute is not auditable, which is the one thing
       * the spec says every record must be. Everything else a caller needs goes through `memoryProperties`.
       */
      utterance: {
        propertySchemas: {
          speaker: { type: 'string', required: true },
          statedOn: { type: 'date', required: true },
          ...(opts.memoryProperties ?? {}),
        },
      },
    },
  };
}
