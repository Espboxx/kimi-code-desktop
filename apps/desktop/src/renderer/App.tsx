import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  Check,
  ChevronDown,
  CircleDashed,
  FileOutput,
  FolderOpen,
  GitFork,
  Moon,
  Pencil,
  Settings,
  Sun,
  Trash2,
  Users,
  X,
} from 'lucide-react';

import type { GitDiffArea, SessionListItem } from '../shared/desktop-api';
import type { DesktopSurface } from '../shared/team-session';
import { buildAgentActivityForest } from './agent-activity';
import { Composer } from './Composer';
import { modelImageInputSupport } from './composer-utils';
import { CreateTeamDialog } from './CreateTeamDialog';
import {
  assignWorkbenchTabSurface,
  desktopSurfaceStorageKey,
  pruneWorkbenchTabSurfaces,
  restoreDesktopSurfaceState,
  serializeDesktopSurfaceState,
  workbenchForSurface,
  type WorkbenchTabSurfaces,
} from './desktop-surfaces';
import { useDesktopState } from './desktop-state';
import { DirtyFilesDialog } from './DirtyFilesDialog';
import { Inspector } from './Inspector';
import { PendingInteractionDock } from './PendingInteractionDock';
import { SettingsDialog } from './SettingsDialog';
import { Sidebar, type SessionAction } from './Sidebar';
import { TeamPage } from './TeamPage';
import { TeamSidebar } from './TeamSidebar';
import { persistTheme, readTheme, toggleTheme } from './theme';
import { Timeline } from './Timeline';
import type { FileOperationTarget } from './tool-display';
import { classNames, record, text } from './ui-utils';
import {
  FileEditorView,
  GitDiffEditorView,
  MemoryDiffDialog,
  OperationDiffEditorView,
} from './WorkbenchEditor';
import { WorkbenchTabs } from './WorkbenchTabs';
import {
  activateWorkbenchTab,
  agentTab,
  closeWorkbenchTab,
  closeSessionWorkbenchTabs,
  cycleWorkbenchTab,
  EMPTY_WORKBENCH,
  ensureWorkbenchTab,
  diffTab,
  fileTab,
  openWorkbenchTab,
  operationDiffTab,
  patchWorkbenchTab,
  pruneInvalidSessionWorkbenchTabs,
  restoreWorkbenchState,
  serializeWorkbenchState,
  sessionTab,
  teamTab,
  workbenchStorageKey,
  type FileWorkbenchTab,
  type WorkbenchTab,
  type WorkbenchTabState,
} from './workbench-tabs';

interface SessionDialogState {
  readonly session: SessionListItem;
  readonly action: SessionAction;
  readonly running?: boolean;
}

interface RendererError {
  readonly code: string;
  readonly message: string;
}

type DirtyPrompt =
  | { readonly kind: 'tab'; readonly tabId: string }
  | { readonly kind: 'workspace' }
  | { readonly kind: 'host'; readonly requestId: string };

interface MemoryDiffState {
  readonly path: string;
  readonly disk: string;
  readonly editor: string;
  readonly languageId: string;
}

interface TeamCreationState {
  readonly clientMessageId: string;
  readonly sessionId?: string;
}

