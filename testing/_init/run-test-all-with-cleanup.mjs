import { spawnSync } from 'node:child_process';

function run(command) {
  const result = spawnSync(command, {
    stdio: 'inherit',
    shell: true,
    env: process.env,
  });

  if (result.error) {
    console.error(`Command failed to launch: ${command}`);
    console.error(result.error.message);
    return 1;
  }

  return result.status ?? 1;
}

function main() {
  console.log('Running full test suite (core)...');
  const testExit = run('npm run test:all:core');

  console.log('Running mandatory post-test cleanup...');
  const cleanupExit = run('npm run test:down:clean');

  if (testExit !== 0) {
    console.error(`Full test suite failed with exit code ${testExit}. Cleanup exit code: ${cleanupExit}.`);
    process.exit(testExit);
  }

  if (cleanupExit !== 0) {
    console.error(`Tests passed, but cleanup failed with exit code ${cleanupExit}.`);
    process.exit(cleanupExit);
  }

  console.log('Full test suite passed and cleanup completed.');
}

main();
