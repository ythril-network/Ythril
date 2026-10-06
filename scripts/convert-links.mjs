/**
 * Convert a space's 4.x array entries into link records — the manual entry point, for a space whose boot
 * conversion failed.
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
 * **It runs itself at boot from 5.0, and this is the manual entry point.** Every start converts each space
 * that is not yet marked. Reach for this when a space's boot conversion FAILED — its link reads are refused
 * until it has been walked cleanly, and the refusal names the space.
 *
 * **Converting one space does not mark it.** `completeLinkage` is set only by a full run, per space, and
 * only where that space's walk had no failures. The marker cannot be turned off again: with the 4.x arrays
 * removed in 5.0 there is no other shape for a space to be read through.
 *
 * **A space that cannot be converted does not stop the others, and the exit code says so.** Each space is converted on its
 * own; one that fails is NAMED with its reason, is not marked, and has its file seqs left unstamped, and the script exits
 * non-zero so a deploy step does not read a partial run as a clean one.
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
const { convertSpaceLinks, convertAllLinks, previewSpaceLinks, stampFileMetaSeqs, linkConversionConcerns, unreconciledReason } =
  await import(dist('brain/links-conversion.js'));
const { getConfig } = await import(dist('config/loader.js'));

loadConfig();

const args = process.argv.slice(2);
const preview = args.includes('--preview');
const only = args.find(a => !a.startsWith('--'));

/*
 * A NAMED space is looked up, not trusted: a proxy holds no records, so walking one finds nothing — and the
 * boot conversion and the array clear never treat one as a subject (`Q-78`). Refused by name, before any
 * connection, and with a non-zero exit so a wrapper script does not read it as a clean run.
 */
if (only) {
  const named = getConfig().spaces.find(s => s.id === only);
  if (named && !linkConversionConcerns(named)) {
    console.error(`'${only}' is a proxy space: it holds no records of its own, so it has no links to convert. `
      + 'Name one of its members instead.');
    process.exit(2);
  }
}

await connectMongo();

if (preview) {
  // Reads only. Deliberately the first branch and a separate exit: a preview that shares a line of the
  // conversion's control flow is a preview one edit away from writing.
  const spaces = only ? [{ id: only }] : getConfig().spaces.filter(linkConversionConcerns);
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
// Every space this run did NOT convert, each with its reason: what the output names and the exit code answers for.
let failedSpaces;
try {
  if (only) {
    // One named space converts but is NOT marked complete: `completeLinkage` says every link in the space is
    // a record, and a single-space run is the shape an operator uses to try one first. Marking it from here
    // would let a partial pass answer for the whole instance.
    try {
      const report = await convertSpaceLinks(only);
      reports = [report];
      failedSpaces = report.failed > 0 ? [{ spaceId: only, reason: unreconciledReason(report) }] : [];
    } catch (err) {
      // A space that could not be converted at all is named, with its reason: a stack trace names a line of ours.
      reports = [];
      failedSpaces = [{ spaceId: only, reason: err instanceof Error ? err.message : String(err) }];
    }
  } else {
    // Each space on its own: one that fails is named in `failedSpaces` and the others are still converted and marked.
    ({ reports, failedSpaces } = await convertAllLinks());
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
   *
   * NOT for a space that failed. A file's `seq` is what makes it page to a peer, and a space whose walk was partial is a
   * space the operator is about to run again: stamping its records now would hand them a counter value from a run that
   * did not finish. The output says so beside each such space.
   */
  const failedIds = new Set(failedSpaces.map(f => f.spaceId));
  for (const r of reports) {
    if (!failedIds.has(r.spaceId)) r.fileSeqsStamped = await stampFileMetaSeqs(r.spaceId);
  }
} finally {
  await closeMongo();
}

const failedIds = new Set(failedSpaces.map(f => f.spaceId));
for (const r of reports) {
  if (failedIds.has(r.spaceId)) continue;
  const scanned = Object.entries(r.scanned).map(([c, n]) => `${c}=${n}`).join(' ');
  console.log(`${r.spaceId}: ${scanned} | links added ${r.added} | failed ${r.failed}`
    + ` | file seqs stamped ${r.fileSeqsStamped ?? 0}`);
}
for (const f of failedSpaces) {
  console.error(`${f.spaceId}: FAILED (${f.reason}) | not converted, not marked | file seqs NOT stamped`);
}
if (failedSpaces.length > 0) {
  console.error(`\n${failedSpaces.length} space(s) were NOT converted: ${failedSpaces.map(f => f.spaceId).join(', ')}. `
    + 'Every other space was converted. A boot retries them, and so does running this again once the cause is fixed.');
}
if (only) console.log('single space: completeLinkage was NOT set — run without an argument to mark the instance.');

// A non-zero exit when a space was not converted, so a run inside a deploy step does not report success over a partial walk.
process.exit(failedSpaces.length > 0 ? 1 : 0);
