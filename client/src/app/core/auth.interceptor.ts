import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';
import { Router } from '@angular/router';
import { AuthService } from './auth.service';
import { tokenMayReach } from './token-may-reach';

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  const token = auth.token();
  let out = req;
  // Only attach the bearer to same-origin requests — never leak credentials to
  // cross-origin endpoints (e.g. the OIDC IdP discovery/token endpoints). The rule is
  // `tokenMayReach`, shared with the download helper so the two cannot differ.
  if (token && tokenMayReach(req.url)) {
    out = req.clone({ setHeaders: { Authorization: `Bearer ${token}` } });
  }

  return next(out).pipe(
    catchError(err => {
      if (err.status === 401 && auth.isAuthenticated()) {
        auth.logout();
        router.navigate(['/login'], { queryParams: { reason: 'session_expired' } });
      }
      return throwError(() => err);
    }),
  );
};
