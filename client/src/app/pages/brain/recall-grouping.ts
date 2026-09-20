/**
 * Group chunk-level file hits under the document they came from (brain-ux-epic 4c-ii).
 *
 * Semantic recall over files matches CHUNKS, not documents — a long paper that is relevant in five places
 * returns five near-identical rows, which pushes everything else out of the visible list and tells the
 * reader five times over what they already knew after the first. Grouping restores the thing they are
 * actually looking for: *which document*, and *where in it*.
 *
 * ── Why this lives in the client ────────────────────────────────────────────────────────────────────────
 *
 * The server already does the expensive half: every chunk hit arrives carrying `parentFileId` and an
 * inlined `parentFile {path, description, tags}`, batch-fetched in one query. Nothing in the client had
 * ever read those fields — the data crossed the wire on every recall and was thrown away. So this is a
 * presentation concern, and doing it here changes no API shape and does not ripple to MCP callers, who
 * receive the flat list they are built around.
 *
 * ── The count question, answered honestly ───────────────────────────────────────────────────────────────
 *
 * Collapsing five rows into one makes a `topK` of ten look like six. The alternative — over-fetching and
 * collapsing server-side — would change the recall contract for every consumer to fix a display problem.
 * Instead the group carries `hitCount`, and the UI reports both numbers. A reader who asked for ten and
 * sees six documents is not being short-changed as long as the six say how many passages they matched;
 * silently showing six with no explanation is what would mislead.
 */
import type { RecallResult } from '../../core/api.types';

/** The file-specific fields the server sends on a recall hit. `RecallResult` is index-signature typed, so
 *  these are narrowed here rather than being assumed at every use site. */
interface FileHitFields {
  _id?: unknown;
  parentFileId?: unknown;
  parentFile?: { path?: unknown; description?: unknown; tags?: unknown };
  headingText?: unknown;
  path?: unknown;
}

/** A parent document, when a group represents one. */
export interface RecallGroupFile {
  id: string;
  path: string;
  description?: string;
  tags?: string[];
}

