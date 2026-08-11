import type {
  AgentDescriptor,
  AgentTranscriptSnapshot,
  TranscriptOperation,
} from '@moonshot-ai/transcript';
import type {
  TeamArtifactContent,
  TeamMessage,
  TeamOperation,
  TeamPolicyInput,
  TeamQuestionAnswers,
  TeamSnapshot,
} from './team-types';
import type { TeamStateSnapshot } from './team-state';
import type { DesktopSurface } from './team-session';

export type {
  TeamAssignment,
  TeamAssignmentStatus,
  TeamArtifact,
  TeamArtifactContent,
  TeamAttempt,
  TeamBatch,
  TeamBatchStatus,
  TeamBudgetReport,
  TeamIntegrationState,
  TeamMember,
  TeamMessage,
  TeamMessageAttachment,
  TeamOperation,
  TeamPolicy,
  TeamPolicyInput,
  TeamQuestionAnswers,
  TeamQuestionItem,
  TeamReview,
  TeamSchedulerState,
  TeamSnapshot,
  TeamSnapshotV2,
  TeamTask,
} from './team-types';
export type { TeamStateSnapshot } from './team-state';
export type { DesktopSurface } from './team-session';

export type TodoStatus = 'pending' | 'in_progress' | 'done';
export interface TodoItem {
  readonly title: string;
  readonly status: TodoStatus;
}

export type AgentProfileManageScope = 'workspace' | 'user';
export type AgentProfileManagedModelPreference = 'auto' | 'primary' | 'secondary';

export interface AgentProfileDraft {
  readonly name: string;
  readonly description: string;
  readonly whenToUse?: string;
  readonly prompt: string;
  readonly scope: AgentProfileManageScope;
  readonly override?: boolean;
  readonly tools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly subagents?: readonly string[];
  readonly modelPreference?: AgentProfileManagedModelPreference;
}

export interface AgentProfileUpdateInput extends AgentProfileDraft {
  readonly revision: string;
}

export interface AgentProfileDeleteInput {
  readonly name: string;
  readonly scope: AgentProfileManageScope;
  readonly revision: string;
}

export interface AgentProfileDescriptor {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly whenToUse?: string;
  readonly prompt?: string;
  readonly override: boolean;
  readonly tools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly subagents?: readonly string[];
  readonly modelPreference: AgentProfileManagedModelPreference;
  readonly sourceId: string;
  readonly scope?: AgentProfileManageScope;
  readonly editable: boolean;
  readonly effective: boolean;
  readonly path?: string;
  readonly revision?: string;
}

export interface AgentProfileDiagnostic {
  readonly sourceId: string;
  readonly path?: string;
  readonly message: string;
}

export interface AgentProfileListResult {
  readonly profiles: readonly AgentProfileDescriptor[];
  readonly diagnostics: readonly AgentProfileDiagnostic[];
}

export interface AgentProfileMutationResult {
  readonly profile: AgentProfileDescriptor;
  readonly created?: boolean;
}

export interface AgentProfileDeleteResult {
  readonly id: string;
  readonly name: string;
  readonly scope: AgentProfileManageScope;
  readonly deleted: true;
}

export const DESKTOP_DOMAINS = [
  'workspace',
  'auth',
  'config',
  'profile',
  'session',
  'turn',
  'interaction',
  'context',
  'extension',
  'mcp',
  'task',
  'team',
  'goal',
  'shell',
  'update',
  'host',
] as const;

export type DesktopDomain = (typeof DESKTOP_DOMAINS)[number];
export type JsonRecord = Record<string, unknown>;

export interface KimiDesktopError {
  readonly code: string;
  readonly message: string;
  readonly details?: JsonRecord;
  readonly retryable?: boolean;
}

export type DesktopUpdateStatus =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error';

export type DesktopUpdateMode = 'automatic' | 'manual';
export type DesktopUpdateManualReason =
  | 'development'
  | 'windows-portable'
  | 'macos-unsigned'
  | 'linux-package'
  | 'unsupported-platform';

