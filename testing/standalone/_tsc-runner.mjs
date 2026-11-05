/**
 * How a package script runs the TypeScript compiler: the ONE spelling, for the gates that read a script's steps.
 *
 * ## The question it answers
 *
 * *"Is this step of a package script the compiler run, and does it name the compiler by a bin link?"* The schema build gate
 * (`the-schema-package-builds-and-resolves-as-the-server-does.test.js`, the dist clean before the compile) and the bin-link gate
 * (`a-package-script-runs-its-own-typescript.test.js`) both ask it. A copy in each would drift the day the runner moves, and the
 * clean-before-compile check would then find no compile step at all.
 *
 * ## What it prevents
 *
 * A bare `tsc` (or `npx tsc`, `tsserver`) in a package script runs whatever `node_modules/.bin/tsc` points at, and the schema
 * package's `typescript-6` devDependency claims that bin too (Q-687). `scripts/tsc.mjs` resolves the workspace's own `typescript`.
 */

import { shellCommands } from '../_shared/ci-workflow.mjs';

/** A step that runs the compiler through `scripts/tsc.mjs`, from a workspace (`../scripts`) or the root (`scripts`). */
export const COMPILER_RUN = /^node\s+(?:\.\.\/)?scripts\/tsc\.mjs(?:\s|$)/;

/** A command word that reaches the compiler through a bin link: `tsc`, `tsserver`, `npx tsc`, `npm exec tsc`. */
const BIN_LINK_CALL = /(?:^|[\s;&|(])(?:(?:npx|npm\s+exec|pnpm\s+exec|yarn)\s+(?:--\s+)?)?(?:tsc|tsserver)(?=$|[\s;&|)])/;

/** The commands of `script` (split by the one splitter, `shellCommands`) that run the compiler through a bin link instead of `scripts/tsc.mjs`. */
export function binLinkCompilerSteps(script) {
  return shellCommands(script).filter(s => BIN_LINK_CALL.test(s));
}
