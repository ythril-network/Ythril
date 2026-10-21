/**
 * How a REST route settles the space a WRITE lands in (`Q-440`, rewritten by Q-531).
 *
 * A write names its space in the path, and that space is the one it lands in: a proxy that used to stand between the two is a personal view
 * now, and a view never writes. So the whole of "resolve the write target" is two refusals a route must make before anything else, once, here:
 *
 * - **the retired `targetSpace`** (`?targetSpace=`), refused BY NAME with its replacement on every write door, so an integrator who still
 *   sends it is told what to send instead of having the field silently ignored;
 * - **an id that is not a configured space** (an unknown id, another token's view, the caller's own view, a retired proxy id), answered by the
 *   one existence rule (`answerUnknownSpace`) - the owner of a view is told it is a view and where to write.
 *
 * The route's guard has already judged reach and the area rung on the space the path names, so this does not re-judge them. Returns the
 * space to write to, or `null` after answering.
 */
import type { Request, Response } from 'express';
import { answerLostSpace, answerUnknownSpace } from '../spaces/unknown-space.js';
import { retiredAddressingQueryError } from '../brain/retired-write-fields.js';

export function writeSpaceOf(req: Request, res: Response, spaceId: string): string | null {
  const retired = retiredAddressingQueryError(req.query);
  if (retired) { res.status(400).json({ error: retired }); return null; }
  return answeredUnknownSpace(req, res, spaceId) ? null : spaceId;
}

/**
 * The existence rule alone, for a door that has no `targetSpace` spelling (a delete, a read, a file route, a config route): `true` after
 * answering. The ONE REST wrapper of `answerUnknownSpace` - a route that names a space asks this and nothing else.
 */
export function answeredUnknownSpace(req: Request, res: Response, spaceId: string): boolean {
  const unknown = answerUnknownSpace(req, spaceId);
  if (!unknown) return false;
  res.status(unknown.status).json(unknown.body);
  return true;
}

/** Answer a space the route has already found missing (looked up itself, or lost between a plan and its write): never silent. */
export function sendLostSpace(req: Request, res: Response, spaceId: string): void {
  const lost = answerLostSpace(req, spaceId);
  res.status(lost.status).json(lost.body);
}
