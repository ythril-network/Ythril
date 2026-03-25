import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { MfaPromptComponent } from './shared/mfa-prompt.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, MfaPromptComponent],
  template: `<router-outlet /><app-mfa-prompt />`,
})
export class AppComponent {}
