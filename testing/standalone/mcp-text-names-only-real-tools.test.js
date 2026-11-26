/**
 * Everything an MCP client reads as reference names only tools and parameters that exist.
 *
 * Found by the Q-45 cleanup audit, 2026-09-24: the server instructions — the first text a connecting agent
 * reads — named `list_chrono`, `find_similar`, `list_peers` and `sync_now`, and the help text named
 * `find_entities_by_name`, `get_space_meta` and a `query` tool, months after all of them were renamed or
 * folded away. A stale tool name costs the caller a failed call, and nothing on the server side notices.
 *
 * Derived, not listed: the texts are rendered from the live modules, and every snake_case word in them must
 * be a tool name or a parameter some tool's schema declares. A list of RETIRED names would pass the next
 * rename that nobody adds to it.
 *
 * Run: node --test testing/standalone/mcp-text-names-only-real-tools.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let tools, schemas, helpSections, spaceScopeSentence;
before(async () => {
  ({ ALL_TOOLS: tools } = await import('../../server/dist/mcp/tools/index.js'));
  const { toolSchemasFor } = await import('../../server/dist/mcp/tool-schema.js');
  schemas = toolSchemasFor(['general']);
  ({ helpSections } = await import('../../server/dist/mcp/tools/help-sections.js'));
  ({ spaceScopeSentence } = await import('../../server/dist/mcp/space-scope-sentence.js'));
});

/** Tool names, and every property name any tool's input schema declares, at any depth. */
function vocabulary() {
  const words = new Set([...tools.map(t => t.name), ...DATA_VALUES.keys(), ...ANSWER_VALUES]);
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (o.properties && typeof o.properties === 'object') for (const k of Object.keys(o.properties)) words.add(k);
    for (const v of Object.values(o)) walk(v);
  };
  for (const t of tools) walk(t.inputSchema(schemas));
  return words;
}

/**
 * DATA that happens to be snake_case, never a tool or a parameter. Each is named in a description as an
 * example value a caller will see or write, which is exactly why it must not be mistaken for a tool name.
 */
const DATA_VALUES = new Map([
  ['depends_on', 'an example edge label (save_edge: direction is part of the meaning)'],
  ['reports_to', 'an example edge label'],
  ['vote_pending', 'the status a network write returns while a vote round is open'],
  ['space_act_failed', 'the code of a space act that failed here after its vote passed (bundle-106, delete_space_data)'],
  ['change_note', 'the first half of the webhook event name change_note.received (F-42)'],
  // A former NAME, kept on purpose: an integrator whose call fails with "unknown tool" needs to find out what
  // it became (embed-job-tools-say-which-queue.test.js asserts it stays).
  ['retry_failed_embeddings', 'the name retry_embed_media had until 3.1'],
]);

/**
 * Values an answer carries — why a row was left out (`incompleteRows[].reason`) and which bound ended an answer
 * (`truncatedBy`). Read from the module that defines them, never listed, so a new reason is known here the day
 * it exists and a retired one stops being excused.
 */
