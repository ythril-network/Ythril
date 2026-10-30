import { visibleNetworks } from '../../auth/network-rights.js';
import type { ToolHandler, ToolContext, ToolResult, ToolSchemas } from './types.js';
import { getConfig } from '../../config/loader.js';
import { MIN_PEER_VERSION, peerFloorRefusal } from '../../sync/peer-floor.js';
import { unknownPeerRefusal } from '../../sync/peer-target.js';
import { attachSyncNote } from '../../sync/change-notes.js';
import { networkSyncOutcome, peerSyncOutcome, resolveSyncWait, syncTimeoutMs } from '../../sync/trigger.js';

export const network_peersTool: ToolHandler = {
  name: 'network_peers',
  description: 'List the peer instances of the networks you may see, flattened across them. A network is visible '
    + 'with `networks: read` on EVERY space it carries (an instance admin sees all of them); a token with no '
    + 'network rights gets an empty list. Read-only — it configures nothing and triggers nothing.\n\n'
    + 'ONE PEER APPEARS ONCE PER NETWORK IT BELONGS TO, not once overall. The same instance in two networks '
    + 'gives two rows with the same `instanceId` and different `network`/`networkId`. Deduplicate on '
    + '`instanceId` if you want distinct machines; keep the rows as they are if you care about which network a '
    + 'link belongs to, because the direction and the sync state are per network.\n\n'
    + 'IT IS THE SOURCE OF THE `instanceId` VALUES the sync-triggering tool wants — that one takes an exact '
    + 'instanceId and never a URL or a label, so copy it from here rather than typing it.\n\n'
    + 'NO CREDENTIALS ARE EVER RETURNED. Token hashes and invite-key hashes are stripped before the reply is '
    + 'built; there is no parameter that includes them and no other surface that exposes them.\n\n'
    + 'RESPONSE, per row: `instanceId` and `label` (who), `url` (where), `direction` (whether this link '
    + 'pushes, pulls or both), `network`/`networkId`/`networkType` (which network this row is about), '
    + '`lastSyncAt` (null if this pair has never synced), `consecutiveFailures` (0 when healthy — a climbing '
    + 'number is the signal that a peer is unreachable, and it is the field to check before blaming missing '
    + 'records on anything else), and `skipTlsVerify` (true means certificate checking is off for this peer, '
    + 'which is worth noticing on an audit).\n\n'
    + 'A space can also be HELD (a deletion or wipe is being applied on one side) or DECLINED (on pub/sub, the member left it); '
    + 'neither moves `consecutiveFailures`. When records are missing and failures are 0, the network\'s sync history lists them as held or declined.\n\n'
    + 'ALSO PER ROW: `version` (what that peer last reported, `null` if it never has), `minPeerVersion` '
    + '(the floor this instance requires, the same on every row) and `belowFloor` '
    + '(a sentence when this peer is refused on version grounds, `null` when it is fine). A peer below '
    + 'the floor does not sync DATA in either direction, so when records are missing and `consecutiveFailures` '
    + 'is 0 this is the field that says why. The envelope carries `minPeerVersion`, the floor this '
    + 'instance requires, so a refusal can be read without looking it up.' + '\n\n'
    + 'A `null` version means one of TWO things and `belowFloor` is what tells them apart: a peer that '
    + 'answered and named no version predates version reporting, so it IS refused; a peer this instance '
    + 'has never exchanged with is simply unknown, and is not refused on version grounds. Do not infer '
    + 'a verdict from `version` being null — read `belowFloor`.\n\n'
    + 'An empty list means no network you may see has peers — not that syncing failed.',
  // F-34: no longer instance-admin — it lists the networks this token may SEE (`networks: read` on every space
  // each carries), through the same filter as `GET /api/networks`. A token with no network rungs sees none.
  inputSchema: (_s: ToolSchemas) => ({ type: 'object', properties: {}, required: [], additionalProperties: false }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const listPeersCfg = getConfig();
    // Build a flat list of peers across all networks, scrubbing all
    // credential fields (tokenHash, inviteKeyHash must never be exposed).
    const peers = visibleNetworks({ ...(ctx.rights ? { rights: ctx.rights } : {}) }, listPeersCfg.networks).flatMap(net =>
      net.members.map(m => ({
        instanceId: m.instanceId,
        label: m.label,
        url: m.url,
        direction: m.direction,
        network: net.label,
        networkId: net.id,
        networkType: net.type,
        lastSyncAt: m.lastSyncAt ?? null,
        consecutiveFailures: m.consecutiveFailures ?? 0,
        skipTlsVerify: m.skipTlsVerify ?? false,
        /*
         * The floor's VERDICT, not only its input. An operator holding a version and a floor still
         * has to do the comparison, and 'absent means old' is the half they would get wrong — a null
         * version reads as 'unknown, probably fine' and actually means refused. So the sentence that
         * would be logged is the sentence reported, from the same function.
         */
        version: m.version ?? null,
        belowFloor: peerFloorRefusal(m.version, m.versionCheckedAt),
        minPeerVersion: MIN_PEER_VERSION,
      })),
    );
    return {
      content: [
        {
          type: 'text' as const,
          /*
           * A BARE ARRAY, and `minPeerVersion` rides on each row rather than on an envelope.
           *
           * Wrapping the array in `{ minPeerVersion, peers }` was the first attempt and CI refused it:
           * this tool's contract is a JSON array, asserted by `mcp.test.js` and described by its own
           * text as rows. An envelope is a breaking change to every caller that indexes the result,
           * bought for a constant.
           *
           * Per-row is also this tool's existing idiom — `network`, `networkId` and `networkType` are
           * already repeated on every row — and it keeps ONE spelling of the fact across both doors,
           * which is what the y-flows convention `convention-ythril-both-doors-same-parameters` asks for. REST puts it on each member for the same reason.
           */
          text: peers.length === 0
            ? 'No peers configured.'
            : JSON.stringify(peers),
        },
      ],
      /*
       * NAMED, and the refusal recorded above does not reach this.
       *
       * That decision is about the TEXT half: the array is this tool's contract, a caller indexes it,
       * and wrapping it breaks them. `structuredContent` must be an object and has never existed here,
       * so there is no caller to break — and answering in one half only is the defect the canary
       * operator reported against `filter`.
       *
       * Unconditional, including when `peers` is empty: the text says 'No peers configured.' in prose,
       * and a client reading the structured half gets `{ peers: [] }` rather than a sentence to parse.
       */
      structuredContent: { peers },
    };
  },
};

