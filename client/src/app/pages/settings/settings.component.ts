import { Component } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <div class="page-header">
      <h1 class="page-title">Settings</h1>
    </div>

    <div class="tabs">
      <a class="tab" routerLink="tokens"   routerLinkActive="active">Tokens</a>
      <a class="tab" routerLink="spaces"   routerLinkActive="active">Spaces</a>
      <a class="tab" routerLink="storage"  routerLinkActive="active">Storage</a>
      <a class="tab" routerLink="networks" routerLinkActive="active">Networks</a>
    </div>

    <router-outlet />
  `,
})
export class SettingsComponent {}
