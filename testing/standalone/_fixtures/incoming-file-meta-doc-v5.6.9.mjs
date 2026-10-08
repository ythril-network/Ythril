/**
 * The wire schema a PUBLISHED v5.6.9 server validates an arriving file's metadata with, frozen as a literal.
 *
 * ## What it is for
 *
 * A change to what a file's metadata sends must never be sent to a peer that predates it. A v5.6.9 receiver REFUSES a
 * document with a key it does not declare (`.strict()`: a stripped `parentFileId` would turn a chunk into a top-level
 * file), and it refuses one that lacks `tags`. So "what does this sender put on the wire for an older peer" is answered
 * by asking THIS schema, not the one in the tree under test: the schema in the tree is exactly the thing a change moves,
 * and a test that validated against it would agree with every change it should have caught.
 *
 * ## Why it is a literal, and why that is allowed
 *
 * A fixture that derived its expectations from the code under test would assert that the code equals itself. This file is
 * a COPY of `IncomingFileMetaDoc` as `git show v5.6.9:server/src/api/sync/_shared.ts` prints it (with `MAX_TAGS` and
 * `MAX_SYNC_SEQ` written out and `AuthorRefSchema` inlined), and it is never edited: a later release's schema is a new
 * fixture next to this one, because a peer running 5.6.9 is still on the network after it.
 */
import { z } from 'zod';

/** `MAX_SYNC_SEQ` of v5.6.9. */
const MAX_SYNC_SEQ = 2 ** 50;

/** `AuthorRefSchema` of v5.6.9. */
const AuthorRefSchema = z.object({
  instanceId: z.string().min(1),
  instanceLabel: z.string().min(1),
});

/** `IncomingFileMetaDoc` of v5.6.9 (`MAX_TAGS` was 100). */
export const IncomingFileMetaDocV569 = z.object({
  _id: z.string().min(1),
  spaceId: z.string().min(1),
  path: z.string().min(1),
  description: z.string().optional(),
  descriptionSource: z.enum(['generated', 'extracted']).optional(),
  tags: z.array(z.string()).max(100),
  properties: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  suppressEmbeddings: z.boolean().optional(),
  author: AuthorRefSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  seq: z.number().int().nonnegative().max(MAX_SYNC_SEQ),
  parentFileId: z.never().optional(),
}).strict();

/** The newest version this schema describes: a peer reporting this or any older version validates with it. */
export const FROZEN_FOR_VERSION = '5.6.9';
