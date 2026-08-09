import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  Check,
  ChevronDown,
  CircleDashed,
  FileOutput,
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
import { buildAgentActivityForest } from './agent-activity';
import { Composer } from './Composer';
import { useDesktopState } from './desktop-state';
import { DirtyFilesDialog } from './DirtyFilesDialog';
import { Inspector } from './Inspector';
import { PendingInteractionDock } from './PendingInteractionDock';
import { SettingsDialog } from './SettingsDialog';
import { Sidebar, type SessionAction } from './Sidebar';
import { SwarmEntryController, type SwarmPermissionPrompt } from './swarm-ui';
import { SwarmPermissionDialog } from './SwarmPermissionDialog';
import { TeamPage } from './TeamPage';
import { Timeline } from './Timeline';
import { classNames, record, text } from './ui-utils';
import {
  FileEditorView,
  GitDiffEditorView,
  MemoryDiffDialog,
} from './WorkbenchEditor';
import { WorkbenchTabs } from './WorkbenchTabs';
import {
  activateWorkbenchTab,
  closeWorkbenchTab,
  cycleWorkbenchTab,
  EMPTY_WORKBENCH,
  ensureWorkbenchTab,
  fileTab,
  openWorkbenchTab,
  patchWorkbenchTab,
  restoreWorkbenchState,
  serializeWorkbenchState,
  sessionTab,
  teamTab,
  workbenchStorageKey,
  type FileWorkbenchTab,
  type WorkbenchTab,
  type WorkbenchTabState,
} from './workbench-tabs';

type Theme = 'system' | 'light' | 'dark';

