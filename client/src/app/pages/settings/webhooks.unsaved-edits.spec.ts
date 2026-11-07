/**
 * The webhooks page asks before leaving with an open create/edit dialog that differs from what it opened with (Q-701).
 *
 * The dialog registers its draft, so a sidebar click or a reload asks; its own close (X, Escape, Cancel) asking first is held in
 * settings-dialogs.dismiss.spec.ts (Q-713).
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
import { UnsavedEdits } from '../../core/unsaved-edits';

const hook = (over: Partial<WebhookSubscription> = {}): WebhookSubscription => ({
  id: 'w1', url: 'https://x.example.com/h', spaces: [], events: [], enabled: true,
  createdAt: '', updatedAt: '', status: 'active', consecutiveFailures: 0, ...over,
});

function open() {
  const admin = {
    listWebhooks: vi.fn(() => of({ webhooks: [hook()] })),
    createWebhook: vi.fn(() => of(hook())),
    updateWebhook: vi.fn(() => of(hook())),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [WebhooksComponent, getTranslocoModule()],
    providers: [
      { provide: AdminApi, useValue: admin },
      { provide: SpacesApi, useValue: { listSpaces: () => of({ spaces: [] }) } },
      { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
      { provide: ConfirmDialogService, useValue: { confirm: vi.fn(() => Promise.resolve(true)) } },
    ],
  });
  const c = TestBed.createComponent(WebhooksComponent).componentInstance;
  return { c, edits: TestBed.inject(UnsavedEdits) };
}

describe('the webhooks page holds its open dialog (Q-701)', () => {
  it('is clean with no dialog open', () => {
    expect(open().edits.any()).toBe(false);
  });

  it('a freshly opened create dialog is clean', () => {
    const { c, edits } = open();
    c.openCreate();
    expect(edits.any()).toBe(false);
  });

  it('a typed url in the create dialog is held until it is saved', () => {
    const { c, edits } = open();
    c.openCreate();
    c.form()!.url = 'https://hook.example.com/x';
    expect(edits.any()).toBe(true);
    c.save(c.form()!);
    expect(edits.any()).toBe(false);
  });

  it('a picked event is held', () => {
    const { c, edits } = open();
    c.openCreate();
    c.form()!.allEvents = false;
    c.toggleEvent(c.form()!, 'file.created' as never);
    expect(edits.any()).toBe(true);
  });

  it('an edit dialog is clean until a field changes, and clean again once it is closed', () => {
    const { c, edits } = open();
    c.openEdit(hook());
    expect(edits.any()).toBe(false);
    c.form()!.enabled = false;
    expect(edits.any()).toBe(true);
    c.closeForm();
    expect(edits.any()).toBe(false);
  });

  it('a typed secret on an edit is held', () => {
    const { c, edits } = open();
    c.openEdit(hook());
    c.form()!.secret = 'a-new-secret';
    expect(edits.any()).toBe(true);
  });
});
