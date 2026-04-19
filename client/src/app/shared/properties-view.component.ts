import { Component, Input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { PropertySchema } from '../core/api.service';

@Component({
  selector: 'app-properties-view',
  standalone: true,
  imports: [CommonModule],
  styles: [`
    .props-none { color: var(--text-muted); font-size: 12px; }
    .props-wrap { font-size: 11px; }
    .props-toggle {
      display: flex;
      gap: 3px;
      margin-bottom: 5px;
    }
    .props-toggle button {
      font-size: 10px;
      padding: 1px 7px;
      border-radius: 3px;
      border: 1px solid var(--border);
      background: transparent;
      color: var(--text-muted);
      cursor: pointer;
      line-height: 1.7;
    }
    .props-toggle button.active {
      background: var(--accent-dim);
      border-color: var(--accent);
      color: var(--accent);
    }
    .props-toggle button:hover:not(.active) {
      border-color: var(--text-muted);
      color: var(--text-primary);
    }
    .props-table { border-collapse: collapse; width: 100%; }
    .props-table tr:not(:last-child) td { padding-bottom: 2px; }
    .props-key {
      color: var(--text-muted);
      font-weight: 500;
      white-space: nowrap;
      padding-right: 10px;
      vertical-align: top;
      font-size: 11px;
    }
    .props-val {
      color: var(--text-primary);
      word-break: break-all;
      font-size: 11px;
      vertical-align: top;
    }
    .props-pre {
      font-family: var(--font-mono, 'Consolas', 'Monaco', monospace);
      font-size: 10px;
      white-space: pre-wrap;
      word-break: break-all;
      color: var(--text-primary);
      background: var(--bg-secondary);
      border-radius: var(--radius-sm, 4px);
      padding: 4px 6px;
      margin: 0;
      max-height: 140px;
      overflow-y: auto;
    }
  `],
  template: `
    @if (isEmpty()) {
      <span class="props-none">—</span>
    } @else {
      <div class="props-wrap">
        <div class="props-toggle">
          <button [class.active]="mode() === 'table'" (click)="mode.set('table')">Table</button>
          <button [class.active]="mode() === 'json'" (click)="mode.set('json')">JSON</button>
        </div>
        @if (mode() === 'table') {
          <table class="props-table">
            @for (kv of entries(); track kv.key) {
              <tr>
                <td class="props-key">{{ kv.key }}</td>
                <td class="props-val">{{ formatValue(kv.key, kv.value) }}</td>
              </tr>
            }
          </table>
        } @else {
          <pre class="props-pre">{{ jsonStr() }}</pre>
        }
      </div>
    }
  `
})
export class PropertiesViewComponent {
  @Input() properties: Record<string, unknown> | null | undefined;
  @Input() schema?: Record<string, PropertySchema>;

  mode = signal<'table' | 'json'>('table');

  isEmpty(): boolean {
    return !this.properties || Object.keys(this.properties).length === 0;
  }

  entries(): Array<{ key: string; value: unknown }> {
    if (!this.properties) return [];
    return Object.entries(this.properties).map(([key, value]) => ({ key, value }));
  }

  formatValue(key: string, val: unknown): string {
    if (this.schema?.[key]?.type === 'date' && typeof val === 'string' && val) {
      const d = new Date(val.length === 10 ? val + 'T12:00:00Z' : val);
      if (!isNaN(d.getTime())) {
        const day = String(d.getDate()).padStart(2, '0');
        const month = String(d.getMonth() + 1).padStart(2, '0');
        return `${day}.${month}.${d.getFullYear()}`;
      }
    }
    return String(val ?? '');
  }

  jsonStr(): string {
    return JSON.stringify(this.properties, null, 2);
  }
}
