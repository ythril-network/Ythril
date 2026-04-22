/**
 * Merkle root computation for a space.
 *
 * The root is a SHA-256 hash over a binary Merkle tree whose leaves are:
 *   - For each memory / entity / edge document (excluding tombstones):
 *       SHA-256( "doc:<type>:<_id>:<seq>" )
 *   - For each file in the space:
 *       SHA-256( "file:<relative-path>:<sha256>" )
 *
 * Leaves are sorted lexicographically before tree construction so the root is
 * deterministic regardless of insertion order.
 *
 * If the space contains no documents and no files the root is the SHA-256 of
 * the empty string — a well-defined sentinel value.
 *
 * Enabled per-network via `network.merkle === true` (opt-in).
 */

import { createHash } from 'node:crypto';
import { col, mFilter } from '../db/mongo.js';
import { buildFileManifest } from '../files/manifest.js';

// ── Internal helpers ─────────────────────────────────────────────────────────

function sha256hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Build a binary Merkle tree from a sorted array of leaf hashes and return the
 * root hash.
 *
 * If `leaves` is empty, returns SHA-256("") — a stable empty-tree sentinel.
 * If `leaves` has one element, that element IS the root.
 * If the number of nodes at any level is odd, the last node is duplicated
 * (standard Bitcoin/RFC-style Merkle tree convention).
 */
function merkleRoot(leaves: string[]): string {
  if (leaves.length === 0) return sha256hex('');

  let level = leaves.slice();

  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1] ?? left; // duplicate last if odd
      next.push(sha256hex(left + right));
    }
    level = next;
  }

  return level[0]!;
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface MerkleResult {
  spaceId: string;
  root: string;      // hex SHA-256
  leafCount: number;
  computedAt: string; // ISO 8601
}

/**
 * Compute the Merkle root for a single space.
 *
 * Queries memories, entities, and edges from MongoDB (only `_id` and `seq` —
 * no payload data is read) and walks the file system for the file manifest.
 * All leaves are sorted before tree construction.
 */
export async function computeMerkleRoot(spaceId: string): Promise<MerkleResult> {
  const leaves: string[] = [];

  // ── Brain documents ────────────────────────────────────────────────────
  // Only (_id, seq) — no need to load payload data.
  for (const collType of ['memories', 'entities', 'edges', 'chrono'] as const) {
    const collName = `${spaceId}_${collType}`;
    const docs = await col<{ _id: string; seq: number }>(collName)
      .find(mFilter({}))
      .project({ _id: 1, seq: 1 })
      .toArray() as { _id: string; seq: number }[];

    for (const doc of docs) {
      leaves.push(sha256hex(`doc:${collType}:${doc._id}:${doc.seq}`));
    }
  }

  // ── File manifest ──────────────────────────────────────────────────────
  const files = await buildFileManifest(spaceId);
  for (const f of files) {
    leaves.push(sha256hex(`file:${f.path}:${f.sha256}`));
  }

  // Deterministic ordering
  leaves.sort();

  return {
    spaceId,
    root: merkleRoot(leaves),
    leafCount: leaves.length,
    computedAt: new Date().toISOString(),
  };
}