export interface RecallGroup {
  /** Best score in the group — what the list orders by, so grouping never reorders relative to other hits. */
  score?: number;
  /** Set only for a grouped file. Absent for facts, entities, edges, chrono and ungroupable file rows. */
  file?: RecallGroupFile;
  /** The underlying hits, best first. Exactly one for a non-file group. */
  hits: RecallResult[];
  /** How many passages matched. 1 for everything that is not a grouped document. */
  hitCount: number;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

/**
 * The RECORD inside a hit — its own fields, as opposed to how it placed.
 *
 * ## Why every field read goes through one accessor
 *
 * A recall hit is `{score, spaceId, type, record: {...}}`: the ranking metadata beside the record rather
 * than mixed into it. `POST /api/brain/recall` used to return one FLAT object instead, and that difference
 * between the two doors existed for no reason anybody could defend — `RECALL_ENVELOPE_KEYS` on the server
 * existed solely to stop a projection eating the score on the flat side. The REST route collapsed onto the
 * shared tool module at 5.0 and the shapes became one.
 *
 * Reading `record` at each use site would have been a dozen edits and a dozen chances to miss one, and the
 * ones that got missed would read `undefined` rather than fail — a passage with no text, a file group with
 * no path. One accessor is one place to be wrong, and the next shape change is one line.
 *
 * **It does NOT fall back to the hit itself.** A tolerant reader would keep working against either shape
 * and hide the day the server stops sending one — which is how a client ends up quietly rendering nothing.
 */
const recordOf = (r: RecallResult): Record<string, unknown> =>
  (r['record'] ?? {}) as Record<string, unknown>;

/**
 * The key a file hit groups under: its parent document when it is a chunk, otherwise itself.
 *
 * Returning the file's own id for a NON-chunk hit is deliberate — it means a whole-file match and the
 * chunk matches from that same file collapse into one group instead of appearing as a document plus some
 * unrelated-looking fragments.
 */
export function fileGroupKey(r: RecallResult): string | null {
  if (r.type !== 'file') return null;
  const f = recordOf(r) as FileHitFields;
  return str(f.parentFileId) ?? str(f._id) ?? null;
}

/** The parent document description for a group, from whichever hit carries it. */
function fileOf(hits: RecallResult[], key: string): RecallGroupFile {
  for (const h of hits) {
    const f = recordOf(h) as FileHitFields;
    const p = str(f.parentFile?.path);
    if (p) {
      return {
        id: key, path: p,
        ...(str(f.parentFile?.description) ? { description: str(f.parentFile?.description)! } : {}),
        ...(Array.isArray(f.parentFile?.tags) ? { tags: f.parentFile?.tags as string[] } : {}),
      };
    }
  }
  // A non-chunk file hit has no `parentFile` — it IS the file, so its own path is the document's path.
  for (const h of hits) {
    const p = str((recordOf(h) as FileHitFields).path);
    if (p) return { id: key, path: p };
  }
  return { id: key, path: key };
}

/**
 * Collapse chunk hits under their parent document, preserving the incoming order.
 *
 * Order is by each group's FIRST occurrence, not by re-sorting on score: the server has already ranked the
 * results, and re-ranking here would quietly disagree with the ordering every other consumer sees.
 */
export function groupRecallResults(results: readonly RecallResult[]): RecallGroup[] {
  const groups: RecallGroup[] = [];
  const byKey = new Map<string, RecallGroup>();

  for (const r of results) {
    const key = fileGroupKey(r);
    if (key === null) {
      groups.push({ hits: [r], hitCount: 1, ...(r.score != null ? { score: r.score } : {}) });
      continue;
    }
    const existing = byKey.get(key);
    if (existing) {
      existing.hits.push(r);
      existing.hitCount++;
      continue;
    }
    const group: RecallGroup = { hits: [r], hitCount: 1, ...(r.score != null ? { score: r.score } : {}) };
    byKey.set(key, group);
    groups.push(group);
  }

  // The parent is resolved after collection so a group whose FIRST hit lacked `parentFile` can still be
  // named from a later one.
  for (const [key, g] of byKey) g.file = fileOf(g.hits, key);
  return groups;
}

/** A short label for where in the document a chunk matched — its heading, when the chunker recorded one. */
export function chunkLabel(r: RecallResult): string | undefined {
  return str((recordOf(r) as FileHitFields).headingText);
}

/** Longest passage rendered inline before it is cut. Long enough to judge relevance, short enough that six
 *  of them under one document stay scannable. */
const PASSAGE_MAX = 400;

/**
 * The matching passage's own text, for display.
 *
 * Recall results otherwise render as pretty-printed JSON, which is defensible for a record you are
 * inspecting and useless for a passage you are reading — and grouping makes it worse, stacking six JSON
 * blobs under one document. `content` is the chunk's text; `matchedText` is the exact string that was
 * embedded, which is what actually matched, so it is the better fallback than the raw record.
 *
 * Returns undefined when there is no text, so the caller can fall back rather than render an empty block.
 */
export function passageText(r: RecallResult): string | undefined {
  const f = recordOf(r) as FileHitFields & { content?: unknown; matchedText?: unknown };
  const text = str(f.content) ?? str(f.matchedText);
  if (!text) return undefined;
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > PASSAGE_MAX ? `${clean.slice(0, PASSAGE_MAX - 1)}…` : clean;
}

/**
 * Turn a graph-augmented recall into the flat, ordered list this tab renders.
 *
 * `traverse > 0` no longer returns traversed records beside the matches. Each match carries a `_graph` array
 * of `{edges, node, paths}`, and a nested node carries its own `_graph`, so the answer is a tree per match —
 * which is the right API shape (`count` means matches again, and a structurally-reached node is not competing
 * in a ranked list) and the wrong shape for a list of rows.
 *
 * So the tree is walked DEPTH-FIRST: each match, then what it reached, then what that reached. A reader sees
 * the same rows in the same order as before, and a neighbour sits directly beneath the match it belongs to
 * instead of after every other match. Everything downstream — the file grouping reading `parentFile`, the
 * passage fallback reading `content`, the JSON fallback dumping the hit — keeps receiving records, not
 * envelopes.
 *
 * What the row carries from the graph is what a reader needs to place it: `source: 'traverse'`, the derived
 * `hops`, the reaching edge's `label`, and `graphParentId`. Nothing is computed that the response did not
 * already state.
 */
/** One traversed neighbour, kept as the whole record with what placed it in the graph. */
export interface RelatedRecord {
  record: RecallResult;
  kind: string;
  hops: number;
  label?: string;
}

/** A match's neighbourhood, grouped the way a reader asks for it. */
export interface RelatedGroups {
  entities: RelatedRecord[];
  facts: RelatedRecord[];
  chronos: RelatedRecord[];
  files: RelatedRecord[];
  total: number;
}

/**
 * A match's `_graph`, flattened to a list per KIND, with each node kept whole.
 *
 * This REPLACED a flattener, and the difference is the bug it fixes. That function — deleted with this
 * comment's last claim on it — appended every graph node to the RESULT list — so a traversed neighbour arrived looking exactly like a
 * match, in rank order, counted in the result total, with a `source: 'traverse'` marker that the panel never
 * rendered. Reported by the owner: *"the graph entries seem to be included in rank and handed as main result
 * instead of part of a graph"*.
 *
 * A neighbour is not a match. It has no score of its own, it did not answer the question, and it is only
 * meaningful BESIDE the record that reached it. So it stays under its match, and the ranked list holds
 * exactly what the server ranked.
 *
 * Depth-first, and a node reached at hop 2 sits in the same list as one at hop 1 — with its `hops` recorded,
 * so the reader can see which is which without the tree being rebuilt in the markup.
 */
export function relatedOf(match: RecallResult): RelatedGroups {
  const out: RelatedGroups = { entities: [], facts: [], chronos: [], files: [], total: 0 };
  const walk = (nodes: unknown): void => {
    if (!Array.isArray(nodes)) return;
    for (const raw of nodes) {
      if (raw === null || typeof raw !== 'object') continue;
      const entry = raw as Record<string, unknown>;
      const node = entry['node'];
      if (node === null || typeof node !== 'object' || Array.isArray(node)) continue;
      const rec = node as Record<string, unknown>;
      const edge = (entry['edge'] ?? {}) as Record<string, unknown>;
      const paths = Array.isArray(entry['paths']) ? (entry['paths'] as unknown[]) : [];
      const primary = Array.isArray(paths[0]) ? (paths[0] as unknown[]) : [];
      const kind = typeof rec['kind'] === 'string' ? (rec['kind'] as string) : 'entity';
      const item: RelatedRecord = {
        record: rec as RecallResult,
        kind,
        hops: Math.max(1, primary.length - 1),
        ...(typeof edge['label'] === 'string' ? { label: edge['label'] as string } : {}),
      };
      const bucket = kind === 'fact' ? out.facts
        : kind === 'chrono' ? out.chronos
        : kind === 'file' ? out.files
        : out.entities;
      bucket.push(item);
      out.total++;
      walk(rec['_graph'] ?? entry['_graph']);
    }
  };
  walk((match as Record<string, unknown>)['_graph']);
  return out;
}

/** The per-stage scores a result carries, with the one that DECIDED its place named. */
export interface Ordering {
  /** The deciding field's name — `rerankScore`, `fusedScore` or `score`. */
  by: 'rerankScore' | 'fusedScore' | 'score';
  /** Its value. */
  value: number;
  /** Every stage that ran, deciding one first, for the reader who wants the rest. */
  stages: Array<{ name: string; value: number }>;
}

/**
 * Which number ordered this result, and what the other stages said.
 *
 * ## Why the panel has to show this
 *
 * Precedence is `rerankScore` → `fusedScore` → `score`, and the guide says so: *"on an instance with a
 * cross-encoder configured, `score` — plain vector similarity — is NOT the number that ordered the answer"*.
 * The panel showed `score` and called it "Score", so on exactly those instances it displayed a number that
 * had not decided anything, beside results in an order it did not explain.
 *
 * None of these sit behind `includeDiagnostics` — that flag covers `matchedText`, `embeddingModel` and
 * `seq`. Three floats per result are not a cost, which is why they are always sent, and showing them costs
 * nothing either.
 *
 * ## Absent means the stage did not RUN
 *
 * No reranker configured, no lexical channel for that query. So a missing field is information rather than a
 * gap, and it is left out rather than rendered as zero — a zero would read as "the reranker scored this
 * nothing", which is the opposite of "the reranker never saw it".
 */
export function orderingOf(hit: Record<string, unknown>): Ordering | null {
  const num = (k: string): number | null => (typeof hit[k] === 'number' ? hit[k] as number : null);

  // Highest precedence FIRST, and the deciding one is simply the first present. Written as a list rather
  // than as nested conditionals so the order is the rule, visible in one line.
  const PRECEDENCE = ['rerankScore', 'fusedScore', 'score'] as const;
  const decider = PRECEDENCE.find(k => num(k) !== null);
  if (!decider) return null;

  const stages: Array<{ name: string; value: number }> = [];
  for (const k of [...PRECEDENCE, 'lexicalScore']) {
    const v = num(k);
    if (v !== null) stages.push({ name: k, value: v });
  }
  return { by: decider, value: num(decider)!, stages };
}
