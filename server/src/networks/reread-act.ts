/**
 * The operator's full re-read of a network, as an act: `POST /api/networks/:id/reread` and MCP `network_reread` call this one function, so the doors cannot
 * differ in what they accept, refuse or answer (bundle-81, design rev 8 §7, D-20, decisions 18, 26, 39, 64).
 *
 * ## What it does
 *
 * It marks `spaces` (default: every space the network carries) as owed a full re-read from every member of the network (`sync/full-reread.ts`); the sync
 * engine then forgets this network's receive and push marks for one space per member per cycle and reads the space again from the start, skipping every copy held by
 * version. It starts nothing itself and moves no data. It is idempotent while one is owed.
 *
 * ## Who may, and what it costs
 *
 * An INSTANCE ADMINISTRATOR, with the second factor: REST through `requireAdminMfa` (`api/networks/crud.ts`), MCP by refusing (`mcp/tools/networks.ts`: this door has no
 * place for a code, so it says to use the web UI, as `view_copy` does). The act itself asks only for the administrator, so it cannot be reached from a door that
 * forgot the guard as anyone else. It names its cost in the refusal of a missing `confirm`: records that peers deleted and have since forgotten can come back
 * (D-20), and a space of N records takes at least ceil(N / 10,000) cycles, one space per member per cycle.
 */
import { z } from 'zod';
import { getConfig } from '../config/loader.js';
import { isInstanceAdmin } from '../auth/instance-admin.js';
import { requestFullReread, rereadOwedOf } from '../sync/full-reread.js';
import { MAX_SPACE_IDS } from '../util/request-bounds.js';
import { refusalOfParse } from '../util/log.js';
import type { NetworkActResult } from './network-acts.js';

/** The body of the re-read: the confirmation, and optionally which of the network's spaces. Declared once, so the REST route and the MCP tool read the same parameters. */
export const RereadBody = z.object({
  confirm: z.literal(true, { message: 'confirm: true is required. A re-read reads every record of the space from every member again; records peers deleted and have since forgotten can come back.' }),
  spaces: z.array(z.string().min(1)).min(1).max(MAX_SPACE_IDS).optional(),
}).strict();

/** The cost in words, once, for the refusal and the docs of both doors. */
export const REREAD_COST = 'about one cycle per 10,000 records per space, one space per member per cycle; records peers deleted and have since forgotten can come back';

/** Ask for the re-read of `networkId`. See the module header. */
export function rereadNetworkAct(caller: Parameters<typeof isInstanceAdmin>[0], networkId: string, input: unknown): NetworkActResult {
  if (!isInstanceAdmin(caller)) return { status: 403, error: 'Re-reading a network is for an instance administrator' };
  const net = getConfig().networks.find(n => n.id === networkId);
  if (!net) return { status: 404, error: 'Network not found' };
  const parsed = RereadBody.safeParse(input ?? {});
  if (!parsed.success) return { status: 400, error: refusalOfParse(parsed.error).error };
  const spaces = parsed.data.spaces ?? [...net.spaces];
  const unknown = spaces.filter(s => !net.spaces.includes(s));
  if (unknown.length > 0) return { status: 400, error: `The network does not carry ${unknown.length === 1 ? 'space' : 'spaces'} ${unknown.map(s => `'${s}'`).join(', ')}.` };
  const started = requestFullReread(net.id, spaces);
  return { status: 200, body: { status: 'owed', networkId: net.id, spaces, started, cost: REREAD_COST, rereadOwed: rereadOwedOf(getConfig().networks.find(n => n.id === net.id) ?? net) } };
}