let ANSWER_VALUES = [];
before(async () => {
  const { INCOMPLETE_ROW_REASONS, WALK_STOPS } = await import('../../server/dist/brain/row-graphs.js');
  // And the `code` a network refusal carries (Q-133), from the one list of them.
  const { NETWORK_REFUSAL_CODES } = await import('../../server/dist/networks/refusal-codes.js');
  // And the `code` a refused merge carries (bundle-30, Q-107 part 3a), from its one list.
  const { MERGE_REFUSAL_CODES } = await import('../../server/dist/brain/merge.js');
  // And the `code` a file act's refusal carries (`destination_exists`, `confirm_required`, ...), from the tally that holds one
  // entry per code of the answer's own union (`fileActAnswerCounts`).
  const { fileActAnswerCounts } = await import('../../server/dist/files/act-answers.js');
  // And the `code` a write a standing space act refuses carries (`space_being_restored`, `space_being_migrated`, ...), from the one
  // list of act kinds (`SPACE_ACT_KINDS`, each kind's `writeRefusalCode`): `space_rename` and help() name the ones a rename meets.
  const { SPACE_ACT_KINDS } = await import('../../server/dist/config/types-space-acts.js');
  const actCodes = Object.values(SPACE_ACT_KINDS).map(k => k.writeRefusalCode);
  assert.ok(actCodes.length >= 5, `only ${actCodes.length} space act refusal codes were read`);
  // And the `code` a write at its version ceiling answers (`409`, the four update tools and the fork resolve name it), from the constant the doors answer with.
  const { RECORD_VERSION_AT_CEILING } = await import('../../server/dist/brain/write-precondition.js');
  // And the `code` an ordinary edit of a fork row, or a re-key past the fork cap, answers (Q-624: `fork_row_read_only`, `fork_cap`), from their one list.
  // And the code a link taken back because its entity was deleted meanwhile carries (`link_target_removed`, Q-305: a warning row, or the 409 of a link written on its own), from its constant beside the other.
  const { FORK_REFUSAL_CODES, ENDPOINT_REMOVED, LINK_TARGET_REMOVED } = await import('../../server/dist/util/errors.js');
  assert.ok(FORK_REFUSAL_CODES?.length >= 2, 'the fork refusal codes were not read');
  // And the `code` a create or a rename answers while a deleted space's search-index drop still runs (`space_still_being_removed`), from its constant.
  const { SPACE_STILL_BEING_REMOVED } = await import('../../server/dist/spaces/search-index-drops-in-flight.js');
  // And the `code` a waited sync answer carries when nothing synced or the instance is stopping (`sync_failed`, `sync_store_failed`, `shutting_down`:
  // `network_sync` names them), from the verdict table's own list (bundle-39 D2).
  const { SYNC_ANSWER_CODES } = await import('../../server/dist/sync/trigger.js');
  assert.ok(SYNC_ANSWER_CODES.length >= 3, `only ${SYNC_ANSWER_CODES.length} sync answer codes were read`);
  // And the reasons a `degraded` list can carry (`index_not_ready`, ...): the recall and similar texts list them, from the constant.
  const { DEGRADED_REASONS } = await import('../../server/dist/brain/degraded-reasons.js');
  assert.ok(DEGRADED_REASONS.length >= 2, 'the degraded reasons were not read');
  // And the `code` a refused read of the file change feed carries (`cursor_expired`, `invalid_cursor`: `file_changes` names them, bundle-255).
  const { FILE_CHANGES_REFUSAL_CODES } = await import('../../server/dist/mcp/tools/file-changes.js');
  assert.ok(FILE_CHANGES_REFUSAL_CODES?.length >= 2, 'the file change feed refusal codes were not read');
  // And the codes a refused schema-version read carries (`bad_fingerprint`, `unknown_fingerprint`, ...: `space_schema_versions` names them, bundle-267).
  const { SCHEMA_VERSION_REFUSAL_CODES } = await import('../../server/dist/spaces/schema-versions-acts.js');
  assert.ok(SCHEMA_VERSION_REFUSAL_CODES?.length >= 3, 'the schema-version refusal codes were not read');
  // And the codes a schema conversion's doors refuse with, the reason classes an unconverted record carries and the codes of its list and dismissals
  // (`space_schema_convert`, `list_unconverted`, `dismiss_unconverted` and `dismiss_unconverted_shown` name them), each from the one list the acts answer from.
  // And the state a conversion status read through a personal view of several members answers (`per_member`: `space_schema_conversion` and help() name it).
  const { SCHEMA_CONVERT_REFUSAL_CODES, SCHEMA_CONVERT_VIEW_STATE } = await import('../../server/dist/spaces/schema-convert-acts.js');
  assert.equal(typeof SCHEMA_CONVERT_VIEW_STATE, 'string', 'the per-member conversion state was not read');
  const { UNCONVERTED_REFUSAL_CODES } = await import('../../server/dist/spaces/unconverted-acts.js');
  // And the codes the RDF exports refuse with (`export_rdf`, `space_schema_rdf` and help() name them, bundle-269), each from the act's own list.
  const { RDF_EXPORT_REFUSAL_CODES } = await import('../../server/dist/rdf/export-act.js');
  const { RDF_SCHEMA_REFUSAL_CODES } = await import('../../server/dist/rdf/schema-export-act.js');
  assert.ok(RDF_EXPORT_REFUSAL_CODES?.length >= 5 && RDF_SCHEMA_REFUSAL_CODES?.length >= 3, 'the RDF export refusal codes were not read');
  // The codes the SPARQL endpoint answers and the warnings its summary carries (`sparql_query` names them, Q-757), from the act's own lists.
  const { SPARQL_ENDPOINT_CODES, SPARQL_WARNING_CODES } = await import('../../server/dist/rdf/sparql-answer.js');
  assert.ok(SPARQL_ENDPOINT_CODES?.length >= 10 && SPARQL_WARNING_CODES?.length >= 2, 'the SPARQL codes were not read');
  // The codes a SPARQL Update answers (`sparql_update` and help() name them, Q-761): the act's own and its evaluation's, each from its one list.
  const { SPARQL_UPDATE_ACT_CODES } = await import('../../server/dist/spaces/sparql-update-act.js');
  const { SPARQL_UPDATE_REFUSAL_CODES } = await import('../../server/dist/rdf/change-set-store.js');
  assert.ok(SPARQL_UPDATE_ACT_CODES?.length >= 5 && SPARQL_UPDATE_REFUSAL_CODES?.length >= 3, 'the SPARQL Update codes were not read');
  // The code a triple index rebuild refuses with (`space_rdf_rebuild` names it, Q-764), from the act's own list.
  const { TRIPLE_INDEX_REBUILD_REFUSAL_CODES } = await import('../../server/dist/rdf/triple-index/rebuild.js');
  assert.ok(TRIPLE_INDEX_REBUILD_REFUSAL_CODES?.length >= 1, 'the triple index rebuild refusal codes were not read');
  const { UNCONVERTED_REASONS } = await import('../../server/dist/brain/schema-convert-items.js');
  assert.ok(SCHEMA_CONVERT_REFUSAL_CODES?.length >= 5 && UNCONVERTED_REFUSAL_CODES?.length >= 5 && UNCONVERTED_REASONS?.length >= 5, 'the conversion refusal codes and reason classes were not read');
  ANSWER_VALUES = [SCHEMA_CONVERT_VIEW_STATE, ...SCHEMA_CONVERT_REFUSAL_CODES,...UNCONVERTED_REFUSAL_CODES, ...UNCONVERTED_REASONS, ...DEGRADED_REASONS, ...FILE_CHANGES_REFUSAL_CODES, ...SCHEMA_VERSION_REFUSAL_CODES,...INCOMPLETE_ROW_REASONS, ...WALK_STOPS, ...NETWORK_REFUSAL_CODES, ...MERGE_REFUSAL_CODES, ...Object.keys(fileActAnswerCounts()),
    ...actCodes, RECORD_VERSION_AT_CEILING, ...FORK_REFUSAL_CODES, ENDPOINT_REMOVED, LINK_TARGET_REMOVED, SPACE_STILL_BEING_REMOVED, ...SYNC_ANSWER_CODES,
    ...RDF_EXPORT_REFUSAL_CODES, ...RDF_SCHEMA_REFUSAL_CODES, ...SPARQL_ENDPOINT_CODES, ...SPARQL_WARNING_CODES,
    ...SPARQL_UPDATE_ACT_CODES, ...SPARQL_UPDATE_REFUSAL_CODES, ...TRIPLE_INDEX_REBUILD_REFUSAL_CODES];
  assert.ok(ANSWER_VALUES.length >= 2, 'the answer values were not read');
});

