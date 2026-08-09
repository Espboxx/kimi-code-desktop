import type { DesktopSurface } from '../shared/team-session';
import type { WorkbenchTab, WorkbenchTabState } from './workbench-tabs';

export type WorkbenchTabSurfaces = Readonly<Record<string, DesktopSurface>>;

export interface DesktopSurfaceState {
  readonly active: DesktopSurface;
  readonly tabSurfaces: WorkbenchTabSurfaces;
}

export const DEFAULT_DESKTOP_SURFACE_STATE: DesktopSurfaceState = {
  active: 'chat',
  tabSurfaces: {},
};

export function workbenchTabSurface(
  tab: WorkbenchTab,
  tabSurfaces: WorkbenchTabSurfaces,
): DesktopSurface {
  if (tab.kind === 'team' || tab.kind === 'agent') return 'team';
  if (tab.kind === 'session') return 'chat';
  return tabSurfaces[tab.id] ?? 'chat';
}

export function workbenchForSurface(
  state: WorkbenchTabState,
  surface: DesktopSurface,
  tabSurfaces: WorkbenchTabSurfaces,
): WorkbenchTabState {
  const tabs = state.tabs.filter((tab) => workbenchTabSurface(tab, tabSurfaces) === surface);
  const activeId = tabs.some((tab) => tab.id === state.activeId) ? state.activeId : tabs[0]?.id;
  return {
    tabs,
    activeId,
    recentIds: state.recentIds.filter((id) => tabs.some((tab) => tab.id === id)),
  };
}

export function assignWorkbenchTabSurface(
  current: WorkbenchTabSurfaces,
  tab: WorkbenchTab,
  surface: DesktopSurface,
): WorkbenchTabSurfaces {
  if (tab.kind === 'session' || tab.kind === 'team' || tab.kind === 'agent') return current;
  return current[tab.id] === surface ? current : { ...current, [tab.id]: surface };
}

export function pruneWorkbenchTabSurfaces(
  current: WorkbenchTabSurfaces,
  tabs: readonly WorkbenchTab[],
): WorkbenchTabSurfaces {
  const ids = new Set(tabs.map((tab) => tab.id));
  const entries = Object.entries(current).filter(([id]) => ids.has(id));
  return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries);
}

export function serializeDesktopSurfaceState(state: DesktopSurfaceState): string {
  return JSON.stringify({ version: 1, active: state.active, tabSurfaces: state.tabSurfaces });
}

export function restoreDesktopSurfaceState(value: string | null): DesktopSurfaceState {
  if (value === null) return DEFAULT_DESKTOP_SURFACE_STATE;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (parsed['version'] !== 1) return DEFAULT_DESKTOP_SURFACE_STATE;
    const active = parsed['active'] === 'team' ? 'team' : 'chat';
    const raw = parsed['tabSurfaces'];
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { active, tabSurfaces: {} };
    }
    const tabSurfaces = Object.fromEntries(Object.entries(raw).filter(
      (entry): entry is [string, DesktopSurface] => entry[1] === 'chat' || entry[1] === 'team',
    ));
    return { active, tabSurfaces };
  } catch {
    return DEFAULT_DESKTOP_SURFACE_STATE;
  }
}

export function desktopSurfaceStorageKey(workspaceKey: string): string {
  return `${workspaceKey}.surfaces`;
}
