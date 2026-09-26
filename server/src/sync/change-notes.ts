/**
 * Change notes: a note that travels WITH a downward sync (`F-42`).
 *
 * Owner, 2026-09-26: *"it should be a flag on a directed sync (also braintree i guess) and not a scrape on files.
 * that way anyone can add notes when syncing downwards. in ui as well as on rest/mcp"* — and *"thats also an event
 * to webhook on if desired"*.
 *
 * ## What it is
 *
 * A short markdown note plus the spaces it concerns, sent from an instance to the members BELOW it: a pub/sub
 * publisher to its subscribers, a braintree node to its children. Nothing is written into a space; a receiver never
 * scans files for it. An operator attaches one to a sync (`POST /api/networks/:id/sync`, MCP `network_sync`), and the
 * structural changes a network carries draft their own (`queueGeneratedNote`) — a schema update, a space added.
 *
 * ## Why a queue, not a field on the sync request
 *
 * A note is queued per recipient and delivered in the member exchange (`deliverChangeNotes`, called from the
 * engine's governance step), then marked delivered for that member only. A member that is offline for a week gets
 * the note when it is back; a note sent with a sync that happened to reach nobody would otherwise be lost. The
 * exchange it rides is best-effort, so delivery never throws — a failed attempt stays queued for the next cycle.
 *
 * ## Why the receiver checks who sent it
 *
 * `POST /api/sync/networks/:id/change-notes` accepts a note only from THIS instance's upstream (`upstreamOf`): a
 * subscriber must not be able to put words in its publisher's mouth for the other subscribers, and a note is
 * something an operator acts on. Same rule, and the same function, as a space announcement.
 */
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { col, asFilter, asDoc } from '../db/mongo.js';
import { getConfig } from '../config/loader.js';
import type { NetworkConfig, NetworkMember } from '../config/types.js';
import { localToRemote, remoteToLocal } from './space-map.js';
import { peerSafeFetch } from './peer-fetch.js';
import { upstreamOf } from '../networks/network-spaces.js';
import { emitWebhookEvent } from '../webhooks/dispatcher.js';
import { log } from '../util/log.js';
import type { NetworkActResult } from '../networks/network-acts.js';

const COLLECTION = '_change_notes';
/** Kept per network and direction; the oldest delivered or received notes go first. */
const MAX_PER_NETWORK = 200;
/** Notes sent in one exchange: a member that was away for a long time catches up over several cycles. */
const MAX_PER_DELIVERY = 20;
export const MAX_NOTE_CHARS = 10_000;

export interface ChangeNote {
  _id: string;
  networkId: string;
  /** `out`: written here, for the members below. `in`: received from this instance's upstream. */
  direction: 'out' | 'in';
  note: string;
  /** LOCAL space ids on this instance (mapped from the network's ids on arrival). Empty = the whole network. */
  spaces: string[];
  /** Who wrote it: a token's name, or `generated` for a note a structural change drafted. */
  author: string;
  generated: boolean;
  createdAt: string;
  /** out: the members it has not reached yet. */
  pendingFor?: string[];
  /** out: the members that refused it as malformed (400) — taken off `pendingFor` so it cannot block the queue. */
  refusedBy?: string[];
  /** in: the instance that sent it, and when it arrived. */
  from?: string;
  receivedAt?: string;
}

/** The body a note travels in. Strict: an undeclared key is a protocol mismatch, not something to drop. */
export const IncomingChangeNotes = z.object({
  notes: z.array(z.object({
    id: z.string().uuid(),
    note: z.string().min(1).max(MAX_NOTE_CHARS),
    spaces: z.array(z.string().max(40)).max(100),
    author: z.string().max(200),
    generated: z.boolean(),
    createdAt: z.string().max(40),
  }).strict()).max(MAX_PER_DELIVERY),
}).strict();

/**
 * The members BELOW this instance in `net`: who a note written here goes to. A publisher's subscribers, a tree
 * node's children. Club, closed and democratic networks have no "below", so they have none.
 */
export function downwardMembers(net: NetworkConfig, selfId?: string): NetworkMember[] {
  if (net.type === 'pubsub') return net.members.filter(m => m.direction === 'push');
  // Only the tree needs this instance's own id, so only the tree reads config for it (as `networkRole` does).
  // Children only, by parent — NOT by `direction`: a temporary reparent stores the NEW PARENT with `push`, and
  // counting it as below sent this node's notes UP to it, where they were refused every cycle.
  if (net.type === 'braintree') {
    const self = selfId ?? getConfig().instanceId;
    return net.members.filter(m => m.parentInstanceId === self);
  }
  return [];
}

