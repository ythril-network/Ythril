import { HttpInterceptorFn, HttpRequest, HttpHandlerFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, from, switchMap, throwError } from 'rxjs';
import { MfaService } from './mfa.service';

/** HTTP method groups that can trigger an MFA challenge */
const MFA_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/**
 * MFA interceptor — functional style (Angular 17+ withInterceptors).
 *
 * When an admin-mutation request returns 403 with error MFA_REQUIRED or
 * MFA_INVALID:
 *   1. Prompt the user for a TOTP code (or use a cached one within the
 *      15-minute session window).
 *   2. Retry the original request with X-TOTP-Code header injected.
 *   3. On success, cache the code for the remainder of the window.
 *   4. On second failure (wrong code), invalidate cache and propagate the error.
 *
 * When MFA is disabled on the server, admin routes return 200 without
 * requiring this header — the interceptor is a no-op in that case.
 */
export const mfaInterceptor: HttpInterceptorFn = (req: HttpRequest<unknown>, next: HttpHandlerFn) => {
  const mfa = inject(MfaService);

  // Only ever inject TOTP headers on admin-mutation-style HTTP methods
  if (!MFA_METHODS.has(req.method)) {
    return next(req);
  }

  // If we have a valid cached code, attach it proactively
  const proactive = mfa.getCached();
  const outReq = proactive ? req.clone({ setHeaders: { 'X-TOTP-Code': proactive } }) : req;

  return next(outReq).pipe(
    catchError(err => {
      const errorCode: string = err?.error?.error ?? '';
      if (err.status !== 403 || (errorCode !== 'MFA_REQUIRED' && errorCode !== 'MFA_INVALID')) {
        return throwError(() => err);
      }

      // If we got MFA_INVALID, the cached code is stale — clear it
      if (errorCode === 'MFA_INVALID') mfa.invalidate();

      // Ask the user for a fresh code
      return from(mfa.prompt()).pipe(
        switchMap(code => {
          if (!code) {
            // User cancelled
            return throwError(() => err);
          }
          const retryReq = req.clone({ setHeaders: { 'X-TOTP-Code': code } });
          return next(retryReq).pipe(
            catchError(retryErr => {
              mfa.invalidate();
              return throwError(() => retryErr);
            }),
            // On success, cache the code
            switchMap(response => {
              mfa.cacheCode(code);
              return [response];
            }),
          );
        }),
      );
    }),
  );
};
