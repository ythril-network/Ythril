import { Routes } from '@angular/router';
import { authGuard } from './core/auth.guard';
import { setupGuard } from './core/setup.guard';
import { oidcCallbackGuard } from './core/oidc-callback.guard';
import { guardEveryPage } from './core/unsaved-edits';

/**
 * Every route that loads a page carries the unsaved-edits guard, added here by `guardEveryPage` rather than route by route, so a new
 * page cannot be left without asking whether a draft would be lost (Q-701; `testing/unsaved-edits-are-held.spec.ts`).
 */
export const routes: Routes = guardEveryPage([
  // Public routes
  {
    path: 'setup',
    title: 'titles.setup',
    canActivate: [setupGuard],
    loadComponent: () =>
      import('./pages/setup/setup.component').then(m => m.SetupComponent),
  },
  {
    path: 'login',
    title: 'login.signIn',
    loadComponent: () =>
      import('./pages/login/login.component').then(m => m.LoginComponent),
  },
  {
    path: 'oidc-callback',
    canActivate: [oidcCallbackGuard],
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
        title: 'nav.brain',
        loadComponent: () =>
          import('./pages/brain/brain.component').then(m => m.BrainComponent),
      },
      {
        path: 'files/conflicts',
        title: 'nav.conflicts',
        loadComponent: () =>
          import('./pages/files/conflicts.component').then(m => m.ConflictsComponent),
      },
      {
        path: 'schema-library',
        title: 'nav.schemaLibrary',
        loadComponent: () =>
          import('./pages/schema-library/schema-library.component').then(m => m.SchemaLibraryComponent),
      },
      {
        path: 'settings',
        loadComponent: () =>
          import('./pages/settings/settings.component').then(m => m.SettingsComponent),
        children: [
          { path: '', redirectTo: 'tokens', pathMatch: 'full' },
          {
            path: 'preferences',
            title: 'nav.settings',
            loadComponent: () =>
              import('./pages/settings/preferences.component').then(m => m.PreferencesComponent),
          },
          {
            path: 'tokens',
            title: 'nav.tokens',
            loadComponent: () =>
              import('./pages/settings/tokens.component').then(m => m.TokensComponent),
          },
          {
            path: 'spaces',
            title: 'nav.spaces',
            loadComponent: () =>
              import('./pages/settings/spaces.component').then(m => m.SpacesComponent),
          },
          {
            path: 'storage',
            title: 'nav.metrics',
            loadComponent: () =>
              import('./pages/settings/storage.component').then(m => m.StorageComponent),
          },
          {
            path: 'networks',
            title: 'nav.networks',
            loadComponent: () =>
              import('./pages/settings/networks.component').then(m => m.NetworksComponent),
          },
          {
            path: 'audit-log',
            title: 'nav.logs',
            loadComponent: () =>
              import('./pages/settings/audit-log.component').then(m => m.AuditLogComponent),
          },
          {
            path: 'data',
            title: 'nav.data',
            loadComponent: () =>
              import('./pages/settings/data.component').then(m => m.DataComponent),
          },
          {
            path: 'webhooks',
            title: 'nav.webhooks',
            loadComponent: () =>
              import('./pages/settings/webhooks.component').then(m => m.WebhooksComponent),
          },
          {
            path: 'embedding',
            title: 'nav.embedding',
            loadComponent: () =>
              import('./pages/settings/embedding.component').then(m => m.EmbeddingComponent),
          },
          {
            path: 'about',
            title: 'nav.about',
            loadComponent: () =>
              import('./pages/settings/about.component').then(m => m.AboutComponent),
          },
          {
            path: 'help',
            title: 'nav.help',
            loadComponent: () =>
              import('./pages/settings/help.component').then(m => m.HelpComponent),
          },
          {
            path: 'media-processing',
            title: 'titles.models',
            loadComponent: () =>
              import('./pages/settings/media-processing/media-processing-page.component').then(m => m.MediaProcessingPageComponent),
          },
          // The page was called "Models" until it grew to cover the whole media/document pipeline. Keep the
          // old path working: it is in bookmarks, in older docs, and in links people have already shared.
          { path: 'models', redirectTo: 'media-processing', pathMatch: 'full' },
          // Duplicate review moved out of global Settings and into the per-space Brain "Review" tab
          // (F-REVIEW): a duplicate pair only ever means something inside one space. The old path stays
          // as a redirect — it was a sidebar entry, so it is in muscle memory and in bookmarks.
          { path: 'duplicates', redirectTo: '/brain', pathMatch: 'full' },
        ],
      },
    ],
  },

  { path: '**', redirectTo: '' },
]);
