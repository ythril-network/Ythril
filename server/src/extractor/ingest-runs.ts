/**
 * The `ingest` runs this process holds (`F-31`). A run is minutes of model calls, so the door answers `202` with a
 * run id and the caller reads the run back.
 *
 * In memory, and said so on both doors: a restart loses the runs, not the records a finished run wrote. Bounded —
 * past the cap the OLDEST FINISHED run goes first and a running one never does, so a busy instance cannot grow
 * this without limit and a caller polling a long run cannot have it evicted from under them.
 *
 * Keyed by space as well as id: a run is found only under the space it was started in, so a token scoped to one
 * space cannot read another's run by guessing its id.
 */
import { randomUUID } from 'node:crypto';
import type { WriteOutcome } from './conversation/write-extraction.js';
import { MAX_ACTIVE_INGEST_RUNS } from '../util/request-bounds.js';

export type IngestPhase = 'queued' | 'extracting' | 'writing' | 'done' | 'failed';

export interface IngestRun {
  runId: string;
  spaceId: string;
  conversationId?: string;
  phase: IngestPhase;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  /** Which backends answered — the decision model and the writer, as the extraction recorded them. */
  backends?: string[];
  written?: WriteOutcome['written'];
  writeErrors?: WriteOutcome['errors'];
  dropped?: unknown[];
  uncovered?: string[];
  judgements?: number;
  /** Set when transcripts were not written, and why. */
  transcripts?: string;
  /** Every key the extraction named, and the record id it has now — written by this run or already there. */
  ids?: WriteOutcome['ids'];
  /**
   * Record id → the turns it came from. PROVENANCE REPORTED, NOT STORED: a turn id in a record would be noise in
   * every vector of the space, so the only place it lives is here — which is how a caller joins a record back to
   * the conversation (the benchmark joins its answer keys this way).
   */
  sourceTurns?: WriteOutcome['sourceTurns'];
}

const FINISHED: ReadonlySet<IngestPhase> = new Set(['done', 'failed']);

/** The refusal when every ingest slot is taken — one sentence for both doors. */
export const INGEST_BUSY = `at most ${MAX_ACTIVE_INGEST_RUNS} ingest runs may be in progress at once; try again when one finishes`;

export class IngestRuns {
  private readonly runs = new Map<string, IngestRun>();
  /**
   * @param cap          runs KEPT, finished ones evicted first — what `ingest_status` can still read.
   * @param activeCap    runs UNFINISHED at once (`Q-108`). Each holds model calls for minutes, so the count is the
   *                     axis that costs; the per-token rate limit alone let a fleet of tokens start any number.
   */
  constructor(private readonly cap = 200, private readonly activeCap = MAX_ACTIVE_INGEST_RUNS) {}

  /** Whether a run can start now — asked by the door BEFORE it spends the caller's rate-limit slot. */
  hasRoom(): boolean {
    let active = 0;
    for (const run of this.runs.values()) if (!FINISHED.has(run.phase)) active++;
    return active < this.activeCap;
  }

  create(spaceId: string): IngestRun {
    // The guard lives HERE, not at the door: a door that forgot to ask `hasRoom` still cannot start a fifth run.
    if (!this.hasRoom()) throw new Error(INGEST_BUSY);
    const run: IngestRun = { runId: randomUUID(), spaceId, phase: 'queued', startedAt: new Date().toISOString() };
    this.runs.set(run.runId, run);
    this.evict();
    return run;
  }

  get(spaceId: string, runId: string): IngestRun | undefined {
    const run = this.runs.get(runId);
    return run && run.spaceId === spaceId ? run : undefined;
  }

  private evict(): void {
    for (const [id, run] of this.runs) {
      if (this.runs.size <= this.cap) return;
      if (FINISHED.has(run.phase)) this.runs.delete(id);
    }
  }
}

/** The process's runs — one registry, read by both doors. */
export const ingestRuns = new IngestRuns();
