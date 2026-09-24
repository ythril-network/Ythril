/**
 * `ingest` (`F-31`): a conversation in, records out. The one module both doors call — the REST route and the MCP
 * tool parse with `parseIngestRequest`, refuse with `ingestRefusals`, and start with `startIngest`, so the two
 * cannot accept different bodies or refuse for different reasons.
 *
 * Two kinds of body, exactly one per call:
 *  - `sessions` — a raw conversation, run through every phase (1–10): minutes of model calls;
 *  - `extraction` — one already made, in the committed format: validated and written (9.2–10), no model at all.
 *    This is how the benchmark writes its committed extractions, and how an integrator replays one.
 *
 * ## Phase 0: refuse before paying
 *
 * A space that cannot hold the records, or an instance with no model to judge them, is refused up front and the
 * refusal names what to change. Discovering either after the model calls would charge the caller for a run that
 * was never going to write anything. `ingest` never writes schema itself: the space gets the `conversation` group
 * through the Schema Library's group apply, where an operator can see it happen.
 */
import { createHash } from 'node:crypto';
import type { SpaceMeta, SchemaLibraryEntry } from '../config/types.js';
import { resolveMetaRefs } from '../spaces/schema-validation.js';
import { shippedLibraryEntries } from '../config/shipped-library-entries.js';
import { loadConversation, ConversationSourceError, type ConversationSource, type LoadedConversation } from './conversation/load.js';
import type { ExtractResult, ExtractVocabulary } from './conversation/extract.js';
import type { Extraction } from './conversation/assemble.js';
import type { SchemaEntry } from './validate-extraction.js';
import type { WriteOutcome } from './conversation/write-extraction.js';
import { ingestRuns, type IngestRun } from './ingest-runs.js';
import { log } from '../util/log.js';
import { unknownBodyFields } from '../brain/query.js';

export const INGEST_KINDS = ['conversation'] as const;
/** The body both doors read. MCP's `space` / `targetSpace` are the tool's addressing, stripped before this. */
export const INGEST_BODY_KEYS: ReadonlySet<string> = new Set(['kind', 'conversationId', 'sessions', 'extraction']);
const GROUP = 'conversation';
const CONVERSATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export interface IngestRequest {
  kind: typeof INGEST_KINDS[number];
  conversationId: string;
  /** Present for a raw conversation, already loaded (so a malformed one is refused before a run exists). */
  conversation?: LoadedConversation;
  source?: ConversationSource;
  extraction?: Extraction;
}

export function parseIngestRequest(body: unknown): { ok: true; request: IngestRequest } | { ok: false; error: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  // A key this door does not read is refused by name: carried and ignored, a misspelt `session` would answer 202.
  const unknown = unknownBodyFields(b, INGEST_BODY_KEYS);
  if (unknown) return { ok: false, error: unknown.error };
  if (!INGEST_KINDS.includes(b['kind'] as never)) {
    return { ok: false, error: `\`kind\` must be one of: ${INGEST_KINDS.join(', ')}` };
  }
  const hasSessions = b['sessions'] !== undefined, hasExtraction = b['extraction'] !== undefined;
  if (hasSessions === hasExtraction) {
    return { ok: false, error: 'send exactly one of `sessions` (a raw conversation, run through every phase) or `extraction` (one already made, validated and written)' };
  }
  if (b['conversationId'] !== undefined && (typeof b['conversationId'] !== 'string' || !CONVERSATION_ID_RE.test(b['conversationId']))) {
    return { ok: false, error: '`conversationId` must be 1–100 letters, digits, dots, dashes or underscores, starting with a letter or digit — it names the transcripts\' folder' };
  }
  if (hasExtraction) {
    const x = b['extraction'];
    if (!x || typeof x !== 'object' || Array.isArray(x)) return { ok: false, error: '`extraction` must be an object in the committed extraction format' };
    const extraction = x as Extraction;
    const id = (b['conversationId'] as string | undefined) ?? extraction.conversationId;
    if (typeof id !== 'string' || !CONVERSATION_ID_RE.test(id)) {
      return { ok: false, error: '`conversationId` is required — in the body or in the extraction — as 1–100 letters, digits, dots, dashes or underscores' };
    }
    return { ok: true, request: { kind: 'conversation', conversationId: id, extraction: { ...extraction, conversationId: id } } };
  }
  const source = { sessions: b['sessions'] } as ConversationSource;
  let conversation: LoadedConversation;
  try {
    conversation = loadConversation(source);
  } catch (err) {
    if (err instanceof ConversationSourceError) return { ok: false, error: err.message };
    throw err;
  }
  // Derived from the content when not given, so the same conversation sent twice names the same transcripts.
  const conversationId = (b['conversationId'] as string | undefined)
    ?? `conversation-${conversation.sessions[0]!.date}-${createHash('sha256').update(JSON.stringify(source.sessions)).digest('hex').slice(0, 8)}`;
  return { ok: true, request: { kind: 'conversation', conversationId, conversation, source } };
}

