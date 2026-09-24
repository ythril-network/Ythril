import angular from '@analogjs/vite-plugin-angular';
import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';

/**
 * Client unit-test runner (Vitest + jsdom + the Angular compiler plugin).
 *
 * This exists specifically so change-detection changes (OnPush, and eventually zoneless — P5)
 * can be VERIFIED rather than shipped on a green build. OnPush's failure mode is a view that
 * silently stops updating after a state change; a production build cannot see that, so before
 * this harness there was no way to catch it except clicking through the UI by hand.
 */
export default defineConfig({
  plugins: [angular({ tsconfig: './tsconfig.spec.json' })],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['src/test-setup.ts'],
    include: ['src/**/*.spec.ts'],
    // Vitest's 5s default is tuned for plain unit tests. These are Angular TestBed specs: creating a
    // component compiles it, builds an injector and renders into jsdom, and 71 spec files run in
    // parallel forks contending for CPU. Individual tests were measured at 5063ms and 5729ms against
    // that 5000ms ceiling — passing alone, failing at random in a full run, and never the same test
    // twice.
    //
    // Raised rather than chased test-by-test: two different specs tipped over on consecutive runs, so
    // it is the ceiling that is wrong, not the tests. This matters more since `npm run preflight`
    // asks every push to run this suite — a gate that fails at random is one people stop trusting,
    // and then stop running.
    //
    // The cost is that a genuinely hung test now takes 20s to report instead of 5s. The suite
    // completes in ~9s when healthy, so that is a rare price for a stable signal.
    testTimeout: 20_000,
    // Same argument, one stage later: the POOL's shutdown deadline, not a test's.
    //
    // Twice on 2026-08-01 the suite reported `844 passed (844)` and then failed the run with
    // `Error: Failed to terminate worker` out of tinypool — a fork that had finished its file and had not
    // exited before the pool's destroy deadline. Both times it was under `npm run preflight`, which builds
    // the server and the client bundle first and leaves the machine loaded; two bare `vitest run` invocations
    // straight afterwards were clean. So this is the shutdown ceiling being wrong on a busy machine, exactly
    // as `testTimeout`'s 5 s ceiling was.
    //
    // The cost of raising it is that a genuinely wedged worker takes 30 s to report instead of 10 s, once,
    // at the very end of a run. The cost of leaving it is a gate that goes red at random with every single
    // test passing — and a gate people stop trusting is a gate they stop running.
    teardownTimeout: 30_000,
    /**
     * Worker THREADS, not forked processes.
     *
     * Raising `teardownTimeout` above fixed a fork that had not *exited* before the pool's deadline. It did not
     * fix the next thing: under `npm run preflight` — which builds the server and the client bundle first and
     * leaves the machine loaded — the run reported
     *
     *     Test Files  77 passed (77)
     *           Tests  855 passed (855)
     *     npm error code 3221225477
     *
     * `3221225477` is `0xC0000005`: a Windows **access violation**. A forked child was segfaulting during
     * teardown, *after* every test had passed, and npm turned that into a failed gate. No timeout can fix a
     * native crash, which is why the previous ceiling raise did not help. Two bare `vitest run` invocations
     * straight afterwards exited 0 with the same 855 — it needed the load to reproduce, and under preflight it
     * reproduced every time.
     *
     * Switching the pool to threads fixed it: two consecutive preflights green, 855/855 in both. The
     * per-file isolation this suite depends on is unchanged — `isolate` defaults to true for threads as well,
     * so each spec file still gets a fresh Angular test platform and TestBed. That was the constraint that
     * ruled out a shared/single worker (leaked TestBed state, NG0400 from a double-created platform); it does
     * not rule out threads.
     *
     * If this ever regresses, the exit code is the diagnosis — `3221225477` means the worker died rather than
     * a test failing, and the suite summary immediately above it will say so.
     */
    pool: 'threads',
    /**
     * A ceiling on worker threads, because the default is one per core less one — 15 on a 16-core dev machine.
     *
     * Each thread compiles Angular components and renders them into its own jsdom, and under `npm run preflight`
     * on 2026-09-24 that took the Windows node process to `FATAL ERROR: Zone Allocation failed - process out of
     * memory` and the machine with it. The same suite with two workers finished clean. Four keeps most of the
     * speed and bounds the memory to a number that does not depend on how many cores the machine happens to have.
     */
    maxWorkers: Math.min(4, Math.max(1, availableParallelism() - 1)),
    // Default per-file isolation (each spec file in its own fork) — so each file gets a fresh
    // Angular test platform and TestBed. A shared/single fork instead leaked TestBed state
    // between files (a component created by one file broke the next) and double-created the
    // platform (NG0400). Isolation is the correct model for Angular's global TestBed.
  },
});
