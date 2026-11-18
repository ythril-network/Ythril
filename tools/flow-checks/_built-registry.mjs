/**
 * The server's registries as the BUILD holds them: the tool registry, the rights tables and the capability map, behind one refusal.
 *
 * ## What it prevents
 *
 * A probe that reads the tool registry (`ALL_TOOLS`) and the rights tables out of `server/dist` and answers about a build nobody made from this
 * source: after an edit to `server/src` or `schema/src` the old build is still on disk and answers happily. `testing/_shared/stale-build.mjs`
 * is what the standalone runner uses to refuse that; here the same refusal is `cannot answer` (exit 2) with the command that makes the build,
 * never a verdict about the old one, and a missing build says the same.
 *
 * Why the build and not the source: a tool's `inputSchema` is a function that spreads shared schema builders and constants, and the rights
 * tables are typed arrays. Reading either from text would be a second parser of what the code already runs.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../../testing/standalone/_sources.mjs';
import { staleBuilds } from '../../testing/_shared/stale-build.mjs';
import { CannotAnswer } from './_verdict.mjs';

/** The schemas a tool's `inputSchema` is asked with: a space is a string, as the dispatcher's enum would make it. */
export const SPACE_SCHEMAS = Object.freeze({ requiredSpace: { type: 'string' }, optionalSpace: { type: 'string' } });

/**
 * `{ ALL_TOOLS, ROUTE_RIGHTS, TOOL_RIGHTS, NOT_AREA_SCOPED, capabilityMapModel }`, or `cannot answer` when a build is missing or older than its source.
 * The capability map is the project's one pairing of a tool with its REST route (`testing/standalone/_guide-tables.mjs`).
 */
export async function builtRegistry() {
  const stale = staleBuilds(REPO_ROOT);
  if (stale.length) throw new CannotAnswer(stale[0]);
  const url = (p) => pathToFileURL(join(REPO_ROOT, p)).href;
  const { ALL_TOOLS } = await import(url('server/dist/mcp/tools/index.js'));
  const { ROUTE_RIGHTS, TOOL_RIGHTS, NOT_AREA_SCOPED } = await import(url('server/dist/auth/space-rights.js'));
  const { capabilityMapModel } = await import(url('testing/standalone/_guide-tables.mjs'));
  if (!Array.isArray(ALL_TOOLS) || ALL_TOOLS.length < 30 || !ROUTE_RIGHTS.length || !TOOL_RIGHTS.length) {
    throw new CannotAnswer('the tool registry or the rights tables read too short: the build was not read');
  }
  return { ALL_TOOLS, ROUTE_RIGHTS, TOOL_RIGHTS, NOT_AREA_SCOPED, capabilityMapModel };
}
