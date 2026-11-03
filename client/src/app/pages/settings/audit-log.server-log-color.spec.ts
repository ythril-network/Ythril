/**
 * The server log viewer colours a line by its own level, read from where the level is written (Q-323).
 *
 * A server log line is `[<ISO time>] [<LEVEL>] [<request id>] <message>`, the level padded to five characters (`INFO `, `WARN `, `ERROR`, `DEBUG`;
 * server/src/util/log.ts). `serverLogColor` asked three times whether the line CONTAINS `[ERROR]`, `[WARN ` or `[DEBUG]` anywhere, so an INFO line whose
 * message mentions `[ERROR]` (a request that echoes a bracketed word, or a forged line a peer got into a value) was painted as an error, and a quiet line
 * could be dressed as a warning. The level is the second bracketed group at the START of the line and nowhere else.
 *
 * The colour is a fact about the rendered page, so the cases render the viewer over lines and read each row's inline colour.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { of } from 'rxjs';
import { AdminApi } from '../../core/admin-api.service';
import { SpacesApi } from '../../core/spaces-api.service';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { AuditLogComponent } from './audit-log.component';

const ERROR = 'var(--error)';
const WARN = 'var(--warning)';
const DEBUG = 'var(--text-muted)';
const PLAIN = 'var(--text-primary)';

const TS = '2026-11-03T10:00:00.000Z';
const line = (level: string, msg: string, rid?: string) => `[${TS}] [${level}]${rid ? ` [${rid}]` : ''} ${msg}`;

function viewer(lines: string[]) {
  const api = {
    listSpaces: () => of({ spaces: [] }),
    getAuditLog: () => of({ entries: [], total: 0, hasMore: false, retentionDays: 90 }),
    getAboutLogs: () => of({ lines }),
    mintLogsTicket: () => of({ ticket: 't', expiresInMs: 60000 }),
  } as any;
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [AuditLogComponent, getTranslocoModule()],
    providers: [{ provide: AdminApi, useValue: api }, { provide: SpacesApi, useValue: api }],
  });
  const fixture = TestBed.createComponent(AuditLogComponent);
  fixture.detectChanges();
  const c = fixture.componentInstance;
  c.activeLogTab.set('server'); // opening the tab loads the lines from the (stubbed) logs endpoint
  fixture.detectChanges();
  fixture.detectChanges();
  // A row is the childless div whose text is the line (the viewer's container carries inline styles jsdom re-serialises, so it is not selected by them).
  const all = [...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>('div')].filter(d => d.children.length === 0);
  const rows = lines.map(l => all.find(d => d.textContent === l)).filter((d): d is HTMLElement => !!d);
  return { c, rows, colours: rows.map(r => r.style.color) };
}

describe('the server log colours a line by its anchored level (Q-323)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('each level at the start of a line gets its own colour', () => {
    const { rows, colours } = viewer([
      line('ERROR', 'boom'), line('WARN ', 'careful'), line('DEBUG', 'detail'), line('INFO ', 'fine'),
    ]);
    expect(rows.length, 'four rows rendered').toBe(4);
    expect(colours).toEqual([ERROR, WARN, DEBUG, PLAIN]);
  });

  it('the request id between the level and the message changes nothing', () => {
    const { colours } = viewer([line('ERROR', 'boom', 'req-1'), line('WARN ', 'careful', 'req-2'), line('INFO ', 'fine', 'req-3')]);
    expect(colours).toEqual([ERROR, WARN, PLAIN]);
  });

  it('an INFO line whose message says [ERROR] is an INFO line', () => {
    const { colours } = viewer([line('INFO ', 'client sent "[ERROR]" in a header')]);
    expect(colours).toEqual([PLAIN]);
  });

  it('an INFO line that says [WARN  and a DEBUG line that says [ERROR] keep their own level', () => {
    const { colours } = viewer([line('INFO ', 'saw [WARN  in a value'), line('DEBUG', 'echo [ERROR] here')]);
    expect(colours).toEqual([PLAIN, DEBUG]);
  });

  it('a forged second line inside a value is text of the line it came in with (the server escapes the newline; the colour holds either way)', () => {
    const forged = line('INFO ', 'name=bob\\n[2026-11-03T10:00:01.000Z] [ERROR] forged');
    expect(viewer([forged]).colours).toEqual([PLAIN]);
  });

  it('a line with no level group at all is plain, whatever it contains', () => {
    const { colours } = viewer(['plain text with [ERROR] and [WARN  and [DEBUG]', 'also [ERROR] first']);
    expect(colours).toEqual([PLAIN, PLAIN]);
  });

  it('the level must be one of the four: [ERROR ] or [error] at the level slot is not an error line', () => {
    const { colours } = viewer([`[${TS}] [error] lower case`, `[${TS}] [ERRORS] not a level`, `[${TS}] [FATAL] not a level`]);
    expect(colours).toEqual([PLAIN, PLAIN, PLAIN]);
  });
});
