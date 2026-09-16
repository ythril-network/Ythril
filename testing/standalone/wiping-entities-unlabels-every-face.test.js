/**
 * Emptying a space's entities must unlabel every face that pointed at one.
 *
 * ## The defect, and the direction it came from
 *
 * A face descriptor is a FILE-META record carrying `faceEmbedding` and, once labelled, `faceEntityId`. So
 * deleting the entities collection leaves every labelled face pointing at a person who no longer exists —
 * the label still renders, the link goes nowhere, and nothing reports it.
 *
 * `bulkDeleteEntities` did the cascade, as an `afterDelete` handed to `wipeSpaceCollection`. The MCP tool
 * never did: it calls `wipeSpace`, which `deleteMany`s each collection. Two implementations of one act, and
 * the five `DELETE .../<collection>` routes were the ones carrying the guard.
 *
 * **So the collapse at 5.0 would have deleted the correct half.** One capability, one shape — and the shape
 * that survived was the one missing the cascade. That is this repo's commonest defect arriving from the
 * unusual direction: usually the newer, narrower door is the weaker one; here it was the door being kept.
 *
 * ## Why a source gate rather than a behavioural one
 *
 * `face-label-cascade.test.js` drives the real thing against a live Mongo and covers the SINGLE-entity
 * delete. This asserts the wipe path calls the same cascade, which is a claim about one line in one
 * function, and it is the line that goes missing when somebody rewrites `wipeSpace`'s parallel deletes
 * into something tidier. The behavioural half is covered by the integration suite's wipe cases.
 *
 * Run: node --test testing/standalone/wiping-entities-unlabels-every-face.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { blockAfter } from './_structural-window.mjs';

const SRC = stripComments(readFileSync('server/src/spaces/lifecycle.ts', 'utf8'));

describe('wiping entities unlabels every face', () => {
  it('the wipe is still there to be checked', () => {
    // Comments stripped, so this cannot be satisfied by the docblock that explains the cascade — which is
    // exactly how a source gate passes while the code it describes is gone.
    assert.match(SRC, /export async function wipeSpace\(/,
      'wipeSpace has moved — re-anchor this gate rather than deleting it');
  });

  it('it calls the same cascade a single-entity delete calls', () => {
    const at = SRC.indexOf('export async function wipeSpace(');
    const body = blockAfter(SRC, at, 'the wipeSpace body');
    assert.match(body, /unlabelAllFaces\(spaceId\)/,
      'wiping entities must unlabel the faces that pointed at them, or every labelled face in the space '
      + 'is left pointing at a person who no longer exists');
  });

  it('and only when entities are among the types being wiped', () => {
    /*
     * The condition matters as much as the call. `types: ['facts']` must not strip labels off faces whose
     * people are still there — a cascade that runs unconditionally is a data-loss bug wearing the clothes
     * of a fix, and it would pass the assertion above.
     */
    const at = SRC.indexOf('export async function wipeSpace(');
    const body = blockAfter(SRC, at, 'the wipeSpace body');
    assert.match(body, /targets\.has\('entities'\)\s*\)?\s*(?:await )?unlabelAllFaces/,
      'the cascade must be guarded by entities being wiped — running it on any wipe would unlabel faces '
      + 'whose entities are untouched');
  });
});
