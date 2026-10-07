/**
 * The module-resolution hook behind `no-packages.mjs`: a bare specifier that is not a Node built-in does not resolve.
 *
 * ## What it prevents
 *
 * "This script runs where nothing was installed" is a claim about every module the script reaches, directly or through
 * the shared modules it imports, and the only way to check it is to run the script in that condition. This repository's
 * advisory CI job calls `scripts/test-times.mjs --summary` without an `npm ci`, so one `import` of a package (a YAML
 * reader, to learn a workflow's job names) anywhere under it turns the run's own summary page into a failed step, in CI only.
 * A test cannot delete `node_modules` out from under a checkout it shares, and a copied tree drifts from the real one; a hook
 * that refuses the package imports does the same thing to the same code.
 *
 * Relative, absolute, `file:`, `data:` and `node:` specifiers, and the built-ins' bare names (`fs`), resolve as they always do.
 */
import { isBuiltin } from 'node:module';

const NOT_A_PACKAGE = /^(?:\.{1,2}\/|\/|[A-Za-z]:[\\/]|file:|data:|node:)/;

export async function resolve(specifier, context, nextResolve) {
  if (!NOT_A_PACKAGE.test(specifier) && !isBuiltin(specifier)) {
    throw new Error(`no-packages: ${specifier} is a package, and nothing is installed here (imported from ${context.parentURL ?? 'the entry point'})`);
  }
  return nextResolve(specifier, context);
}