/** Why a note cannot be sent on `net` from here, or null. One sentence for both doors. */
export function changeNoteRefusal(net: NetworkConfig): string | null {
  if (net.type !== 'pubsub' && net.type !== 'braintree') {
    return `A change note travels with a downward sync, and a ${net.type} network has none: only pub/sub (publisher to subscribers) and braintree (parent to children) sync downward.`;
  }
  if (downwardMembers(net).length === 0) {
    return `This instance has no member below it in '${net.label}', so a change note would reach nobody: on a pub/sub only the publisher sends one, on a braintree only a node with children.`;
  }
  return null;
}

/**
 * Queue a note on `net` for every member below this instance. Refuses (returns the reason) rather than dropping
 * it when nobody is below, or when a named space is not one the network carries here.
 */
export async function queueChangeNote(
  net: NetworkConfig,
  input: { note: string; spaces?: readonly string[]; author: string; generated?: boolean },
): Promise<{ note: ChangeNote } | { refusal: string }> {
  const refusal = changeNoteRefusal(net);
  if (refusal) return { refusal };
  const text = input.note.trim();
  if (!text) return { refusal: 'A change note needs text.' };
  if (text.length > MAX_NOTE_CHARS) return { refusal: `A change note is at most ${MAX_NOTE_CHARS} characters; this one is ${text.length}.` };
  const spaces = [...new Set(input.spaces ?? [])];
  const foreign = spaces.filter(s => !net.spaces.includes(s));
  if (foreign.length) return { refusal: `The network '${net.label}' does not carry ${foreign.map(s => `'${s}'`).join(', ')} here.` };
  const note: ChangeNote = {
    _id: uuidv4(), networkId: net.id, direction: 'out', note: text, spaces, author: input.author,
    generated: input.generated === true, createdAt: new Date().toISOString(),
    pendingFor: downwardMembers(net).map(m => m.instanceId),
  };
  await col<ChangeNote>(COLLECTION).insertOne(asDoc<ChangeNote>(note));
  await prune(net.id, 'out');
  return { note };
}

/**
 * The `note` / `spaces` pair a sync trigger accepts, on both doors. Absent note = nothing to attach.
 * `spaces` without a `note` is refused rather than ignored: it can only mean the caller forgot the text.
 */
export const SyncNoteBody = z.object({
  note: z.string().max(MAX_NOTE_CHARS).optional(),
  spaces: z.array(z.string().min(1).max(40)).max(100).optional(),
}).strict();

/**
 * Attach a note to the sync `caller` is about to run on `net` — the ONE parser and refusal for both doors
 * (`POST /api/networks/:id/sync` and MCP `network_sync`), so neither can accept a note the other refuses.
 * Null when there is nothing to attach; otherwise the queued note, or the status and sentence to refuse with:
 * 400 for a malformed note, 409 when the network has nobody below this instance to receive it.
 */
export async function attachSyncNote(
  net: NetworkConfig, input: unknown, author: string,
): Promise<null | { queued: ChangeNote } | { status: 400 | 409; error: string }> {
  const parsed = SyncNoteBody.safeParse(input ?? {});
  if (!parsed.success) return { status: 400, error: parsed.error.message };
  const { note, spaces } = parsed.data;
  if (note === undefined) return spaces?.length ? { status: 400, error: '`spaces` names what a change note concerns; send it with a `note`.' } : null;
  const blocked = changeNoteRefusal(net);
  if (blocked) return { status: 409, error: blocked };
  const r = await queueChangeNote(net, { note, spaces, author });
  return 'refusal' in r ? { status: 400, error: r.refusal } : { queued: r.note };
}

/**
 * The note a schema update carried by a network sends down when its round passes (`F-42`, `Q-61`): who changed
 * which space, which types it added or changed, which other fields, and which types it left out that members KEEP.
 * Plain sentences: an operator reads it, and a webhook forwards it.
 */
export function metaChangeNote(
  proposer: string, networkLabel: string, spaceId: string,
  change: { fields?: readonly string[]; changedTypes?: readonly string[]; keptTypes?: readonly string[] },
): string {
  const lines = [`${proposer} updated the schema of '${spaceId}' in '${networkLabel}'.`];
  if (change.changedTypes?.length) lines.push(`Types added or changed: ${change.changedTypes.join(', ')}.`);
  const others = (change.fields ?? []).filter(f => f !== 'typeSchemas');
  if (others.length) lines.push(`Also changed: ${others.join(', ')}.`);
  if (change.keptTypes?.length) lines.push(`Left out of the new definition, and KEPT on every member (nothing is removed by a network update): ${change.keptTypes.join(', ')}. Retire them locally if you no longer use them.`);
  return lines.join('\n');
}

