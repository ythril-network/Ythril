/**
 * The tokens page asks before leaving with an inline label edit, an open create dialog or an open rights dialog that Save has not sent (Q-701).
 *
 * The dialogs' own close (X, Escape, backdrop) is not changed here (Q-713); each registers its draft, so a sidebar click or a reload asks.
 */
import type { Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi } from 'vitest';
import { of } from 'rxjs';
import { AuthApi } from '../../core/auth-api.service';
import { SpacesApi } from '../../core/spaces-api.service';
import { ToastService } from '../../core/toast.service';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { UnsavedEdits } from '../../core/unsaved-edits';
import { TokensComponent } from './tokens.component';
import { TokenCreateDialogComponent } from './token-create-dialog.component';
import { TokenRightsDialogComponent } from './token-rights-dialog.component';

const RIGHTS = { instanceAdmin: false, createSpaces: false, floor: null, perSpace: {} };
const TOKEN = { id: 't1', name: 'one', spaces: [], rights: RIGHTS };

function boot<T>(component: Type<T>, inputs: Record<string, unknown> = {}) {
  const authApi = {
    getMe: () => of({ admin: true }),
    verifyToken: () => of({ id: 'self', name: 'self' }),
    listTokens: () => of({ tokens: [TOKEN] }),
    renameToken: vi.fn((_id: string, name: string) => of({ token: { ...TOKEN, name } })),
    createToken: vi.fn(() => of({ token: TOKEN, plaintext: 'tok_x' })),
    updateToken: vi.fn(() => of({ token: { ...TOKEN, name: 'saved' } })),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [component, getTranslocoModule()],
    providers: [
      { provide: AuthApi, useValue: authApi },
      { provide: SpacesApi, useValue: { listSpaces: () => of({ spaces: [] }) } },
      { provide: ToastService, useValue: { show: () => {}, error: () => {}, success: () => {} } },
      { provide: ConfirmDialogService, useValue: { confirm: () => Promise.resolve(true) } },
    ],
  });
  const fixture = TestBed.createComponent(component);
  for (const [k, v] of Object.entries(inputs)) fixture.componentRef.setInput(k, v);
  fixture.detectChanges();
  return { c: fixture.componentInstance as any, fixture, authApi, edits: TestBed.inject(UnsavedEdits) };
}

/** The page owns the label model and the editing id; the table shows them, so the page is rendered after each change. */
describe('the tokens page holds its inline label edit (Q-701)', () => {
  it('is clean when untouched, and when the editor is just opened', () => {
    const { c, fixture, edits } = boot(TokensComponent);
    expect(edits.any()).toBe(false);
    c.startEditLabel(TOKEN);
    fixture.detectChanges();
    expect(edits.any()).toBe(false);
  });

  it('a changed label is held until it is saved', () => {
    const { c, fixture, edits } = boot(TokensComponent);
    c.startEditLabel(TOKEN);
    c.editLabelModel.set('renamed');
    fixture.detectChanges();
    expect(edits.any()).toBe(true);
    c.saveLabel(TOKEN);
    fixture.detectChanges();
    expect(edits.any()).toBe(false);
  });

  it('a label typed back to the saved name, and a cancelled edit, are clean', () => {
    const { c, fixture, edits } = boot(TokensComponent);
    c.startEditLabel(TOKEN);
    c.editLabelModel.set('renamed');
    c.editLabelModel.set('one');
    fixture.detectChanges();
    expect(edits.any()).toBe(false);
    c.editLabelModel.set('renamed again');
    c.cancelEditLabel();
    fixture.detectChanges();
    expect(edits.any()).toBe(false);
  });
});

describe('the token create dialog holds its draft (Q-701)', () => {
  it('is clean when untouched', () => {
    expect(boot(TokenCreateDialogComponent).edits.any()).toBe(false);
  });

  it('a typed name is held until the token is created', () => {
    const { c, edits } = boot(TokenCreateDialogComponent);
    c.newName = 'ci-bot';
    expect(edits.any()).toBe(true);
    c.createToken();
    expect(edits.any()).toBe(false);
  });

  it('a granted flag is held with no name', () => {
    const { c, edits } = boot(TokenCreateDialogComponent);
    c.setFlag('instanceAdmin', true);
    expect(edits.any()).toBe(true);
  });
});

describe('the token rights dialog holds its draft (Q-701)', () => {
  const open = () => boot(TokenRightsDialogComponent, { token: TOKEN, availableSpaces: [] });

  it('is clean when opened', () => {
    expect(open().edits.any()).toBe(false);
  });

  it('a changed name is held until it is saved', () => {
    const { c, edits } = open();
    c.draftName = 'renamed';
    expect(edits.any()).toBe(true);
    c.save();
    expect(edits.any()).toBe(false);
  });

  it('a changed flag and a changed rate limit are held', () => {
    const a = open();
    a.c.setFlag('createSpaces', true);
    expect(a.edits.any()).toBe(true);
    const b = open();
    b.c.draftRateLimit = 60;
    expect(b.edits.any()).toBe(true);
  });
});