export interface DesktopUpdateProgress {
  readonly percent: number;
  readonly transferred: number;
  readonly total: number;
  readonly bytesPerSecond: number;
}

export interface DesktopUpdateSnapshot {
  readonly currentVersion: string;
  readonly mode: DesktopUpdateMode;
  readonly manualReason?: DesktopUpdateManualReason;
  readonly status: DesktopUpdateStatus;
  readonly latestVersion?: string;
  readonly releaseName?: string;
  readonly releaseNotes?: string;
  readonly releaseUrl?: string;
  readonly checkedAt?: string;
  readonly progress?: DesktopUpdateProgress;
  readonly error?: KimiDesktopError;
}

export interface WorkspaceNode {
  readonly name: string;
  readonly path: string;
  readonly kind: 'file' | 'directory';
  readonly extension?: string;
  readonly hasChildren?: boolean;
  readonly children?: readonly WorkspaceNode[];
}

export type GitStatus = 'untracked' | 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'conflicted';

export interface GitFileStats {
  readonly additions: number;
  readonly deletions: number;
}

export interface GitFile {
  readonly path: string;
  readonly originalPath?: string;
  readonly indexStatus?: GitStatus;
  readonly worktreeStatus?: GitStatus;
  readonly indexStats: GitFileStats;
  readonly worktreeStats: GitFileStats;
}

export type WorkspaceFileKind = 'text' | 'binary' | 'too-large';

export interface WorkspaceFileSnapshot {
  readonly path: string;
  readonly kind: WorkspaceFileKind;
  readonly content?: string;
  readonly languageId: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly version: string;
  readonly bom: boolean;
  readonly readOnlyReason?: string;
}

export type GitDiffArea = 'staged' | 'working' | 'conflict';

export interface WorkspaceDiffSnapshot {
  readonly path: string;
  readonly originalPath?: string;
  readonly area: GitDiffArea;
  readonly original?: string;
  readonly modified?: string;
  readonly originalLabel: string;
  readonly modifiedLabel: string;
  readonly languageId: string;
  readonly binary: boolean;
  readonly truncated: boolean;
  readonly version: string;
}

export interface WorkspaceSnapshot {
  readonly name: string;
  readonly root: string;
  readonly branch: string;
  readonly changedFiles: number;
  readonly isRepo: boolean;
  readonly trusted: boolean;
  readonly gatedMcpServers: readonly string[];
}

export interface SessionListItem {
  readonly id: string;
  readonly title?: string;
  readonly lastPrompt?: string;
  readonly workDir: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archived?: boolean;
  readonly active: boolean;
  readonly selected: boolean;
  readonly lastTurnReason?: 'completed' | 'cancelled' | 'failed';
  readonly surface: DesktopSurface;
}

export interface DesktopSessionCreateOptions {
  readonly model?: string;
  readonly thinking?: string;
  readonly permission?: 'manual' | 'auto' | 'yolo';
  readonly planMode?: boolean;
  readonly additionalDirs?: readonly string[];
  readonly surface?: DesktopSurface;
}

export interface TeamSubmitResult {
  readonly message: TeamMessage;
  readonly wake: 'automatic';
}

export interface TeamImageInput {
  readonly type: 'image_url';
  readonly url: string;
  readonly name: string;
}

export interface TokenUsageSnapshot {
  readonly inputOther: number;
  readonly output: number;
  readonly inputCacheRead: number;
  readonly inputCacheCreation: number;
}

export interface SessionUsageSnapshot {
  readonly byModel?: Readonly<Record<string, TokenUsageSnapshot>>;
  readonly currentTurn?: TokenUsageSnapshot;
  readonly total?: TokenUsageSnapshot;
}

