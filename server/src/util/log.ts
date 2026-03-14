// Centralised logger — redacts Authorization header from all output.

const REDACTED = 'Bearer [redacted]';

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

export const log = {
  info: (msg: string, meta?: unknown) => console.log(fmt('INFO ', msg, meta)),
  warn: (msg: string, meta?: unknown) => console.warn(fmt('WARN ', msg, meta)),
  error: (msg: string, meta?: unknown) => console.error(fmt('ERROR', msg, meta)),
  debug: (msg: string, meta?: unknown) => {
    if (process.env['DEBUG']) console.log(fmt('DEBUG', msg, meta));
  },
};
