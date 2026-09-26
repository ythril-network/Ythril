/**
 * C1 — WebhooksComponent create/edit payload shaping (the security-relevant bits).
 *
 * - "Subscribe to all events" / "All spaces" send empty arrays (server semantics for "everything").
 * - The write-only secret is sent ONLY when the user typed one — on edit, a blank field must NOT send
 *   a secret (the server never returns it, so blank means "keep the existing one").
 * - The page stays OnPush.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi } from 'vitest';
import { of } from 'rxjs';
import { AdminApi } from '../../core/admin-api.service';
import { SpacesApi } from '../../core/spaces-api.service';
import { ToastService } from '../../core/toast.service';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { WebhooksComponent } from './webhooks.component';
import type { WebhookSubscription } from '../../core/api.types';
import { isOnPush } from '../../testing/onpush';

function webhook(over: Partial<WebhookSubscription> = {}): WebhookSubscription {
  return {
    id: 'w1', url: 'https://x.example.com/h', spaces: [], events: [], enabled: true,
    createdAt: '', updatedAt: '', status: 'active', consecutiveFailures: 0, ...over,
  };
}

describe('WebhooksComponent — payload shaping (C1)', () => {
  let admin: { createWebhook: any; updateWebhook: any; listWebhooks: any };

  function create() {
    admin = {
      listWebhooks: vi.fn(() => of({ webhooks: [] })),
      createWebhook: vi.fn(() => of(webhook())),
      updateWebhook: vi.fn(() => of(webhook())),
    };
    TestBed.configureTestingModule({
      imports: [WebhooksComponent, getTranslocoModule()],
      providers: [
        { provide: AdminApi, useValue: admin },
        { provide: SpacesApi, useValue: { listSpaces: () => of({ spaces: [] }) } },
        { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
        { provide: ConfirmDialogService, useValue: { confirm: vi.fn(() => Promise.resolve(true)) } },
      ],
    });
    return TestBed.createComponent(WebhooksComponent).componentInstance;
  }

  it('is OnPush', () => {
    expect(isOnPush(WebhooksComponent)).toBe(true);
  });

  it('create with "all events"/"all spaces" sends empty arrays + the typed secret', () => {
    const cmp = create();
    cmp.openCreate();
    const f = cmp.form()!;
    f.url = 'https://hook.example.com/x';
    f.secret = 'longenough';
    cmp.save(f);
    expect(admin.createWebhook).toHaveBeenCalledWith({
      url: 'https://hook.example.com/x', events: [], spaces: [], enabled: true, secret: 'longenough',
    });
  });

  it('create with specific events sends exactly those', () => {
    const cmp = create();
    cmp.openCreate();
    const f = cmp.form()!;
    f.url = 'https://hook.example.com/x';
    f.secret = 'longenough';
    f.allEvents = false;
    cmp.toggleEvent(f, 'fact.created');
    cmp.toggleEvent(f, 'entity.deleted');
    cmp.save(f);
    const body = admin.createWebhook.mock.calls[0][0];
    expect(body.events.sort()).toEqual(['entity.deleted', 'fact.created']);
  });

  it('edit with a blank secret does NOT send a secret (keeps existing)', () => {
    const cmp = create();
    cmp.openEdit(webhook({ id: 'w9', url: 'https://k.example.com' }));
    const f = cmp.form()!;
    f.enabled = false; // some other change
    cmp.save(f);
    expect(admin.updateWebhook).toHaveBeenCalledTimes(1);
    const [id, body] = admin.updateWebhook.mock.calls[0];
    expect(id).toBe('w9');
    expect('secret' in body).toBe(false);
    expect(body.enabled).toBe(false);
  });
});