/**
 * Queue a note a structural change drafted, when this instance has anyone below it; otherwise nothing. Never
 * throws: its callers are a vote conclusion and a network edit, whose own work must not be lost to a note.
 */
export async function queueGeneratedNote(networkId: string, note: string, spaces: readonly string[]): Promise<void> {
  try {
    const net = getConfig().networks.find(n => n.id === networkId);
    if (!net || changeNoteRefusal(net)) return;
    const r = await queueChangeNote(net, { note, spaces, author: 'generated', generated: true });
    if ('refusal' in r) log.warn(`Network ${networkId}: generated change note not queued: ${r.refusal}`);
  } catch (err) {
    log.warn(`Network ${networkId}: generated change note not queued: ${err}`);
  }
}

/**
 * Send `member` the notes queued for it on `net`, in the order they were written, and mark each delivered for that
 * member only. Called from the member exchange; never throws, and a note that did not arrive stays queued.
 */
export async function deliverChangeNotes(net: NetworkConfig, member: NetworkMember, opts: () => RequestInit): Promise<void> {
  try {
    const below = downwardMembers(net).map(m => m.instanceId);
    const coll = col<ChangeNote>(COLLECTION);
    // A member that left, or is no longer below, is owed nothing: without this its notes read "waiting for N" for ever.
    await coll.updateMany(asFilter<ChangeNote>({ networkId: net.id, direction: 'out', pendingFor: { $elemMatch: { $nin: below } } }),
      { $pull: { pendingFor: { $nin: below } } } as never);
    if (!below.includes(member.instanceId)) return;
    const due = await coll.find(asFilter<ChangeNote>({ networkId: net.id, direction: 'out', pendingFor: member.instanceId }))
      .sort({ createdAt: 1 }).limit(MAX_PER_DELIVERY).toArray() as ChangeNote[];
    if (!due.length) return;
    const url = `${member.url}/api/sync/networks/${encodeURIComponent(net.id)}/change-notes`;
    const send = async (batch: ChangeNote[]): Promise<number> => {
      const resp = await peerSafeFetch(url, { ...opts(), method: 'POST', body: JSON.stringify({
        notes: batch.map(n => ({ id: n._id, note: n.note, spaces: n.spaces.map(s => localToRemote(net, s)), author: n.author, generated: n.generated, createdAt: n.createdAt })),
      }) });
      await resp.body?.cancel().catch(() => {});
      return resp.status;
    };
    const delivered = (ids: string[]) => coll.updateMany(asFilter<ChangeNote>({ _id: { $in: ids } }), { $pull: { pendingFor: member.instanceId } } as never);
    const status = await send(due);
    if (status >= 200 && status < 300) {
      await delivered(due.map(n => n._id));
      log.info(`Delivered ${due.length} change note(s) to ${member.label} on '${net.label}'`);
      return;
    }
    // A 400 says the BODY is wrong, and the receiver validates a batch whole — so one bad note would hold every note
    // behind it back for ever. Send them one by one instead: a note refused on its own is taken out of this member's
    // queue and recorded in `refusedBy`, and the rest go through. Any other status (an older peer with no route, a
    // 403, a 5xx) is about the member rather than a note, so everything stays queued for the next cycle.
    if (status !== 400) { log.warn(`Change notes to ${member.label} (${member.instanceId}) on '${net.label}': ${status}; kept for the next cycle`); return; }
    for (const n of due) {
      const one = await send([n]);
      if (one >= 200 && one < 300) { await delivered([n._id]); continue; }
      if (one !== 400) { log.warn(`Change notes to ${member.label} on '${net.label}': ${one}; the rest kept for the next cycle`); return; }
      await coll.updateOne(asFilter<ChangeNote>({ _id: n._id }), { $pull: { pendingFor: member.instanceId }, $addToSet: { refusedBy: member.instanceId } } as never);
      log.warn(`Change note ${n._id} on '${net.label}' was refused by ${member.label} (400) and will not be offered to it again`);
    }
  } catch (err) {
    log.warn(`Change notes to ${member.label} (${member.instanceId}) on '${net.label}': ${err}; kept for the next cycle`);
  }
}

