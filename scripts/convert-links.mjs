/**
 * Convert a space's array entries into link records — the operator's entry point for `M-2`.
 *
 * Usage, from the repo root, with the server built:
 *
 *     node scripts/convert-links.mjs --preview            # count what WOULD move, write nothing
 *     node scripts/convert-links.mjs --preview <spaceId>  # the same, one space
 *     node scripts/convert-links.mjs <spaceId>            # one space, and no marker is set
 *     node scripts/convert-links.mjs                      # every space this instance holds, and mark them
 *
 * **Start with `--preview`.** It reads and never writes, and it answers the question an operator actually
 * has before running a migration against live data: how much is there. Run it again afterwards — the link
 * count rises and nothing else moves.
 *
 * **Converting one space does not arm anything.** The marker that makes a space refuse array writes
 * (`completeLinkage`) is set only by a full run, per space, and only where that space's walk had no
 * failures. So a single-space run is a genuine pilot: the links are created, both surfaces keep working,
 * and every existing writer is unaffected.
 *
 * **And the marker is reversible.** It is an ordinary space setting — `PATCH /api/spaces/<id>` with
 * `{"completeLinkage": false}` — and array writes are accepted again the moment it is off. The link records
 * a conversion created stay; they are not the thing being switched.
 *
 * Safe to run twice. A link's id is derived from the connection, so a second run recomputes the same ids,
 * finds them already stored, and writes nothing — which also means an interrupted run is fixed by running it
 * again rather than by working out where it stopped.
 *
 * It never removes an array. See `server/src/brain/links-conversion.ts` for why that is a rule and not a
 * conservative default.
 *
 * Reads the same `CONFIG_PATH` and `MONGO_URI` the server does, so point it at the instance you mean.
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const dist = (p) => pathToFileURL(path.join(process.cwd(), 'server', 'dist', p)).href;

const { loadConfig } = await import(dist('config/loader.js'));
const { connectMongo, closeMongo } = await import(dist('db/mongo.js'));
const { convertSpaceLinks, convertAllLinks, previewSpaceLinks, stampFileMetaSeqs } = await import(dist('brain/links-conversion.js'));

loadConfig();
await connectMongo();

const args = process.argv.slice(2);
const preview = args.includes('--preview');
const only = args.find(a => !a.startsWith('--'));

if (preview) {
  // Reads only. Deliberately the first branch and a separate exit: a preview that shares a line of the
  // conversion's control flow is a preview one edit away from writing.
  const { getConfig } = await import(dist('config/loader.js'));
  const spaces = only ? [{ id: only }] : getConfig().spaces.filter(s => !(s.proxyFor?.length > 0));
  try {
    for (const s of spaces) {
      const p = await previewSpaceLinks(s.id);
      const classes = Object.keys(p.records)
        .filter(k => p.records[k] > 0)
        .map(k => `${k}=${p.records[k]} recs/${p.entries[k]} entries`)
        .join(' ');
      console.log(`${p.spaceId}: ${classes || 'no arrays carry anything'} | link records now ${p.links}`
        + `${p.converted ? ' | completeLinkage IS SET' : ''}`);
    }
  } finally {
    await closeMongo();
  }
  console.log('\npreview only: nothing was written. `entries` is the CEILING on new links — an entry naming a '
    + 'record that no longer exists makes none, and two entries naming the same pair make one.');
  process.exit(0);
}

let reports;
try {
  if (only) {
    // One named space converts but is NOT marked complete: `completeLinkage` says every link in the space is
    // a record, and a single-space run is the shape an operator uses to try one first. Marking it from here
    // would let a partial pass answer for the whole instance.
    reports = [await convertSpaceLinks(only)];
  } else {
    reports = await convertAllLinks();
  }

  /*
   * THE SEQ STAMP RIDES HERE, and it used to ride inside `convertSpaceLinks`.
   *
   * Giving a pre-4.0 file record the `seq` it never had is a one-time migration over a collection that
   * REPLICATES, and the rule for those is that they migrate lazily — every instance would otherwise stamp
   * the same records with its own counter at whatever moment it restarted, and each would win the
   * last-writer-wins comparison against the others in turn. That was fine while `convertSpaceLinks` was
   * only ever reached from this script; `convertLinksOnBoot` then started calling it at every startup and
   * quietly turned it into exactly the boot migration its own docblock forbids.
   *
   * So it lives on the operator path, which is this file, and it covers BOTH branches from one place —
   * a second call inside the `if` above is the shape that lets one branch drift away from the other.
   */
  for (const r of reports) r.fileSeqsStamped = await stampFileMetaSeqs(r.spaceId);
} finally {
  await closeMongo();
}

let failed = 0;
for (const r of reports) {
  const scanned = Object.entries(r.scanned).map(([c, n]) => `${c}=${n}`).join(' ');
  console.log(`${r.spaceId}: ${scanned} | links added ${r.added} | failed ${r.failed}`
    + ` | file seqs stamped ${r.fileSeqsStamped ?? 0}`);
  failed += r.failed;
}
if (only) console.log('single space: completeLinkage was NOT set — run without an argument to mark the instance.');

// A non-zero exit on failures, so a run inside a deploy step does not report success over a partial walk.
process.exit(failed > 0 ? 1 : 0);
