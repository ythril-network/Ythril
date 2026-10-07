/**
 * `node --import <this file's URL> script.mjs` runs the script as if no package were installed: any import of a non-built-in
 * package fails. The hook is `no-packages-loader.mjs`, which says why this exists.
 *
 * It registers on import, so it is only ever named by `--import` of a child process; a test that imported it would take the
 * packages away from its own process. `test-times-harness.mjs`'s `runTimesWithoutPackages` is the caller.
 */
import { register } from 'node:module';

register('./no-packages-loader.mjs', import.meta.url);
