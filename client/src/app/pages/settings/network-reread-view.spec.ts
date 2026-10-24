/**
 * What a network card reads from the administrator's `rereadOwed` (bundle-81, decision 39): which member owes a re-read, in which state, and
 * whether the view is an administrator's at all. An absent marker is "not yours to see", never "none owed".
 */
import { describe, it, expect } from 'vitest';
import { isAdministeredView, memberRereadState, rereadByMember, rereadOwedMembers, rereadStateOf } from './network-reread-view';

const owed = [
  { instanceId: 'berlin', space: 'general', state: 'owed' as const },
  { instanceId: 'berlin', space: 'notes', state: 'catching' as const },
  { instanceId: 'gdansk', space: 'general', state: 'owed' as const },
];

describe('the re-read view of a network', () => {
  it('groups the entries by member, keeping the spaces in the order listed', () => {
    const by = rereadByMember({ rereadOwed: owed });
    expect([...by.keys()]).toEqual(['berlin', 'gdansk']);
    expect(by.get('berlin')!.map(e => e.space)).toEqual(['general', 'notes']);
  });

  it('a member is catching up while any space is being read, owed while only later spaces wait, and nothing when it owes none', () => {
    expect(rereadStateOf({ rereadOwed: owed }, 'berlin')).toBe('catching');
    expect(rereadStateOf({ rereadOwed: owed }, 'gdansk')).toBe('owed');
    expect(rereadStateOf({ rereadOwed: owed }, 'paris')).toBeNull();
    expect(memberRereadState(undefined)).toBeNull();
    expect(rereadOwedMembers({ rereadOwed: owed })).toBe(2);
    expect(rereadOwedMembers({})).toBe(0);
  });

  it('the view is an administrator’s when the owed re-reads, space acts or record counts were served, and not otherwise', () => {
    expect(isAdministeredView({ rereadOwed: [] })).toBe(true);
    expect(isAdministeredView({ owedSpaceActs: [] })).toBe(true);
    expect(isAdministeredView({ spaceRecordCounts: { general: 3 } })).toBe(true);
    expect(isAdministeredView({})).toBe(false);
  });
});
