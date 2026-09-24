/**
 * Copy every JSON asset under `src/` into `dist/`, at the same relative path. Runs after `tsc` in `npm run build`.
 *
 * `tsc` emits JavaScript and nothing else, and the image ships `server/dist` only — so a data file the server reads
 * at runtime (the Schema Library entries the product ships, under `src/extractor/conversation/schemas/`) did not
 * exist in a running instance at all. Copied by walking `src/` rather than by a list, so a new asset ships by being
 * added; and an empty walk FAILS the build, because a copy step that finds nothing reports success exactly like one
 * that worked.
 */
import { readdirSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');
const dist = join(root, 'dist');

function* walk(dir) {
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) yield* walk(p);
    else if (d.name.endsWith('.json')) yield p;
  }
}

let copied = 0;
for (const file of walk(src)) {
  const out = join(dist, relative(src, file));
  mkdirSync(dirname(out), { recursive: true });
  copyFileSync(file, out);
  copied++;
}
if (copied === 0) {
  console.error('copy-src-assets: no JSON asset found under src/ — the shipped Schema Library entries would be missing at runtime');
  process.exit(1);
}
console.log(`copy-src-assets: ${copied} file(s) into dist/`);
