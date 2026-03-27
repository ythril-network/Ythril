import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';

/** Reject direct navigation to /oidc-callback without the required query params. */
export const oidcCallbackGuard: CanActivateFn = (route) => {
  const router = inject(Router);
  const params = route.queryParamMap;
  if (params.has('code') && params.has('state')) return true;
  if (params.has('error')) return true; // IdP error redirect — let component show the message
  return router.createUrlTree(['/login']);
};