export interface SessionStatusSnapshot {
  readonly model?: string;
  readonly thinkingEffort: string;
  readonly permission: 'manual' | 'auto' | 'yolo';
  readonly planMode: boolean;
  readonly swarmMode?: boolean;
  readonly contextTokens: number;
  readonly maxContextTokens: number;
  readonly contextUsage: number;
  readonly usage?: SessionUsageSnapshot;
  readonly busy: boolean;
}

export interface TranscriptSnapshot {
  readonly sessionId: string;
  readonly agents: readonly AgentDescriptor[];
  readonly transcripts: Readonly<Record<string, AgentTranscriptSnapshot>>;
  readonly seqByAgent: Readonly<Record<string, number>>;
}

export interface ShellSnapshot {
  readonly commandId?: string;
  readonly command?: string;
  readonly status: 'idle' | 'running' | 'completed' | 'cancelled' | 'failed';
  readonly stdout: string;
  readonly stderr: string;
  readonly isError?: boolean;
  readonly backgrounded?: boolean;
}

export interface SessionDetailsSnapshot {
  readonly status?: SessionStatusSnapshot;
  readonly plan?: unknown;
  readonly backgroundTasks: readonly unknown[];
  readonly goal?: unknown;
  readonly cron?: unknown;
  readonly context?: {
    readonly tokenCount: number;
    readonly messageCount: number;
    readonly additionalDirs: readonly string[];
  };
  readonly skills: readonly unknown[];
  readonly pluginCommands: readonly unknown[];
  readonly commands: readonly unknown[];
  readonly mcpServers: readonly unknown[];
  readonly mcpStartupMetrics?: unknown;
}

export interface ExtensionSnapshot {
  readonly plugins: readonly unknown[];
  readonly capabilities: readonly unknown[];
  readonly workspaceSkills: readonly unknown[];
}

export interface ConfigSnapshot {
  readonly path: string;
  readonly value: JsonRecord;
  readonly diagnostics: unknown;
  readonly experimentalFeatures: readonly unknown[];
}

export interface DesktopSnapshot {
  readonly workspace: WorkspaceSnapshot;
  readonly tree: readonly WorkspaceNode[];
  readonly gitFiles: readonly GitFile[];
  readonly sessions: readonly SessionListItem[];
  readonly activeSessionId?: string;
  readonly transcript?: TranscriptSnapshot;
  readonly teams: Readonly<Record<string, TeamStateSnapshot>>;
  readonly session: SessionDetailsSnapshot;
  readonly extensions: ExtensionSnapshot;
  readonly config: ConfigSnapshot;
  readonly auth: unknown;
  readonly globalMcpServers: readonly unknown[];
  readonly globalMcpAuth: readonly unknown[];
  readonly shell: ShellSnapshot;
  readonly update: DesktopUpdateSnapshot;
  readonly rawEvents: readonly JsonRecord[];
  readonly loading: boolean;
}

export interface SequencedTranscriptBatch {
  readonly sessionId: string;
  readonly agentId: string;
  readonly seq: number;
  readonly ops: readonly TranscriptOperation[];
}

export type KimiDesktopNotification =
  | { readonly type: 'snapshot.reset'; readonly snapshot: DesktopSnapshot }
  | { readonly type: 'transcript.ops'; readonly batch: SequencedTranscriptBatch }
  | { readonly type: 'team.reset'; readonly sessionId: string; readonly state?: TeamStateSnapshot }
  | { readonly type: 'team.ops'; readonly sessionId: string; readonly operations: readonly TeamOperation[] }
  | {
      readonly type: 'session.status';
      readonly sessionId: string;
      readonly status: SessionStatusSnapshot;
    }
  | {
      readonly type: 'interaction.pending';
      readonly sessionId: string;
      readonly agentId: string;
      readonly interactionId: string;
      readonly interactionKind: 'approval' | 'question';
      readonly request: unknown;
    }
  | {
      readonly type: 'interaction.resolved';
      readonly sessionId: string;
      readonly agentId: string;
      readonly interactionId: string;
      readonly state: 'approved' | 'rejected' | 'cancelled' | 'answered' | 'dismissed';
      readonly response: unknown;
    }
  | {
      readonly type: 'workspace.changed';
      readonly workspace: WorkspaceSnapshot;
      readonly tree: readonly WorkspaceNode[];
      readonly gitFiles: readonly GitFile[];
      readonly changedPaths: readonly string[];
    }
  | { readonly type: 'update.changed'; readonly update: DesktopUpdateSnapshot }
  | {
      readonly type: 'host.closeRequested';
      readonly requestId: string;
      readonly dirtyPaths: readonly string[];
      readonly reason: 'quit' | 'install-update';
    }
  | { readonly type: 'error'; readonly error: KimiDesktopError; readonly command?: string };