export function App() {
  const state = useDesktopState();
  const snapshot = state.snapshot;
  const activeSessionId = snapshot?.activeSessionId;
  const sessionIndexKey = snapshot?.sessions.map((session) => `${session.id}:${session.surface}`).join('\0') ?? '';
  const [selectedAgents, setSelectedAgents] = useState<Record<string, string>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [workspaceChoosing, setWorkspaceChoosing] = useState(false);
  const [theme, setTheme] = useState(() => readTheme(
    window.localStorage,
    window.matchMedia('(prefers-color-scheme: dark)').matches,
  ));
  const [sessionDialog, setSessionDialog] = useState<SessionDialogState>();
  const [taskOutput, setTaskOutput] = useState<{ taskId: string; output?: string }>();
  const [actionError, setActionError] = useState<RendererError>();
  const [workbench, setWorkbench] = useState<WorkbenchTabState>(EMPTY_WORKBENCH);
  const [surface, setSurface] = useState<DesktopSurface>('chat');
  const [tabSurfaces, setTabSurfaces] = useState<WorkbenchTabSurfaces>({});
  const [teamCreation, setTeamCreation] = useState<TeamCreationState>();
  const [hydratedRoot, setHydratedRoot] = useState<string>();
  const [dirtyPrompt, setDirtyPrompt] = useState<DirtyPrompt>();
  const [dirtyPromptBusy, setDirtyPromptBusy] = useState(false);
  const [dirtyPromptError, setDirtyPromptError] = useState<string>();
  const [memoryDiff, setMemoryDiff] = useState<MemoryDiffState>();
  const [planPendingSessions, setPlanPendingSessions] = useState<ReadonlySet<string>>(() => new Set());
  const [timelineFollowRequest, setTimelineFollowRequest] = useState(0);
  const [seenTeamSeqs, setSeenTeamSeqs] = useState<Record<string, number>>({});
  const workbenchRef = useRef(workbench);
  const tabSurfacesRef = useRef(tabSurfaces);
  const loadingTabs = useRef(new Set<string>());
  const savingPaths = useRef(new Set<string>());
  const sessionActivation = useRef<{ desired?: string; running: boolean; target?: string }>({ running: false });
  const validSessionIds = useRef<ReadonlySet<string>>(new Set());
  const activeSessionIdRef = useRef<string | undefined>(undefined);
  const deletingSessionIds = useRef(new Set<string>());
  const suppressEmptyWorkbenchAutoOpen = useRef(false);
  const planPendingRef = useRef(new Set<string>());
  const knownTeamSessions = useRef(new Set<string>());
  const closedTeamTabs = useRef(new Set<string>());
  workbenchRef.current = workbench;
  tabSurfacesRef.current = tabSurfaces;
  validSessionIds.current = new Set(snapshot?.sessions.map((session) => session.id) ?? []);
  activeSessionIdRef.current = activeSessionId;

  const visibleWorkbench = workbenchForSurface(workbench, surface, tabSurfaces);
  const activeTab = visibleWorkbench.tabs.find((tab) => tab.id === visibleWorkbench.activeId);
  const activeWorkbenchSessionId = activeTab?.kind === 'session' || activeTab?.kind === 'team' || activeTab?.kind === 'agent'
    ? activeTab.sessionId
    : undefined;
  const selectedAgentSessionId = activeWorkbenchSessionId ?? activeSessionId;
  const selectedAgentId = activeTab?.kind === 'agent'
    ? activeTab.agentId
    : selectedAgentSessionId === undefined ? 'main' : selectedAgents[selectedAgentSessionId] ?? 'main';
  const setSelectedAgentId = useCallback((agentId: string) => {
    if (selectedAgentSessionId === undefined) return;
    setSelectedAgents((current) => current[selectedAgentSessionId] === agentId
      ? current
      : { ...current, [selectedAgentSessionId]: agentId });
  }, [selectedAgentSessionId]);
  const agentActivity = useMemo(
    () => buildAgentActivityForest(state.transcript),
    [state.transcript, state.transcriptVersion],
  );
  const todos = state.transcript?.getAgent('main')?.getTodo('todo')?.items ?? [];
  const todoReadOnly = snapshot?.session.status?.busy === true ||
    agentActivity.counts.running > 0 ||
    agentActivity.counts.waiting > 0;

  const activateSessionRuntime = useCallback((sessionId: string) => {
    if (
      activeSessionIdRef.current === sessionId ||
      !validSessionIds.current.has(sessionId) ||
      deletingSessionIds.current.has(sessionId)
    ) return;
    const activation = sessionActivation.current;
    if (activation.desired === sessionId || activation.target === sessionId) return;
    activation.desired = sessionId;
    if (activation.running) return;
    activation.running = true;
    void (async () => {
      try {
        while (activation.desired !== undefined) {
          const target = activation.desired;
          activation.desired = undefined;
          if (
            activeSessionIdRef.current === target ||
            !validSessionIds.current.has(target) ||
            deletingSessionIds.current.has(target)
          ) continue;
          activation.target = target;
          try {
            await window.kimiDesktop.session.resume(target);
          } catch (error) {
            if (
              activation.desired === undefined &&
              validSessionIds.current.has(target) &&
              !deletingSessionIds.current.has(target)
            ) {
              setActionError(rendererError(error, 'session.resume_failed'));
            }
          } finally {
            activation.target = undefined;
          }
        }
      } finally {
        activation.running = false;
      }
    })();
  }, []);

  const loadFile = useCallback(async (id: string, path: string) => {
    if (loadingTabs.current.has(id)) return;
    loadingTabs.current.add(id);
    setWorkbench((current) => patchWorkbenchTab(current, id, (tab) => tab.kind === 'file' ? { ...tab, loading: true, error: undefined } : tab));
    try {
      const file = await window.kimiDesktop.workspace.readFile(path);
      setWorkbench((current) => patchWorkbenchTab(current, id, (tab) => tab.kind === 'file' ? {
        ...tab,
        loading: false,
        file,
        content: file.content ?? '',
        savedContent: file.content ?? '',
        dirty: false,
        conflict: false,
        error: undefined,
      } : tab));
    } catch (error) {
      setWorkbench((current) => patchWorkbenchTab(current, id, (tab) => tab.kind === 'file' ? {
        ...tab,
        loading: false,
        error: errorMessage(error),
      } : tab));
    } finally {
      loadingTabs.current.delete(id);
    }
  }, []);

  const loadDiff = useCallback(async (id: string, path: string, area: GitDiffArea) => {
    if (loadingTabs.current.has(id)) return;
    loadingTabs.current.add(id);
    setWorkbench((current) => patchWorkbenchTab(current, id, (tab) => tab.kind === 'diff' ? { ...tab, loading: true, error: undefined } : tab));
    try {
      const diff = await window.kimiDesktop.workspace.readDiff(path, area);
      setWorkbench((current) => patchWorkbenchTab(current, id, (tab) => tab.kind === 'diff' ? {
        ...tab,
        loading: false,
        diff,
        error: undefined,
      } : tab));
    } catch (error) {
      setWorkbench((current) => patchWorkbenchTab(current, id, (tab) => tab.kind === 'diff' ? {
        ...tab,
        loading: false,
        error: errorMessage(error),
      } : tab));
    } finally {
      loadingTabs.current.delete(id);
    }
  }, []);

  const saveFile = useCallback(async (id: string, force = false): Promise<void> => {
    const tab = workbenchRef.current.tabs.find((candidate): candidate is FileWorkbenchTab => candidate.id === id && candidate.kind === 'file');
    if (tab?.file === undefined || tab.file.kind !== 'text' || !tab.dirty) return;
    savingPaths.current.add(tab.path);
    try {
      const file = await window.kimiDesktop.workspace.writeFile(
        tab.path,
        tab.content,
        tab.file.version,
        force,
        tab.file.bom,
      );
      setWorkbench((current) => patchWorkbenchTab(current, id, (candidate) => candidate.kind === 'file' ? {
        ...candidate,
        file,
        savedContent: candidate.content,
        dirty: false,
        conflict: false,
        error: undefined,
      } : candidate));
    } finally {
      savingPaths.current.delete(tab.path);
    }
  }, []);

  const dirtyTabs = useMemo(() => workbench.tabs.filter((tab): tab is FileWorkbenchTab => tab.kind === 'file' && tab.dirty), [workbench.tabs]);
  const monacoTheme = theme === 'dark' ? 'vs-dark' : 'vs';

  useEffect(() => {
    if (snapshot === undefined || snapshot.loading) return;
    const root = snapshot.workspace.root;
    if (root.length === 0 || hydratedRoot === root) return;
    const restored = restoreWorkbenchState(
      localStorage.getItem(workbenchStorageKey(root)),
      new Set(snapshot.sessions.map((session) => session.id)),
      new Set(snapshot.sessions.map((session) => session.id)),
    );
    const restoredSurfaces = restoreDesktopSurfaceState(
      localStorage.getItem(desktopSurfaceStorageKey(workbenchStorageKey(root))),
    );
    const initial = restored.tabs.length === 0 && snapshot.activeSessionId !== undefined
      ? openWorkbenchTab(restored, sessionTab(snapshot.activeSessionId))
      : restored;
    setWorkbench(initial);
    setSurface(restoredSurfaces.active);
    setTabSurfaces(restoredSurfaces.tabSurfaces);
    suppressEmptyWorkbenchAutoOpen.current = false;
    knownTeamSessions.current = new Set(Object.keys(state.teams));
    closedTeamTabs.current.clear();
    setSeenTeamSeqs(readSeenTeamSeqs(teamSeenStorageKey(root)));
    setHydratedRoot(root);
    loadingTabs.current.clear();
  }, [hydratedRoot, snapshot, state.teams]);

  useEffect(() => {
    if (snapshot === undefined || hydratedRoot !== snapshot.workspace.root) return;
    localStorage.setItem(workbenchStorageKey(snapshot.workspace.root), serializeWorkbenchState(workbench));
    localStorage.setItem(
      desktopSurfaceStorageKey(workbenchStorageKey(snapshot.workspace.root)),
      serializeDesktopSurfaceState({ active: surface, tabSurfaces }),
    );
  }, [hydratedRoot, snapshot, surface, tabSurfaces, workbench]);

  useEffect(() => {
    setTabSurfaces((current) => pruneWorkbenchTabSurfaces(current, workbench.tabs));
  }, [workbench.tabs]);

  useEffect(() => {
    if (snapshot === undefined || hydratedRoot !== snapshot.workspace.root) return;
    localStorage.setItem(teamSeenStorageKey(snapshot.workspace.root), JSON.stringify(seenTeamSeqs));
  }, [hydratedRoot, seenTeamSeqs, snapshot]);

  useEffect(() => {
    if (snapshot === undefined || snapshot.loading || hydratedRoot !== snapshot.workspace.root) return;
    const currentSessionIds = new Set(snapshot.sessions.map((session) => session.id));
    setWorkbench((current) => {
      const next = pruneInvalidSessionWorkbenchTabs(current, currentSessionIds);
      if (current.tabs.length > 0 && next.tabs.length === 0) suppressEmptyWorkbenchAutoOpen.current = true;
      return next;
    });
    setSelectedAgents((current) => pruneSessionRecord(current, currentSessionIds));
    setSeenTeamSeqs((current) => pruneSessionRecord(current, currentSessionIds));
    for (const sessionId of knownTeamSessions.current) {
      if (!currentSessionIds.has(sessionId)) knownTeamSessions.current.delete(sessionId);
    }
    for (const sessionId of closedTeamTabs.current) {
      if (!currentSessionIds.has(sessionId)) closedTeamTabs.current.delete(sessionId);
    }
    let planPendingChanged = false;
    for (const sessionId of planPendingRef.current) {
      if (currentSessionIds.has(sessionId)) continue;
      planPendingRef.current.delete(sessionId);
      planPendingChanged = true;
    }
    if (planPendingChanged) setPlanPendingSessions(new Set(planPendingRef.current));
    const desired = sessionActivation.current.desired;
    if (desired !== undefined && !currentSessionIds.has(desired)) sessionActivation.current.desired = undefined;
  }, [hydratedRoot, sessionIndexKey, snapshot?.loading, snapshot?.workspace.root]);

  useEffect(() => {
    if (snapshot === undefined || hydratedRoot !== snapshot.workspace.root) return;
    for (const sessionId of Object.keys(state.teams)) {
      if (!validSessionIds.current.has(sessionId)) continue;
      if (knownTeamSessions.current.has(sessionId)) continue;
      knownTeamSessions.current.add(sessionId);
      if (closedTeamTabs.current.has(sessionId)) continue;
      setWorkbench((current) => ensureWorkbenchTab(current, teamTab(sessionId), current.tabs.length === 0));
    }
  }, [hydratedRoot, sessionIndexKey, snapshot?.workspace.root, state.teamVersion, state.teams]);

  useEffect(() => {
    const sessionId = snapshot?.activeSessionId;
    if (
      hydratedRoot !== snapshot?.workspace.root ||
      sessionId === undefined ||
      workbenchForSurface(workbench, 'chat', tabSurfaces).tabs.length > 0 ||
      suppressEmptyWorkbenchAutoOpen.current
    ) return;
    setWorkbench((current) => workbenchForSurface(current, 'chat', tabSurfacesRef.current).tabs.length === 0
      ? openWorkbenchTab(current, sessionTab(sessionId))
      : current);
  }, [hydratedRoot, snapshot?.activeSessionId, snapshot?.workspace.root, tabSurfaces, workbench]);

  useEffect(() => {
    if (hydratedRoot === undefined) return;
    for (const tab of workbench.tabs) {
      if (tab.kind === 'file' && tab.loading) void loadFile(tab.id, tab.path);
      if (tab.kind === 'diff' && tab.loading) void loadDiff(tab.id, tab.path, tab.area);
    }
  }, [hydratedRoot, loadDiff, loadFile, workbench.tabs]);

  useEffect(() => {
    if (
      activeWorkbenchSessionId === undefined ||
      snapshot === undefined ||
      snapshot.activeSessionId === activeWorkbenchSessionId ||
      !validSessionIds.current.has(activeWorkbenchSessionId) ||
      deletingSessionIds.current.has(activeWorkbenchSessionId)
    ) return;
    activateSessionRuntime(activeWorkbenchSessionId);
  }, [activateSessionRuntime, activeWorkbenchSessionId, sessionIndexKey, snapshot?.activeSessionId]);

  useEffect(() => {
    const changed = new Set(state.workspaceChange.paths);
    if (state.workspaceChange.version === 0) return;
    for (const tab of workbenchRef.current.tabs) {
      if (tab.kind === 'file' && changed.has(tab.path) && !savingPaths.current.has(tab.path)) {
        if (tab.dirty) {
          setWorkbench((current) => patchWorkbenchTab(current, tab.id, (candidate) => candidate.kind === 'file' ? { ...candidate, conflict: true } : candidate));
        } else {
          void loadFile(tab.id, tab.path);
        }
      }
      if (tab.kind === 'diff' && (changed.size === 0 || changed.has(tab.path))) {
        void loadDiff(tab.id, tab.path, tab.area);
      }
    }
  }, [loadDiff, loadFile, state.workspaceChange]);

  useEffect(() => {
    void window.kimiDesktop.host.setDirtyFiles(dirtyTabs.map((tab) => tab.path));
  }, [dirtyTabs]);

  useEffect(() => {
    if (state.closeRequest === undefined) return;
    if (dirtyTabs.length === 0) {
      void window.kimiDesktop.host.resolveClose(state.closeRequest.requestId, 'proceed');
      state.dismissCloseRequest();
      return;
    }
    setDirtyPrompt({ kind: 'host', requestId: state.closeRequest.requestId });
    setDirtyPromptError(undefined);
  }, [dirtyTabs.length, state.closeRequest]);

  useEffect(() => {
    setActionError(undefined);
  }, [snapshot?.activeSessionId]);

  useEffect(() => {
    if (
      activeSessionId !== undefined &&
      state.transcript !== undefined &&
      state.transcript.getAgent(selectedAgentId) === undefined
    ) {
      setSelectedAgents((current) => ({ ...current, [activeSessionId]: 'main' }));
    }
  }, [activeSessionId, selectedAgentId, state.transcript, state.transcriptVersion]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset['theme'] = theme;
    persistTheme(window.localStorage, theme);
  }, [theme]);

  const requestCloseTab = useCallback((tab: WorkbenchTab) => {
    if (tab.kind === 'file' && tab.dirty) {
      setDirtyPrompt({ kind: 'tab', tabId: tab.id });
      setDirtyPromptError(undefined);
      return;
    }
    if (tab.kind === 'team') closedTeamTabs.current.add(tab.sessionId);
    setWorkbench((current) => {
      const next = closeWorkbenchTab(current, tab.id);
      const currentVisible = workbenchForSurface(current, surface, tabSurfacesRef.current);
      const nextVisible = workbenchForSurface(next, surface, tabSurfacesRef.current);
      if (currentVisible.tabs.length > 0 && nextVisible.tabs.length === 0) suppressEmptyWorkbenchAutoOpen.current = true;
      return next;
    });
  }, [surface]);

  const activateTab = useCallback((tab: WorkbenchTab) => {
    setWorkbench((current) => activateWorkbenchTab(current, tab.id));
  }, []);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const current = workbenchRef.current;
      const visible = workbenchForSurface(current, surface, tabSurfacesRef.current);
      const selected = visible.tabs.find((tab) => tab.id === visible.activeId);
      if (event.key.toLowerCase() === 's' && selected?.kind === 'file') {
        event.preventDefault();
        void saveFile(selected.id, selected.conflict).catch((error) => setActionError(rendererError(error, 'workspace.save_failed')));
      } else if (event.key.toLowerCase() === 'w' && selected !== undefined) {
        event.preventDefault();
        requestCloseTab(selected);
      } else if (event.key === 'Tab') {
        event.preventDefault();
        setWorkbench((state) => {
          const next = cycleWorkbenchTab(
            workbenchForSurface(state, surface, tabSurfacesRef.current),
            event.shiftKey,
          );
          return next.activeId === undefined ? state : activateWorkbenchTab(state, next.activeId);
        });
      }
    };
    window.addEventListener('keydown', listener, { capture: true });
    return () => window.removeEventListener('keydown', listener, { capture: true });
  }, [requestCloseTab, saveFile, surface]);

  const setSessionPlanMode = useCallback(async (sessionId: string, enabled: boolean): Promise<void> => {
    if (planPendingRef.current.has(sessionId)) return;
    planPendingRef.current.add(sessionId);
    setPlanPendingSessions(new Set(planPendingRef.current));
    setActionError(undefined);
    try {
      await window.kimiDesktop.turn.setPlanMode(enabled, sessionId);
    } catch (error) {
      setActionError(rendererError(error, 'session.plan_mode_failed'));
    } finally {
      planPendingRef.current.delete(sessionId);
      setPlanPendingSessions(new Set(planPendingRef.current));
    }
  }, []);
  const setPlanMode = useCallback(async (enabled: boolean): Promise<void> => {
    if (activeSessionId !== undefined) await setSessionPlanMode(activeSessionId, enabled);
  }, [activeSessionId, setSessionPlanMode]);
  const deleteSession = useCallback(async (sessionId: string): Promise<void> => {
    if (deletingSessionIds.current.has(sessionId)) return;
    const previousAutoOpenSuppression = suppressEmptyWorkbenchAutoOpen.current;
    suppressEmptyWorkbenchAutoOpen.current = true;
    deletingSessionIds.current.add(sessionId);
    if (sessionActivation.current.desired === sessionId) sessionActivation.current.desired = undefined;
    setActionError(undefined);
    try {
      await window.kimiDesktop.session.delete(sessionId);
      setWorkbench((current) => closeSessionWorkbenchTabs(current, sessionId));
      setSelectedAgents((current) => deleteSessionRecord(current, sessionId));
      setSeenTeamSeqs((current) => deleteSessionRecord(current, sessionId));
      knownTeamSessions.current.delete(sessionId);
      closedTeamTabs.current.delete(sessionId);
      if (planPendingRef.current.delete(sessionId)) {
        setPlanPendingSessions(new Set(planPendingRef.current));
      }
    } catch (error) {
      suppressEmptyWorkbenchAutoOpen.current = previousAutoOpenSuppression;
      throw error;
    } finally {
      deletingSessionIds.current.delete(sessionId);
    }
  }, []);

  if (snapshot === undefined || snapshot.loading) {
    return <div className="app-loading"><CircleDashed className="spin" size={22} /><span>正在启动 Kimi Code Desktop</span></div>;
  }

  const status = snapshot.session.status;
  const selectedSession = activeTab?.kind === 'session' || activeTab?.kind === 'team' || activeTab?.kind === 'agent'
    ? snapshot.sessions.find((session) => session.id === activeTab.sessionId)
    : snapshot.sessions.find((session) => session.id === snapshot.activeSessionId);
  const transcript = state.transcript?.getAgent(selectedAgentId) ?? state.transcript?.getAgent('main');
  const planModePending = activeSessionId !== undefined && planPendingSessions.has(activeSessionId);
  const modelOptions = Object.entries(record(snapshot.config.value['models'])).map(([id, raw]) => ({
    id,
    label: text(record(raw)['displayName'], id),
    imageInput: modelImageInputSupport(raw),
  }));
  const legacyTeamSessionIds = new Set(workbench.tabs.flatMap((tab) => (
    tab.kind === 'team' || tab.kind === 'agent' ? [tab.sessionId] : []
  )));
  const teamSessionIds = new Set([
    ...snapshot.sessions.filter((session) => session.surface === 'team').map((session) => session.id),
    ...Object.keys(state.teams),
    ...legacyTeamSessionIds,
  ]);
  const teamSessions = snapshot.sessions.filter((session) => teamSessionIds.has(session.id));
  const chatSessions = snapshot.sessions.filter((session) => !teamSessionIds.has(session.id));
  const openSessionIds = new Set(visibleWorkbench.tabs.filter((tab) => tab.kind === 'session').map((tab) => tab.sessionId));
  const activeFilePath = activeTab?.kind === 'file' || activeTab?.kind === 'diff' || activeTab?.kind === 'operation-diff'
    ? activeTab.path
    : undefined;

  const openFile = (path: string) => {
    suppressEmptyWorkbenchAutoOpen.current = false;
    const tab = fileTab(path);
    setTabSurfaces((current) => assignWorkbenchTabSurface(current, tab, surface));
    setWorkbench((current) => openWorkbenchTab(current, tab));
  };
  const openGitDiff = (path: string) => {
    suppressEmptyWorkbenchAutoOpen.current = false;
    const tab = diffTab(path, 'working');
    setTabSurfaces((current) => assignWorkbenchTabSurface(current, tab, surface));
    setWorkbench((current) => openWorkbenchTab(current, tab));
  };
  const openFileOperation = (target: FileOperationTarget) => {
    suppressEmptyWorkbenchAutoOpen.current = false;
    const before = target.before;
    const after = target.after;
    if (target.operation === 'edit' && before !== undefined && after !== undefined) {
      const tab = operationDiffTab(
        target.toolCallId,
        target.path,
        before,
        after,
      );
      setTabSurfaces((current) => assignWorkbenchTabSurface(current, tab, surface));
      setWorkbench((current) => openWorkbenchTab(current, tab));
      return;
    }
    openFile(target.path);
  };
  const openSession = (sessionId: string) => {
    suppressEmptyWorkbenchAutoOpen.current = false;
    setSurface('chat');
    const tab = sessionTab(sessionId);
    setWorkbench((current) => openWorkbenchTab(current, tab));
  };
  const openTeam = (sessionId: string) => {
    suppressEmptyWorkbenchAutoOpen.current = false;
    setSurface('team');
    closedTeamTabs.current.delete(sessionId);
    setWorkbench((current) => openWorkbenchTab(current, teamTab(sessionId)));
  };
  const selectTeamAgent = (sessionId: string, agentId: string) => {
    suppressEmptyWorkbenchAutoOpen.current = false;
    setSurface('team');
    setSelectedAgents((current) => ({ ...current, [sessionId]: agentId }));
    setWorkbench((current) => openWorkbenchTab(current, agentTab(sessionId, agentId)));
  };
  const markTeamSeen = (sessionId: string, channelSeq: number) => {
    setSeenTeamSeqs((current) => (current[sessionId] ?? 0) >= channelSeq
      ? current
      : { ...current, [sessionId]: channelSeq });
  };
  const teamBadges = Object.fromEntries(Object.entries(state.teams).map(([sessionId, teamState]) => [sessionId, {
    unread: Math.max(0, teamState.snapshot.latestChannelSeq - (seenTeamSeqs[sessionId] ?? 0)),
    running: teamState.snapshot.assignments.filter((assignment) => [
      'queued',
      'blocked',
      'ready',
      'running',
      'awaiting_validation',
      'integrating',
    ].includes(assignment.status)).length,
    failed: teamState.snapshot.assignments.filter((assignment) => assignment.status === 'failed').length,
  }]));
  const teamAgentLabels = Object.fromEntries(Object.entries(state.teams).flatMap(([sessionId, teamState]) =>
    teamState.snapshot.members.map((member) => {
      const assignment = teamState.snapshot.assignments.findLast(
        (candidate) => candidate.agentId === member.agentId,
      );
      return [
        `${sessionId}:${member.agentId}`,
        member.displayName ?? assignment?.displayName ?? (member.agentId === 'main' ? '组长' : member.agentId),
      ];
    }),
  ));
  const createSession = async () => openSession(await window.kimiDesktop.session.create());
  const selectSurface = (next: DesktopSurface) => {
    if (next === surface) return;
    setSurface(next);
    setWorkbench((current) => {
      const target = workbenchForSurface(current, next, tabSurfacesRef.current);
      const id = target.recentIds[0] ?? target.tabs[0]?.id;
      return id === undefined ? current : activateWorkbenchTab(current, id);
    });
  };
  const beginTeamCreation = () => {
    setSurface('team');
    setTeamCreation({ clientMessageId: crypto.randomUUID() });
  };
  const createTeamTask = async (
    objective: string,
    permission: 'current' | 'yolo',
    model?: string,
  ) => {
    if (teamCreation === undefined) return;
    let sessionId = teamCreation.sessionId;
    if (sessionId === undefined) {
      sessionId = await window.kimiDesktop.session.create({
        surface: 'team',
        model,
        permission: permission === 'yolo' ? 'yolo' : undefined,
      });
      setTeamCreation((current) => current === undefined ? current : { ...current, sessionId });
      openTeam(sessionId);
    }
    await window.kimiDesktop.session.rename(sessionId, teamTaskTitle(objective));
    await window.kimiDesktop.team.submit(sessionId, objective, teamCreation.clientMessageId);
    setTeamCreation(undefined);
  };
  const selectWorkspace = async () => {
    setWorkspaceChoosing(true);
    setActionError(undefined);
    try {
      await window.kimiDesktop.workspace.choose();
    } catch (error) {
      setActionError(rendererError(error, 'workspace.open_failed'));
    } finally {
      setWorkspaceChoosing(false);
    }
  };
  const chooseWorkspace = () => {
    if (dirtyTabs.length > 0) {
      setDirtyPrompt({ kind: 'workspace' });
      setDirtyPromptError(undefined);
    } else {
      void selectWorkspace();
    }
  };
  const reloadFile = (tab: FileWorkbenchTab) => void loadFile(tab.id, tab.path);
  const compareConflict = async (tab: FileWorkbenchTab) => {
    const disk = await window.kimiDesktop.workspace.readFile(tab.path);
    if (disk.kind !== 'text' || disk.content === undefined) {
      setActionError({ code: 'workspace.compare_unsupported', message: disk.readOnlyReason ?? '磁盘内容无法比较' });
      return;
    }
    setMemoryDiff({ path: tab.path, disk: disk.content, editor: tab.content, languageId: disk.languageId });
  };
  const cycleTheme = () => setTheme(toggleTheme);

  const dirtyPromptPaths = dirtyPrompt?.kind === 'tab'
    ? dirtyTabs.filter((tab) => tab.id === dirtyPrompt.tabId).map((tab) => tab.path)
    : dirtyTabs.map((tab) => tab.path);
  const finishDirtyPrompt = async (save: boolean) => {
    if (dirtyPrompt === undefined) return;
    setDirtyPromptBusy(true);
    setDirtyPromptError(undefined);
    try {
      if (save) {
        const targets = dirtyPrompt.kind === 'tab'
          ? dirtyTabs.filter((tab) => tab.id === dirtyPrompt.tabId)
          : dirtyTabs;
        for (const tab of targets) await saveFile(tab.id, false);
      }
      if (dirtyPrompt.kind === 'tab') {
        setWorkbench((current) => {
          const next = closeWorkbenchTab(current, dirtyPrompt.tabId);
          if (current.tabs.length > 0 && next.tabs.length === 0) suppressEmptyWorkbenchAutoOpen.current = true;
          return next;
        });
      } else if (dirtyPrompt.kind === 'workspace') {
        await window.kimiDesktop.workspace.choose();
      } else {
        await window.kimiDesktop.host.resolveClose(dirtyPrompt.requestId, 'proceed');
        state.dismissCloseRequest();
      }
      setDirtyPrompt(undefined);
    } catch (error) {
      setDirtyPromptError(errorMessage(error));
    } finally {
      setDirtyPromptBusy(false);
    }
  };
  const cancelDirtyPrompt = () => {
    if (dirtyPrompt?.kind === 'host') {
      void window.kimiDesktop.host.resolveClose(dirtyPrompt.requestId, 'cancel');
      state.dismissCloseRequest();
    }
    setDirtyPrompt(undefined);
    setDirtyPromptError(undefined);
  };
  const workspaceSelected = snapshot.workspace.root.length > 0;

  return (
    <div className="desktop-app">
      <header className="topbar">
        <div className="brand-block">
          <span className="brand-mark"><Bot size={17} /></span>
          <strong>Kimi Code Desktop</strong>
          <span className={classNames('runtime-state', status?.busy && 'busy')}><span />{status?.busy ? 'Working' : !workspaceSelected ? '未选择工作区' : snapshot.activeSessionId === undefined ? 'No session' : 'Ready'}</span>
        </div>
        <nav className="surface-switcher" aria-label="工作台模式">
          <button className={classNames(surface === 'chat' && 'active')} aria-pressed={surface === 'chat'} onClick={() => selectSurface('chat')}><Bot size={13} />会话</button>
          <button className={classNames(surface === 'team' && 'active')} aria-pressed={surface === 'team'} onClick={() => selectSurface('team')}><Users size={13} />团队</button>
        </nav>
        <div className="top-actions">
          <button
            className="icon-button"
            onClick={cycleTheme}
            title={theme === 'light' ? '切换到深色主题' : '切换到浅色主题'}
            aria-label={theme === 'light' ? '切换到深色主题' : '切换到浅色主题'}
          >
            {theme === 'light' ? <Sun size={15} /> : <Moon size={15} />}
          </button>
          <button className="icon-button" onClick={() => setSettingsOpen(true)} title="设置"><Settings size={16} /></button>
        </div>
      </header>

      {workspaceSelected && surface === 'chat' ? <div className="workbench">
        <Sidebar
          workspace={snapshot.workspace}
          tree={snapshot.tree}
          gitFiles={snapshot.gitFiles}
          workspaceRevision={state.workspaceChange.version}
          sessions={chatSessions}
          activeSessionId={snapshot.activeSessionId}
          activeWorkbenchSessionId={activeWorkbenchSessionId}
          activeFilePath={activeFilePath}
          openSessionIds={openSessionIds}
          sessionStatuses={state.sessionStatuses}
          pendingInteractionCounts={state.pendingInteractionCounts}
          onChooseWorkspace={chooseWorkspace}
          onRefreshWorkspace={() => void window.kimiDesktop.workspace.refresh()}
          onOpenFile={openFile}
          onNewSession={() => void createSession()}
          onSelectSession={openSession}
          onReloadSession={(sessionId) => void window.kimiDesktop.session.reload(sessionId)}
          onSessionAction={(session, action) => setSessionDialog({ session, action })}
        />
        <main className="conversation-pane editor-group">
          <WorkbenchTabs
            state={visibleWorkbench}
            sessions={chatSessions}
            statuses={state.sessionStatuses}
            pendingCounts={state.pendingInteractionCounts}
            onActivate={activateTab}
            onClose={requestCloseTab}
          />
          {activeTab === undefined && (
            <div className="workbench-empty"><Bot size={24} /><strong>没有打开的编辑器</strong><div><button onClick={() => void createSession()}>新建会话</button><button onClick={chooseWorkspace}>打开工作区</button></div></div>
          )}
          {activeTab?.kind === 'session' && activeTab.sessionId !== snapshot.activeSessionId && (
            <div className="editor-state"><CircleDashed className="spin" size={17} /><span>正在恢复会话</span></div>
          )}
          {activeTab?.kind === 'session' && activeTab.sessionId === snapshot.activeSessionId && (
            <div className="conversation-surface">
              <div className="conversation-header">
                <div><strong>{selectedSession?.title || selectedSession?.lastPrompt || 'Kimi 会话'}</strong><span>{snapshot.activeSessionId}</span></div>
                {state.transcript !== undefined && state.transcript.agents().length > 1 && (
                  <label className="select-control agent-select">
                    <Users size={13} />
                    <select value={selectedAgentId} onChange={(event) => setSelectedAgentId(event.target.value)}>
                      {state.transcript.agents().map((agent) => <option value={agent.agentId} key={agent.agentId}>{agent.label ?? agent.agentId}</option>)}
                    </select>
                    <ChevronDown size={12} />
                  </label>
                )}
              </div>
              <Timeline
                transcript={transcript}
                store={state.transcript}
                activity={agentActivity}
                selectedAgentId={selectedAgentId}
                onSelectAgent={setSelectedAgentId}
                sessionId={snapshot.activeSessionId}
                version={state.transcriptVersion}
                followRequest={timelineFollowRequest}
                workspaceRoot={snapshot.workspace.root}
                onOpenFileOperation={openFileOperation}
                onOpenGitDiff={openGitDiff}
              />
              <PendingInteractionDock store={state.transcript} sessionId={snapshot.activeSessionId} selectedAgentId={selectedAgentId} version={state.transcriptVersion} onSelectAgent={setSelectedAgentId} />
              <Composer
                sessionId={snapshot.activeSessionId}
                busy={status?.busy === true}
                status={status}
                models={modelOptions}
                skills={snapshot.session.skills}
                pluginCommands={snapshot.session.pluginCommands}
                commands={snapshot.session.commands}
                onSubmit={(input) => {
                  setTimelineFollowRequest((current) => current + 1);
                  return window.kimiDesktop.turn.submit({ sessionId: snapshot.activeSessionId, ...input });
                }}
                onCancel={() => window.kimiDesktop.turn.cancel(snapshot.activeSessionId)}
                planModePending={planModePending}
                onSetPlanMode={setPlanMode}
              />
            </div>
          )}
          {activeTab?.kind === 'file' && (
            <FileEditorView
              tab={activeTab}
              theme={monacoTheme}
              onChange={(content) => setWorkbench((current) => patchWorkbenchTab(current, activeTab.id, (tab) => tab.kind === 'file' ? {
                ...tab,
                content,
                dirty: content !== tab.savedContent,
              } : tab))}
              onSave={(force) => void saveFile(activeTab.id, force).catch((error) => setActionError(rendererError(error, 'workspace.save_failed')))}
              onReload={() => reloadFile(activeTab)}
              onCompareConflict={() => void compareConflict(activeTab)}
            />
          )}
          {activeTab?.kind === 'diff' && <GitDiffEditorView tab={activeTab} theme={monacoTheme} onReload={() => void loadDiff(activeTab.id, activeTab.path, activeTab.area)} />}
          {activeTab?.kind === 'operation-diff' && <OperationDiffEditorView tab={activeTab} theme={monacoTheme} onOpenGitDiff={() => openGitDiff(activeTab.path)} />}
        </main>
        <Inspector
          sessionId={snapshot.activeSessionId}
          details={snapshot.session}
          activity={agentActivity}
          selectedAgentId={selectedAgentId}
          onSelectAgent={setSelectedAgentId}
          planModePending={planModePending}
          onSetPlanMode={setPlanMode}
          todos={todos}
          todoReadOnly={todoReadOnly}
          onTaskOutput={(taskId) => {
            setTaskOutput({ taskId });
            void window.kimiDesktop.task.output(taskId, 200_000, snapshot.activeSessionId).then((output) => setTaskOutput({ taskId, output }));
          }}
        />
      </div> : workspaceSelected ? (
        <div className="team-workbench">
          <TeamSidebar
            workspace={snapshot.workspace}
            sessions={teamSessions}
            activeSessionId={snapshot.activeSessionId}
            activeWorkbenchSessionId={activeWorkbenchSessionId}
            statuses={state.sessionStatuses}
            badges={teamBadges}
            onCreate={beginTeamCreation}
            onSelect={openTeam}
            onDelete={(session) => {
              setSessionDialog({
                session,
                action: 'delete',
                running:
                  state.sessionStatuses[session.id]?.busy === true ||
                  (teamBadges[session.id]?.running ?? 0) > 0,
              });
            }}
          />
          <main className="team-detail-pane editor-group">
            <WorkbenchTabs
              state={visibleWorkbench}
              sessions={teamSessions}
              statuses={state.sessionStatuses}
              pendingCounts={state.pendingInteractionCounts}
              teamBadges={teamBadges}
              agentLabels={teamAgentLabels}
              onActivate={activateTab}
              onClose={requestCloseTab}
            />
            {activeTab === undefined && (
              <div className="workbench-empty team-workbench-empty"><Users size={24} /><strong>选择或创建团队任务</strong><div><button onClick={beginTeamCreation}>新建团队任务</button></div></div>
            )}
            {activeTab?.kind === 'team' && state.teams[activeTab.sessionId] === undefined && (
              <div className="editor-state"><CircleDashed className="spin" size={17} /><span>正在恢复团队频道</span></div>
            )}
            {activeTab?.kind === 'team' && state.teams[activeTab.sessionId] !== undefined && (
              <TeamPage
                sessionId={activeTab.sessionId}
                state={state.teams[activeTab.sessionId]!}
                activity={snapshot.activeSessionId === activeTab.sessionId ? agentActivity : undefined}
                status={state.sessionStatuses[activeTab.sessionId]}
                models={modelOptions}
                leaderTodos={snapshot.activeSessionId === activeTab.sessionId ? todos : []}
                planModePending={planPendingSessions.has(activeTab.sessionId)}
                onSetPlanMode={(enabled) => setSessionPlanMode(activeTab.sessionId, enabled)}
                onSeen={(channelSeq) => markTeamSeen(activeTab.sessionId, channelSeq)}
                onSelectAgent={(agentId) => selectTeamAgent(activeTab.sessionId, agentId)}
              />
            )}
            {activeTab?.kind === 'agent' && activeTab.sessionId !== snapshot.activeSessionId && (
              <div className="editor-state"><CircleDashed className="spin" size={17} /><span>正在恢复 Agent 详情</span></div>
            )}
            {activeTab?.kind === 'agent' && activeTab.sessionId === snapshot.activeSessionId && (
              <div className="team-agent-surface">
                <div className="conversation-header">
                  <div>
                    <strong>{activeTab.agentId === 'main' ? '组长详情' : teamAgentLabels[`${activeTab.sessionId}:${activeTab.agentId}`] ?? 'Agent 详情'}</strong>
                    <span>{activeTab.agentId}</span>
                  </div>
                  <button className="team-channel-back" onClick={() => openTeam(activeTab.sessionId)}><Users size={13} />返回团队频道</button>
                </div>
                <Timeline
                  transcript={transcript}
                  store={state.transcript}
                  activity={agentActivity}
                  selectedAgentId={activeTab.agentId}
                  onSelectAgent={(agentId) => selectTeamAgent(activeTab.sessionId, agentId)}
                  sessionId={activeTab.sessionId}
                  version={state.transcriptVersion}
                  followRequest={timelineFollowRequest}
                  workspaceRoot={snapshot.workspace.root}
                  onOpenFileOperation={openFileOperation}
                  onOpenGitDiff={openGitDiff}
                />
                <PendingInteractionDock store={state.transcript} sessionId={activeTab.sessionId} selectedAgentId={activeTab.agentId} version={state.transcriptVersion} onSelectAgent={(agentId) => selectTeamAgent(activeTab.sessionId, agentId)} />
              </div>
            )}
            {activeTab?.kind === 'file' && (
              <FileEditorView
                tab={activeTab}
                theme={monacoTheme}
                onChange={(content) => setWorkbench((current) => patchWorkbenchTab(current, activeTab.id, (tab) => tab.kind === 'file' ? {
                  ...tab,
                  content,
                  dirty: content !== tab.savedContent,
                } : tab))}
                onSave={(force) => void saveFile(activeTab.id, force).catch((error) => setActionError(rendererError(error, 'workspace.save_failed')))}
                onReload={() => reloadFile(activeTab)}
                onCompareConflict={() => void compareConflict(activeTab)}
              />
            )}
            {activeTab?.kind === 'diff' && <GitDiffEditorView tab={activeTab} theme={monacoTheme} onReload={() => void loadDiff(activeTab.id, activeTab.path, activeTab.area)} />}
            {activeTab?.kind === 'operation-diff' && <OperationDiffEditorView tab={activeTab} theme={monacoTheme} onOpenGitDiff={() => openGitDiff(activeTab.path)} />}
          </main>
        </div>
      ) : (
        <WorkspaceWelcome busy={workspaceChoosing} onChoose={chooseWorkspace} />
      )}

      {settingsOpen && <SettingsDialog snapshot={snapshot} onClose={() => setSettingsOpen(false)} />}
      {teamCreation !== undefined && (
        <CreateTeamDialog
          currentPermission={defaultPermission(snapshot.config.value)}
          models={modelOptions}
          defaultModel={text(snapshot.config.value['defaultModel']) || modelOptions[0]?.id}
          onCreate={createTeamTask}
          onCancel={() => setTeamCreation(undefined)}
        />
      )}
      {sessionDialog !== undefined && <SessionActionDialog state={sessionDialog} onDelete={deleteSession} onClose={() => setSessionDialog(undefined)} />}
      {taskOutput !== undefined && <OutputDialog title={`Task · ${taskOutput.taskId}`} output={taskOutput.output} onClose={() => setTaskOutput(undefined)} />}
      {dirtyPrompt !== undefined && dirtyPromptPaths.length > 0 && (
        <DirtyFilesDialog
          title={dirtyPrompt.kind === 'host' ? '退出前保存修改' : dirtyPrompt.kind === 'workspace' ? '切换工作区前保存修改' : '保存文件修改'}
          paths={dirtyPromptPaths}
          busy={dirtyPromptBusy}
          error={dirtyPromptError}
          onSave={() => void finishDirtyPrompt(true)}
          onDiscard={() => void finishDirtyPrompt(false)}
          onCancel={cancelDirtyPrompt}
        />
      )}
      {memoryDiff !== undefined && <MemoryDiffDialog {...memoryDiff} theme={monacoTheme} onClose={() => setMemoryDiff(undefined)} />}
      {(actionError ?? state.error) !== undefined && (
        <div className="error-toast" role="alert">
          <span><strong>{(actionError ?? state.error)?.code}</strong>{(actionError ?? state.error)?.message}</span>
          <button className="icon-button" onClick={() => { if (actionError !== undefined) setActionError(undefined); else state.clearError(); }} title="关闭"><X size={14} /></button>
        </div>
      )}
    </div>
  );
}

