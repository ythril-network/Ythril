import { Component, inject, input, signal } from '@angular/core';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import { DatePipe } from '@angular/common';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { Network } from '../../core/api.types';
import type { ChangeNote } from '../../core/change-note.types';
import { NetworksApi } from '../../core/networks-api.service';
import { ToastService } from '../../core/toast.service';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { MarkdownRenderService } from '../../shared/markdown-render.service';

/** Roles with members BELOW them, so a note written here reaches somebody: a publisher, a tree root or inner node. */
const SENDING_ROLES = new Set(['publisher', 'root', 'node']);

/**
 * "Change notes" on a network card (F-42): write a note that travels with a downward sync, and read the notes that
 * arrived from above or were sent from here.
 *
 * A note goes only DOWN — a publisher to its subscribers, a tree node to its children — so the composer shows only
 * for a role with somebody below it; the server refuses the rest with 409 regardless, and that sentence is shown if
 * it does. The lists load when the section is opened, not with the page: most visits never read them. Its own
 * component because `networks.component.ts` is on the god-file ratchet.
 */
@Component({
  selector: 'app-network-change-notes',
  standalone: true,
  imports: [TranslocoPipe, DatePipe, PhIconComponent],
  styles: [`
    :host { display: block; margin-top: 16px; }
    .note { padding: 8px 10px; background: var(--bg-elevated); border-radius: var(--radius-sm); margin-bottom: 8px; font-size: 13px; }
    .note-meta { display: block; font-size: 11px; color: var(--text-muted); margin-bottom: 4px; }
    .note-body { white-space: pre-wrap; overflow-wrap: anywhere; }
    .note-body.md { white-space: normal; }
    .note-body.md :first-child { margin-top: 0; }
    .note-body.md :last-child { margin-bottom: 0; }
    .space-pick { display: inline-flex; align-items: center; gap: 4px; margin-right: 10px; font-size: 12px; }
    textarea { width: 100%; min-height: 72px; box-sizing: border-box; }
  `],
  template: `
    <button type="button" class="section-title" style="cursor:pointer; display:inline-flex; align-items:center; gap:4px; background:none; border:0; padding:0;"
            [attr.aria-expanded]="open()" (click)="toggle()">
      {{ 'networks.network.changeNotes.title' | transloco }} <ph-icon [name]="open() ? 'caret-up' : 'caret-down'" [size]="12" />
    </button>
    @if (open()) {
      @if (canSend()) {
        <div style="margin:8px 0 12px;">
          <label [for]="'cn-' + network().id" style="font-size:12px; color:var(--text-muted);">{{ 'networks.network.changeNotes.composeLabel' | transloco }}</label>
          <textarea [id]="'cn-' + network().id" maxlength="10000" [value]="draft()" (input)="draft.set($any($event.target).value)"
                    [placeholder]="'networks.network.changeNotes.placeholder' | transloco"></textarea>
          @if (network().spaces.length > 1) {
            <div style="margin:6px 0;">
              <span style="font-size:12px; color:var(--text-muted); margin-right:8px;">{{ 'networks.network.changeNotes.concerns' | transloco }}</span>
              @for (s of network().spaces; track s) {
                <label class="space-pick"><input type="checkbox" [checked]="picked().has(s)" (change)="togglePick(s)" /> {{ s }}</label>
              }
            </div>
          }
          <button class="btn-primary btn btn-sm" [disabled]="sending() || !draft().trim()" (click)="send()">
            @if (sending()) { <span class="spinner" style="width:11px;height:11px;border-width:2px;"></span> }
            {{ 'networks.network.changeNotes.send' | transloco }}
          </button>
        </div>
      }
      @if (loading()) {
        <div style="font-size:12px; color:var(--text-muted);">{{ 'networks.network.changeNotes.loading' | transloco }}</div>
      } @else {
        <div class="section-title" style="font-size:12px; margin-top:4px;">{{ 'networks.network.changeNotes.received' | transloco }}</div>
        @for (n of received(); track n._id) {
          <div class="note">
            <span class="note-meta">{{ n.receivedAt | date:'medium' }} · {{ (n.generated ? 'networks.network.changeNotes.generated' : 'networks.network.changeNotes.by') | transloco: { author: n.author } }}{{ n.spaces.length ? ' · ' + n.spaces.join(', ') : '' }}</span>
            @if (html()[n._id]; as h) { <div class="note-body md" [innerHTML]="h"></div> } @else { <span class="note-body">{{ n.note }}</span> }
          </div>
        } @empty {
          <div style="font-size:12px; color:var(--text-muted); margin-bottom:8px;">{{ 'networks.network.changeNotes.noneReceived' | transloco }}</div>
        }
        @if (canSend()) {
          <div class="section-title" style="font-size:12px; margin-top:8px;">{{ 'networks.network.changeNotes.sent' | transloco }}</div>
          @for (n of sent(); track n._id) {
            <div class="note">
              <span class="note-meta">{{ n.createdAt | date:'medium' }} · {{ n.pendingFor?.length ? ('networks.network.changeNotes.pending' | transloco: { count: n.pendingFor!.length }) : ('networks.network.changeNotes.delivered' | transloco) }}{{ n.spaces.length ? ' · ' + n.spaces.join(', ') : '' }}</span>
              @if (html()[n._id]; as h) { <div class="note-body md" [innerHTML]="h"></div> } @else { <span class="note-body">{{ n.note }}</span> }
            </div>
          } @empty {
            <div style="font-size:12px; color:var(--text-muted);">{{ 'networks.network.changeNotes.noneSent' | transloco }}</div>
          }
        }
      }
    }
  `,
})
export class NetworkChangeNotesComponent {
  private networksApi = inject(NetworksApi);
  private toast = inject(ToastService);
  private transloco = inject(TranslocoService);
  private markdown = inject(MarkdownRenderService);
  private sanitizer = inject(DomSanitizer);