export interface DesktopCommand {
  readonly domain: DesktopDomain;
  readonly action: string;
  readonly payload?: unknown;
}

type Invoke = <T = unknown>(domain: DesktopDomain, action: string, payload?: unknown) => Promise<T>;

export interface KimiDesktopApi {
  readonly workspace: {
    choose(): Promise<string | null>;
    open(path: string): Promise<void>;
    refresh(): Promise<void>;
    listDirectory(path?: string): Promise<readonly WorkspaceNode[]>;
    readFile(path: string): Promise<WorkspaceFileSnapshot>;
    writeFile(path: string, content: string, expectedVersion: string, force?: boolean, bom?: boolean): Promise<WorkspaceFileSnapshot>;
    readDiff(path: string, area: GitDiffArea): Promise<WorkspaceDiffSnapshot>;
    diff(path?: string): Promise<{ path: string; patch: string; truncated: boolean }>;
    trust(): Promise<void>;
  };
  readonly auth: {
    status(providerName?: string): Promise<unknown>;
    login(options?: { providerName?: string; baseUrl?: string; oauthHost?: string }): Promise<unknown>;
    logout(providerName?: string): Promise<unknown>;
    usage(providerName?: string): Promise<unknown>;
    feedback(content: string, contact?: string): Promise<unknown>;
  };
  readonly config: {
    get(): Promise<ConfigSnapshot>;
    set(patch: JsonRecord): Promise<ConfigSnapshot>;
    removeProvider(providerId: string): Promise<ConfigSnapshot>;
    diagnostics(): Promise<unknown>;
    features(): Promise<readonly unknown[]>;
  };
  readonly profile: {
    list(): Promise<AgentProfileListResult>;
    create(input: AgentProfileDraft): Promise<AgentProfileMutationResult>;
    update(input: AgentProfileUpdateInput): Promise<AgentProfileMutationResult>;
    delete(input: AgentProfileDeleteInput): Promise<AgentProfileDeleteResult>;
  };
  readonly session: {
    list(): Promise<readonly SessionListItem[]>;
    create(options?: DesktopSessionCreateOptions): Promise<string>;
    select(sessionId: string): Promise<void>;
    resume(sessionId: string): Promise<void>;
    reload(sessionId: string): Promise<void>;
    rename(sessionId: string, title: string): Promise<void>;
    fork(sessionId: string, turnIndex?: number, title?: string): Promise<string>;
    export(sessionId: string, outputPath?: string): Promise<unknown>;
    close(sessionId: string): Promise<void>;
    delete(sessionId: string): Promise<void>;
  };
  readonly turn: {
    submit(input: unknown): Promise<void>;
    cancel(sessionId?: string): Promise<void>;
    setModel(model: string, sessionId?: string): Promise<void>;
    setThinking(effort: string, sessionId?: string): Promise<void>;
    setPermission(mode: 'manual' | 'auto' | 'yolo', sessionId?: string): Promise<void>;
    setPlanMode(enabled: boolean, sessionId?: string): Promise<void>;
    setSwarmMode(enabled: boolean, sessionId?: string): Promise<void>;
    compact(instruction?: string, sessionId?: string): Promise<void>;
    cancelCompact(sessionId?: string): Promise<void>;
    undo(count?: number, sessionId?: string): Promise<void>;
  };
  readonly interaction: { resolve(sessionId: string, interactionId: string, response: unknown): Promise<void> };
  readonly context: {
    get(sessionId?: string): Promise<unknown>;
    clear(sessionId?: string): Promise<void>;
    import(content: string, source?: string, sessionId?: string): Promise<void>;
    addDirectory(path: string, persist?: boolean, sessionId?: string): Promise<unknown>;
    initAgents(sessionId?: string): Promise<void>;
    applySecondaryModel(sessionId?: string): Promise<void>;
    clearPlan(sessionId?: string): Promise<void>;
  };
  readonly extension: {
    list(): Promise<ExtensionSnapshot>;
    installPlugin(source: string): Promise<unknown>;
    togglePlugin(id: string, enabled: boolean): Promise<void>;
    togglePluginMcp(id: string, server: string, enabled: boolean): Promise<void>;
    removePlugin(id: string): Promise<void>;
    reloadPlugins(): Promise<unknown>;
    installCapability(id: string): Promise<unknown>;
    activateSkill(name: string, args?: string, sessionId?: string): Promise<void>;
    activatePlugin(pluginId: string, commandName: string, args?: string, sessionId?: string): Promise<void>;
    runCommand(name: string, args?: string, sessionId?: string): Promise<void>;
  };
  readonly mcp: {
    list(): Promise<unknown>;
    add(server: JsonRecord): Promise<unknown>;
    update(server: JsonRecord): Promise<unknown>;
    remove(name: string): Promise<unknown>;
    authenticate(name: string): Promise<void>;
    resetAuth(name: string): Promise<void>;
    test(name: string): Promise<unknown>;
    reconnect(name: string, sessionId?: string): Promise<void>;
  };
  readonly task: {
    list(sessionId?: string): Promise<readonly unknown[]>;
    output(taskId: string, tail?: number, sessionId?: string): Promise<string>;
    stop(taskId: string, reason?: string, sessionId?: string): Promise<void>;
    detach(taskId: string, sessionId?: string): Promise<unknown>;
    startBtw(sessionId?: string): Promise<string>;
    replaceTodos(
      expected: readonly TodoItem[],
      todos: readonly TodoItem[],
      sessionId?: string,
    ): Promise<void>;
  };
  readonly team: {
    ensure(sessionId: string, policy?: TeamPolicyInput): Promise<TeamSnapshot>;
    snapshot(sessionId: string): Promise<TeamSnapshot>;
    operations(sessionId: string, afterSeq: number, limit?: number): Promise<readonly TeamOperation[]>;
    history(sessionId: string, beforeChannelSeq?: number, limit?: number): Promise<readonly TeamMessage[]>;
    send(
      sessionId: string,
      body: string,
      clientMessageId: string,
      recipientAgentIds?: readonly string[],
    ): Promise<TeamMessage>;
    submit(
      sessionId: string,
      body: string,
      clientMessageId: string,
      media?: readonly TeamImageInput[],
      recipientAgentIds?: readonly string[],
    ): Promise<TeamSubmitResult>;
    answerQuestion(
      sessionId: string,
      questionId: string,
      answers: TeamQuestionAnswers | null,
    ): Promise<TeamMessage>;
    updatePolicy(
      sessionId: string,
      policy: TeamPolicyInput,
      expectedSeq: number,
    ): Promise<TeamSnapshot>;
    pause(sessionId: string, expectedSeq: number, reason?: string): Promise<TeamSnapshot>;
    resume(sessionId: string, expectedSeq: number): Promise<TeamSnapshot>;
    cancelTask(sessionId: string, taskId: string, expectedSeq: number): Promise<TeamSnapshot>;
    retryTask(sessionId: string, taskId: string, expectedSeq: number): Promise<TeamSnapshot>;
    reassignTask(
      sessionId: string,
      taskId: string,
      expectedSeq: number,
      profileName?: string,
      model?: string,
    ): Promise<TeamSnapshot>;
    artifact(sessionId: string, artifactId: string): Promise<TeamArtifactContent>;
    previewIntegration(sessionId: string): Promise<TeamArtifactContent | undefined>;
    applyIntegration(sessionId: string, expectedSeq: number): Promise<TeamSnapshot>;
    discardIntegration(sessionId: string, expectedSeq: number): Promise<TeamSnapshot>;
  };
  readonly goal: {
    get(sessionId?: string): Promise<unknown>;
    create(objective: string, replace?: boolean, sessionId?: string): Promise<unknown>;
    pause(sessionId?: string): Promise<unknown>;
    resume(sessionId?: string): Promise<unknown>;
    cancel(sessionId?: string): Promise<unknown>;
    cron(sessionId?: string): Promise<unknown>;
  };
  readonly shell: {
    run(command: string, sessionId?: string): Promise<unknown>;
    cancel(commandId: string, sessionId?: string): Promise<void>;
  };
  readonly update: {
    state(): Promise<DesktopUpdateSnapshot>;
    check(): Promise<DesktopUpdateSnapshot>;
    download(): Promise<DesktopUpdateSnapshot>;
    install(): Promise<void>;
    openRelease(): Promise<void>;
  };
  readonly host: {
    snapshot(): Promise<DesktopSnapshot>;
    openExternal(url: string): Promise<void>;
    openPath(path: string): Promise<void>;
    setDirtyFiles(paths: readonly string[]): Promise<void>;
    resolveClose(requestId: string, action: 'proceed' | 'cancel'): Promise<void>;
  };
  onNotification(listener: (notification: KimiDesktopNotification) => void): () => void;
}

