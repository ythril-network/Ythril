/**
 * Vitest setup — initialise the Angular test environment once per worker.
 *
 * The app is zoneless (P13): `provideZonelessChangeDetection()` in app.config.ts, no zone.js
 * polyfill. Tests must run under the SAME change-detection regime, or the OnPush/staleness
 * assertions (see change-detection-harness.spec.ts) would be exercising a scheduler that
 * production doesn't use. `ZonelessTestModule` injects the zoneless providers into every
 * TestBed the same way app.config.ts does for the app.
 */
import { NgModule, provideZonelessChangeDetection } from '@angular/core';
import { getTestBed } from '@angular/core/testing';
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing';

@NgModule({ providers: [provideZonelessChangeDetection()] })
class ZonelessTestModule {}

// Each spec file runs in its own isolated fork (see vitest.config.ts), so the platform is
// created once per file — exactly what Angular's global TestBed expects.
/**
 * jsdom has no `CSS.escape`, and a spec that looks an element up by an id it read from the DOM (`#${CSS.escape(id)}`, for the element an
 * `aria-describedby` names) would throw "Cannot read properties of undefined (reading 'escape')" before it asserted anything. This is the
 * CSSOM "serialize an identifier" algorithm, installed only where the environment lacks one.
 */
const cssGlobal = globalThis as unknown as { CSS?: { escape?: (value: string) => string } };
if (typeof cssGlobal.CSS?.escape !== 'function') {
  const escape = (value: string): string => {
    const text = String(value);
    let out = '';
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      const ch = text.charAt(i);
      if (code === 0) out += '�';
      else if ((code >= 0x1 && code <= 0x1f) || code === 0x7f || (i === 0 && code >= 0x30 && code <= 0x39) || (i === 1 && code >= 0x30 && code <= 0x39 && text.charCodeAt(0) === 0x2d)) out += `\\${code.toString(16)} `;
      else if (i === 0 && text.length === 1 && code === 0x2d) out += `\\${ch}`;
      else if (code >= 0x80 || code === 0x2d || code === 0x5f || (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) out += ch;
      else out += `\\${ch}`;
    }
    return out;
  };
  cssGlobal.CSS = { ...(cssGlobal.CSS ?? {}), escape };
}

getTestBed().initTestEnvironment([BrowserTestingModule, ZonelessTestModule], platformBrowserTesting());
