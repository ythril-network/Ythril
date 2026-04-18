import { Component, Input, Output, EventEmitter, signal, computed, ElementRef, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-tag-input',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="tag-input-wrap" (click)="focusInput()">
      @for (tag of value; track tag) {
        <span class="tag-pill">
          {{ tag }}
          <button type="button" class="tag-remove" (click)="remove(tag); $event.stopPropagation()" aria-label="Remove tag">×</button>
        </span>
      }
      <div class="tag-input-inner" style="position:relative; flex:1; min-width:80px;">
        <input #inp
          type="text"
          class="tag-text-input"
          [placeholder]="value.length ? '' : placeholder"
          [(ngModel)]="query"
          [name]="inputName"
          (input)="onInput()"
          (keydown)="onKey($event)"
          (focus)="open.set(true)"
          (blur)="onBlur()"
          autocomplete="off"
        />
        @if (open() && filtered().length) {
          <div class="tag-dropdown">
            @for (s of filtered(); track s) {
              <div class="tag-option" (mousedown)="addTag(s)">{{ s }}</div>
            }
          </div>
        }
      </div>
    </div>
  `,
  styles: [`
    .tag-input-wrap {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px;
      min-height: 34px;
      padding: 4px 6px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm, 4px);
      background: var(--bg-secondary);
      cursor: text;
    }
    .tag-input-wrap:focus-within {
      border-color: var(--accent);
    }
    .tag-pill {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      padding: 1px 6px 1px 8px;
      border-radius: 12px;
      background: var(--accent-dim);
      color: var(--accent);
      font-size: 11px;
      white-space: nowrap;
    }
    .tag-remove {
      padding: 0;
      border: none;
      background: none;
      color: var(--accent);
      cursor: pointer;
      font-size: 13px;
      line-height: 1;
      opacity: 0.7;
    }
    .tag-remove:hover { opacity: 1; }
    .tag-text-input {
      border: none;
      outline: none;
      background: transparent;
      color: var(--text);
      font-size: 12px;
      width: 100%;
      min-width: 60px;
      padding: 2px 0;
    }
    .tag-dropdown {
      position: absolute;
      top: calc(100% + 2px);
      left: 0;
      min-width: 160px;
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-md, 6px);
      box-shadow: 0 4px 12px rgba(0,0,0,0.25);
      z-index: 300;
      max-height: 180px;
      overflow-y: auto;
    }
    .tag-option {
      padding: 6px 12px;
      font-size: 12px;
      color: var(--text);
      cursor: pointer;
      border-bottom: 1px solid var(--border);
    }
    .tag-option:last-child { border-bottom: none; }
    .tag-option:hover { background: var(--bg-elevated); }
  `]
})
export class TagInputComponent {
  @Input() value: string[] = [];
  @Output() valueChange = new EventEmitter<string[]>();
  @Input() suggestions: string[] = [];
  @Input() placeholder = 'Add tag…';
  @Input() inputName = 'tagInput';

  @ViewChild('inp') inp!: ElementRef<HTMLInputElement>;

  query = '';
  open = signal(false);

  filtered = computed(() => {
    const q = this.query.toLowerCase().trim();
    return this.suggestions
      .filter(s => !this.value.includes(s) && (!q || s.toLowerCase().includes(q)))
      .slice(0, 8);
  });

  focusInput(): void {
    this.inp?.nativeElement.focus();
  }

  onInput(): void {
    this.open.set(true);
  }

  onKey(e: KeyboardEvent): void {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const val = this.query.trim().replace(/,$/, '');
      if (val) this.addTag(val);
    } else if (e.key === 'Backspace' && !this.query && this.value.length) {
      this.remove(this.value[this.value.length - 1]);
    } else if (e.key === 'Escape') {
      this.open.set(false);
    }
  }

  onBlur(): void {
    // Commit any pending typed text on blur
    const val = this.query.trim().replace(/,$/, '');
    if (val) this.addTag(val);
    setTimeout(() => this.open.set(false), 150);
  }

  addTag(tag: string): void {
    const t = tag.trim();
    if (!t || this.value.includes(t)) { this.query = ''; return; }
    this.valueChange.emit([...this.value, t]);
    this.query = '';
    this.open.set(false);
  }

  remove(tag: string): void {
    this.valueChange.emit(this.value.filter(t => t !== tag));
  }
}
