import { col, mFilter, mUpdate } from '../db/mongo.js';
import { getConfig, saveConfig } from '../config/loader.js';
import { log } from './log.js';
import type { SpaceCounterDoc } from '../config/types.js';

/**
 * Returns the next monotonic sequence number for a space.
 * Safe for concurrent callers — uses findOneAndUpdate with $inc.
 */
export async function nextSeq(spaceId: string): Promise<number> {
  const counters = col<SpaceCounterDoc>('ythril_counters');
  const result = await counters.findOneAndUpdate(
    { _id: spaceId },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' },
  );
  if (!result) throw new Error(`Failed to increment sequence counter for space ${spaceId}`);
  return result.seq;
}

/**
 * Ensure the space counter is at least `minSeq`.
 * Called after receiving remote documents via sync so that subsequent local
 * writes always get a seq higher than any synced document.
 * Uses $max — only advances the counter, never decreases it.
 */
export async function bumpSeq(spaceId: string, minSeq: number): Promise<void> {
  await col<SpaceCounterDoc>('ythril_counters').updateOne(
    mFilter<SpaceCounterDoc>({ _id: spaceId }),
    mUpdate<SpaceCounterDoc>({ $max: { seq: minSeq } }),
    { upsert: true },
  );
}

/**
 * Detects the bind-mount / volume mismatch that occurs when `docker compose
 * down -v` wipes MongoDB but leaves config.json intact on the host bind-mount.
 *
 * Symptom: ythril_counters is empty (seq counter was in the wiped volume) yet
 * one or more network members carry a non-zero lastSeqReceived watermark from
 * the previous run.  Without this fix those networks would pull with a high
 * sinceSeq and silently miss every document whose seq falls below the stale
 * watermark.
 *
 * Safe to call at every startup: it is a no-op when ythril_counters is
 * non-empty (normal restart) or when all watermarks are already zero.
 */
export async function resetStaleWatermarksIfNeeded(): Promise<void> {
  const count = await col<SpaceCounterDoc>('ythril_counters').estimatedDocumentCount();
  if (count > 0) return; // MongoDB intact — nothing to do

  const cfg = getConfig();
  let changed = false;
  for (const net of cfg.networks) {
    for (const member of net.members) {
      if (member.lastSeqReceived && Object.keys(member.lastSeqReceived).length > 0) {
        member.lastSeqReceived = {};
        changed = true;
      }
    }
    // Also clear any pendingMember watermarks inside vote rounds
    for (const round of net.pendingRounds) {
      if (round.pendingMember?.lastSeqReceived && Object.keys(round.pendingMember.lastSeqReceived).length > 0) {
        round.pendingMember.lastSeqReceived = {};
        changed = true;
      }
    }
  }
  if (changed) {
    saveConfig(cfg);
    log.warn('Seq counters absent but watermarks were non-zero — reset all lastSeqReceived to 0 (bind-mount/volume mismatch recovery)');
  }
}
