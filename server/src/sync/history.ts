import { col, asFilter, asDoc } from '../db/mongo.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * A cycle's counts: one per replicated family under its `countKey`, and `files` (the files the file routes moved, not bytes), derived from the
 * family list (`sync/replicated-families.ts`, bundle-39 Q-265). Stored history written before a key existed has no key there (`links` before
 * `M-2`, `filemeta` before bundle-39), so a reader gets `undefined` rather than `0` — which is correct and not a gap: that cycle did not count
 * it, and reporting `0` would claim it looked and found none.
 */
export type { SyncCounts } from './replicated-families.js';
import type { SyncCounts } from './replicated-families.js';
import type { CycleStatus } from './cycle-outcome.js';

/**
 * What a cycle's pulled pages stored that the receiving space's schema does not accept and the copy they replaced lacked, for ONE space
 * (`sync/arrival-recording.ts`, R6-9): how many documents, and the field names most of them carried with how many each. Names and counts only —
 * never a value, and never a document's id.
 */
export interface SyncSchemaRecording {
  spaceId: string;
  records: number;
  top: Array<{ name: string; count: number }>;
}

export interface SyncHistoryRecord {
  _id: string;
  networkId: string;
  triggeredAt: string;
  completedAt: string;
  /**
   * The cycle's verdict word (`syncVerdict`, `sync/cycle-outcome.ts`), the same word the metric and the waited answer carry. `refused` (only peers
   * too old to sync with, nothing failed) was recorded as `failed` before bundle-39; an older version reads it as a word it does not know. A cycle
   * stopped by shutdown is recorded `partial`, its errors saying so.
   */
  status: CycleStatus;
  pulled: SyncCounts;
  pushed: SyncCounts;
  errors?: string[];
  /**
   * Per space, what this cycle's pulls stored against the local schema's rules (`SyncSchemaRecording`). Absent when nothing was — a
   * cycle that recorded nothing writes the row it always wrote. A push is not in it: a pushing peer is answered per document.
   */
  schemaViolations?: SyncSchemaRecording[];
  /**
   * Spaces this cycle did not exchange because a deletion or wipe is being applied on one side (design v5 section 3.3, W9), with the
   * members it was held with and why. A held space is not a failure: a cycle whose only shortfall is held spaces is `success`. Absent
   * when nothing was held.
   */
  held?: SyncHeldSpace[];
  /** Spaces a pub/sub member left and answered `space_declined` for (X10): recorded, never requested again, never a hold. Absent when none. */
  declined?: SyncDeclinedSpace[];
}

/** One held space of a cycle: the members it was held with, and why. */
export interface SyncHeldSpace { spaceId: string; members: string[]; reason: string; /** The held families, when the hold is one family's and not the space's. */ families?: string[] }
/** One declined space of a cycle, and the members that declined it. */
export interface SyncDeclinedSpace { spaceId: string; members: string[] }

const COLLECTION = '_sync_history';
const MAX_PER_NETWORK = 100;

export async function recordSyncResult(record: Omit<SyncHistoryRecord, '_id'>): Promise<void> {
  const doc: SyncHistoryRecord = { _id: uuidv4(), ...record };
  const coll = col<SyncHistoryRecord>(COLLECTION);
  await coll.insertOne(asDoc<SyncHistoryRecord>(doc));

  // Prune: keep only the most recent MAX_PER_NETWORK per network
  const boundary = await coll
    .find(asFilter<SyncHistoryRecord>({ networkId: record.networkId }))
    .sort({ completedAt: -1 })
    .skip(MAX_PER_NETWORK)
    .limit(1)
    .project({ completedAt: 1 })
    .toArray();

  if (boundary.length > 0) {
    await coll.deleteMany(asFilter<SyncHistoryRecord>({
      networkId: record.networkId,
      completedAt: { $lte: (boundary[0] as unknown as { completedAt: string }).completedAt },
    }));
  }
}

export async function getSyncHistory(networkId: string, limit: number = 20): Promise<SyncHistoryRecord[]> {
  return col<SyncHistoryRecord>(COLLECTION)
    .find(asFilter<SyncHistoryRecord>({ networkId }))
    .sort({ completedAt: -1 })
    .limit(Math.min(limit, 100))
    .toArray() as Promise<SyncHistoryRecord[]>;
}
