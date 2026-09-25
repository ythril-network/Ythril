/**
 * The test stack leaves the machine room to work: every service has a CPU and a memory ceiling, and the defaults
 * together stay within about half of the Docker VM (`Q-57`).
 *
 * Owner, 2026-09-25: *"you have to cap resources on test-instances. again my whole programs (especially vscode) were
 * killed"*. Nine containers carried memory ceilings that summed to 25 GB — more than the 24 GB the Docker VM is given
 * on the development machine — and no CPU ceiling at all, so a sync run took 602% CPU and the host's editor was killed
 * for memory. A ceiling per service is not enough on its own: nine ceilings each "reasonable" can still add up to
 * the whole machine, so the SUM of the defaults is the rule.
 *
 * Derived from the file, never a list: a service added to the stack without ceilings fails here.
 *
 * Run: node --test testing/standalone/the-test-stack-leaves-the-machine-room.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const FILE = readFileSync('testing/docker-compose.test.yml', 'utf8').replace(/\r\n/g, '\n');

/** The Docker VM on the development machine: `.wslconfig` gives it 16 processors and 24 GB. */
const VM_CPUS = 16;
const VM_GIB = 24;

/** Each service block under `services:`, by name. */
function services() {
  const lines = FILE.split('\n');
  const start = lines.indexOf('services:');
  const out = {};
  let name = null;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;                                   // the next top-level key ends `services:`
    const header = line.match(/^  ([a-z0-9-]+):\s*$/);
    if (header) { name = header[1]; out[name] = '\n'; continue; }
    if (name) out[name] += `${line}\n`;
  }
  return out;
}

/** A compose value, resolving `${VAR:-default}` to its default. */
const value = (block, key) => {
  const m = block.match(new RegExp(`\\n?    ${key}:\\s*["']?([^"'\\n]+)`));
  if (!m) return null;
  const v = m[1].trim();
  const d = v.match(/^\$\{[A-Z0-9_]+:-([^}]+)\}$/);
  return d ? d[1] : v;
};
const gib = (s) => {
  const m = String(s).match(/^([\d.]+)\s*([gmk])b?$/i);
  assert.ok(m, `unreadable memory value: ${s}`);
  return Number(m[1]) / ({ g: 1, m: 1024, k: 1024 * 1024 })[m[2].toLowerCase()];
};

describe('the test stack has ceilings', () => {
  const all = services();

  it('the file has the stack in it', () => {
    assert.ok(Object.keys(all).length >= 9, `found only ${Object.keys(all).join(', ')}`);
  });

  it('every service has a CPU ceiling and a memory ceiling', () => {
    const missing = Object.entries(all).filter(([, b]) => !value(b, 'cpus') || !value(b, 'mem_limit')).map(([n]) => n);
    assert.deepEqual(missing, [], 'these can take the whole machine');
  });

  it('together, by default, they leave at least half the CPUs and a third of the memory to everything else', () => {
    const cpus = Object.values(all).reduce((s, b) => s + Number(value(b, 'cpus') ?? VM_CPUS), 0);
    const mem = Object.values(all).reduce((s, b) => s + gib(value(b, 'mem_limit') ?? `${VM_GIB}g`), 0);
    assert.ok(cpus <= VM_CPUS / 2 + 0.5, `the default CPU ceilings sum to ${cpus} of ${VM_CPUS}`);
    assert.ok(mem <= (VM_GIB * 2) / 3, `the default memory ceilings sum to ${mem.toFixed(1)} GB of ${VM_GIB}`);
  });

  it('each ceiling can be raised for a bigger runner without editing the file', () => {
    const fixed = Object.entries(all)
      .filter(([, b]) => !/cpus:\s*["']?\$\{/.test(b) || !/mem_limit:\s*["']?\$\{/.test(b)).map(([n]) => n);
    assert.deepEqual(fixed, [], 'these ceilings are hard-coded');
  });
});
