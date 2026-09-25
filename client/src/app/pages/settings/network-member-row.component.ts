/**
 * One member of a network, as a row.
 *
 * ## Why this is its own component (`N-2`)
 *
 * It is owed by a god-file raise: `networks.component.ts` went 643 → 650 when the peer-floor badge landed
 * (`N-1`), and the rule here is that a raise queues its decomposition. The row is the right thing to take
 * out, because **every new per-member FACT lands in this template** — the version badge was the second one
 * in a year — so the growth is structural rather than incidental.
 *
 * ## What moved, and what deliberately did not
 *
 * The row's own styles come with it, or the parent keeps dead CSS for markup it no longer holds — a class
 * with one consumer belongs with that consumer. What stays behind is everything ABOUT the network: the
 * card, the vote list, the invite panel, and the removal itself, which needs the network and the confirm
 * dialog. This emits and the parent decides.
 *
 * ## The host IS the row
 *
 * `:host { display: flex }` rather than a wrapping `<div class="member-row">`. A custom element is INLINE
 * by default, so a border, a gap and `flex-wrap` on an inner div inside an inline host shrink-wrap to the
 * content and the row stops being a row. Setting `display` on the host is what keeps the layout identical
 * to the markup it replaces.
 */
import { Component, ChangeDetectionStrategy, input, output } from '@angular/core';
import { DatePipe } from '@angular/common';
import { TranslocoPipe } from '@jsverse/transloco';
import { PhIconComponent } from '../../shared/ph-icon.component';
import type { NetworkMember } from '../../core/api.types';

@Component({
  selector: 'app-network-member-row',
  standalone: true,
  imports: [DatePipe, TranslocoPipe, PhIconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="mono badge badge-gray" style="font-size:11px;">{{ member().instanceId.slice(0, 8) }}</span>
    <span style="font-weight:500; flex:1;">{{ member().label }}</span>
    <!-- direction, the field the server sends. This read syncDirection, which nothing sends, so every row showed 'both'. -->
    <span class="badge badge-gray">{{ member().direction ?? 'both' }}</span>

    <!-- Without this, a peer refused on version grounds is indistinguishable from a brand-new one:
         no failure streak (never dialled) and no timestamp. -->
    @if (member().belowFloor) {
      <span class="member-failing" [attr.title]="member().belowFloor">
        <ph-icon name="warning" [size]="11"/> {{ 'networks.member.belowFloor' | transloco }}
      </span>
    }
    <!-- Sync health at a glance: a failing badge when a run streak is failing. -->
    @if (member().consecutiveFailures) {
      <span class="member-failing"
        [attr.title]="'networks.member.failingTitle' | transloco: { count: member().consecutiveFailures }">
        <ph-icon name="warning" [size]="11"/>
        {{ 'networks.member.failing' | transloco: { count: member().consecutiveFailures } }}
      </span>
    }

    <span class="member-sync" [attr.title]="member().lastSyncAt ? (member().lastSyncAt | date:'dd.MM.yyyy HH:mm') : ''">
      @if (member().lastSyncAt) {
        {{ 'networks.member.synced' | transloco }} {{ member().lastSyncAt | date:'dd.MM.yyyy HH:mm' }}
      } @else {
        {{ 'networks.member.neverSynced' | transloco }}
      }
    </span>

    <!-- url, the field the server sends; this read endpoint, which nothing sends, so no address was ever shown. -->
    <a class="member-endpoint" [href]="member().url" target="_blank" rel="noopener"
      [attr.title]="member().url">{{ member().url }}</a>

    @if (removable()) {
    <button
      class="btn-danger btn btn-sm"
      style="padding:2px 8px;"
      [disabled]="removing()"
      (click)="remove.emit()"
      [attr.title]="'networks.network.members.removeTitle' | transloco"
      [attr.aria-label]="'networks.network.members.removeAriaLabel' | transloco"
    ><ph-icon name="x" [size]="14"/></button>
    }
  `,
  styles: [`
    /* The HOST is the row — see the class note above. An inline host would shrink-wrap the border and gap. */
    :host {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 0;
      border-bottom: 1px solid var(--border-muted);
      font-size: 13px;
      flex-wrap: wrap; /* narrow iframe: the endpoint URL + delete wrap to the next line, never overflow */
    }
    :host(:last-of-type) { border-bottom: none; }

    /* The peer endpoint can be a long URL — let it shrink and ellipsize instead of pushing the row wide. */
    .member-endpoint {
      flex: 1 1 160px;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 11px;
      color: var(--text-muted);
    }

    .member-sync { font-size: 11px; color: var(--text-muted); white-space: nowrap; }
    .member-failing {
      display: inline-flex; align-items: center; gap: 3px; font-size: 11px; white-space: nowrap;
      padding: 1px 7px; border-radius: 10px; color: var(--error);
      background: color-mix(in srgb, var(--error) 12%, transparent);
      border: 1px solid color-mix(in srgb, var(--error) 45%, transparent);
    }
  `],
})
export class NetworkMemberRowComponent {
  readonly member = input.required<NetworkMember>();
  /** Disables the remove button while the parent's request is in flight. */
  readonly removing = input(false);
  /** Whether this instance may remove this member at all — a pub/sub subscriber may not remove its publisher (F-38.1). */
  readonly removable = input(true);
  /** The parent owns the removal: it holds the network and the confirmation. */
  readonly remove = output<void>();
}
