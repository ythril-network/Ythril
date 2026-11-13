/**
 * When CI's test stack fails, its log dump says why a container's process was killed: each container's OOMKilled flag and exit
 * code, and the kernel's out-of-memory lines.
 *
 * Bought by main's CI run 43499981804 (shard 2, 2026-11-13). The harness Mongo's runner log said only
 * `"error running command","error":"signal: killed","binary":"/usr/bin/mongod"`, and `compose ps` said `Exited (0)`. Every database
 * test after it failed on ECONNREFUSED 127.0.0.1:27117. Nothing in the dump could tell the out-of-memory killer from a stop from
 * outside, so the cause could only be guessed. The kernel log names the OOM kill and the cgroup it hit. `docker inspect` names the
 * container whose own process was killed.
 *
 * The dump action is the one every stack job of ci.yml runs (.github/actions/dump-test-stack-logs/action.yml). This reads its run
 * script with comment lines dropped, so a comment that mentions the commands cannot satisfy the check.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ACTION = fileURLToPath(new URL('../../.github/actions/dump-test-stack-logs/action.yml', import.meta.url));
const script = readFileSync(ACTION, 'utf8').split(/\r?\n/).filter(line => !/^\s*#/.test(line)).join('\n');

describe('the test stack dump says why a process was killed', () => {
  it('prints each container\'s OOMKilled flag and exit code from docker inspect', () => {
    assert.match(script, /docker inspect\b[^\n]*\.State\.OOMKilled/, 'the dump never reads a container\'s OOMKilled flag');
    assert.match(script, /docker inspect\b[^\n]*\.State\.ExitCode/, 'the dump never reads a container\'s exit code');
  });

  it('prints the kernel\'s out-of-memory lines, and a runner that refuses dmesg does not fail the dump', () => {
    const line = script.split('\n').find(l => /\bdmesg\b/.test(l));
    assert.ok(line, 'the dump never reads the kernel log');
    assert.match(line, /out of memory|oom/i, 'the kernel log is read without picking its out-of-memory lines');
    assert.match(line, /\|\|\s*true/, 'a runner that refuses dmesg would fail the dump step');
  });
});