export const network_syncTool: ToolHandler = {
  name: 'network_sync',
  description:
        'Run a sync cycle now instead of waiting for the schedule. Requires instance-admin rights.\n\n'
        + 'IT WAITS FOR THE CYCLE BY DEFAULT (`wait`, default true here), so the reply is an outcome and not an '
        + 'acknowledgement: the transfers run inline and the text reports how many networks synced and how many '
        + 'errored. A network\'s wait is bounded by `timeoutMs` (default 30000, held between 1000 and 120000): '
        + 'past it the reply says the cycle is STILL RUNNING (`status: "timeout"`, `isError` set) — it was not stopped, '
        + 'and its outcome is in `network_sync_history`. A peer with a large backlog is a slow call, not a hung one, '
        + 'so raise `timeoutMs` for it. Pass `wait: false` to start the cycle and return at once, as '
        + '`POST /api/networks/:id/sync` does by default; every reply says the `wait` it used.\n\n'
        + 'THIS PARAGRAPH USED TO SAY THE OPPOSITE — "it does not wait for the data", and that a successful '
        + 'reply meant only "a cycle was started". If you built a poll loop against that, you were waiting '
        + 'for something that had already finished. And until `wait` and `timeoutMs` existed on this tool the wait '
        + 'had no bound at all.\n\n'
        + 'WHAT IT STILL DOES NOT TELL YOU is whether every record is now in step. A cycle transfers what the '
        + 'watermarks say is outstanding and can be bounded per hop, so a clean run is not proof of a '
        + 'converged space — `network_peers` and its `lastSyncAt` / `consecutiveFailures` are how you see that.'
        + '\n\n'
        + 'A space can also be HELD (a deletion or wipe is being applied on one side) or DECLINED (on pub/sub, the member left it); '
        + 'neither moves `consecutiveFailures`. When records are missing and failures are 0, the network\'s sync history lists them as held or declined.\n\n'
        + 'SYNC IS ALREADY AUTOMATIC. Every network has a schedule, so this is for closing a gap you do not '
        + 'want to wait out: after fixing a peer that was unreachable, or before reading a space you have just '
        + 'been told was changed elsewhere. It is not something to call in a loop — a cycle that overlaps the '
        + 'scheduled one does no more work, it competes with it.\n\n'
        + 'PARAMETERS:\n'
        + '- `peerId` — an EXACT `instanceId` from `network_peers`. Never a URL and never a label. That one peer '
        + 'is synced across every network it belongs to.\n'
        + '- `networkId` — sync that one network, like `POST /api/networks/:id/sync`. Send at most one of `peerId` '
        + 'and `networkId`; omit both to run a full cycle for every network, which is the usual call.\n'
        + '- `note` — a CHANGE NOTE (markdown, at most 10000 characters) that travels with this sync to the members '
        + 'BELOW this instance: a pub/sub publisher\'s subscribers, a braintree node\'s children. Needs `networkId`. '
        + 'Refused, and the sync not run, when the network has nobody below this instance (a club, closed or '
        + 'democratic network, or a subscriber). Queued per member and delivered in each member\'s next exchange, so '
        + 'a member that is offline gets it when it is back; each arrival fires the `change_note.received` webhook '
        + 'there. Same as the `{ note, spaces }` body of `POST /api/networks/:id/sync`.\n'
        + '- `spaces` — the network\'s spaces the note concerns, by this instance\'s ids. Only with `note`; omit it '
        + 'for a note about the whole network.\n'
        + '- `wait` — whether to run the cycle and report what it did (true) or start it and return at once (false). '
        + 'The ONE default that differs from REST: true on MCP, false on `POST /api/networks/:id/sync`, because an agent '
        + 'wants the outcome and a script wants the answer at once. Everything else is the same on both doors.\n'
        + '- `timeoutMs` — how long to wait for a NETWORK\'s cycle (default 30000, held to 1000-120000 and not refused '
        + 'outside it). A full cycle applies it per network. Ignored for `peerId`, whose cycle is bounded by that peer\'s own '
        + 'request timeouts; ignored with `wait: false`.\n\n'
        + 'RESPONSE: what the cycle did — per network when you omit `peerId`, with a total. A peer that is '
        + 'unreachable is COUNTED as an error and the call comes back with `isError` set, so a clean reply is '
        + 'real evidence the peers answered. It also raises `consecutiveFailures` on that peer, which is where '
        + 'you see a peer that has been failing for a while rather than just now.\n\n'
        + 'THAT IS ALSO A CORRECTION: this said an unreachable peer does NOT make the call return an error, '
        + 'and that the call succeeding was not evidence any peer answered. Both were wrong — `isError` is '
        + 'set from the error count.',
  mutating: true,
  admin: true,
  inputSchema: (_s: ToolSchemas) => ({
          type: 'object',
          properties: {
            peerId: {
              type: 'string',
              description: 'Exact instanceId of the peer to sync (must be a known member instanceId — never a URL). Omit to sync all networks.',
            },
            networkId: { type: 'string', description: 'Sync this one network. Not with `peerId`. Required for `note`.' },
            note: { type: 'string', maxLength: 10000, description: 'A change note that travels with this sync to the members below this instance. Needs `networkId`.' },
            spaces: { type: 'array', items: { type: 'string' }, maxItems: 100, description: 'The network\'s spaces (this instance\'s ids) the note concerns. Only with `note`.' },
            // NO `default` and NO `minimum`/`maximum`, deliberately: the dispatcher enforces this schema before the handler, so
            // a bound here would REFUSE a `timeoutMs` the REST route clamps. The defaults live in `sync/trigger.ts`.
            wait: {
              type: 'boolean',
              description: 'Run the cycle and report what it did (true) or start it and return at once (false). Default true on MCP — REST\'s `?wait=` defaults to false, the one default that differs between the doors. The reply says the `wait` it used.',
            },
            timeoutMs: {
              type: 'integer',
              description: 'How long to wait for a network\'s cycle, in ms (default 30000; held between 1000 and 120000, not refused outside them). Applied per network on a full cycle; ignored for `peerId` and with `wait: false`. Past it the reply is `status: "timeout"` and the cycle keeps running. The reply says the value that applied.',
            },
          },
          required: [],
          additionalProperties: false,
        }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { args: a } = ctx;
    const peerId = a['peerId'] != null ? String(a['peerId']).trim() : null;
    const networkId = a['networkId'] != null ? String(a['networkId']).trim() : null;
    // The door decides the default (`resolveSyncWait`): MCP waits unless told not to, and the same tool reached through the
    // generic REST door (`POST /api/network_sync`) answers as REST does. `timeoutMs` is clamped, never refused, by REST's function.
    const wait = resolveSyncWait(a['wait'], ctx.transport);
    const timeoutMs = syncTimeoutMs(a['timeoutMs']);
    const syncCfg = getConfig();
    const fail = (status: number, error: string): ToolResult => ({ content: [{ type: 'text' as const, text: `Error (${status}): ${error}` }], isError: true });

    if (peerId && networkId) return fail(400, 'Send `peerId` or `networkId`, not both: a sync has one subject.');
    if (!networkId && (a['note'] !== undefined || a['spaces'] !== undefined)) {
      return fail(400, 'A change note belongs to one network: send `networkId` with `note`.');
    }

    if (networkId) {
      // The same door as `POST /api/networks/:id/sync`, and the note goes through the same parser and refusal.
      const net = syncCfg.networks.find(n => n.id === networkId);
      if (!net) return fail(404, 'Network not found');
      const noteInput = a['note'] !== undefined || a['spaces'] !== undefined ? { note: a['note'], spaces: a['spaces'] } : undefined;
      const attached = await attachSyncNote(net, noteInput, ctx.actor?.tokenLabel ?? 'an instance admin');
      if (attached && 'error' in attached) return fail(attached.status, attached.error);
      const noteId = attached ? attached.queued._id : undefined;
      const answer = await networkSyncOutcome(net.id, { wait, timeoutMs, ...(noteId ? { noteId } : {}) });
      // A cycle that threw is answered by the dispatcher's own failure handling, as it was when the tool ran the cycle itself.
      if (answer.failure) throw answer.failure.err;
      const queued = noteId ? ` Change note ${noteId} queued for the members below.` : '';
      const status = answer.body.status;
      const synced = answer.detail?.synced ?? 0;
      const errors = answer.detail?.errors ?? 0;
      return {
        content: [{ type: 'text' as const, text: (status === 'triggered'
          ? `${net.label}: sync cycle started (wait: false) — not waited for; see network_sync_history for what it did.`
          : status === 'timeout'
            ? `${net.label}: the cycle is still running after ${timeoutMs} ms (it was not stopped); see network_sync_history for what it did.`
            : `${net.label}: ${synced} ok, ${errors} error(s).`) + queued }],
        // The body REST answers, whole: `wait` and (for a waited network) `timeoutMs` say what applied; `synced`/`errors` are there when the cycle finished.
        structuredContent: { ...answer.body },
        isError: status === 'timeout' || errors > 0,
      };
    }

    if (peerId) {
      // SEC-16, through the shared check. `POST /api/networks/peers/:peerId/sync` names the same subject,
      // and a security rule with two implementations is how the weaker one ends up in charge.
      const refusal = unknownPeerRefusal(peerId);
      if (refusal) {
        return {
          content: [{ type: 'text' as const, text: `Error (${refusal.status}): ${refusal.error}` }],
          isError: true,
        };
      }
      const answer = await peerSyncOutcome(peerId, { wait });
      if (answer.failure) throw answer.failure.err;
      if (answer.body.status === 'triggered') {
        return {
          content: [{ type: 'text' as const, text: `Sync cycle for peer '${peerId}' started (wait: false) — not waited for.` }],
          structuredContent: { ...answer.body },
        };
      }
      const result = answer.detail!;
      return {
        content: [{
          type: 'text' as const,
          text: result.notFound
            ? `Peer '${peerId}' not found in any network.`
            : `Sync complete: ${result.networksSynced} network(s) synced, ${result.errors} error(s)${(result.refused ?? 0) > 0 ? `, ${result.refused} member(s) too old to exchange with (pre-6.0)` : ''}.`,
        }],
        // `notFound` is carried EXPLICITLY rather than inferred from a sentence. It is the one
        // outcome a caller must branch on — a named peer that does not exist is not a sync that
        // did nothing — and it was readable only by matching English. `wait` says which kind of answer this is.
        structuredContent: { ...result, wait },
        isError: result.errors > 0,
      };
    } else {
      // Sync all networks: the same act per network, the wait and the bound applied to each.
      let totalSynced = 0; let totalErrors = 0; let stillRunning = 0;
      const lines: string[] = [];
      for (const net of syncCfg.networks) {
        const answer = await networkSyncOutcome(net.id, { wait, timeoutMs });
        if (answer.failure) throw answer.failure.err;
        const status = answer.body.status;
        if (status === 'triggered') lines.push(`${net.label}: cycle started`);
        else if (status === 'timeout') { stillRunning++; lines.push(`${net.label}: still running after ${timeoutMs} ms`); }
        else {
          const r = answer.detail!;
          totalSynced += r.synced ?? 0;
          totalErrors += r.errors;
          lines.push(`${net.label}: ${r.synced} ok, ${r.errors} error(s)`);
        }
      }
      const total = !wait ? `\n\nStarted ${lines.length} cycle(s) (wait: false) — not waited for.`
        : `\n\nTotal: ${totalSynced} synced, ${totalErrors} error(s)${stillRunning ? `, ${stillRunning} still running` : ''}.`;
      return {
        content: [{
          type: 'text' as const,
          text: lines.length === 0 ? 'No networks configured.' : lines.join('\n') + total,
        }],
        structuredContent: {
          synced: totalSynced, errors: totalErrors, networks: lines, wait,
          ...(wait ? { timeoutMs } : {}),
          ...(stillRunning ? { timedOut: stillRunning } : {}),
        },
        isError: totalErrors > 0 || stillRunning > 0,
      };
    }
  },
};
