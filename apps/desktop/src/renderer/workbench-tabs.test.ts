// Scenario: Workbench tab lifecycle and Explorer Git decoration behavior.
// Responsibilities: stable tab identity, session-owned tab cleanup, persistence filtering, and Git aggregation.
// Wiring: pure renderer state helpers with no stubbed collaborators. Run with the Desktop Vitest config.
import { describe, expect, it } from 'vitest';

import type { GitFile } from '../shared/desktop-api';
import { gitDecoration } from './git-tree';
import {
  activateWorkbenchTab,
  agentTab,
  closeWorkbenchTab,
  closeSessionWorkbenchTabs,
  diffTab,
  ensureWorkbenchTab,
  fileTab,
  openWorkbenchTab,
  operationDiffTab,
  pruneInvalidSessionWorkbenchTabs,
  restoreWorkbenchState,
  serializeWorkbenchState,
  sessionTab,
  teamTab,
} from './workbench-tabs';

describe('workbench tab state', () => {
  it('reuses stable tabs, tracks MRU activation, and closes without SDK lifecycle state', () => {
    let state = openWorkbenchTab({ tabs: [], recentIds: [] }, sessionTab('s1'));
    state = openWorkbenchTab(state, fileTab('src/main.ts'));
    state = openWorkbenchTab(state, sessionTab('s1'));
    expect(state.tabs.map((tab) => tab.id)).toEqual(['session:s1', 'file:src/main.ts']);
    state = activateWorkbenchTab(state, 'file:src/main.ts');
    state = closeWorkbenchTab(state, 'file:src/main.ts');
    expect(state.activeId).toBe('session:s1');
    expect(state.tabs).toEqual([sessionTab('s1')]);
  });

  it('persists descriptors only and filters sessions that no longer exist', () => {
    let state = openWorkbenchTab({ tabs: [], recentIds: [] }, sessionTab('missing'));
    const dirty = { ...fileTab('src/main.ts'), loading: false, content: 'draft', savedContent: 'disk', dirty: true };
    state = openWorkbenchTab(state, dirty);
    state = openWorkbenchTab(state, diffTab('src/main.ts', 'working'));
    const serialized = serializeWorkbenchState(state);
    expect(serialized).not.toContain('draft');
    const restored = restoreWorkbenchState(serialized, new Set());
    expect(restored.tabs.map((tab) => tab.kind)).toEqual(['file', 'diff']);
    expect(restored.tabs[0]).toMatchObject({ kind: 'file', loading: true, dirty: false });
  });

  it('omits an operation diff and its snippets from restored workspace state', () => {
    let state = openWorkbenchTab({ tabs: [], recentIds: [] }, fileTab('src/main.ts'));
    state = openWorkbenchTab(state, operationDiffTab('call-1', 'src/main.ts', 'secret-before', 'secret-after'));

    const serialized = serializeWorkbenchState(state);
    const restored = restoreWorkbenchState(serialized, new Set());

    expect(serialized).not.toContain('secret-before');
    expect(serialized).not.toContain('call-1');
    expect(restored.tabs.map((tab) => tab.id)).toEqual(['file:src/main.ts']);
  });

  it('opens Team tabs in the background and restores only existing teams', () => {
    let state = openWorkbenchTab({ tabs: [], recentIds: [] }, fileTab('src/main.ts'));
    state = ensureWorkbenchTab(state, teamTab('s1'));
    expect(state.activeId).toBe('file:src/main.ts');
    expect(state.tabs.at(-1)).toEqual(teamTab('s1'));

    const serialized = serializeWorkbenchState(state);
    expect(restoreWorkbenchState(serialized, new Set(['s1']), new Set()).tabs).toHaveLength(1);
    const restored = restoreWorkbenchState(serialized, new Set(['s1']), new Set(['s1']));
    expect(restored.tabs.map((tab) => tab.id)).toEqual(['file:src/main.ts', 'team:s1']);
  });

  it('persists Team agent details only while their Team session exists', () => {
    let state = openWorkbenchTab({ tabs: [], recentIds: [] }, teamTab('s1'));
    state = openWorkbenchTab(state, agentTab('s1', 'reviewer'));
    const serialized = serializeWorkbenchState(state);

    expect(restoreWorkbenchState(serialized, new Set(['s1']), new Set()).tabs).toEqual([]);
    expect(restoreWorkbenchState(serialized, new Set(['s1']), new Set(['s1'])).tabs).toEqual([
      teamTab('s1'),
      agentTab('s1', 'reviewer'),
    ]);
  });

  it('removes session-owned tabs when a session is deleted, selecting the most recent survivor', () => {
    let state = openWorkbenchTab({ tabs: [], recentIds: [] }, sessionTab('s1'));
    state = openWorkbenchTab(state, fileTab('src/main.ts'));
    state = openWorkbenchTab(state, sessionTab('s2'));
    state = activateWorkbenchTab(state, 'file:src/main.ts');
    state = openWorkbenchTab(state, teamTab('s1'));

    state = closeSessionWorkbenchTabs(state, 's1');

    expect(state.tabs.map((tab) => tab.id)).toEqual(['file:src/main.ts', 'session:s2']);
    expect(state.activeId).toBe('file:src/main.ts');
    expect(state.recentIds).toEqual(['file:src/main.ts', 'session:s2']);
  });

  it('keeps the active editor when an inactive session is deleted', () => {
    let state = openWorkbenchTab({ tabs: [], recentIds: [] }, sessionTab('s1'));
    state = openWorkbenchTab(state, fileTab('src/main.ts'));

    state = closeSessionWorkbenchTabs(state, 's1');

    expect(state.tabs.map((tab) => tab.id)).toEqual(['file:src/main.ts']);
    expect(state.activeId).toBe('file:src/main.ts');
  });

  it('prunes stale session views when the authoritative session index changes', () => {
    let state = openWorkbenchTab({ tabs: [], recentIds: [] }, sessionTab('missing'));
    state = openWorkbenchTab(state, teamTab('missing'));
    state = openWorkbenchTab(state, sessionTab('existing'));

    state = pruneInvalidSessionWorkbenchTabs(state, new Set(['existing']));

    expect(state.tabs).toEqual([sessionTab('existing')]);
    expect(state.activeId).toBe('session:existing');
  });

  it('leaves the workbench empty when the deleted session owns every open tab', () => {
    let state = openWorkbenchTab({ tabs: [], recentIds: [] }, sessionTab('s1'));
    state = openWorkbenchTab(state, teamTab('s1'));

    state = closeSessionWorkbenchTabs(state, 's1');

    expect(state).toEqual({ tabs: [], activeId: undefined, recentIds: [] });
  });
});

describe('Explorer Git decorations', () => {
  it('aggregates file status onto directories', () => {
    const files: GitFile[] = [
      {
        path: 'src/nested/main.ts',
        indexStatus: 'modified',
        worktreeStatus: 'modified',
        indexStats: { additions: 1, deletions: 0 },
        worktreeStats: { additions: 2, deletions: 1 },
      },
      {
        path: 'new file.md',
        worktreeStatus: 'untracked',
        indexStats: { additions: 0, deletions: 0 },
        worktreeStats: { additions: 0, deletions: 0 },
      },
    ];
    expect(gitDecoration('src', files, true)).toBe('modified');
    expect(gitDecoration('new file.md', files)).toBe('untracked');
  });

  it('prefers the highest-priority status for a directory', () => {
    const files: GitFile[] = [
      { path: 'src/new.ts', worktreeStatus: 'untracked', indexStats: { additions: 0, deletions: 0 }, worktreeStats: { additions: 0, deletions: 0 } },
      { path: 'src/conflict.ts', worktreeStatus: 'conflicted', indexStats: { additions: 0, deletions: 0 }, worktreeStats: { additions: 0, deletions: 0 } },
    ];
    expect(gitDecoration('src', files, true)).toBe('conflicted');
  });
});
