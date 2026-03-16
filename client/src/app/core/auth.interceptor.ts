import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';
import { Router } from '@angular/router';
import { AuthService } from './auth.service';

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  const token = auth.token();
  let out = req;
  if (token) {
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
