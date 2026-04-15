import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const thisFile = fileURLToPath(import.meta.url);
const scriptsDir = path.dirname(thisFile);

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (typeof result.status === 'number') return result.status;
  return 1;
}

let exitCode = 1;

if (process.platform === 'win32') {
  exitCode = run('powershell', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(scriptsDir, 'enable-networks-workstation.ps1'),
  ]);
} else {
  exitCode = run('bash', [path.join(scriptsDir, 'enable-networks-workstation.sh')]);
}

process.exit(exitCode);