/**
 * Store notes arriving from `fromInstanceId` on network `networkId`, and fire `change_note.received` once per space
 * each concerns (once with no space for a note about the whole network — the webhook is subscribed per space, so it
 * then goes to every space the network carries here). Only the upstream may send: anyone else is refused.
 * Re-delivery of a note already held is a no-op, so a sender that lost the answer can safely send it again.
 */
export async function receiveChangeNotes(
  networkId: string, fromInstanceId: string | undefined, body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const net = getConfig().networks.find(n => n.id === networkId);
  if (!net) return { status: 404, body: { error: 'Network not found' } };
  if (!fromInstanceId || upstreamOf(net) !== fromInstanceId) {
    return { status: 403, body: { error: 'Only the instance above this one in the network may send it change notes.' } };
  }
  const parsed = IncomingChangeNotes.safeParse(body);
  if (!parsed.success) return { status: 400, body: { error: parsed.error.message } };
  const coll = col<ChangeNote>(COLLECTION);
  let stored = 0;
  for (const n of parsed.data.notes) {
    if (await coll.findOne(asFilter<ChangeNote>({ _id: n.id }), { projection: { _id: 1 } })) continue;
    // Map to local ids, and keep only spaces this instance carries in the network: a name it does not carry is
    // the sender's business, not something to report as a local space.
    const spaces = n.spaces.map(s => remoteToLocal(net, s)).filter(s => net.spaces.includes(s));
    const doc: ChangeNote = {
      _id: n.id, networkId, direction: 'in', note: n.note, spaces, author: n.author, generated: n.generated,
      createdAt: n.createdAt, from: fromInstanceId, receivedAt: new Date().toISOString(),
    };
    await coll.insertOne(asDoc<ChangeNote>(doc));
    stored += 1;
    const entry = { id: doc._id, networkId, networkLabel: net.label, from: fromInstanceId, author: doc.author, generated: doc.generated, note: doc.note, spaces };
    for (const spaceId of spaces.length ? spaces : net.spaces) emitWebhookEvent({ event: 'change_note.received', spaceId, entry });
  }
  if (stored) await prune(networkId, 'in');
  return { status: 200, body: { received: parsed.data.notes.length, stored } };
}

/** Notes on `networkId`, newest first: `in` what arrived here, `out` what was written here and who it has not reached. */
export async function listChangeNotes(networkId: string, direction: 'in' | 'out', limit = 50): Promise<ChangeNote[]> {
  return col<ChangeNote>(COLLECTION).find(asFilter<ChangeNote>({ networkId, direction }))
    .sort({ createdAt: -1 }).limit(Math.min(Math.max(limit, 1), MAX_PER_NETWORK)).toArray() as Promise<ChangeNote[]>;
}

/**
 * `GET /api/networks/:id/change-notes` and MCP `network_change_notes`: one act, so both doors take the same
 * `direction` (default `in`, what arrived here) and `limit` (1-200, default 50) and refuse the same way.
 */
export async function changeNotesAct(id: string, direction: unknown, limit: unknown): Promise<NetworkActResult> {
  const net = getConfig().networks.find(n => n.id === id);
  if (!net) return { status: 404, error: 'Network not found' };
  const dir = direction === undefined || direction === null || direction === '' ? 'in' : direction;
  if (dir !== 'in' && dir !== 'out') return { status: 400, error: '`direction` is `in` (notes that arrived here) or `out` (notes written here).' };
  const n = limit === undefined || limit === null || limit === '' ? 50 : Number(limit);
  if (!Number.isInteger(n) || n < 1 || n > MAX_PER_NETWORK) return { status: 400, error: `\`limit\` is a whole number from 1 to ${MAX_PER_NETWORK}.` };
  return { status: 200, body: { networkId: net.id, direction: dir, notes: await listChangeNotes(net.id, dir, n) } };
}

/** Keep the newest MAX_PER_NETWORK per network and direction — but never drop an outgoing note still owed to someone. */
async function prune(networkId: string, direction: 'in' | 'out'): Promise<void> {
  const coll = col<ChangeNote>(COLLECTION);
  const old = await coll.find(asFilter<ChangeNote>({ networkId, direction })).sort({ createdAt: -1 })
    .skip(MAX_PER_NETWORK).project({ _id: 1, pendingFor: 1 }).toArray() as Pick<ChangeNote, '_id' | 'pendingFor'>[];
  const ids = old.filter(n => !(n.pendingFor?.length)).map(n => n._id);
  if (ids.length) await coll.deleteMany(asFilter<ChangeNote>({ _id: { $in: ids } }));
}
