/**
 * The compaction runs without a UAC prompt only through a copy an administrator alone can change (`Q-119`).
 *
 * Owner, 2026-09-28: *"is it possible to always allow or something?"* A scheduled task with highest privileges does
 * it, and it is also a door: a task that ran a file a normal user can edit would let that user run anything as
 * administrator. So the task must run the PROTECTED copy, the copy must be locked to Administrators and SYSTEM, the
 * elevated script must load nothing from a writable place and take no arguments, and the normal script must fall back
 * to UAC when the task is absent. The elevated half cannot run in CI, so this holds the structure that makes it safe.
 *
 * Run: node --test testing/standalone/the-compaction-task-runs-only-a-protected-copy.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const code = (f) => readFileSync(f, 'utf8').split('\n').filter(l => !l.trimStart().startsWith('#')).join('\n');
const install = code('scripts/docker-compact-install.ps1');
const elevated = code('scripts/docker-compact-elevated.ps1');
const compact = code('scripts/docker-compact.ps1');

describe('the task runs a protected copy, never the repo file', () => {
  it('the task action is the ProgramData copy', () => {
    assert.match(install, /\$target = Join-Path \$dir 'docker-compact-elevated\.ps1'/);
    assert.match(install, /-File `"\$target`"/, 'the task does not run the protected copy');
    assert.doesNotMatch(install, /-File `"\$source`"/, 'the task runs the repo file, which a normal user can edit');
  });

  it('the copy and its folder are locked to Administrators and SYSTEM, Users read-only', () => {
    for (const sid of ['S-1-5-32-544', 'S-1-5-18']) assert.match(install, new RegExp(`\\*${sid}:(\\(OI\\)\\(CI\\))?F`));
    assert.match(install, /\*S-1-5-32-545:(\(OI\)\(CI\))?RX/, 'Users must be read and execute only');
    assert.match(install, /\/inheritance:r/, 'an inherited looser ACL could leak write access in');
  });

  it('the task is on demand only, and the install refuses to run unelevated', () => {
    assert.doesNotMatch(install, /New-ScheduledTaskTrigger/, 'the task must have no trigger');
    assert.match(install, /-RunLevel Highest/);
    assert.match(install, /IsInRole\(\[Security\.Principal\.WindowsBuiltInRole\]::Administrator\)/);
    assert.match(install, /\[switch\]\$Uninstall/, 'there is no way to remove the task');
  });
});

describe('the elevated script can do one thing', () => {
  it('it takes no parameters and loads nothing', () => {
    assert.doesNotMatch(elevated, /\bparam\s*\(/i, 'an elevated script with parameters can be pointed anywhere');
    assert.doesNotMatch(elevated, /(^|\s)\.\s+['"$]|Import-Module|Invoke-Expression|\biex\b/im,
      'the elevated script loads code, which could come from a writable place');
  });

  it('it attaches the disk read-only and compacts nothing else', () => {
    assert.match(elevated, /'attach vdisk readonly'/);
    assert.match(elevated, /\$hit\.Name -eq 'docker_data\.vhdx'/, 'it must act only on a docker_data.vhdx');
  });
});

describe('the normal script prefers the task and falls back to UAC', () => {
  it('starts the task when installed, and asks UAC otherwise', () => {
    assert.match(compact, /Get-ScheduledTask -TaskName \$taskName -ErrorAction SilentlyContinue/);
    assert.match(compact, /Start-ScheduledTask -TaskName \$taskName/);
    assert.match(compact, /-Verb RunAs/, 'the UAC fallback is gone, so a machine without the task cannot compact');
  });
});
