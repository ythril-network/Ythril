/**
 * One INSTANCE of a mesh, as a child process: its own config, its own harness database, its own copy of the server's singletons.
 * `a-fork-resolved-elsewhere-is-decided-here-mesh-db.test.js` starts three and carries rows between them.
 *
 * ## Why a child process
 *
 * The server's config, Mongo layer and engine are process singletons, and a test needs THREE instances whose authors, tombstone issuers and
 * deletion authorities differ. One process cannot be three instances; three processes each running `openPushDoor` (the real handlers over
 * the real Mongo layer, as every `-db` push test does) can. What crosses between them is what crosses on the wire: this instance SERVES its
 * rows with the local-only fields stripped, and RECEIVES another's page through its real push routes with the sender's peer identity, so the
 * receiver's own planner, writer and deletion authority decide, exactly as on a delivered page.
 *
 * ## What it does not do
 *
 * It carries no HTTP and no engine schedule: a "cycle" is `serve` on the sender and `receive` on the receiver, driven by the test.
 * The sync engine's own pull is covered by the pull-door tests; what these tests hold is what a receiver does with a fork tombstone it
 * declines, which is the receiving half and is identical for a push and a pull (`push-and-pull-decide-alike-db`).
 *
 * Protocol: one JSON object per line on stdin `{ rid, op, ...args }`, one `{ rid, result }` or `{ rid, error }` per line on stdout.
 * Environment: `MESH_SUITE` (the harness database slug; the instance id is `<suite>-receiver`), `MESH_SPACE`, `MESH_NETWORKS` (JSON).
 */
import readline from 'node:readline';
import { openPushDoor, peerToken } from './_push-door.mjs';
import { initForkFixtures, reviewDoors, rowsOf } from './_fork-kinds.mjs';

const SPACE = process.env.MESH_SPACE;
const door = await openPushDoor({
  suite: process.env.MESH_SUITE, networks: JSON.parse(process.env.MESH_NETWORKS ?? '[]'),
  spaces: [{ id: SPACE, label: 'Mesh', folders: [], meta: {} }],
});
await initForkFixtures();
const rd = await reviewDoors(door, SPACE);
const { stripLocalOnly } = await import('../../server/dist/sync/local-only-fields.js');
const { computeMerkleRoot } = await import('../../server/dist/brain/merkle.js');
const WIRE_TOMBSTONE = ['_id', 'type', 'spaceId', 'deletedAt', 'instanceId', 'seq', 'originalSeq'];

const ops = {
  wipe: async () => { await door.wipe(SPACE); return true; },
  seed: async ({ family, rows }) => { await door.coll(SPACE, family).insertMany(rows); return true; },
  serve: async ({ family }) => (await door.coll(SPACE, family).find({}).sort({ seq: 1, _id: 1 }).toArray()).map(r => stripLocalOnly({ ...r })),
  serveTombstones: async () => (await door.coll(SPACE, 'tombstones').find({}).toArray()).map(t => Object.fromEntries(WIRE_TOMBSTONE.filter(k => t[k] !== undefined).map(k => [k, t[k]]))),
  receive: async ({ from, family, docs }) => { const r = await door.push('/batch-upsert', { [family]: docs }, { spaceId: SPACE, token: peerToken(from) }); return { code: r.code, body: r.body }; },
  receiveTombstones: async ({ from, tombs }) => { const r = await door.push('/tombstones', { tombstones: tombs }, { spaceId: SPACE, token: peerToken(from) }); return { code: r.code, body: r.body }; },
  resolve: async ({ kind, forkId, keep }) => { const r = await rd.resolve.REST(kind, forkId, keep); return { ok: r.ok, status: r.status, sentence: r.sentence }; },
  list: async ({ kind }) => rowsOf((await rd.list.REST({ kind })).body).map(r => ({ forkId: r.forkId ?? r._id, orphaned: r.orphaned, resolvedElsewhere: r.resolvedElsewhere ?? [] })),
  has: async ({ family, id }) => (await door.coll(SPACE, family).countDocuments({ _id: id })) > 0,
  row: async ({ family, id }) => door.coll(SPACE, family).findOne({ _id: id }),
  root: async () => { const m = await computeMerkleRoot(SPACE); return m.root ?? m.hash ?? m; },
};

const rl = readline.createInterface({ input: process.stdin });
process.stdout.write(`${JSON.stringify({ ready: true })}\n`);
for await (const line of rl) {
  // `rid`, not `id`: an op's own arguments name records by `id`.
  const { rid, op, ...args } = JSON.parse(line);
  try { process.stdout.write(`${JSON.stringify({ rid, result: await ops[op](args) })}\n`); }
  catch (err) { process.stdout.write(`${JSON.stringify({ rid, error: String(err?.stack ?? err) })}\n`); }
}
await door.close();
process.exit(0);
