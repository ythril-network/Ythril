/**
 * The public names of this checkout, read from its tracked code, for the changelog rule that refuses an internal mechanism.
 *
 * ## What it prevents
 *
 * A list of public names kept by hand lags the code: a route renamed in a release is refused or admitted by the old
 * spelling until someone edits the list. {@link codeSurfaces} reads the server, the schema package and `scripts/` each time, so
 * the rule follows the code. The floors are inside: a checkout whose listing came back short throws and is never read as
 * "nothing is public".
 *
 * `_changelog-mechanisms.mjs` and this file are left out of the read: they carry the term list and their own names as
 * strings, and would make those public.
 */
import { readTrackedSources, SERVER_CODE_ROOTS } from '../testing/standalone/_sources.mjs';
import { surfacesOf } from './_changelog-mechanisms.mjs';

const OWN = ['scripts/_changelog-mechanisms.mjs', 'scripts/_changelog-surfaces.mjs'];

/** @param {{ root?: string }} [opts] the checkout to read, default this one */
export function codeSurfaces({ root } = {}) {
  const code = readTrackedSources(SERVER_CODE_ROOTS, { specs: false, floor: 200, root });
  const scripts = readTrackedSources(['scripts'], { ext: ['.mjs'], floor: 20, exclude: OWN, root });
  return surfacesOf([...code, ...scripts]);
}
