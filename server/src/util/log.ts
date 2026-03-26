// Centralised logger — redacts Authorization header from all output.
// Maintains an in-memory ring buffer for the /api/about/logs endpoint.

const REDACTED = 'Bearer [redacted]';
const MAX_RING = 1000;
const _ring: string[] = [];

function redact(msg: string): string {
  return msg.replace(/Bearer\s+[A-Za-z0-9_.\-]+/gi, REDACTED);
}

function fmt(level: string, msg: string, meta?: unknown): string {
  const ts = new Date().toISOString();
  const base = `[${ts}] [${level}] ${redact(msg)}`;
  if (meta === undefined) return base;
  if (meta instanceof Error) return `${base} ${redact(meta.stack ?? meta.message)}`;
  return `${base} ${redact(JSON.stringify(meta))}`;
}

function emit(line: string): void {
  _ring.push(line);
  if (_ring.length > MAX_RING) _ring.shift();
}

export const log = {
  info: (msg: string, meta?: unknown) => { const l = fmt('INFO ', msg, meta); emit(l); console.log(l); },
  warn: (msg: string, meta?: unknown) => { const l = fmt('WARN ', msg, meta); emit(l); console.warn(l); },
  error: (msg: string, meta?: unknown) => { const l = fmt('ERROR', msg, meta); emit(l); console.error(l); },
  debug: (msg: string, meta?: unknown) => {
    if (process.env['DEBUG']) { const l = fmt('DEBUG', msg, meta); emit(l); console.log(l); }
  },
};

/** Return the last `n` log lines from the in-memory ring buffer. */
export function getLogLines(n: number): string[] {
  const clamped = Math.max(1, Math.min(n, MAX_RING));
  return _ring.slice(-clamped);
}
