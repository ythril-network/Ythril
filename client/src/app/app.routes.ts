import { Routes } from '@angular/router';
import { authGuard } from './core/auth.guard';
import { setupGuard } from './core/setup.guard';

export const routes: Routes = [
  // Public routes
  {
    path: 'setup',
    canActivate: [setupGuard],
    loadComponent: () =>
      import('./pages/setup/setup.component').then(m => m.SetupComponent),
  },
  {
    path: 'login',
    loadComponent: () =>
      import('./pages/login/login.component').then(m => m.LoginComponent),
  },
  {
    path: 'oidc-callback',
    loadComponent: () =>
      import('./pages/oidc-callback/oidc-callback.component').then(
        m => m.OidcCallbackComponent,
      ),
  },

  // Protected shell (all main app pages live inside)
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./pages/shell/shell.component').then(m => m.ShellComponent),
    children: [
      { path: '', redirectTo: 'brain', pathMatch: 'full' },
      {
        path: 'brain',
        loadComponent: () =>
          import('./pages/brain/brain.component').then(m => m.BrainComponent),
      },
      {
        path: 'files',
        loadComponent: () =>
          import('./pages/files/file-manager.component').then(m => m.FileManagerComponent),
      },
      {
        path: 'files/conflicts',
        loadComponent: () =>
          import('./pages/files/conflicts.component').then(m => m.ConflictsComponent),
      },
      {
        path: 'settings',
        loadComponent: () =>
          import('./pages/settings/settings.component').then(m => m.SettingsComponent),
        children: [
          { path: '', redirectTo: 'tokens', pathMatch: 'full' },
          {
            path: 'tokens',
            loadComponent: () =>
              import('./pages/settings/tokens.component').then(m => m.TokensComponent),
          },
          {
            path: 'spaces',
            loadComponent: () =>
              import('./pages/settings/spaces.component').then(m => m.SpacesComponent),
          },
          {
            path: 'storage',
            loadComponent: () =>
              import('./pages/settings/storage.component').then(m => m.StorageComponent),
          },
          {
            path: 'networks',
            loadComponent: () =>
              import('./pages/settings/networks.component').then(m => m.NetworksComponent),
          },
          {
            path: 'mfa',
            loadComponent: () =>
              import('./pages/settings/mfa.component').then(m => m.MfaComponent),
          },
          {
            path: 'about',
            loadComponent: () =>
              import('./pages/settings/about.component').then(m => m.AboutComponent),
          },
        ],
      },
    ],
  },

  { path: '**', redirectTo: '' },
];
