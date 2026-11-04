/**
 * The per-network cycle runner: what makes one sync cycle for a network at a time, counts every cycle, and hands a trigger the progress of
 * the run it joined. Split out of `sync/engine.ts`, which holds what a cycle DOES (`_runSyncForNetworkImpl`) and passes it in here, so this
 * module never imports the engine and the two cannot form a runtime cycle (`no-runtime-import-cycles`).
 *
 * What it prevents: a second cycle for a network competing for the bcrypt cache, MongoDB connections and peer sockets. A trigger that arrives
 * while a cycle runs joins it, and schedules exactly one follow-up (the coalescing and rerun-once behaviour is `./coalescing-runner.ts`).
 */
import { createCoalescingRunner } from './coalescing-runner.js';
import { DetachedWork } from '../util/detached-work.js';
import { log, peerText } from '../util/log.js';
import type { MemberResult, SyncVerdict } from './cycle-outcome.js';

export type NetworkCycleResult = { synced: number; errors: number; members: MemberResult[]; outcome: SyncVerdict['outcome'] };

/**
 * What a running cycle has done so far, for a trigger that stops waiting for it (Q-675). The runner makes one holder per run and hands it to
 * the cycle, which fills it in; a trigger reads the holder of the run it joined (`joinNetworkCycle`). `members` is the cycle's own list, live:
 * a reader copies it when it builds its answer. Absent until the cycle has read the network.
 */
export interface NetworkCycleProgress {
  /** The members whose turn has ended, with each one's outcome. */
  members?: readonly MemberResult[];
  /** How many members the network had when the cycle began. */
  membersTotal?: number;
}

/** One cycle's work for a network: it reads the network, fills the progress holder it is handed, and answers the cycle's result. */
export type NetworkCycle = (networkId: string, progress: NetworkCycleProgress) => Promise<NetworkCycleResult>;

const _syncRunner = createCoalescingRunner<NetworkCycleResult, NetworkCycleProgress>({
  onQueued: (id) => log.debug(`Sync cycle already running for network ${peerText(id)} — queuing rerun`),
  onRerun: (id) => log.debug(`Rerun requested for network ${peerText(id)} — starting`),
});

/** True while a sync cycle for the given network is in-flight. Cheap, in-memory; used by GET /api/spaces for a space's "syncing" chip. */
export function isNetworkSyncing(networkId: string): boolean {
  return _syncRunner.isRunning(networkId);
}

// Every cycle, network and single-peer alike, is counted here the moment it starts: the quiescence a test waits for, and what a shutdown
// waits for (bounded) before it closes the database (`runShutdown`, bundle-39 D5).
const cycles = new DetachedWork('sync cycle');
export function syncCyclesInFlight(): number { return cycles.size; }
export function syncCyclesSettled(ms: number): ReturnType<DetachedWork['settledWithin']> { return cycles.settledWithin(ms); }
export const inCycle = <T>(run: () => Promise<T>): Promise<T> => cycles.track(run());

/**
 * The job the runner runs for a network: one cycle, counted, handed the progress holder of its run. Shared by `runNetworkCycle` and `joinNetworkCycle`.
 * A declaration with a block body, not a curried arrow const: the housekeeping gates read a function by its declaration and its block, and a concise
 * `const f = (a) => (b) => …` is a function they cannot see, so the cycle's loops would have no root reaching them (`every-housekeeping-space-walk-is-isolated`).
 */
function cycleJob(networkId: string, cycle: NetworkCycle) {
  return (progress: NetworkCycleProgress): Promise<NetworkCycleResult> => inCycle(() => cycle(networkId, progress));
}

/**
 * Run a full cycle for a network. Concurrent triggers for the same network join the running cycle rather than starting another, and schedule
 * exactly one follow-up. Resolves with the result of the cycle the caller JOINED, not of any rerun.
 */
export async function runNetworkCycle(networkId: string, cycle: NetworkCycle): Promise<NetworkCycleResult> {
  return _syncRunner.run(networkId, cycleJob(networkId, cycle));
}

/**
 * {@link runNetworkCycle}, and with it the progress holder of the cycle the caller started or joined. A trigger that races the cycle
 * against a time bound reads the holder when the bound ends, to answer the members that had finished.
 */
export function joinNetworkCycle(networkId: string, cycle: NetworkCycle): { promise: Promise<NetworkCycleResult>; progress: NetworkCycleProgress } {
  return _syncRunner.join(networkId, cycleJob(networkId, cycle));
}
