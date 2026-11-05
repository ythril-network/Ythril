#!/usr/bin/env node
/**
 * Runs the TypeScript compiler the calling workspace depends on: the `typescript` package resolved from the directory npm runs
 * the script in, with the arguments passed through and its exit status returned.
 *
 * ## The question it answers
 *
 * *"Which compiler builds this workspace?"* Its own `typescript` dependency, by package name, and never whatever
 * `node_modules/.bin/tsc` points at.
 *
 * ## What it prevents
 *
 * `.bin/tsc` is a link any installed package may claim. The schema package's `typescript-6` devDependency (an alias of
 * `typescript@6`, which the from-typescript entry is tested against) declares the same `tsc` and `tsserver` bins as the
 * `typescript` every workspace builds with, and npm links whichever it reaches last. An incremental `npm install` left
 * `.bin/tsc` on TypeScript 6 and the schema build failed (Q-687). An image build that ran `npm ci` with the schema's dev
 * dependencies could build the server with the wrong compiler too. A package script that says `node ../scripts/tsc.mjs`
 * resolves the compiler by package name, so no bin link can change which one runs. The gate
 * `a-package-script-runs-its-own-typescript` refuses a bare `tsc` in a package script.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const from = createRequire(join(process.cwd(), 'package.json'));
const compiler = from.resolve('typescript/bin/tsc');
const run = spawnSync(process.execPath, [compiler, ...process.argv.slice(2)], { stdio: 'inherit' });
if (run.error) throw run.error;
process.exit(run.status ?? 1);
