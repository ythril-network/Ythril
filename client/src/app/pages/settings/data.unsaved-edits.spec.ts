/**
 * The Data page asks before leaving with an unsaved backup destination, schedule or migrate URI (Q-701).
 *
 * Before this, leaving the page lost a typed backup setting to one sidebar click: `configDirty()` only drew the "unsaved" pill, and the
 * migrate URI had no check at all.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi } from 'vitest';
import { of } from 'rxjs';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { DataComponent } from './data.component';
import { AdminApi } from '../../core/admin-api.service';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import { UnsavedEdits } from '../../core/unsaved-edits';

function open() {
  const admin = {
    getDataConfig:       () => of({ source: 'config', mongoUriRedacted: 'mongodb://***@db/ythril', migrationEnabled: true }),
    getMaintenanceStatus:() => of({ active: false, manual: false, heldBy: null }),
    getBackupConfig:     () => of({ config: null, backupsPath: '' }),
    listBackups:         () => of({ backups: [] }),
    getRestoreReport:    () => of({ restore: null }),
    getMigrateReport:    () => of({ migrate: null }),
    saveBackupConfig:    (config: unknown) => of({ ok: true, config }),
    startMigration:      () => of({ migrateId: 'm1', spaces: ['general'] }),
  } as unknown as AdminApi;
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [DataComponent, getTranslocoModule()],
    providers: [
      { provide: AdminApi, useValue: admin },
      { provide: ConfirmDialogService, useValue: { confirm: vi.fn().mockResolvedValue(true) } },
    ],
  });
  const fixture = TestBed.createComponent(DataComponent);
  fixture.detectChanges();
  return { c: fixture.componentInstance, edits: TestBed.inject(UnsavedEdits) };
}

describe('the Data page holds its drafts (Q-701)', () => {
  it('is clean when untouched', () => {
    expect(open().edits.any()).toBe(false);
  });

  it('a typed backup destination is held until it is saved', () => {
    const { c, edits } = open();
    c.destForm.customPath = '/mnt/offsite';
    c.destForm.ythrilInternal = false;
    expect(edits.any()).toBe(true);
    c.saveDest();
    expect(edits.any()).toBe(false);
  });

  it('a picked schedule is held until it is saved', () => {
    const { c, edits } = open();
    c.scheduleForm.frequency = 'daily';
    expect(edits.any()).toBe(true);
    c.saveSchedule();
    expect(edits.any()).toBe(false);
  });

  it('a typed migrate URI is held until the migration is started', async () => {
    const { c, edits } = open();
    c.migrateUri = 'mongodb://new-host:27017/ythril';
    expect(edits.any()).toBe(true);
    await c.confirmMigrate();
    expect(edits.any()).toBe(false);
  });

  it('a blank migrate URI is not a draft', () => {
    const { c, edits } = open();
    c.migrateUri = '   ';
    expect(edits.any()).toBe(false);
  });
});
