/**
 * The `ingest` sequence both doors run, from a request to a started run — so the REST route and the MCP tool
 * cannot differ in which space they check, which body they accept, or which refusals they make. Each door only
 * shapes the answer: REST as a status code, MCP as a tool result.
 *
 * The production wiring lives here too: the decision model, the writer, the NLP sidecar and the space's own entity
 * search for the extractor; the batch door for the write. Phase 0 probes the same functions the run will call, so
 * a refusal and a failure mid-run cannot disagree about whether a model is configured.
 *
 * The heavy-call rail is here too (`S-8`), and it is why `callerKey` is a required argument rather than middleware:
 * a run is minutes of model calls, the REST route had only the global limiter while the MCP tool was rate limited,
 * and a limit that each door mounts for itself is one door away from missing. It counts STARTED runs — after the
 * refusals, so a start refused before anything is paid for costs no slot.
 */
import { getConfig } from '../config/loader.js';
import { resolveWriteTarget } from '../spaces/proxy.js';
import { decide, decisionBackend } from './decide.js';
import { generate, generationBackend } from './generate.js';
import { isNlpAvailable, spansOf } from './conversation/nlp-client.js';
import { spaceEntitySearch } from './conversation/shortlist.js';
import { extractConversation } from './conversation/extract.js';
import { writeExtraction } from './conversation/write-extraction.js';
import { parseIngestRequest, ingestRefusals, spaceContextFrom, startIngest, type IngestDeps, type IngestProbes } from './ingest.js';
import { ingestRuns, type IngestRun } from './ingest-runs.js';
import { holdsRung } from '../auth/reachable-spaces.js';
import type { TokenRights } from '../config/rights-shape.js';
import { consumeHeavyToolCall, HEAVY_CALLS_PER_WINDOW } from '../rate-limit/heavy-tool.js';

/** The refusal a caller over the rail gets, the same words on both doors. */
export const INGEST_RATE_LIMITED = `ingest is rate limited — at most ${HEAVY_CALLS_PER_WINDOW} runs a minute per token; try again shortly`;

export const INGEST_PROBES: IngestProbes = {
  decision: () => decisionBackend(),
  generation: () => generationBackend(),
  nlp: () => isNlpAvailable(),
};

function productionDeps(spaceId: string): IngestDeps {
  return {
    extract: (conversationId, source, vocabulary) => extractConversation(conversationId, source, vocabulary, {
      decide: (state, questions) => decide(decisionBackend(), state, questions),
      write: async (prompt) => (await generate(generationBackend(), prompt)).text,
      spans: (texts) => spansOf(texts),
      searchSpace: spaceEntitySearch(spaceId),
    }),
    write: (target, extraction, opts) => writeExtraction(target, extraction, opts),
  };
}

export type BeginIngest =
  | { status: 202; run: IngestRun }
  | { status: 400 | 404 | 429; error: string }
  | { status: 409; error: string; refusals: string[] };

export async function beginIngest(
  spaceId: string, targetSpace: string | undefined, body: unknown, rights: TokenRights | undefined,
  /** Who the rail counts against: the calling token's id, or its IP when it has none. */
  callerKey: string,
): Promise<BeginIngest> {
  if (!getConfig().spaces.some(s => s.id === spaceId)) return { status: 404, error: `Space '${spaceId}' not found` };
  const wt = resolveWriteTarget(spaceId, targetSpace);
  if (!wt.ok) return { status: 400, error: wt.error };
  const parsed = parseIngestRequest(body);
  if (!parsed.ok) return { status: 400, error: parsed.error };
  const ctx = spaceContextFrom(getConfig().spaces.find(s => s.id === wt.target)?.meta);
  const refusals = await ingestRefusals(parsed.request, ctx, INGEST_PROBES);
  if (refusals.length) {
    return { status: 409, error: `ingest cannot run into '${wt.target}': ${refusals.join('; ')}`, refusals };
  }
  if (!consumeHeavyToolCall(callerKey)) return { status: 429, error: INGEST_RATE_LIMITED };
  // Fails closed: no rights matrix means no second area, so no files.
  const transcripts = !!rights && holdsRung(rights, wt.target, 'files', 'write');
  return { status: 202, run: startIngest(wt.target, parsed.request, ctx, productionDeps(wt.target), { transcripts }) };
}

/**
 * A run, looked up under the space it was started in. A run started through a proxy is held under the MEMBER it
 * wrote into, so the lookup resolves the same write target the start did.
 */
export function ingestStatus(spaceId: string, targetSpace: string | undefined, runId: string): IngestRun | undefined {
  const wt = resolveWriteTarget(spaceId, targetSpace);
  return wt.ok ? ingestRuns.get(wt.target, runId) : undefined;
}