function WorkspaceWelcome({ busy, onChoose }: {
  readonly busy: boolean;
  readonly onChoose: () => void;
}) {
  return (
    <main className="workspace-welcome">
      <div className="workspace-welcome-card">
        <span className="workspace-welcome-icon"><FolderOpen size={28} /></span>
        <div>
          <h1>选择一个工作区</h1>
          <p>打开包含项目文件的文件夹后，Kimi Code 才会加载文件、Git 状态和该工作区的会话。</p>
        </div>
        <button className="button-primary workspace-welcome-action" disabled={busy} onClick={onChoose} autoFocus>
          {busy ? <CircleDashed className="spin" size={15} /> : <FolderOpen size={15} />}
          {busy ? '正在打开…' : '选择工作区'}
        </button>
        <small>成功选择后，下次启动会自动恢复这个工作区。</small>
      </div>
    </main>
  );
}

function teamSeenStorageKey(workspaceRoot: string): string {
  return `${workbenchStorageKey(workspaceRoot)}.team-seen`;
}

function readSeenTeamSeqs(key: string): Record<string, number> {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] => (
      Number.isSafeInteger(entry[1]) && (entry[1] as number) >= 0
    )));
  } catch {
    return {};
  }
}

function pruneSessionRecord<T>(value: Record<string, T>, validSessionIds: ReadonlySet<string>): Record<string, T> {
  const entries = Object.entries(value).filter(([sessionId]) => validSessionIds.has(sessionId));
  return entries.length === Object.keys(value).length ? value : Object.fromEntries(entries);
}

