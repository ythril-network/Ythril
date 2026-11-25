/**
 * An RFC 9457 problem body: the one way a door outside `/api` answers a refusal (bundle-271, Q-758; design §3, §5 "errors: RFC 9457 on
 * /ld/"). Extracted at its second site: the `/ld/` placeholder wrote it by hand, and the Linked Data addresses (`api/linked-data.ts`) answer
 * every refusal with it.
 *
 * ## What it prevents
 *
 * - **A problem body without its media type.** The body is JSON as every error answer is, and `application/problem+json` says it is a
 *   problem; `res.json` keeps a Content-Type already set, so the type is set first, here, where no caller can leave it out.
 * - **Two shapes of one refusal.** `type`, `title`, `status` and `detail` are the RFC's members; `error` (the title) and `code` are the
 *   project's, beside them, so a client that reads `{error, code}` on `/api` reads them here too.
 */
import type { Response } from 'express';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json; charset=utf-8';

/** One refusal: its status, a short title, the sentence that says what to do, and its code. */
export interface Problem {
  status: number;
  title: string;
  detail: string;
  code?: string;
  /** Members of the problem beyond the RFC's and the project's (a format list, a wait). */
  extra?: Record<string, unknown>;
}

/** Answer `p` as an RFC 9457 problem body. */
export function sendProblem(res: Response, p: Problem): void {
  res.setHeader('Content-Type', PROBLEM_CONTENT_TYPE);
  res.status(p.status).json({
    type: 'about:blank', title: p.title, status: p.status, detail: p.detail, error: p.title,
    ...(p.code !== undefined ? { code: p.code } : {}), ...(p.extra ?? {}),
  });
}
