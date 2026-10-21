/**
 * bundle-157 (Q-552, Q-553): the AdminApi doors of a restore and a migrate, typed to what the server answers since they became act sets.
 *
 * `restoreBackup` was typed `{ ok: boolean }`, which the server stopped sending: a restore answers 202 with the set it registered, and the
 * Data page read any success as "Restore completed". The bodies flushed here are the server's (`testing/data-act-bodies.ts`), and the
 * typed assignments below are checked by `npm run typecheck`, so a type that drifts from the wire fails there as well as here.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { AdminApi } from './admin-api.service';
import type { MaintenanceState, MigrateStarted, RestoreAbandoned, RestoreReportAnswer, RestoreStarted } from './admin-data.types';
import { ABANDON_ANSWERS, BACKUP_ID, MAINTENANCE, MIGRATE_ANSWERS, RESTORE_ANSWERS, restoreReport } from '../testing/data-act-bodies';

describe('AdminApi - restore and migrate as act sets (bundle-157)', () => {
  let api: AdminApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [AdminApi, provideHttpClient(), provideHttpClientTesting()] });
    api = TestBed.inject(AdminApi);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  it('restoreBackup types the 202: the set it registered, not { ok }', () => {
    let got: RestoreStarted | undefined;
    api.restoreBackup(BACKUP_ID).subscribe(v => { got = v; });
    const r = http.expectOne('/api/admin/data/restore');
    expect(r.request.method).toBe('POST');
    expect(r.request.body).toEqual({ backupId: BACKUP_ID });
    r.flush(RESTORE_ANSWERS.accepted.body, { status: 202, statusText: 'Accepted' });
    expect(got).toEqual(RESTORE_ANSWERS.accepted.body);
    expect(got?.spaces).toHaveLength(3);
  });

  it('restoreBackup with leaveOut sends the spaces the operator chose to leave out', () => {
    api.restoreBackup(BACKUP_ID, ['old-notes', 'retired']).subscribe();
    const r = http.expectOne('/api/admin/data/restore');
    expect(r.request.body).toEqual({ backupId: BACKUP_ID, leaveOut: ['old-notes', 'retired'] });
    r.flush(RESTORE_ANSWERS.acceptedLeavingOut.body, { status: 202, statusText: 'Accepted' });
  });

  it('getRestoreReport reads GET /api/admin/data/restore, the report or { restore: null }', () => {
    const seen: RestoreReportAnswer[] = [];
    api.getRestoreReport().subscribe(v => seen.push(v));
    http.expectOne(r => r.method === 'GET' && r.url === '/api/admin/data/restore').flush(restoreReport());
    api.getRestoreReport().subscribe(v => seen.push(v));
    http.expectOne(r => r.method === 'GET' && r.url === '/api/admin/data/restore').flush({ restore: null });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual({ restore: null });
  });

  it('abandonRestore posts to /restore/abandon and types the spaces it left half restored', () => {
    let got: RestoreAbandoned | undefined;
    api.abandonRestore().subscribe(v => { got = v; });
    const r = http.expectOne('/api/admin/data/restore/abandon');
    expect(r.request.method).toBe('POST');
    r.flush(ABANDON_ANSWERS.abandoned.body);
    expect(got?.halfRestored).toEqual(['notes', 'proj']);
  });

  it('startMigration types the 202: the migrate set, not { ok, backupDir, manifest }', () => {
    let got: MigrateStarted | undefined;
    api.startMigration('mongodb://new-host:27017/ythril').subscribe(v => { got = v; });
    const r = http.expectOne('/api/admin/data/migrate');
    expect(r.request.method).toBe('POST');
    expect(r.request.body).toEqual({ uri: 'mongodb://new-host:27017/ythril' });
    r.flush(MIGRATE_ANSWERS.accepted.body, { status: 202, statusText: 'Accepted' });
    expect(got).toEqual({ migrateId: 'set-9', spaces: ['general', 'notes'] });
  });

  it('getMigrateReport reads GET /api/admin/data/migrate (slice I4a, shape guessed from the restore report)', () => {
    api.getMigrateReport().subscribe();
    http.expectOne(r => r.method === 'GET' && r.url === '/api/admin/data/migrate').flush({ migrate: null });
  });

  it('the maintenance doors carry both halves and what holds it', () => {
    let got: MaintenanceState | undefined;
    api.getMaintenanceStatus().subscribe(v => { got = v; });
    http.expectOne(r => r.method === 'GET' && r.url === '/api/admin/data/maintenance').flush(MAINTENANCE.heldByRestore);
    expect(got).toEqual({ active: true, manual: false, heldBy: 'restore' });
  });
});
