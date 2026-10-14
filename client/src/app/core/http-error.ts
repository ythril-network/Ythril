/**
 * `httpErrorReason` and `withRequestId` live in `refusal-text.ts` now: the module that reads a failed request's body is
 * ONE (bundle-23, R6-14), and these two are its sentence-without-a-translation-service and its request-id rule.
 *
 * They are re-exported here because every error surface in the app imports them from this path. See the section on the
 * request id in `refusal-text.ts` (observability audit, lens 9): the server mints a correlation id per request, returns it as
 * `X-Request-Id` and logs it with every unhandled error, so a 5xx on screen has to carry the key to its log line.
 */
export { httpErrorReason, withRequestId } from './refusal-text';
