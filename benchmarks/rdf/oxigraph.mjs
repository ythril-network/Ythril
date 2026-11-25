/**
 * The Oxigraph side of the benchmark: bulk-load a dataset into a fresh store, then serve it.
 *
 * ## What this prevents
 *
 * - **A store left over from an earlier run.** `up` removes the container and the volume of its size before it
 *   loads, so every run starts from an empty store and the load time is a cold bulk load.
 * - **An unpinned engine.** The image is the digest in `pin.json`; `up` pulls by digest and refuses a pull
 *   that did not leave that digest in the local image list.
 * - **A server nobody stopped.** `down` removes the container and the volume; the running container is held
 *   in the docker booking only while it runs.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { docker, dockerOk, dockerPlain, pinnedImage, sleep, variantOf } from './env.mjs';

export const oxigraphNames = (size) => ({ container: `b271-oxigraph-${size}`, volume: `b271-oxigraph-${size}` });

export function statePath(work, name) {
  return join(work, 'state', `${name}.json`);
}

export function ensureImage(ref) {
  const digest = ref.slice(ref.indexOf('@') + 1);
  dockerOk(['pull', '--quiet', ref], { mem: 1 });
  const r = dockerPlain(['image', 'inspect', ref, '--format', '{{json .RepoDigests}}']);
  if (r.status !== 0 || !r.stdout.includes(digest)) throw new Error(`image ${ref} is not present by that digest after the pull`);
  return digest;
}

export async function oxigraphUp(work, size) {
  const variant = variantOf(work, size);
  const image = pinnedImage('oxigraph');
  const digest = ensureImage(image);
  const { container, volume } = oxigraphNames(size);
  oxigraphDown(size);
  dockerOk(['volume', 'create', volume]);

  const t0 = process.hrtime.bigint();
  const load = docker(['run', '--rm', '-m', '4g', '-v', `${volume}:/data`, '-v', `${variant.dir}:/in:ro`, image,
    'load', '--location', '/data', '--file', `/in/${basename(variant.file)}`], { mem: 4 });
  const loadMs = Number((process.hrtime.bigint() - t0) / 1_000_000n);
  if (load.status !== 0) throw new Error(`oxigraph load failed (${load.status}): ${load.stderr || load.stdout}`);

  dockerOk(['run', '-d', '--name', container, '-m', '4g', '-p', '127.0.0.1::7878', '-v', `${volume}:/data`, image,
    'serve', '--location', '/data', '--bind', '0.0.0.0:7878'], { mem: 4, hold: [container] });
  const port = dockerPlain(['port', container, '7878/tcp']).stdout.trim().split('\n')[0].split(':').pop();
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${url}/query`, { method: 'POST', headers: { 'content-type': 'application/sparql-query', accept: 'application/sparql-results+json' }, body: 'ASK {}' });
      if (res.ok) break;
    } catch { /* not listening yet */ }
    await sleep(500);
  }
  const state = { engine: 'oxigraph', size, url: `${url}/query`, container, volume, image, digest: `sha256:${digest.replace('sha256:', '')}`, loadMs, variant: variant.name, variantSha256: variant.sha256 };
  mkdirSync(join(work, 'state'), { recursive: true });
  writeFileSync(statePath(work, `oxigraph-${size}`), `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

export function oxigraphDown(size) {
  const { container, volume } = oxigraphNames(size);
  dockerPlain(['rm', '-f', container]);
  dockerPlain(['volume', 'rm', '-f', volume]);
}
