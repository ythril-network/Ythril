/**
 * The embed-origin allowlist, over the admin API — so granting a portal permission to frame this instance does not
 * require shell access to the server.
 *
 * ## Why this route exists
 *
 * `embed.allowedOrigins` has worked since the embedding feature shipped, and it lived only in `config.json`. Asked
 * for by the canary operator 2026-08-19T1046Z, whose case is the one the file-only shape does not serve:
 *
 *   > someone runs a brain, someone else wants to use it inside a portal, and the person who must act has to be
 *   > talked through editing a JSON file on a server.
 *
 * In practice that does not happen and the brain stays in a browser tab. Their portal already reads the resolved
 * list from the public `GET /api/theme` to decide whether to frame a brain at all, which is the half that works
 * today; what was missing is a way for the brain's operator to say yes.
 *
 * ## One validator, two dispositions — and that is deliberate
 *
 * `isValidEmbedOrigin` is the single rule, shared with the config-file path. A second copy in this route, or in the
 * client, would be the defect `CLAUDE.md` names as this repo's most frequent — and here the weaker copy would be
 * deciding who may frame and restyle the admin UI.
 *
 * What differs is what happens to a bad entry, and it differs because the situations differ:
 *
 * | path | bad entry | why |
 * |---|---|---|
 * | `config.json` | dropped, with a warning | nobody is waiting on an answer; refusing would fail the whole boot |
 * | this route | **400, naming it** | somebody typed it and is watching. Dropping it silently would report success |
 *
 * Silently accepting-and-dropping is the shape that produced the unscoped-token defect: a caller told 201 while the
 * field they sent went nowhere. A form must never do that.
 *
 * ## What this route does NOT do, at their request as much as ours
 *
 * No wildcard mode. No per-user list. And no way for a non-admin token to extend it — their words, which are better
 * than ours: *an origin allowlist that any authenticated caller could extend is not an allowlist.* Hence
 * `requireAdminMfa` on the write, the same bar as the media/model configuration, because listing an origin grants
 * framing AND restyling together and both are spoofing primitives.
 *
 * ## No restart, and no reload call here either
 *
 * `saveConfig` updates the in-memory config, the CSP `frame-ancestors` header is rebuilt by
 * `frameAncestorsDirective()` on every response, and `GET /api/theme` resolves the list per request. So the change
 * is live on the next request with nothing to restart and nothing to invalidate.
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin, requireAdminMfa } from '../auth/middleware.js';
import { getConfig, saveConfig } from '../config/loader.js';
import { getAllowedEmbedOrigins, isValidEmbedOrigin } from '../config/embed.js';

export const embedConfigRouter = Router();

/**
 * `.strict()` for the same reason every credential body has it: an unknown key here is a caller who thinks they
 * are setting something. `POST {allowedOrigin: 'https://x'}` — singular — would otherwise answer 200 having
 * changed nothing.
 */
export const EmbedConfigBody = z.object({
  allowedOrigins: z.array(z.string()).max(64),
}).strict();

/**
 * Both lists, because they answer different questions.
 *
 * `allowedOrigins` is what is stored — what the operator typed. `resolved` is what the CSP header and `/api/theme`
 * actually serve. They differ when `config.json` holds an entry the validator drops, and an operator looking at a
 * portal that will not frame needs to see exactly that difference rather than one list that might be either.
 */
embedConfigRouter.get('/', requireAdmin, (_req, res) => {
  const stored = getConfig().embed?.allowedOrigins ?? [];
  const configured = Array.isArray(stored) ? stored : [];
  const resolved = getAllowedEmbedOrigins();
  res.json({
    allowedOrigins: configured,
    resolved,
    invalid: configured.filter(entry => !isValidEmbedOrigin(entry)),
  });
});

embedConfigRouter.patch('/', requireAdminMfa, (req, res) => {
  const parsed = EmbedConfigBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'Body must be {"allowedOrigins": ["https://portal.example.com"]} and nothing else.',
      detail: parsed.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`),
    });
    return;
  }

  // Refused, not dropped. See the table in the header: the caller is watching, so silence would be a lie.
  const invalid = parsed.data.allowedOrigins.filter(entry => !isValidEmbedOrigin(entry));
  if (invalid.length > 0) {
    res.status(400).json({
      error: 'Every entry must be an exact, scheme-qualified origin with no path — https only, except on '
        + 'localhost. Wildcards are never accepted; there is no "allow everything" mode.',
      invalid,
    });
    return;
  }

  /*
   * Normalised through `new URL().origin` and de-duplicated, so what is stored is what the CSP header and the
   * postMessage check compare against. Without this, `https://portal.example.com/` would be stored with its
   * trailing slash, served normalised, and an operator comparing the two would see a mismatch that is not one.
   */
  const origins = [...new Set(parsed.data.allowedOrigins.map(entry => new URL(entry.trim()).origin))];

  const config = getConfig();
  config.embed = { ...config.embed, allowedOrigins: origins };
  saveConfig(config);

  // The audit middleware records `config.embed.update`; the response carries the stored list so a UI does not have
  // to re-read to know what it now says.
  res.json({ allowedOrigins: origins, resolved: getAllowedEmbedOrigins() });
});