function deleteSessionRecord<T>(value: Record<string, T>, sessionId: string): Record<string, T> {
  if (value[sessionId] === undefined) return value;
  const next = { ...value };
  delete next[sessionId];
  return next;
}

function rendererError(error: unknown, fallbackCode: string): RendererError {
  if (error instanceof Error) return { code: fallbackCode, message: error.message };
  const value = record(error);
  return { code: text(value['code'], fallbackCode), message: text(value['message'], String(error)) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : text(record(error)['message'], String(error));
}

function defaultPermission(config: Readonly<Record<string, unknown>>): 'manual' | 'auto' | 'yolo' {
  const value = config['defaultPermissionMode'];
  return value === 'auto' || value === 'yolo' ? value : 'manual';
}

function teamTaskTitle(objective: string): string {
  const firstLine = objective.split(/\r?\n/, 1)[0]?.trim() ?? objective.trim();
  return firstLine.length <= 60 ? firstLine : `${firstLine.slice(0, 57)}…`;
}

function SessionActionDialog({
  state,
  onDelete,
  onClose,
}: {
  readonly state: SessionDialogState;
  readonly onDelete: (sessionId: string) => Promise<void>;
  readonly onClose: () => void;
}) {
  const [title, setTitle] = useState(state.session.title ?? '');
  const [turnIndex, setTurnIndex] = useState('');
  const [outputPath, setOutputPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const run = async () => {
    setBusy(true);
    setActionError(undefined);
    try {
      switch (state.action) {
        case 'rename': await window.kimiDesktop.session.rename(state.session.id, title.trim()); break;
        case 'fork': await window.kimiDesktop.session.fork(state.session.id, turnIndex.trim() === '' ? undefined : Number(turnIndex), title.trim() || undefined); break;
        case 'export': {
          const result = record(await window.kimiDesktop.session.export(state.session.id, outputPath.trim() || undefined));
          const zipPath = text(result['zipPath']);
          if (zipPath.length > 0) await window.kimiDesktop.host.openPath(zipPath);
          break;
        }
        case 'close': await window.kimiDesktop.session.close(state.session.id); break;
        case 'delete': await onDelete(state.session.id); break;
      }
      onClose();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const teamDelete = state.action === 'delete' && state.session.surface === 'team';
  const titleByAction: Record<SessionAction, string> = {
    rename: '重命名会话', fork: '分叉会话', export: '导出会话', close: '关闭活动会话', delete: '永久删除会话',
  };
  if (teamDelete) titleByAction.delete = '永久删除团队任务';
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="action-dialog" role="dialog" aria-modal="true">
        <header className="dialog-header"><div>{state.action === 'fork' ? <GitFork size={16} /> : state.action === 'delete' ? <Trash2 size={16} /> : state.action === 'export' ? <FileOutput size={16} /> : <Pencil size={16} />}<strong>{titleByAction[state.action]}</strong></div><button className="icon-button" onClick={onClose}><X size={15} /></button></header>
        <div className="dialog-body">
          <p>{state.session.title || state.session.lastPrompt || state.session.id}</p>
          {(state.action === 'rename' || state.action === 'fork') && <label><span>标题</span><input value={title} onChange={(event) => setTitle(event.target.value)} autoFocus /></label>}
          {state.action === 'fork' && <label><span>保留到历史轮次</span><input type="number" min={0} step={1} value={turnIndex} onChange={(event) => setTurnIndex(event.target.value)} placeholder="留空表示完整分叉" /></label>}
          {state.action === 'export' && <label><span>输出路径</span><input value={outputPath} onChange={(event) => setOutputPath(event.target.value)} placeholder="留空使用默认导出路径" /></label>}
          {state.action === 'close' && <div className="dialog-notice">关闭只结束当前活动 runtime，会话历史仍保留。</div>}
          {state.action === 'delete' && (
            <div className="dialog-danger">
              {teamDelete && state.running === true
                ? '该团队任务仍在运行。确认后会立即终止全部 Agent，并永久删除频道和持久化历史，无法撤销。'
                : teamDelete
                  ? '该团队任务的频道和持久化历史将被永久删除，无法撤销。'
                  : '该会话的持久化历史将被永久删除，无法撤销。'}
            </div>
          )}
          {actionError !== undefined && <div className="dialog-danger">{actionError}</div>}
        </div>
        <footer className="dialog-footer"><button onClick={onClose}>取消</button><button className={state.action === 'delete' ? 'button-danger' : 'button-primary'} disabled={busy || (state.action === 'rename' && title.trim().length === 0)} onClick={() => void run()}>{busy ? <CircleDashed className="spin" size={13} /> : state.action === 'delete' ? <Trash2 size={13} /> : <Check size={13} />}确认</button></footer>
      </div>
    </div>
  );
}

function OutputDialog({ title, output, onClose }: { readonly title: string; readonly output?: string; readonly onClose: () => void }) {
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="output-dialog" role="dialog" aria-modal="true">
        <header className="dialog-header"><div><FileOutput size={16} /><strong>{title}</strong></div><button className="icon-button" onClick={onClose}><X size={15} /></button></header>
        {output === undefined ? <div className="dialog-loading"><CircleDashed className="spin" size={17} />读取输出</div> : <pre>{output || '(empty)'}</pre>}
      </div>
    </div>
  );
}