  network = input.required<Network>();
  /**
   * Each note rendered as markdown, by id — through the app's ONE markdown pipeline, which sanitises (a note is
   * text another instance's operator wrote). Until it renders, or if it cannot, the note shows as plain text.
   */
  html = signal<Record<string, SafeHtml>>({});

  open = signal(false);
  loading = signal(false);
  sending = signal(false);
  draft = signal('');
  picked = signal(new Set<string>());
  received = signal<ChangeNote[]>([]);
  sent = signal<ChangeNote[]>([]);

  canSend(): boolean {
    const role = this.network().myRole;
    return !!role && SENDING_ROLES.has(role.role) && role.members.length > 0;
  }

  toggle(): void {
    this.open.update(o => !o);
    if (this.open()) this.load();
  }

  togglePick(space: string): void {
    this.picked.update(p => { const n = new Set(p); if (n.has(space)) n.delete(space); else n.add(space); return n; });
  }

  send(): void {
    const note = this.draft().trim();
    if (!note) return;
    this.sending.set(true);
    this.networksApi.syncWithNote(this.network().id, note, [...this.picked()]).subscribe({
      next: () => {
        this.sending.set(false);
        this.draft.set('');
        this.picked.set(new Set());
        this.toast.success(this.transloco.translate('networks.network.changeNotes.queued'));
        this.load();
      },
      error: (err) => {
        this.sending.set(false);
        this.toast.error(err.error?.error ?? this.transloco.translate('networks.network.changeNotes.failed'));
      },
    });
  }

  private load(): void {
    const id = this.network().id;
    this.loading.set(true);
    let pending = this.canSend() ? 2 : 1;
    const done = () => { if (--pending === 0) this.loading.set(false); };
    const fail = (err: { error?: { error?: string } }) => { this.toast.error(err.error?.error ?? this.transloco.translate('networks.network.changeNotes.loadFailed')); done(); };
    this.networksApi.changeNotes(id, 'in').subscribe({ next: r => { this.received.set(r.notes); this.renderAll(r.notes); done(); }, error: fail });
    if (this.canSend()) this.networksApi.changeNotes(id, 'out').subscribe({ next: r => { this.sent.set(r.notes); this.renderAll(r.notes); done(); }, error: fail });
  }

  private renderAll(notes: ChangeNote[]): void {
    for (const n of notes) {
      if (this.html()[n._id]) continue;
      this.markdown.render(n.note)
        .then(h => this.html.update(m => ({ ...m, [n._id]: this.sanitizer.bypassSecurityTrustHtml(h) })))
        .catch(() => { /* stays plain text */ });
    }
  }
}