/** What `ingest` needs to know about the target space, read from its resolved schema. */
export interface IngestSpaceContext {
  /** `knowledgeType/typeName` for every type the space declares. */
  declared: Set<string>;
  /** Every declared type, as the validator reads them — the space's own rules, not the shipped copies. */
  schemaEntries: SchemaEntry[];
  vocabulary: ExtractVocabulary;
  /** The group's fact type: what a claim is written as. */
  claimType: string;
  group: SchemaLibraryEntry[];
}

export function spaceContextFrom(meta: SpaceMeta | undefined): IngestSpaceContext {
  const resolved = meta ? resolveMetaRefs(meta) : {};
  const typeSchemas = (resolved.typeSchemas ?? {}) as Record<string, Record<string, Record<string, unknown>>>;
  const schemaEntries: SchemaEntry[] = Object.entries(typeSchemas).flatMap(([knowledgeType, types]) =>
    Object.entries(types ?? {}).map(([typeName, schema]) => ({ knowledgeType, typeName, schema })));
  const declared = new Set(schemaEntries.map(e => `${e.knowledgeType}/${e.typeName}`));
  const group = shippedLibraryEntries().filter(e => e.schemaGroup === GROUP);
  const own = (e: SchemaLibraryEntry) => (typeSchemas[e.knowledgeType]?.[e.typeName] ?? e.schema) as Record<string, any>;
  const entityTypes: Record<string, string> = {};
  const edgeLabels: ExtractVocabulary['edgeLabels'] = {};
  for (const e of group) {
    if (e.knowledgeType === 'entity') entityTypes[e.typeName] = e.description ?? e.typeName;
    if (e.knowledgeType === 'edge') {
      // The endpoints the SPACE allows — an operator who narrowed a label narrows what the extractor may draw.
      const ends = own(e)['endpoints'] ?? {};
      edgeLabels[e.typeName] = { description: e.description ?? e.typeName, from: ends.from ?? [], to: ends.to ?? [] };
    }
  }
  const claim = group.find(e => e.knowledgeType === 'fact');
  if (!claim) throw new Error(`the shipped '${GROUP}' group declares no fact type — nowhere to write a claim`);
  return { declared, schemaEntries, vocabulary: { entityTypes, edgeLabels }, claimType: claim.typeName, group };
}

/** The checks phase 0 runs, injected so a test can say which of them fail. Each throws or answers false. */
export interface IngestProbes {
  decision: () => unknown;
  generation: () => unknown;
  nlp: () => Promise<boolean>;
}