interface SessionDialogState {
  readonly session: SessionListItem;
  readonly action: SessionAction;
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

export function App() {
  const state = useDesktopState();
  const snapshot = state.snapshot;
  const activeSessionId = snapshot?.activeSessionId;
  const [selectedAgents, setSelectedAgents] = useState<Record<string, string>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>('system');
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  const [sessionDialog, setSessionDialog] = useState<SessionDialogState>();
  const [taskOutput, setTaskOutput] = useState<{ taskId: string; output?: string }>();
  const [swarmPermission, setSwarmPermission] = useState<SwarmPermissionPrompt>();
  const [swarmActionError, setSwarmActionError] = useState<RendererError>();
  const [workbench, setWorkbench] = useState<WorkbenchTabState>(EMPTY_WORKBENCH);
  const [hydratedRoot, setHydratedRoot] = useState<string>();
  const [dirtyPrompt, setDirtyPrompt] = useState<DirtyPrompt>();
  const [dirtyPromptBusy, setDirtyPromptBusy] = useState(false);
  const [dirtyPromptError, setDirtyPromptError] = useState<string>();
  const [memoryDiff, setMemoryDiff] = useState<MemoryDiffState>();
  const [planPendingSessions, setPlanPendingSessions] = useState<ReadonlySet<string>>(() => new Set());
  const [timelineFollowRequest, setTimelineFollowRequest] = useState(0);
  const [seenTeamSeqs, setSeenTeamSeqs] = useState<Record<string, number>>({});
  const workbenchRef = useRef(workbench);
  const loadingTabs = useRef(new Set<string>());
  const savingPaths = useRef(new Set<string>());
  const sessionActivation = useRef<{ desired?: string; running: boolean }>({ running: false });
  const planPendingRef = useRef(new Set<string>());
  const knownTeamSessions = useRef(new Set<string>());
  const closedTeamTabs = useRef(new Set<string>());
  workbenchRef.current = workbench;

  const [swarmEntryController] = useState(() => new SwarmEntryController(
    (sessionId) => window.kimiDesktop.turn.setPermission('yolo', sessionId),
    (prompt) => { setSwarmPermission(prompt); },
  ));
  const activePermission = snapshot?.session.status?.permission;
  const selectedAgentId = activeSessionId === undefined ? 'main' : selectedAgents[activeSessionId] ?? 'main';
  const setSelectedAgentId = useCallback((agentId: string) => {
    if (activeSessionId === undefined) return;
    setSelectedAgents((current) => current[activeSessionId] === agentId
      ? current
      : { ...current, [activeSessionId]: agentId });
  }, [activeSessionId]);
  const agentActivity = useMemo(
    () => buildAgentActivityForest(state.transcript),
    [state.transcript, state.transcriptVersion],
  );
  const todos = state.transcript?.getAgent('main')?.getTodo('todo')?.items ?? [];
  const todoReadOnly = snapshot?.session.status?.busy === true ||
    agentActivity.counts.running > 0 ||
    agentActivity.counts.waiting > 0;

  const activateSessionRuntime = useCallback((sessionId: string) => {
    const activation = sessionActivation.current;
    activation.desired = sessionId;
    if (activation.running) return;
    activation.running = true;
    void (async () => {
      try {
        while (activation.desired !== undefined) {
          const target = activation.desired;
          activation.desired = undefined;
          try {
            await window.kimiDesktop.session.resume(target);
          } catch (error) {
            if (activation.desired === undefined) {
              setSwarmActionError(rendererError(error, 'session.resume_failed'));
            }
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
  const activeTab = workbench.tabs.find((tab) => tab.id === workbench.activeId);
  const activeWorkbenchSessionId = activeTab?.kind === 'session' || activeTab?.kind === 'team'
    ? activeTab.sessionId
    : undefined;
  const monacoTheme = theme === 'dark' || (theme === 'system' && systemDark) ? 'vs-dark' : 'vs';

  useEffect(() => {
    if (snapshot === undefined || snapshot.loading) return;
    const root = snapshot.workspace.root;
    if (root.length === 0 || hydratedRoot === root) return;
    const restored = restoreWorkbenchState(
      localStorage.getItem(workbenchStorageKey(root)),
      new Set(snapshot.sessions.map((session) => session.id)),
      new Set(snapshot.sessions.map((session) => session.id)),
    );
    const initial = restored.tabs.length === 0 && snapshot.activeSessionId !== undefined
      ? openWorkbenchTab(restored, sessionTab(snapshot.activeSessionId))
      : restored;
    setWorkbench(initial);
    knownTeamSessions.current = new Set(Object.keys(state.teams));
    closedTeamTabs.current.clear();
    setSeenTeamSeqs(readSeenTeamSeqs(teamSeenStorageKey(root)));
    setHydratedRoot(root);
    loadingTabs.current.clear();
  }, [hydratedRoot, snapshot, state.teams]);

  useEffect(() => {
    if (snapshot === undefined || hydratedRoot !== snapshot.workspace.root) return;
    localStorage.setItem(workbenchStorageKey(snapshot.workspace.root), serializeWorkbenchState(workbench));
  }, [hydratedRoot, snapshot, workbench]);

  useEffect(() => {
    if (snapshot === undefined || hydratedRoot !== snapshot.workspace.root) return;
    localStorage.setItem(teamSeenStorageKey(snapshot.workspace.root), JSON.stringify(seenTeamSeqs));
  }, [hydratedRoot, seenTeamSeqs, snapshot]);

  useEffect(() => {
    if (snapshot === undefined || hydratedRoot !== snapshot.workspace.root) return;
    for (const sessionId of Object.keys(state.teams)) {
      if (knownTeamSessions.current.has(sessionId)) continue;
      knownTeamSessions.current.add(sessionId);
      if (closedTeamTabs.current.has(sessionId)) continue;
      setWorkbench((current) => ensureWorkbenchTab(current, teamTab(sessionId), current.tabs.length === 0));
    }
  }, [hydratedRoot, snapshot, state.teamVersion, state.teams]);

  useEffect(() => {
    const sessionId = snapshot?.activeSessionId;
    if (hydratedRoot !== snapshot?.workspace.root || sessionId === undefined || workbench.tabs.length > 0) return;
    setWorkbench((current) => current.tabs.length === 0
      ? openWorkbenchTab(current, sessionTab(sessionId))
      : current);
  }, [hydratedRoot, snapshot?.activeSessionId, snapshot?.workspace.root, workbench.tabs.length]);

  useEffect(() => {
    if (hydratedRoot === undefined) return;
    for (const tab of workbench.tabs) {
      if (tab.kind === 'file' && tab.loading) void loadFile(tab.id, tab.path);
      if (tab.kind === 'diff' && tab.loading) void loadDiff(tab.id, tab.path, tab.area);
    }
  }, [hydratedRoot, loadDiff, loadFile, workbench.tabs]);

  useEffect(() => {
    if (activeWorkbenchSessionId === undefined) return;
    activateSessionRuntime(activeWorkbenchSessionId);
  }, [activateSessionRuntime, activeWorkbenchSessionId]);

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
    setSwarmActionError(undefined);
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

  useEffect(() => {
    swarmEntryController.cancelOutside(activeSessionId);
  }, [activeSessionId, swarmEntryController]);

  useEffect(() => () => swarmEntryController.dispose(), [swarmEntryController]);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.dataset['theme'] = theme;
  }, [theme]);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, []);

  const requestCloseTab = useCallback((tab: WorkbenchTab) => {
    if (tab.kind === 'file' && tab.dirty) {
      setDirtyPrompt({ kind: 'tab', tabId: tab.id });
      setDirtyPromptError(undefined);
      return;
    }
    if (tab.kind === 'team') closedTeamTabs.current.add(tab.sessionId);
    setWorkbench((current) => closeWorkbenchTab(current, tab.id));
  }, []);

  const activateTab = useCallback((tab: WorkbenchTab) => {
    setWorkbench((current) => activateWorkbenchTab(current, tab.id));
    if (tab.kind === 'session' || tab.kind === 'team') {
      void window.kimiDesktop.session.resume(tab.sessionId).catch((error) => setSwarmActionError(rendererError(error, 'session.resume_failed')));
    }
  }, []);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const current = workbenchRef.current;
      const selected = current.tabs.find((tab) => tab.id === current.activeId);
      if (event.key.toLowerCase() === 's' && selected?.kind === 'file') {
        event.preventDefault();
        void saveFile(selected.id, selected.conflict).catch((error) => setSwarmActionError(rendererError(error, 'workspace.save_failed')));
      } else if (event.key.toLowerCase() === 'w' && selected !== undefined) {
        event.preventDefault();
        requestCloseTab(selected);
      } else if (event.key === 'Tab') {
        event.preventDefault();
        setWorkbench((state) => cycleWorkbenchTab(state, event.shiftKey));
      }
    };
    window.addEventListener('keydown', listener, { capture: true });
    return () => window.removeEventListener('keydown', listener, { capture: true });
  }, [requestCloseTab, saveFile]);

  const cancelSwarmPermission = useCallback(() => swarmEntryController.cancel(), [swarmEntryController]);
  const enterSwarm = useCallback(async (activate: () => Promise<void> | void): Promise<boolean> => {
    if (activeSessionId === undefined) return false;
    setSwarmActionError(undefined);
    try {
      return await swarmEntryController.enter(activeSessionId, activePermission ?? 'manual', activate);
    } catch (error) {
      setSwarmActionError(rendererError(error, 'swarm.entry_failed'));
      return false;
    }
  }, [activePermission, activeSessionId, swarmEntryController]);
  const chooseSwarmPermission = useCallback(async (choice: 'yolo' | 'current') => swarmEntryController.choose(choice), [swarmEntryController]);
  const setPlanMode = useCallback(async (enabled: boolean): Promise<void> => {
    if (activeSessionId === undefined || planPendingRef.current.has(activeSessionId)) return;
    planPendingRef.current.add(activeSessionId);
    setPlanPendingSessions(new Set(planPendingRef.current));
    setSwarmActionError(undefined);
    try {
      await window.kimiDesktop.turn.setPlanMode(enabled, activeSessionId);
    } catch (error) {
      setSwarmActionError(rendererError(error, 'session.plan_mode_failed'));
    } finally {
      planPendingRef.current.delete(activeSessionId);
      setPlanPendingSessions(new Set(planPendingRef.current));
    }
  }, [activeSessionId]);

  if (snapshot === undefined) {
    return <div className="app-loading"><CircleDashed className="spin" size={22} /><span>正在启动 Kimi Code Desktop</span></div>;
  }

  const status = snapshot.session.status;
  const selectedSession = activeTab?.kind === 'session' || activeTab?.kind === 'team'
    ? snapshot.sessions.find((session) => session.id === activeTab.sessionId)
    : snapshot.sessions.find((session) => session.id === snapshot.activeSessionId);
  const transcript = state.transcript?.getAgent(selectedAgentId) ?? state.transcript?.getAgent('main');
  const planModePending = activeSessionId !== undefined && planPendingSessions.has(activeSessionId);
  const modelOptions = Object.entries(record(snapshot.config.value['models'])).map(([id, raw]) => ({
    id,
    label: text(record(raw)['displayName'], id),
  }));
  const openSessionIds = new Set(workbench.tabs.filter((tab) => tab.kind === 'session').map((tab) => tab.sessionId));
  const activeFilePath = activeTab?.kind === 'file' || activeTab?.kind === 'diff' ? activeTab.path : undefined;

  const openFile = (path: string) => setWorkbench((current) => openWorkbenchTab(current, fileTab(path)));
  const openSession = (sessionId: string) => {
    const tab = sessionTab(sessionId);
    setWorkbench((current) => openWorkbenchTab(current, tab));
    activateSessionRuntime(sessionId);
  };
  const openTeam = (sessionId: string) => {
    closedTeamTabs.current.delete(sessionId);
    setWorkbench((current) => openWorkbenchTab(current, teamTab(sessionId)));
    activateSessionRuntime(sessionId);
  };
  const selectTeamAgent = (sessionId: string, agentId: string) => {
    setSelectedAgents((current) => ({ ...current, [sessionId]: agentId }));
    setWorkbench((current) => openWorkbenchTab(current, sessionTab(sessionId)));
    activateSessionRuntime(sessionId);
  };
  const markTeamSeen = (sessionId: string, channelSeq: number) => {
    setSeenTeamSeqs((current) => (current[sessionId] ?? 0) >= channelSeq
      ? current
      : { ...current, [sessionId]: channelSeq });
  };
  const teamBadges = Object.fromEntries(Object.entries(state.teams).map(([sessionId, teamState]) => [sessionId, {
    unread: Math.max(0, teamState.snapshot.latestChannelSeq - (seenTeamSeqs[sessionId] ?? 0)),
    running: teamState.snapshot.assignments.filter((assignment) => assignment.status === 'running' || assignment.status === 'queued').length,
    failed: teamState.snapshot.assignments.filter((assignment) => assignment.status === 'failed').length,
  }]));
  const createSession = async () => openSession(await window.kimiDesktop.session.create());
  const chooseWorkspace = () => {
    if (dirtyTabs.length > 0) {
      setDirtyPrompt({ kind: 'workspace' });
      setDirtyPromptError(undefined);
    } else {
      void window.kimiDesktop.workspace.choose();
    }
  };
  const reloadFile = (tab: FileWorkbenchTab) => void loadFile(tab.id, tab.path);
  const compareConflict = async (tab: FileWorkbenchTab) => {
    const disk = await window.kimiDesktop.workspace.readFile(tab.path);
    if (disk.kind !== 'text' || disk.content === undefined) {
      setSwarmActionError({ code: 'workspace.compare_unsupported', message: disk.readOnlyReason ?? '磁盘内容无法比较' });
      return;
    }
    setMemoryDiff({ path: tab.path, disk: disk.content, editor: tab.content, languageId: disk.languageId });
  };
  const cycleTheme = () => setTheme((current) => current === 'system' ? 'light' : current === 'light' ? 'dark' : 'system');

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
        setWorkbench((current) => closeWorkbenchTab(current, dirtyPrompt.tabId));
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

  return (
    <div className="desktop-app">
      <header className="topbar">
        <div className="brand-block">
          <span className="brand-mark"><Bot size={17} /></span>
          <strong>Kimi Code Desktop</strong>
          <span className={classNames('runtime-state', status?.busy && 'busy')}><span />{status?.busy ? 'Working' : snapshot.activeSessionId === undefined ? 'No session' : 'Ready'}</span>
        </div>
        <div className="top-actions">
          <button className="icon-button" onClick={cycleTheme} title={`主题：${theme}`}>{theme === 'light' ? <Sun size={15} /> : theme === 'dark' ? <Moon size={15} /> : <Settings size={15} />}</button>
          <button className="icon-button" onClick={() => setSettingsOpen(true)} title="设置"><Settings size={16} /></button>
        </div>
      </header>

      <div className="workbench">
        <Sidebar
          workspace={snapshot.workspace}
          tree={snapshot.tree}
          gitFiles={snapshot.gitFiles}
          workspaceRevision={state.workspaceChange.version}
          sessions={snapshot.sessions}
          activeSessionId={snapshot.activeSessionId}
          activeWorkbenchSessionId={activeWorkbenchSessionId}
          activeFilePath={activeFilePath}
          openSessionIds={openSessionIds}
          sessionStatuses={state.sessionStatuses}
          pendingInteractionCounts={state.pendingInteractionCounts}
          teamBadges={teamBadges}
          onChooseWorkspace={chooseWorkspace}
          onRefreshWorkspace={() => void window.kimiDesktop.workspace.refresh()}
          onOpenFile={openFile}
          onNewSession={() => void createSession()}
          onSelectSession={openSession}
          onOpenTeam={openTeam}
          onReloadSession={(sessionId) => void window.kimiDesktop.session.reload(sessionId)}
          onSessionAction={(session, action) => setSessionDialog({ session, action })}
        />
        <main className="conversation-pane editor-group">
          <WorkbenchTabs
            state={workbench}
            sessions={snapshot.sessions}
            statuses={state.sessionStatuses}
            pendingCounts={state.pendingInteractionCounts}
            teamBadges={teamBadges}
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
                swarmPermissionPending={swarmPermission !== undefined}
                onEnterSwarm={enterSwarm}
                planModePending={planModePending}
                onSetPlanMode={setPlanMode}
              />
            </div>
          )}
          {activeTab?.kind === 'team' && state.teams[activeTab.sessionId] === undefined && (
            <div className="editor-state"><CircleDashed className="spin" size={17} /><span>正在恢复团队频道</span></div>
          )}
          {activeTab?.kind === 'team' && state.teams[activeTab.sessionId] !== undefined && (
            <TeamPage
              sessionId={activeTab.sessionId}
              state={state.teams[activeTab.sessionId]!}
              onSeen={(channelSeq) => markTeamSeen(activeTab.sessionId, channelSeq)}
              onSelectAgent={(agentId) => selectTeamAgent(activeTab.sessionId, agentId)}
            />
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
              onSave={(force) => void saveFile(activeTab.id, force).catch((error) => setSwarmActionError(rendererError(error, 'workspace.save_failed')))}
              onReload={() => reloadFile(activeTab)}
              onCompareConflict={() => void compareConflict(activeTab)}
            />
          )}
          {activeTab?.kind === 'diff' && <GitDiffEditorView tab={activeTab} theme={monacoTheme} onReload={() => void loadDiff(activeTab.id, activeTab.path, activeTab.area)} />}
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
      </div>

      {settingsOpen && <SettingsDialog snapshot={snapshot} onClose={() => setSettingsOpen(false)} />}
      {swarmPermission !== undefined && <SwarmPermissionDialog permission={swarmPermission.permission} onChoose={chooseSwarmPermission} onCancel={cancelSwarmPermission} />}
      {sessionDialog !== undefined && <SessionActionDialog state={sessionDialog} onClose={() => setSessionDialog(undefined)} />}
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
      {(swarmActionError ?? state.error) !== undefined && (
        <div className="error-toast" role="alert">
          <span><strong>{(swarmActionError ?? state.error)?.code}</strong>{(swarmActionError ?? state.error)?.message}</span>
          <button className="icon-button" onClick={() => { if (swarmActionError !== undefined) setSwarmActionError(undefined); else state.clearError(); }} title="关闭"><X size={14} /></button>
        </div>
      )}
      {snapshot.loading && <div className="loading-line" />}
    </div>
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

function rendererError(error: unknown, fallbackCode: string): RendererError {
  if (error instanceof Error) return { code: fallbackCode, message: error.message };
  const value = record(error);
  return { code: text(value['code'], fallbackCode), message: text(value['message'], String(error)) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : text(record(error)['message'], String(error));
}

function SessionActionDialog({ state, onClose }: { readonly state: SessionDialogState; readonly onClose: () => void }) {
  const [title, setTitle] = useState(state.session.title ?? '');
  const [turnIndex, setTurnIndex] = useState('');
  const [outputPath, setOutputPath] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
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
        case 'delete': await window.kimiDesktop.session.delete(state.session.id); break;
      }
      onClose();
    } finally {
      setBusy(false);
    }
  };
  const titleByAction: Record<SessionAction, string> = {
    rename: '重命名会话', fork: '分叉会话', export: '导出会话', close: '关闭活动会话', delete: '永久删除会话',
  };
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
          {state.action === 'delete' && <div className="dialog-danger">该会话的持久化历史将被永久删除，无法撤销。</div>}
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
