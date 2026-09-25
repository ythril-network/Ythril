/**
 * Fetch a MODEL endpoint by the one rule for whether the request leaves the instance.
 *
 * A bundled or sidecar endpoint — loopback, or a bare service name with no dot (`isLocalModelEndpoint`) — is reached
 * with a plain `fetch`, because it is on this host or this cluster by construction. Anything else is egress and goes
 * through `ssrfSafeFetch` with the slot's private-address policy: DNS-resolved, IP-pinned, redirects re-validated.
 *
 * One function because the reranker wrote it inline and the assist model's fallback (`F-33`) would have been the
 * second and third copies: a local fallback such as `http://ollama:11434` is refused by the guarded fetch unless the
 * operator opened private addresses for the whole slot, which is the wrong switch for a sidecar.
 */
import { ssrfSafeFetch } from './ssrf.js';
import { allowPrivateForSlot, isLocalModelEndpoint, type EgressSlot } from '../config/model-egress-policy.js';

export function modelFetch(url: string, init: RequestInit, slot: EgressSlot): Promise<Response> {
  return isLocalModelEndpoint(url)
    ? fetch(url, init)
    : ssrfSafeFetch(url, init, { allowPrivate: allowPrivateForSlot(slot) });
}
