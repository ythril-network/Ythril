import type { BrainApi } from '../../core/brain-api.service';

/**
 * The Brain page's live-change stream: one SSE connection to the open space (F12), reopened with a fresh ticket when it drops.
 *
 * Moved out of `brain.component.ts`, which the size ratchet freezes, when personal views arrived: the stream is its own concern (it has
 * nothing to say about tabs or chips) and the page needed the lines. The page keeps WHAT a change does (the debounced refresh); this holds HOW
 * the connection is kept.
 *
 * EventSource cannot send an Authorization header, and a raw token in the URL leaks into logs, history and Referer, so every connection
 * mints a single-use `?ticket=` first. Because the ticket is single-use the browser's native auto-reconnect (which would replay the dead
 * ticket) is useless: on error the stream closes and reconnects itself with a FRESH ticket after a fixed backoff, only while the space it was
 * opened for is still the open one. The backoff and the guard keep a persistently failing stream to about one attempt per 3 s, never a request
 * storm, and stop it entirely once the user navigates away. A personal view is opened by its `@name` id, which the ticket and the path carry
 * URL-encoded.
 */
export class BrainLiveStream {
  static readonly RECONNECT_MS = 3000;
  private stream?: EventSource;
  private reconnectTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly deps: {
    brainApi: Pick<BrainApi, 'mintEventsTicket'>;
    /** The space the page has open now: a stream for any other is dropped. */
    activeSpaceId: () => string;
    /** One change event of `spaceId`, as the server named it (`entity.created`, `bulk`, ...). */
    onEvent: (spaceId: string, event: string) => void;
  }) {}

  /** (Re)open the stream for a space. */
  open(spaceId: string): void {
    this.close();
    if (typeof EventSource === 'undefined') return; // non-browser (SSR/test) environment
    if (!spaceId) return;
    this.connect(spaceId);
  }

  close(): void {
    clearTimeout(this.reconnectTimer);
    this.stream?.close();
    this.stream = undefined;
  }

  /** Mint a ticket, then open the stream. */
  private connect(spaceId: string): void {
    if (spaceId !== this.deps.activeSpaceId()) return; // space switched (or torn down) before we got here
    this.deps.brainApi.mintEventsTicket(spaceId).subscribe({
      next: ({ ticket }) => {
        if (spaceId !== this.deps.activeSpaceId()) return; // switched while minting: drop this ticket
        const url = `/api/brain/spaces/${encodeURIComponent(spaceId)}/events?ticket=${encodeURIComponent(ticket)}`;
        const es = new EventSource(url);
        es.onmessage = (e) => {
          let payload: { event?: string };
          try { payload = JSON.parse(e.data); } catch { return; }
          this.deps.onEvent(spaceId, payload.event ?? '');
        };
        es.onerror = () => {
          es.close();
          if (this.stream === es) this.stream = undefined;
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = setTimeout(() => this.connect(spaceId), BrainLiveStream.RECONNECT_MS);
        };
        this.stream = es;
      },
      // Mint failed (auth / rate limit / offline): stay closed; the next space switch retries. Not retried on a timer here to avoid
      // hammering the mint endpoint when auth is genuinely broken.
      error: () => { /* no-op */ },
    });
  }
}
