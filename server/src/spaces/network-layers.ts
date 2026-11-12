/**
 * The network layers that apply to a space, in precedence: the one answer to "which networks send this space schema, and which wins".
 *
 * A leaf (it reads the config it is handed and imports nothing that writes), so both the effective-meta recompute (`effective-meta.ts`)
 * and the schema-snapshot writer (`schema-snapshot-store.ts`, which `updateSpace` calls) read one order without an import cycle through
 * `updateSpace`.
 */
import type { Config } from '../config/types.js';
import type { MetaLayer } from '../sync/replicated-meta.js';

/** The layers that apply to `spaceId`, highest precedence first: the operator's order, then the order joined. */
export function layersFor(cfg: Config, spaceId: string): MetaLayer[] {
  const space = cfg.spaces.find(s => s.id === spaceId);
  const carrying = cfg.networks.filter(n => n.spaces.includes(spaceId) && n.schemaLayers?.[spaceId]);
  const rank = (id: string) => {
    const i = space?.networkPrecedence?.indexOf(id) ?? -1;
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  // Stable: networks the operator did not rank keep config order, which is the order they were created or joined.
  return carrying
    .map((n, i) => ({ n, i }))
    .sort((a, b) => rank(a.n.id) - rank(b.n.id) || a.i - b.i)
    .map(({ n }) => ({ networkId: n.id, meta: n.schemaLayers![spaceId] }));
}