export async function ingestRefusals(request: IngestRequest, ctx: IngestSpaceContext, probes: IngestProbes): Promise<string[]> {
  const refusals: string[] = [];
  const missing = ctx.group.filter(e => !ctx.declared.has(`${e.knowledgeType}/${e.typeName}`));
  if (missing.length) {
    refusals.push(`the space does not declare ${missing.map(e => `${e.knowledgeType} '${e.typeName}'`).join(', ')} from the `
      + `'${GROUP}' group. Add the group with POST /api/schema-library/groups/${GROUP}/apply (Settings → Schema Library → `
      + 'apply group) — ingest never changes a space\'s schema itself');
  }
  // An extraction already made needs no model: it is validated and written, and nothing is asked.
  if (request.conversation) {
    const fails = (probe: () => unknown) => { try { probe(); return false; } catch { return true; } };
    if (fails(probes.decision)) {
      refusals.push('no decision model answers: configure Settings → Models → Decision model, or the assist model it falls back to');
    }
    if (fails(probes.generation)) {
      refusals.push('no assist model writes claims: configure Settings → Models → Assist model (documentProcessing.assistModel) and consent to its host');
    }
    if (!(await probes.nlp())) {
      refusals.push('the doc-nlp sidecar does not answer (NLP_SIDECAR_URL): mention finding needs it — start the doc-nlp service');
    }
  }
  return refusals;
}

export interface IngestDeps {
  extract: (conversationId: string, source: ConversationSource, vocabulary: ExtractVocabulary) => Promise<ExtractResult>;
  write: (spaceId: string, extraction: Extraction, opts: { schemaEntries: SchemaEntry[]; claimType: string; transcripts: boolean }) => Promise<WriteOutcome>;
}

/**
 * What the CALLER may do beyond the door's own right. `ingest` is gated on `knowledge: write`, and a transcript is a
 * FILE — so it is written only for a caller holding `files: write` too, or the door would write files for a token
 * that may not. Skipped rather than refused: the records are what was asked for, and the run says what it left out.
 */
export interface IngestGrants {
  transcripts: boolean;
}

/** A session's transcript, as the file stores it: one `speaker: text` line per turn. */
function transcriptOf(conversation: LoadedConversation): Map<string, string> {
  return new Map(conversation.sessions.map(s => [s.key, s.turns.map(t => `${t.speaker}: ${t.text}`).join('\n')]));
}

/** Run one ingest to the end, recording every phase on `run`. Never throws: a failure is the run's state. */
export async function runIngest(
  run: IngestRun, spaceId: string, request: IngestRequest, ctx: IngestSpaceContext, deps: IngestDeps,
  grants: IngestGrants = { transcripts: false },
): Promise<void> {
  run.conversationId = request.conversationId;
  try {
    let extraction = request.extraction;
    if (!extraction) {
      run.phase = 'extracting';
      const r = await deps.extract(request.conversationId, request.source!, ctx.vocabulary);
      const text = transcriptOf(request.conversation!);
      extraction = { ...r.extraction, sessions: r.extraction.sessions.map(s => ({ ...s, text: text.get(s.key ?? s.date) ?? '' })) };
      run.dropped = r.dropped;
      run.uncovered = r.uncovered;
      run.judgements = r.judgements.length;
    }
    run.backends = extraction.producedBy?.backends ?? [];
    run.phase = 'writing';
    if (!grants.transcripts) run.transcripts = 'skipped: the token does not hold files: write in this space';
    const w = await deps.write(spaceId, extraction, { schemaEntries: ctx.schemaEntries, claimType: ctx.claimType, transcripts: grants.transcripts });
    run.written = w.written;
    run.writeErrors = w.errors;
    run.phase = 'done';
  } catch (err) {
    run.phase = 'failed';
    run.error = err instanceof Error ? err.message : String(err);
    log.warn(`ingest ${run.runId} into ${spaceId} failed: ${run.error}`);
  } finally {
    run.finishedAt = new Date().toISOString();
  }
}

/** Create a run and start it in the background. The caller answers `202` with the returned run. */
export function startIngest(spaceId: string, request: IngestRequest, ctx: IngestSpaceContext, deps: IngestDeps, grants: IngestGrants): IngestRun {
  const run = ingestRuns.create(spaceId);
  run.conversationId = request.conversationId;
  void runIngest(run, spaceId, request, ctx, deps, grants);
  return run;
}
