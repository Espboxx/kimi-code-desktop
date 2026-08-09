import { describe, expect, it } from 'vitest';

import type { GitFile } from '../shared/desktop-api';
import { gitDecoration } from './git-tree';
import {
  activateWorkbenchTab,
  closeWorkbenchTab,
  diffTab,
  fileTab,
  openWorkbenchTab,
  restoreWorkbenchState,
  serializeWorkbenchState,
  sessionTab,
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
