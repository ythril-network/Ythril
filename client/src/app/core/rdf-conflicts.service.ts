import { Injectable, Injector, inject, signal } from '@angular/core';
import { NetworksApi } from './networks-api.service';
import { rdfConflictOf, type NetworkWithRdf } from './rdf-names';

/**
 * Whether a network contests a space's RDF base, for the screens outside the RDF names card (Q-942: the Overview's Networks panel draws
 * a short line linking to the card). The networks the caller reads are asked once per space shown, through the one question
 * {@link rdfConflictOf} asks.
 *
 * ## What it prevents
 *
 * - **A panel that cannot draw without the network.** The networks are asked through the injector when a space is shown; a host without
 *   them (a test of the Overview alone) draws no line, and nothing throws.
 * - **An answer drawn on the wrong space.** The answer is kept per space id; a space shown later reads its own.
 */
@Injectable({ providedIn: 'root' })
export class RdfConflicts {
  private readonly injector = inject(Injector);
  /** Per space id: does a network contest its base. Absent while unknown. */
  readonly contested = signal<Readonly<Record<string, boolean>>>({});

  /** Ask the networks again for `spaceId`. */
  load(spaceId: string): void {
    if (!spaceId) return;
    let api: NetworksApi | null = null;
    try { api = this.injector.get(NetworksApi); } catch { api = null; }
    // A host whose network service reads no list (a stand-in in a test of the page) draws no line.
    if (typeof api?.listNetworks !== 'function') return;
    api.listNetworks().subscribe({
      next: ({ networks }) => this.contested.update(all => ({ ...all, [spaceId]: rdfConflictOf(networks as NetworkWithRdf[], spaceId) !== null })),
      error: () => undefined,
    });
  }

  has(spaceId: string): boolean { return this.contested()[spaceId] === true; }
}
