/**
 * Which server source files ACCEPT inline `edges` on a record write — derived from what they say, never listed.
 *
 * ## What it prevents
 *
 * "Every door that applies connections" was derived from one call, `applyConnections(`. The batch door plans a body's
 * connections through `connectionsOf(` and never calls it, so it was outside the set while the gate's title claimed
 * every door — a gate that never sees a subject cannot fail about it (`Q-170`). A door takes edges when it DECLARES the
 * field (`connectionSchemas(`), refuses its shape (`connectionInputError(`), knows its body key
 * (`CONNECTION_BODY_KEYS`), applies it (`applyConnections(`), plans it (`connectionsOf(`) or hands the body to the
 * batch door (`bulkWrite(` — not the driver's `.bulkWrite(`, and not the declaration). Two gates ask this
 * (`write-functions-guard-their-own-references`, `every-throw-out-of-the-connections-stage-is-wrapped`); one list means
 * a ninth spelling is added once.
 *
 * `brain/write-connections.ts` is the module that DEFINES these, not a door. Untracked files count: a door written in
 * the change under test is the one this most needs to see. Throws below its floor, so an empty listing is not a pass.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

/** A server source, comment-stripped: every match is the call, never a sentence explaining it. */
export const serverSource = (file) => stripComments(readFileSync(join(REPO_ROOT, file), 'utf8'));

const TAKES_EDGES = [
  /\bconnectionSchemas\(/, /\bconnectionInputError\(/, /\bCONNECTION_BODY_KEYS\b/, /\bapplyConnections\(/,
  /\bconnectionsOf\(/, /(?<![.\w])(?<!function )bulkWrite\(/,
];

/** Repo-relative paths, forward slashes. */
export function inlineEdgeDoorFiles() {
  return trackedSources('server/src', { floor: 100, untracked: true })
    .filter(f => !f.endsWith('brain/write-connections.ts'))
    .filter(f => { const s = serverSource(f); return TAKES_EDGES.some(re => re.test(s)); });
}
