/**
 * Wipe the bind-mounted per-instance config so the test stack boots a genuine
 * FIRST-RUN instance — exactly like CI, which starts from a fresh checkout with
 * empty config dirs (see .github/workflows/ci.yml).
 *
 * Why this matters: the instance's config.json is gitignored and lives on the host
 * via a bind mount (testing/sync/configs/<x> -> /config). `docker compose down -v`
 * removes Docker volumes but NOT this host bind mount, so a persisted config.json
 * makes the instance boot NON-first-run. That masks first-run-only bugs (e.g.
 * background workers that were gated on `!isFirstRun`) locally while CI — always
 * first-run — fails. Running this before `up` keeps local and CI in lockstep.
 *
 * `testing/_init/stack-down.mjs` (the one take-down of the stack, run first by `test:up`) wipes the configs of the instances whose container it
 * removed, and keeps those of an instance another session holds; this script, which runs after it, wipes all four. A start is refused while
 * anything of the stack is held, so by the time this runs nothing is.
 */
import fs from 'node:fs';
import path from 'node:path';

const instances = ['a', 'b', 'c', 'd'];
let removed = 0;
for (const x of instances) {
  const dir = path.join('testing', 'sync', 'configs', x);
  try {
    for (const f of fs.readdirSync(dir)) {
      fs.unlinkSync(path.join(dir, f));
      removed++;
    }
  } catch {
    // Directory may not exist yet — fine.
  }
}
console.log(`Test configs wiped (${removed} file(s)) — instances will boot first-run (CI parity).`);