/** The snake_case words of a text — the shape every tool name has and prose words do not. */
const snakeWords = (text) => [...new Set(text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? [])];

describe('MCP reference text names only real tools and parameters', () => {
  it('the vocabulary was actually read', () => {
    assert.ok(tools.length >= 30, `only ${tools.length} tools`);
    assert.ok(vocabulary().size > tools.length + 50, 'parameter names were not collected');
  });

  it('the server instructions\' space sentence', () => {
    const s = spaceScopeSentence(tools, schemas);
    const unknown = snakeWords(s).filter(w => !vocabulary().has(w));
    assert.deepEqual(unknown, [], s);
    assert.match(s, /\brecall\b/, 'recall takes an optional space, so the sentence must name it');
  });

  it('help(), every section', () => {
    const ctx = { accessibleSpaces: [{ id: 'general', label: 'General' }], accessibleSpaceIds: ['general'] };
    const sections = helpSections(ctx, tools.map(t => ({ name: t.name, description: t.description })), 0);
    assert.ok(sections.length >= 5, `only ${sections.length} help sections`);
    const vocab = vocabulary();
    const unknown = sections.flatMap(sec => {
      const text = [sec.title, sec.preamble, sec.body, ...(sec.lines ?? [])].filter(Boolean).join('\n');
      return snakeWords(text).filter(w => !vocab.has(w)).map(w => `${sec.id}: ${w}`);
    });
    assert.deepEqual(unknown, [], 'help names things no tool is called and no parameter is named');
  });

  it('every tool description', () => {
    const vocab = vocabulary();
    const unknown = tools.flatMap(t => snakeWords(t.description ?? '').filter(w => !vocab.has(w)).map(w => `${t.name}: ${w}`));
    assert.deepEqual(unknown, [], 'a tool description names a tool or parameter that does not exist');
  });
});
