import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { map, catchError, of } from 'rxjs';

/**
 * Redirects away from /setup if the instance is already configured.
 * Allows /setup through only when the server returns configured: false.
 */
export const setupGuard: CanActivateFn = () => {
  const http = inject(HttpClient);
  const router = inject(Router);

  return http.get<{ configured: boolean }>('/api/setup/status').pipe(
    map(({ configured }) => configured ? router.createUrlTree(['/login']) : true),
    catchError(() => of(true)),
  );
};
