/**
 * How many CPUs may this process actually use? The host's count, capped by the container's CPU quota.
 *
 * ## Why the host's count is the wrong answer in a container
 *
 * A container limited to one CPU on a 16-core node still sees 16 cores (`os.cpus()`, `nproc`), and anything that
 * sizes a thread pool from that puts sixteen threads on one CPU's worth of CFS quota, throttled for most of every
 * scheduling period. onnxruntime does exactly that by default for the local embedding model: measured in the test
 * stack's container (cpus: 1.0 on 16 cores) it took 640-698 ms per text with its default pool and 54-55 ms with one
 * thread, and a 1000-record seed no longer embedded inside a ten-minute wait. The quota IS visible from inside the
 * container, in the cgroup files read here; this is the one module that reads them (`local-inference-structure.test.js`).
 *
 * `os.availableParallelism()` already honours the quota on a recent runtime (libuv 1.49 and later read the cgroup;
 * the image's Node 22 answered 1 in that container), but not on an older one, and not in every cgroup layout. The
 * quota is read here regardless, and the smaller answer wins, so the result does not depend on which runtime the
 * operator happens to run.
 *
 * ## What it reads
 *
 *  - cgroup v2: `/sys/fs/cgroup/cpu.max`, `"<quota> <period>"`, or `"max <period>"` for no limit.
 *  - cgroup v1: `/sys/fs/cgroup/cpu/cpu.cfs_quota_us` and `cpu.cfs_period_us`, where a quota of `-1` is no limit.
 *
 * The answer is `min(host count, floor(quota / period))`, and never less than 1: a quota of half a CPU still runs one
 * thread. A missing file (not Linux, not a container, a cgroup version without that file), a reader that throws, or
 * text that does not parse is the host count. **It never throws**: the callers size a pool from it at start-up, and a
 * best-effort answer is worth more there than an exception about a file the operator never heard of.
 */
import fs from 'node:fs';
import os from 'node:os';

export interface CpuBudgetSources {
  /** Reads a file as UTF-8; default `fs.readFileSync`. Tests inject a fixed filesystem. */
  readFile?: (path: string) => string;
  /** The host's count; default `os.availableParallelism`. */
  availableParallelism?: () => number;
}

const CGROUP_V2_MAX = '/sys/fs/cgroup/cpu.max';
const CGROUP_V1_QUOTA = '/sys/fs/cgroup/cpu/cpu.cfs_quota_us';
const CGROUP_V1_PERIOD = '/sys/fs/cgroup/cpu/cpu.cfs_period_us';

/** A positive finite number, or null for anything else (an unlimited marker, garbage, zero). */
function positive(text: string | undefined): number | null {
  if (text === undefined || !/^\d+$/.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** quota / period, or null when either is absent, unlimited or unparseable. */
function ratio(quota: string | undefined, period: string | undefined): number | null {
  const q = positive(quota);
  const p = positive(period);
  return q !== null && p !== null ? q / p : null;
}

/** The quota in CPUs, or null when there is none this process can see. Tries v2 first, then v1. */
function cgroupQuota(readFile: (path: string) => string): number | null {
  const attempt = (fn: () => number | null): number | null => {
    try { return fn(); } catch { return null; }
  };
  const v2 = attempt(() => {
    const [quota, period] = readFile(CGROUP_V2_MAX).trim().split(/\s+/);
    return ratio(quota, period);
  });
  if (v2 !== null) return v2;
  return attempt(() => ratio(readFile(CGROUP_V1_QUOTA).trim(), readFile(CGROUP_V1_PERIOD).trim()));
}

export function availableCpus({
  readFile = (p) => fs.readFileSync(p, 'utf8'),
  availableParallelism = () => os.availableParallelism(),
}: CpuBudgetSources = {}): number {
  let host: number;
  try { host = Math.floor(availableParallelism()); } catch { host = 1; }
  if (!Number.isFinite(host) || host < 1) host = 1;
  const quota = cgroupQuota(readFile);
  const capped = quota === null ? host : Math.min(host, Math.floor(quota));
  return Math.max(1, capped);
}
