/**
 * The operator's FULL RE-READ of a network, as an owed state per member and space (bundle-81, design rev 8 §7, D-20, decisions 26, 40, 47, 55).
 *
 * ## What it is for
 *
 * The first carry hands every 5.6 mark to its 6.0 twin by identity, so a record Q-278 shadowed under 5.6 (a record below an author-guarded mark that the reader
 * never saw) stays shadowed. The re-read is the one recovery: it forgets this network's receive mark and push mark for a space, so the next turns read and send it
 * again from the start, skipping every copy held by version. Its cost is D-20's: records that peers deleted and have since forgotten can come back.
 *
 * ## The state, and how it moves
 *
 * `fullRereadState[space]` on the member's row of THIS network (`config/types-networks.ts`): absent (nothing owed), `'owed'` (asked for, not begun), `'catching'`
 * (begun: the marks were forgotten and the pull is reading to the member's head). It is a repair mark, folded through `foldRepairMark`
 * (`sync/member-space-mark.ts`) like the two one-time re-reads, so no third hand-written loop over the networks.
 *
 *  - {@link requestFullReread} sets `'owed'` on every member of the network for each space asked (idempotent: a space already owed or catching is left alone).
 *  - {@link RereadSlot} lets ONE space per member and network begin at a time, so a re-read of many spaces costs at least one cycle per space (decision 47: an empty
 *    space is still visited once) and a member never reads the whole network from zero at once. A space that is `'owed'` while another is `'catching'` is
 *    exchanged as usual in the meantime, its own marks intact. A turn that could not begin (the space is held, or owes its positions) does not use the slot.
 *  - {@link beginFullReread} forgets the marks and sets `'catching'` in ONE config write, so a crash cannot leave a space catching with its marks intact (which would
 *    complete without having read anything).
 *  - {@link endFullReread} removes the state when a turn's legs finished: the pull reached the member's head (no cycle cap, no early stop) and so did the push.
 *    A capped turn is PARTIAL, never a member failure (`sync/watermark.ts`, decision 33), so a large re-read never shows its member as unreachable.
 *
 * A restore forgets the state with the receive marks (`RECEIVE_MARKS`): the restore re-reads anyway. The admin view lists it as `rereadOwed` (`networkAnswer`).
 */
import { getConfig, saveConfig } from '../config/loader.js';
import type { NetworkConfig, NetworkMember } from '../config/types.js';
import { foldRepairMark, readMemberSpaceMark, setMemberSpaceMark } from './member-space-mark.js';
import { mayExchangeNow } from './space-exchange-set.js';

export type FullRereadState = 'owed' | 'catching';
// (`NetworkMember.fullRereadState` is typed `Record<string, string>` like every per-space map; what it may hold is this.)

/** One owed re-read as the admin view lists it: which member, which of this instance's spaces, and how far it is. */
export interface RereadOwedRow { instanceId: string; space: string; state: FullRereadState }

const isState = (v: unknown): v is FullRereadState => v === 'owed' || v === 'catching';

/** Every re-read still owed on `net`, one row per member and space, in the order of the members and then of the network's spaces. Pure: it reads the config object it is handed. */
export function rereadOwedOf(net: Pick<NetworkConfig, 'members' | 'spaces'>): RereadOwedRow[] {
  const rows: RereadOwedRow[] = [];
  for (const m of net.members ?? []) {
    const marks = m.fullRereadState;
    if (!marks) continue;
    const order = [...(net.spaces ?? []), ...Object.keys(marks).filter(s => !(net.spaces ?? []).includes(s))];
    for (const space of order) if (isState(marks[space])) rows.push({ instanceId: m.instanceId, space, state: marks[space] });
  }
  return rows;
}

/**
 * Ask for the full re-read of `spaces` (local ids the network carries) of every member of network `networkId`. A space already owed or catching is left as it is, so asking
 * twice is one re-read. Written in ONE config save. Answers how many (member, space) pairs became owed now.
 */
export function requestFullReread(networkId: string, spaces: readonly string[]): number {
  const cfg = getConfig();
  const net = cfg.networks.find(n => n.id === networkId);
  if (!net) return 0;
  let started = 0;
  for (const m of net.members) {
    for (const space of spaces) {
      setMemberSpaceMark(cfg, m.instanceId, space, 'fullRereadState', { networkId }, (current) => {
        if (current !== undefined) return null;
        started++;
        return 'owed';
      });
    }
  }
  if (started > 0) saveConfig(cfg);
  return started;
}

/** The state of one member's space on one network, read from the LIVE config. */
export function fullRereadStateOf(networkId: string, memberId: string, spaceId: string): FullRereadState | undefined {
  const v = readMemberSpaceMark(networkId, memberId, spaceId, 'fullRereadState');
  return isState(v) ? v : undefined;
}

/**
 * Which turn of one member's exchange may BEGIN a re-read: one space at a time. Built when the member's exchange starts (it is open when none of the member's spaces is
 * `'catching'`) and handed each space's turn in order: {@link RereadSlot.phaseOf} answers `'continue'` for a space already catching, `'begin'` for the first owed one
 * while the slot is open, and nothing otherwise. A turn that actually begins calls {@link RereadSlot.begun}, which closes it for the rest of the exchange.
 */
export class RereadSlot {
  private open: boolean;
  constructor(private readonly networkId: string, private readonly member: Pick<NetworkMember, 'instanceId' | 'fullRereadState'>) {
    this.open = !Object.values(member.fullRereadState ?? {}).includes('catching');
  }
  phaseOf(spaceId: string): 'begin' | 'continue' | undefined {
    const state = fullRereadStateOf(this.networkId, this.member.instanceId, spaceId);
    if (state === 'catching') return 'continue';
    return state === 'owed' && this.open ? 'begin' : undefined;
  }
  begun(): void { this.open = false; }
}

/**
 * Begin the re-read of one space: forget this network's receive and push marks for it and set `'catching'`, in ONE config write. The next pull reads the member from
 * the start and the next push sends the space from the start.
 */
export function beginFullReread(networkId: string, memberId: string, spaceId: string): boolean {
  // Asks the hold first, like every write of a mark of a space (`every-space-the-data-loop-exchanges-comes-from-one-set`): a space removed or newly held since the turn
  // began is not touched, and the re-read stays owed.
  if (mayExchangeNow(networkId, memberId, spaceId)) {
    const cfg = getConfig();
    setMemberSpaceMark(cfg, memberId, spaceId, 'lastPosReceived', { networkId }, () => undefined);
    setMemberSpaceMark(cfg, memberId, spaceId, 'lastPosPushed', { networkId }, () => undefined);
    setMemberSpaceMark(cfg, memberId, spaceId, 'fullRereadState', { networkId }, () => 'catching');
    saveConfig(cfg);
    return true;
  }
  return false;
}

/** The re-read of a space finished: remove its state. Answers whether there was one. */
export function endFullReread(networkId: string, memberId: string, spaceId: string): boolean {
  return foldRepairMark(memberId, spaceId, 'fullRereadState', () => undefined, { networkId })?.before !== undefined;
}
