import type { GitDiffArea, WorkspaceDiffSnapshot, WorkspaceFileSnapshot } from '../shared/desktop-api';

export interface SessionWorkbenchTab {
  readonly id: string;
  readonly kind: 'session';
  readonly sessionId: string;
}

export interface TeamWorkbenchTab {
  readonly id: string;
  readonly kind: 'team';
  readonly sessionId: string;
}

export interface FileWorkbenchTab {
  readonly id: string;
  readonly kind: 'file';
  readonly path: string;
  readonly loading: boolean;
  readonly file?: WorkspaceFileSnapshot;
  readonly content: string;
  readonly savedContent: string;
  readonly dirty: boolean;
  readonly conflict: boolean;
  readonly error?: string;
}

export interface DiffWorkbenchTab {
  readonly id: string;
  readonly kind: 'diff';
  readonly path: string;
  readonly area: GitDiffArea;
  readonly loading: boolean;
  readonly diff?: WorkspaceDiffSnapshot;
  readonly error?: string;
}

export type WorkbenchTab = SessionWorkbenchTab | TeamWorkbenchTab | FileWorkbenchTab | DiffWorkbenchTab;

export interface WorkbenchTabState {
  readonly tabs: readonly WorkbenchTab[];
  readonly activeId?: string;
  readonly recentIds: readonly string[];
}

interface PersistedWorkbenchState {
  readonly version: 1 | 2;
  readonly tabs: readonly PersistedWorkbenchTab[];
  readonly activeId?: string;
}

type PersistedWorkbenchTab =
  | { readonly kind: 'session'; readonly sessionId: string }
  | { readonly kind: 'team'; readonly sessionId: string }
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'diff'; readonly path: string; readonly area: GitDiffArea };

export const EMPTY_WORKBENCH: WorkbenchTabState = { tabs: [], recentIds: [] };

export function sessionTab(sessionId: string): SessionWorkbenchTab {
  return { id: `session:${sessionId}`, kind: 'session', sessionId };
}

export function teamTab(sessionId: string): TeamWorkbenchTab {
  return { id: `team:${sessionId}`, kind: 'team', sessionId };
}

export function fileTab(path: string): FileWorkbenchTab {
  return {
    id: `file:${path}`,
    kind: 'file',
    path,
    loading: true,
    content: '',
    savedContent: '',
    dirty: false,
    conflict: false,
  };
}

export function diffTab(path: string, area: GitDiffArea): DiffWorkbenchTab {
  return { id: `diff:${area}:${path}`, kind: 'diff', path, area, loading: true };
}

export function openWorkbenchTab(state: WorkbenchTabState, tab: WorkbenchTab): WorkbenchTabState {
  const exists = state.tabs.some((candidate) => candidate.id === tab.id);
  return {
    tabs: exists ? state.tabs : [...state.tabs, tab],
    activeId: tab.id,
    recentIds: touchRecent(state.recentIds, tab.id),
  };
}

export function ensureWorkbenchTab(
  state: WorkbenchTabState,
  tab: WorkbenchTab,
  activate = false,
): WorkbenchTabState {
  if (state.tabs.some((candidate) => candidate.id === tab.id)) {
    return activate ? activateWorkbenchTab(state, tab.id) : state;
  }
  return {
    tabs: [...state.tabs, tab],
    activeId: activate || state.activeId === undefined ? tab.id : state.activeId,
    recentIds: activate || state.activeId === undefined
      ? touchRecent(state.recentIds, tab.id)
      : state.recentIds,
  };
}

export function activateWorkbenchTab(state: WorkbenchTabState, id: string): WorkbenchTabState {
  if (!state.tabs.some((tab) => tab.id === id)) return state;
  return { ...state, activeId: id, recentIds: touchRecent(state.recentIds, id) };
}

export function patchWorkbenchTab(
  state: WorkbenchTabState,
  id: string,
  update: (tab: WorkbenchTab) => WorkbenchTab,
): WorkbenchTabState {
  let changed = false;
  const tabs = state.tabs.map((tab) => {
    if (tab.id !== id) return tab;
    changed = true;
    return update(tab);
  });
  return changed ? { ...state, tabs } : state;
}

export function closeWorkbenchTab(state: WorkbenchTabState, id: string): WorkbenchTabState {
  return removeWorkbenchTabs(state, new Set([id]));
}

export function closeSessionWorkbenchTabs(state: WorkbenchTabState, sessionId: string): WorkbenchTabState {
  return removeWorkbenchTabs(state, new Set(
    state.tabs
      .filter((tab) => (tab.kind === 'session' || tab.kind === 'team') && tab.sessionId === sessionId)
      .map((tab) => tab.id),
  ));
}

