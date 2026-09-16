import { col, asFilter, asDoc } from '../db/mongo.js';
import { v4 as uuidv4 } from 'uuid';

export interface SyncCounts {
  facts: number;
  entities: number;
  edges: number;
  files: number;
  chrono: number;
  /**
   * Added with the link records (`M-2`). Stored history written before then has no key here, so a reader
   * gets `undefined` rather than `0` — which is correct and not a gap: that cycle could not have pushed a
   * link, and reporting `0` would claim it looked and found none.
   */
  links: number;
}

export interface SyncHistoryRecord {
  _id: string;
  networkId: string;
  triggeredAt: string;
  completedAt: string;
  status: 'success' | 'partial' | 'failed';
  pulled: SyncCounts;
  pushed: SyncCounts;
  errors?: string[];
}

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
