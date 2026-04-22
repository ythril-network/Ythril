import { col, mFilter, mDoc } from '../db/mongo.js';
import { v4 as uuidv4 } from 'uuid';

export interface SyncCounts {
  memories: number;
  entities: number;
  edges: number;
  files: number;
  chrono: number;
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
  await coll.insertOne(mDoc<SyncHistoryRecord>(doc));

  // Prune: keep only the most recent MAX_PER_NETWORK per network
  const boundary = await coll
    .find(mFilter<SyncHistoryRecord>({ networkId: record.networkId }))
    .sort({ completedAt: -1 })
    .skip(MAX_PER_NETWORK)
    .limit(1)
    .project({ completedAt: 1 })
    .toArray();

  if (boundary.length > 0) {
    await coll.deleteMany(mFilter<SyncHistoryRecord>({
      networkId: record.networkId,
      completedAt: { $lte: (boundary[0] as unknown as { completedAt: string }).completedAt },
    }));
  }
}

export async function getSyncHistory(networkId: string, limit: number = 20): Promise<SyncHistoryRecord[]> {
  return col<SyncHistoryRecord>(COLLECTION)
    .find(mFilter<SyncHistoryRecord>({ networkId }))
    .sort({ completedAt: -1 })
    .limit(Math.min(limit, 100))
    .toArray() as Promise<SyncHistoryRecord[]>;
}
