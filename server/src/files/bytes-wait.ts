/**
 * How long a file record may wait for its bytes before this instance stops waiting — ONE figure for the two places that wait (bundle-70, Q-337).
 *
 * ## What it prevents
 *
 * A record can arrive before its bytes: a metadata-first pull, a restore or an import (the rows come back, the bytes may never), a stray row an
 * older release left in `<space>_filemeta`. The stray drain (`sync/stray-filemeta-drain.ts`) waited `WAIT_DAYS` for such bytes, and the
 * absent-bytes sweep (`files/absent-bytes-sweep.ts`) waits the same for a record that never recorded any, for every record of a space restored or
 * imported within it, and as its ceiling on the evidence of peers' legs. Two literals would drift, and the documented "30 days" with them
 * (the doc-cited-constants gate reads this export).
 */

/** Days a record may wait for its bytes. */
export const WAIT_DAYS_FOR_BYTES = 30;

/** {@link WAIT_DAYS_FOR_BYTES} in milliseconds. */
export const WAIT_FOR_BYTES_MS = WAIT_DAYS_FOR_BYTES * 86_400_000;
