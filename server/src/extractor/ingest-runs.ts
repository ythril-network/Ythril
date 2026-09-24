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

export class IngestRuns {
  private readonly runs = new Map<string, IngestRun>();
  constructor(private readonly cap = 200) {}

  create(spaceId: string): IngestRun {
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
