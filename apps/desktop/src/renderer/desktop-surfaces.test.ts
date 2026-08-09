import { describe, expect, it } from 'vitest';

import {
  assignWorkbenchTabSurface,
  desktopSurfaceStorageKey,
  restoreDesktopSurfaceState,
  serializeDesktopSurfaceState,
  workbenchForSurface,
  workbenchTabSurface,
} from './desktop-surfaces';
import { agentTab, fileTab, openWorkbenchTab, sessionTab, teamTab } from './workbench-tabs';

describe('desktop surfaces', () => {
  it('keeps Chat sessions and Team details on separate top-level surfaces', () => {
    let state = openWorkbenchTab({ tabs: [], recentIds: [] }, sessionTab('chat-1'));
    state = openWorkbenchTab(state, teamTab('team-1'));
    state = openWorkbenchTab(state, agentTab('team-1', 'reviewer'));
    const file = fileTab('src/main.ts');
    state = openWorkbenchTab(state, file);
    const ownership = assignWorkbenchTabSurface({}, file, 'team');

    expect(workbenchTabSurface(sessionTab('chat-1'), ownership)).toBe('chat');
    expect(workbenchForSurface(state, 'chat', ownership).tabs.map((tab) => tab.id)).toEqual(['session:chat-1']);
    expect(workbenchForSurface(state, 'team', ownership).tabs.map((tab) => tab.id)).toEqual([
      'team:team-1',
      'agent:team-1:reviewer',
      'file:src/main.ts',
    ]);
  });

  it('restores only validated surface ownership and defaults old files to Chat', () => {
    const restored = restoreDesktopSurfaceState(serializeDesktopSurfaceState({
      active: 'team',
      tabSurfaces: { 'file:src/main.ts': 'team' },
    }));
    expect(restored).toEqual({ active: 'team', tabSurfaces: { 'file:src/main.ts': 'team' } });
    expect(restoreDesktopSurfaceState('{"version":1,"active":"bad","tabSurfaces":{"file:a":"bad"}}'))
      .toEqual({ active: 'chat', tabSurfaces: {} });
    expect(workbenchTabSurface(fileTab('legacy.ts'), {})).toBe('chat');
    expect(desktopSurfaceStorageKey('workspace-key')).toBe('workspace-key.surfaces');
  });
});