export function createKimiDesktopApi(invoke: Invoke, subscribe: KimiDesktopApi['onNotification']): KimiDesktopApi {
  const call = <T>(domain: DesktopDomain, action: string, payload?: unknown): Promise<T> => invoke<T>(domain, action, payload);
  return {
    workspace: {
      choose: () => call('workspace', 'choose'),
      open: (path) => call('workspace', 'open', { path }),
      refresh: () => call('workspace', 'refresh'),
      listDirectory: (path) => call('workspace', 'listDirectory', { path }),
      readFile: (path) => call('workspace', 'readFile', { path }),
      writeFile: (path, content, expectedVersion, force, bom) => call('workspace', 'writeFile', { path, content, expectedVersion, force, bom }),
      readDiff: (path, area) => call('workspace', 'readDiff', { path, area }),
      diff: (path) => call('workspace', 'diff', { path }),
      trust: () => call('workspace', 'trust'),
    },
    auth: {
      status: (providerName) => call('auth', 'status', { providerName }),
      login: (options) => call('auth', 'login', options),
      logout: (providerName) => call('auth', 'logout', { providerName }),
      usage: (providerName) => call('auth', 'usage', { providerName }),
      feedback: (content, contact) => call('auth', 'feedback', { content, contact }),
    },
    config: {
      get: () => call('config', 'get'),
      set: (patch) => call('config', 'set', { patch }),
      removeProvider: (providerId) => call('config', 'removeProvider', { providerId }),
      diagnostics: () => call('config', 'diagnostics'),
      features: () => call('config', 'features'),
    },
    profile: {
      list: () => call('profile', 'list'),
      create: (input) => call('profile', 'create', input),
      update: (input) => call('profile', 'update', input),
      delete: (input) => call('profile', 'delete', input),
    },
    session: {
      list: () => call('session', 'list'),
      create: (options) => call('session', 'create', options),
      select: (sessionId) => call('session', 'select', { sessionId }),
      resume: (sessionId) => call('session', 'resume', { sessionId }),
      reload: (sessionId) => call('session', 'reload', { sessionId }),
      rename: (sessionId, title) => call('session', 'rename', { sessionId, title }),
      fork: (sessionId, turnIndex, title) => call('session', 'fork', { sessionId, turnIndex, title }),
      export: (sessionId, outputPath) => call('session', 'export', { sessionId, outputPath }),
      close: (sessionId) => call('session', 'close', { sessionId }),
      delete: (sessionId) => call('session', 'delete', { sessionId }),
    },
    turn: {
      submit: (input) => call('turn', 'submit', input),
      cancel: (sessionId) => call('turn', 'cancel', { sessionId }),
      setModel: (model, sessionId) => call('turn', 'model', { sessionId, model }),
      setThinking: (effort, sessionId) => call('turn', 'thinking', { sessionId, effort }),
      setPermission: (mode, sessionId) => call('turn', 'permission', { sessionId, mode }),
      setPlanMode: (enabled, sessionId) => call('turn', 'planMode', { sessionId, enabled }),
      setSwarmMode: (enabled, sessionId) => call('turn', 'swarmMode', { sessionId, enabled, trigger: 'manual' }),
      compact: (instruction, sessionId) => call('turn', 'compact', { sessionId, instruction }),
      cancelCompact: (sessionId) => call('turn', 'cancelCompact', { sessionId }),
      undo: (count = 1, sessionId) => call('turn', 'undo', { sessionId, count }),
    },
    interaction: { resolve: (sessionId, interactionId, response) => call('interaction', 'resolve', { sessionId, interactionId, response }) },
    context: {
      get: (sessionId) => call('context', 'get', { sessionId }),
      clear: (sessionId) => call('context', 'clear', { sessionId }),
      import: (content, source = 'Kimi Code Desktop', sessionId) => call('context', 'import', { sessionId, content, source }),
      addDirectory: (path, persist = true, sessionId) => call('context', 'addDirectory', { sessionId, path, persist }),
      initAgents: (sessionId) => call('context', 'initAgents', { sessionId }),
      applySecondaryModel: (sessionId) => call('context', 'secondaryModel', { sessionId }),
      clearPlan: (sessionId) => call('context', 'clearPlan', { sessionId }),
    },
    extension: {
      list: () => call('extension', 'list'),
      installPlugin: (source) => call('extension', 'installPlugin', { source }),
      togglePlugin: (id, enabled) => call('extension', 'togglePlugin', { id, enabled }),
      togglePluginMcp: (id, server, enabled) => call('extension', 'togglePluginMcp', { id, server, enabled }),
      removePlugin: (id) => call('extension', 'removePlugin', { id }),
      reloadPlugins: () => call('extension', 'reloadPlugins'),
      installCapability: (id) => call('extension', 'installCapability', { id }),
      activateSkill: (name, args, sessionId) => call('extension', 'activateSkill', { sessionId, name, args }),
      activatePlugin: (pluginId, commandName, args, sessionId) => call('extension', 'activatePlugin', { sessionId, pluginId, commandName, args }),
      runCommand: (name, args, sessionId) => call('extension', 'runCommand', { sessionId, name, args }),
    },
    mcp: {
      list: () => call('mcp', 'list'),
      add: (server) => call('mcp', 'add', { server }),
      update: (server) => call('mcp', 'update', { server }),
      remove: (name) => call('mcp', 'remove', { name }),
      authenticate: (name) => call('mcp', 'authenticate', { name }),
      resetAuth: (name) => call('mcp', 'resetAuth', { name }),
      test: (name) => call('mcp', 'test', { name }),
      reconnect: (name, sessionId) => call('mcp', 'reconnect', { sessionId, name }),
    },
    task: {
      list: (sessionId) => call('task', 'list', { sessionId }),
      output: (taskId, tail, sessionId) => call('task', 'output', { sessionId, taskId, tail }),
      stop: (taskId, reason, sessionId) => call('task', 'stop', { sessionId, taskId, reason }),
      detach: (taskId, sessionId) => call('task', 'detach', { sessionId, taskId }),
      startBtw: (sessionId) => call('task', 'startBtw', { sessionId }),
      replaceTodos: (expected, todos, sessionId) =>
        call('task', 'replaceTodos', { sessionId, expected, todos }),
    },
    team: {
      ensure: (sessionId, policy) => call('team', 'ensure', { sessionId, policy }),
      snapshot: (sessionId) => call('team', 'snapshot', { sessionId }),
      operations: (sessionId, afterSeq, limit) => call('team', 'operations', { sessionId, afterSeq, limit }),
      history: (sessionId, beforeChannelSeq, limit) => call('team', 'history', { sessionId, beforeChannelSeq, limit }),
      send: (sessionId, body, clientMessageId, recipientAgentIds) =>
        call('team', 'send', { sessionId, body, clientMessageId, recipientAgentIds }),
      submit: (sessionId, body, clientMessageId, media = [], recipientAgentIds) =>
        call('team', 'submit', { sessionId, body, clientMessageId, media, recipientAgentIds }),
      answerQuestion: (sessionId, questionId, answers) =>
        call('team', 'answerQuestion', { sessionId, questionId, answers }),
      updatePolicy: (sessionId, policy, expectedSeq) =>
        call('team', 'updatePolicy', { sessionId, policy, expectedSeq }),
      pause: (sessionId, expectedSeq, reason) =>
        call('team', 'pause', { sessionId, expectedSeq, reason }),
      resume: (sessionId, expectedSeq) => call('team', 'resume', { sessionId, expectedSeq }),
      cancelTask: (sessionId, taskId, expectedSeq) =>
        call('team', 'cancelTask', { sessionId, taskId, expectedSeq }),
      retryTask: (sessionId, taskId, expectedSeq) =>
        call('team', 'retryTask', { sessionId, taskId, expectedSeq }),
      reassignTask: (sessionId, taskId, expectedSeq, profileName, model) =>
        call('team', 'reassignTask', { sessionId, taskId, expectedSeq, profileName, model }),
      artifact: (sessionId, artifactId) => call('team', 'artifact', { sessionId, artifactId }),
      previewIntegration: (sessionId) => call('team', 'previewIntegration', { sessionId }),
      applyIntegration: (sessionId, expectedSeq) =>
        call('team', 'applyIntegration', { sessionId, expectedSeq }),
      discardIntegration: (sessionId, expectedSeq) =>
        call('team', 'discardIntegration', { sessionId, expectedSeq }),
    },
    goal: {
      get: (sessionId) => call('goal', 'get', { sessionId }),
      create: (objective, replace, sessionId) => call('goal', 'create', { sessionId, objective, replace }),
      pause: (sessionId) => call('goal', 'pause', { sessionId }),
      resume: (sessionId) => call('goal', 'resume', { sessionId }),
      cancel: (sessionId) => call('goal', 'cancel', { sessionId }),
      cron: (sessionId) => call('goal', 'cron', { sessionId }),
    },
    shell: {
      run: (command, sessionId) => call('shell', 'run', { sessionId, command }),
      cancel: (commandId, sessionId) => call('shell', 'cancel', { sessionId, commandId }),
    },
    update: {
      state: () => call('update', 'state'),
      check: () => call('update', 'check'),
      download: () => call('update', 'download'),
      install: () => call('update', 'install'),
      openRelease: () => call('update', 'openRelease'),
    },
    host: {
      snapshot: () => call('host', 'snapshot'),
      openExternal: (url) => call('host', 'openExternal', { url }),
      openPath: (path) => call('host', 'openPath', { path }),
      setDirtyFiles: (paths) => call('host', 'setDirtyFiles', { paths }),
      resolveClose: (requestId, action) => call('host', 'resolveClose', { requestId, action }),
    },
    onNotification: subscribe,
  };
}

declare global {
  interface Window {
    kimiDesktop: KimiDesktopApi;
  }
}