export function pruneInvalidSessionWorkbenchTabs(
  state: WorkbenchTabState,
  validSessionIds: ReadonlySet<string>,
): WorkbenchTabState {
  return removeWorkbenchTabs(state, new Set(
    state.tabs
      .filter((tab) => (tab.kind === 'session' || tab.kind === 'team') && !validSessionIds.has(tab.sessionId))
      .map((tab) => tab.id),
  ));
}

export function cycleWorkbenchTab(state: WorkbenchTabState, backwards = false): WorkbenchTabState {
  if (state.tabs.length < 2) return state;
  const index = Math.max(0, state.tabs.findIndex((tab) => tab.id === state.activeId));
  const offset = backwards ? -1 : 1;
  const next = state.tabs[(index + offset + state.tabs.length) % state.tabs.length];
  return next === undefined ? state : activateWorkbenchTab(state, next.id);
}

export function serializeWorkbenchState(state: WorkbenchTabState): string {
  const persisted: PersistedWorkbenchState = {
    version: 2,
    tabs: state.tabs.map((tab) => {
      if (tab.kind === 'session') return { kind: 'session', sessionId: tab.sessionId };
      if (tab.kind === 'team') return { kind: 'team', sessionId: tab.sessionId };
      if (tab.kind === 'file') return { kind: 'file', path: tab.path };
      return { kind: 'diff', path: tab.path, area: tab.area };
    }),
    activeId: state.activeId,
  };
  return JSON.stringify(persisted);
}

export function restoreWorkbenchState(
  value: string | null,
  validSessionIds: ReadonlySet<string>,
  validTeamSessionIds: ReadonlySet<string> = new Set(),
): WorkbenchTabState {
  if (value === null) return EMPTY_WORKBENCH;
  try {
    const parsed = JSON.parse(value) as Partial<PersistedWorkbenchState>;
    if ((parsed.version !== 1 && parsed.version !== 2) || !Array.isArray(parsed.tabs)) return EMPTY_WORKBENCH;
    const tabs: WorkbenchTab[] = [];
    for (const raw of parsed.tabs) {
      if (raw === null || typeof raw !== 'object') continue;
      if (raw.kind === 'session' && typeof raw.sessionId === 'string' && validSessionIds.has(raw.sessionId)) {
        tabs.push(sessionTab(raw.sessionId));
      } else if (raw.kind === 'team' && typeof raw.sessionId === 'string' && validTeamSessionIds.has(raw.sessionId)) {
        tabs.push(teamTab(raw.sessionId));
      } else if (raw.kind === 'file' && typeof raw.path === 'string' && raw.path.length > 0) {
        tabs.push(fileTab(raw.path));
      } else if (
        raw.kind === 'diff'
        && typeof raw.path === 'string'
        && (raw.area === 'staged' || raw.area === 'working' || raw.area === 'conflict')
      ) {
        tabs.push(diffTab(raw.path, raw.area));
      }
    }
    const activeId = typeof parsed.activeId === 'string' && tabs.some((tab) => tab.id === parsed.activeId)
      ? parsed.activeId
      : tabs[0]?.id;
    return { tabs, activeId, recentIds: activeId === undefined ? [] : [activeId] };
  } catch {
    return EMPTY_WORKBENCH;
  }
}

export function workbenchStorageKey(workspaceRoot: string): string {
  let hash = 2_166_136_261;
  for (const character of workspaceRoot.toLowerCase()) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return `kimi-desktop.workbench-tabs.v1.${(hash >>> 0).toString(16)}`;
}

function touchRecent(recentIds: readonly string[], id: string): readonly string[] {
  return [id, ...recentIds.filter((recent) => recent !== id)].slice(0, 50);
}

function removeWorkbenchTabs(state: WorkbenchTabState, ids: ReadonlySet<string>): WorkbenchTabState {
  if (ids.size === 0) return state;
  const firstRemovedIndex = state.tabs.findIndex((tab) => ids.has(tab.id));
  if (firstRemovedIndex < 0) return state;
  const tabs = state.tabs.filter((tab) => !ids.has(tab.id));
  const recentIds = state.recentIds.filter((recent) => !ids.has(recent));
  if (state.activeId !== undefined && !ids.has(state.activeId)) return { ...state, tabs, recentIds };
  const recent = recentIds.find((recentId) => tabs.some((tab) => tab.id === recentId));
  const adjacent = tabs[Math.min(firstRemovedIndex, Math.max(0, tabs.length - 1))]?.id;
  return { tabs, activeId: recent ?? adjacent, recentIds };
}
