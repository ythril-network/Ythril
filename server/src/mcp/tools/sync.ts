import type { ToolHandler, ToolContext, ToolResult, ToolSchemas } from './types.js';
import { getConfig } from '../../config/loader.js';
import { MIN_PEER_VERSION, peerFloorRefusal } from '../../sync/peer-floor.js';
import { unknownPeerRefusal } from '../../sync/peer-target.js';

export const list_peersTool: ToolHandler = {
  name: 'list_peers',
  description: 'List every peer instance this brain is connected to, flattened across all of its networks. '
    + 'Requires instance-admin rights. Read-only — it configures nothing and triggers nothing.\n\n'
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
    + 'An empty list means this instance is in no network, not that syncing failed.',
  admin: true,
  inputSchema: (_s: ToolSchemas) => ({ type: 'object', properties: {}, required: [], additionalProperties: false }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const listPeersCfg = getConfig();
    // Build a flat list of peers across all networks, scrubbing all
    // credential fields (tokenHash, inviteKeyHash must never be exposed).
    const peers = listPeersCfg.networks.flatMap(net =>
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
           * which is what `CLAUDE.md` asks for. REST puts it on each member for the same reason.
           */
          text: peers.length === 0
            ? 'No peers configured.'
            : JSON.stringify(peers),
        },
      ],
    };
  },
};

export const sync_nowTool: ToolHandler = {
  name: 'sync_now',
  description:
        'Run a sync cycle now instead of waiting for the schedule. Requires instance-admin rights.\n\n'
        + 'IT WAITS FOR THE CYCLE, so the reply is an outcome and not an acknowledgement: the transfers run '
        + 'inline and the text reports how many networks synced and how many errored. How long it takes '
        + 'depends on how far behind the peers are, so give it room — a peer with a large backlog is a slow '
        + 'call, not a hung one.\n\n'
        + 'THIS PARAGRAPH USED TO SAY THE OPPOSITE — "it does not wait for the data", and that a successful '
        + 'reply meant only "a cycle was started". If you built a poll loop against that, you were waiting '
        + 'for something that had already finished.\n\n'
        + 'WHAT IT STILL DOES NOT TELL YOU is whether every record is now in step. A cycle transfers what the '
        + 'watermarks say is outstanding and can be bounded per hop, so a clean run is not proof of a '
        + 'converged space — `list_peers` and its `lastSyncAt` / `consecutiveFailures` are how you see that.'
        + '\n\n'
        + 'SYNC IS ALREADY AUTOMATIC. Every network has a schedule, so this is for closing a gap you do not '
        + 'want to wait out: after fixing a peer that was unreachable, or before reading a space you have just '
        + 'been told was changed elsewhere. It is not something to call in a loop — a cycle that overlaps the '
        + 'scheduled one does no more work, it competes with it.\n\n'
        + 'PARAMETERS:\n'
        + '- `peerId` — an EXACT `instanceId` from `list_peers`. Never a URL and never a label. That one peer '
        + 'is synced across every network it belongs to. Omit it to run a full cycle for every network, which '
        + 'is the usual call.\n\n'
        + 'RESPONSE: what the cycle did — per network when you omit `peerId`, with a total. A peer that is '
        + 'unreachable is COUNTED as an error and the call comes back with `isError` set, so a clean reply is '
        + 'real evidence the peers answered. It also raises `consecutiveFailures` on that peer, which is where '
        + 'you see a peer that has been failing for a while rather than just now.\n\n'
        + 'THAT IS ALSO A CORRECTION: this said an unreachable peer does NOT make the call return an error, '
        + 'and that the call succeeding was not evidence any peer answered. Both were wrong — `isError` is '
        + 'set from the error count.',
  mutating: true,
  admin: true,
  inputSchema: (s: ToolSchemas) => ({
          type: 'object',
          properties: {
            peerId: {
              type: 'string',
              description: 'Exact instanceId of the peer to sync (must be a known member instanceId — never a URL). Omit to sync all networks.',
            },
          },
          required: [],
          additionalProperties: false,
        }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { args: a } = ctx;
    const peerId = a['peerId'] != null ? String(a['peerId']).trim() : null;
    const { runSyncForPeer, runSyncForNetwork } = await import('../../sync/engine.js');
    const syncCfg = getConfig();

    if (peerId) {
      // SEC-16, through the shared check. `POST /api/notify/trigger` takes the same argument since Q-20,
      // and a security rule with two implementations is how the weaker one ends up in charge.
      const refusal = unknownPeerRefusal(peerId);
      if (refusal) {
        return {
          content: [{ type: 'text' as const, text: `Error (${refusal.status}): ${refusal.error}` }],
          isError: true,
        };
      }
      const result = await runSyncForPeer(peerId);
      return {
        content: [{
          type: 'text' as const,
          text: result.notFound
            ? `Peer '${peerId}' not found in any network.`
            : `Sync complete: ${result.networksSynced} network(s) synced, ${result.errors} error(s).`,
        }],
        isError: result.errors > 0,
      };
    } else {
      // Sync all networks
      let totalSynced = 0; let totalErrors = 0;
      const lines: string[] = [];
      for (const net of syncCfg.networks) {
        const r = await runSyncForNetwork(net.id);
        totalSynced += r.synced;
        totalErrors += r.errors;
        lines.push(`${net.label}: ${r.synced} ok, ${r.errors} error(s)`);
      }
      return {
        content: [{
          type: 'text' as const,
          text: lines.length === 0
            ? 'No networks configured.'
            : lines.join('\n') + `\n\nTotal: ${totalSynced} synced, ${totalErrors} error(s).`,
        }],
        isError: totalErrors > 0,
      };
    }
  },
};
