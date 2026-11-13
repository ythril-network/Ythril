/**
 * A space act's answer on the wire: `{ status, body }` sends the body, `{ status, error, code? }` sends `{ error, code? }`.
 *
 * The acts behind the space routers (`spaces/schema-layers-acts.ts`, `spaces/schema-versions-acts.ts`) answer this shape so the MCP door can
 * translate the same result; a router only puts it on the wire. One function, so no router drops the `code` a refusal carries (the network
 * routers' `sendAct`, `api/networks/_shared.ts`, adds what only network acts answer: `204`, an upstream body, a deadline).
 */
import type { Response } from 'express';

/** What a space act answers. */
export type SpaceActAnswer =
  | { readonly status: number; readonly body: unknown }
  | { readonly status: number; readonly error: string; readonly code?: string };

/** Put `r` on the wire: its status, and its body or its refusal with the code when it carries one. */
export function sendSpaceActAnswer(res: Response, r: SpaceActAnswer): void {
  if ('error' in r) { res.status(r.status).json({ error: r.error, ...(r.code ? { code: r.code } : {}) }); return; }
  res.status(r.status).json(r.body);
}
