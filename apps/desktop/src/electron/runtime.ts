import { platform } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { stat } from 'node:fs/promises';

import { watch, type FSWatcher } from 'chokidar';

import {
  createKimiHarnessV2,
  isKimiError,
  toKimiErrorPayload,
  type KimiConfig,
  type KimiConfigPatch,
  type KimiHarness,
  type McpServerConfig,
  type PermissionMode,
  type Session,
  type SessionSummary,
} from '@moonshot-ai/kimi-code-sdk';

import type {
  ConfigSnapshot,
  DesktopSessionCreateOptions,
  DesktopCommand,
  DesktopSnapshot,
  ExtensionSnapshot,
  GitDiffArea,
  JsonRecord,
  KimiDesktopError,
  KimiDesktopNotification,
  SessionListItem,
  WorkspaceSnapshot,
} from '../shared/desktop-api';
import type { DesktopCommandName } from '../shared/desktop-command-schema';
import { desktopSessionSurface, TEAM_SESSION_METADATA } from '../shared/team-session';
import { prepareDesktopMedia, resolveAllowedPath } from './media-service';
import {
  isIgnoredWorkspacePath,
  readGitDiff,
  readGitFileDiff,
  readWorkspaceDirectory,
  readWorkspaceFile,
  refreshWorkspace,
  writeWorkspaceFile,
} from './workspace-service';
import { SessionRuntime } from './session-runtime';

export interface KimiDesktopRuntimeHost {
  readonly chooseDirectory: () => Promise<string | null>;
  readonly openExternal: (url: string) => Promise<void>;
  readonly openPath: (path: string) => Promise<void>;
  readonly setDirtyFiles: (paths: readonly string[]) => void;
  readonly resolveClose: (requestId: string, action: 'proceed' | 'cancel') => void;
  readonly rememberWorkspace: (path: string) => Promise<void>;
  readonly notify: (notification: KimiDesktopNotification) => void;
}

export interface KimiDesktopRuntimeOptions {
  readonly workspaceRoot?: string;
  readonly homeDir?: string;
  readonly host: KimiDesktopRuntimeHost;
}

const EMPTY_WORKSPACE: WorkspaceSnapshot = {
  name: '',
  root: '',
  branch: 'HEAD',
  changedFiles: 0,
  isRepo: false,
  trusted: false,
  gatedMcpServers: [],
};

const EMPTY_CONFIG: ConfigSnapshot = {
  path: '',
  value: {},
  diagnostics: [],
  experimentalFeatures: [],
};

const EMPTY_EXTENSIONS: ExtensionSnapshot = {
  plugins: [],
  capabilities: [],
  workspaceSkills: [],
};

export class KimiDesktopRuntime {
  readonly harness: KimiHarness;

  private readonly host: KimiDesktopRuntimeHost;
  private readonly sessionRuntimes = new Map<string, SessionRuntime>();
  private workspaceRoot?: string;
  private workspace = EMPTY_WORKSPACE;
  private tree: DesktopSnapshot['tree'] = [];
  private gitFiles: DesktopSnapshot['gitFiles'] = [];
  private sessions: readonly SessionSummary[] = [];
  private activeSessionId?: string;
  private config = EMPTY_CONFIG;
  private extensions = EMPTY_EXTENSIONS;
  private auth: unknown = { providers: [] };
  private globalMcpServers: readonly unknown[] = [];
  private globalMcpAuth: readonly unknown[] = [];
  private rawEvents: JsonRecord[] = [];
  private loading = true;
  private initialized = false;
  private closing = false;
  private snapshotTimer?: ReturnType<typeof setTimeout>;
  private sessionIndexRefreshTimer?: ReturnType<typeof setTimeout>;
  private workspaceWatcher?: FSWatcher;
  private workspaceRefreshTimer?: ReturnType<typeof setTimeout>;
  private readonly pendingWorkspacePaths = new Set<string>();

  constructor(options: KimiDesktopRuntimeOptions) {
    this.workspaceRoot = options.workspaceRoot === undefined ? undefined : resolve(options.workspaceRoot);
    this.host = options.host;
    this.harness = createKimiHarnessV2({
      homeDir: options.homeDir,
      uiMode: 'desktop',
      identity: {
        productName: 'kimi-code-desktop',
        version: '0.1.0',
        platform: 'kimi_code_desktop',
        userAgentSuffix: `${process.platform}/${process.arch}`,
      },
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    const initialWorkspace = this.workspaceRoot;
    this.workspaceRoot = undefined;
    await this.harness.ensureConfigFile();
    await this.refreshGlobalState();
    if (initialWorkspace !== undefined) {
      try {
        await this.openWorkspace(initialWorkspace, { remember: false, publish: false });
      } catch (error) {
        await this.clearWorkspaceState();
        this.publishError(Object.assign(new Error(`无法恢复工作区：${initialWorkspace}`), {
          code: 'workspace.restore_failed',
          details: { path: initialWorkspace, reason: error instanceof Error ? error.message : String(error) },
        }), 'workspace.restore');
      }
    }
    this.loading = false;
    this.publishSnapshot();
  }

  async execute(command: DesktopCommand & { readonly name: DesktopCommandName }): Promise<unknown> {
    try {
      if (this.workspaceRoot === undefined && commandRequiresWorkspace(command.name)) {
        this.requireWorkspaceRoot();
      }
      return await this.executeCommand(command);
    } catch (error) {
      this.publishError(error, command.name);
      throw error;
    }
  }

  snapshot(): DesktopSnapshot {
    const runtime = this.activeRuntime(false);
    const teams = Object.fromEntries(
      [...this.sessionRuntimes.entries()]
        .filter((entry): entry is [string, SessionRuntime] => entry[1].teamState?.snapshot.team !== undefined)
        .map(([sessionId, sessionRuntime]) => [sessionId, sessionRuntime.teamState!]),
    );
    return {
      workspace: this.workspace,
      tree: this.tree,
      gitFiles: this.gitFiles,
      sessions: this.sessions.map((summary) => this.sessionItem(summary)),
      activeSessionId: this.activeSessionId,
      transcript: runtime?.transcriptSnapshot(),
      teams,
      session: runtime?.sessionDetails ?? {
        backgroundTasks: [], skills: [], pluginCommands: [], commands: [], mcpServers: [],
      },
      extensions: this.extensions,
      config: this.config,
      auth: this.auth,
      globalMcpServers: this.globalMcpServers,
      globalMcpAuth: this.globalMcpAuth,
      shell: runtime?.shellSnapshot ?? { status: 'idle', stdout: '', stderr: '' },
      rawEvents: this.rawEvents,
      loading: this.loading,
    };
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (this.snapshotTimer !== undefined) clearTimeout(this.snapshotTimer);
    if (this.sessionIndexRefreshTimer !== undefined) clearTimeout(this.sessionIndexRefreshTimer);
    if (this.workspaceRefreshTimer !== undefined) clearTimeout(this.workspaceRefreshTimer);
    await this.workspaceWatcher?.close();
    this.workspaceWatcher = undefined;
    await Promise.allSettled([...this.sessionRuntimes.values()].map((runtime) => runtime.close()));
    this.sessionRuntimes.clear();
    await this.harness.close();
  }

  private async executeCommand(command: DesktopCommand & { readonly name: DesktopCommandName }): Promise<unknown> {
    switch (command.name) {
      case 'workspace.choose': {
        const selected = await this.host.chooseDirectory();
        if (selected !== null) await this.openWorkspace(selected);
        return selected;
      }
      case 'workspace.open':
        await this.openWorkspace(payload<{ path: string }>(command).path);
        return undefined;
      case 'workspace.refresh':
        await this.refreshWorkspace();
        this.publishSnapshot();
        return undefined;
      case 'workspace.listDirectory':
        return readWorkspaceDirectory(this.requireWorkspaceRoot(), payload<{ path?: string }>(command).path);
      case 'workspace.readFile':
        return readWorkspaceFile(this.requireWorkspaceRoot(), payload<{ path: string }>(command).path);
      case 'workspace.writeFile': {
        const input = payload<{
          path: string;
          content: string;
          expectedVersion: string;
          force?: boolean;
          bom?: boolean;
        }>(command);
        const result = await writeWorkspaceFile(this.requireWorkspaceRoot(), input);
        await this.refreshWorkspace([result.path]);
        return result;
      }
      case 'workspace.readDiff': {
        const input = payload<{ path: string; area: GitDiffArea }>(command);
        let file = this.gitFiles.find((candidate) => candidate.path === input.path);
        if (file === undefined) {
          await this.refreshWorkspace();
          file = this.gitFiles.find((candidate) => candidate.path === input.path);
        }
        if (file === undefined) {
          throw Object.assign(new Error(`Git change not found: ${input.path}`), {
            code: 'workspace.git_change_not_found',
            details: { path: input.path, area: input.area },
          });
        }
        return readGitFileDiff(this.requireWorkspaceRoot(), file, input.area);
      }
      case 'workspace.diff':
        return readGitDiff(this.requireWorkspaceRoot(), payload<{ path?: string }>(command).path);
      case 'workspace.trust':
        await this.harness.trustWorkspace(this.requireWorkspaceRoot());
        await this.refreshWorkspace();
        this.publishSnapshot();
        return undefined;

      case 'auth.status':
        this.auth = await this.harness.auth.status(payload<{ providerName?: string }>(command).providerName);
        this.scheduleSnapshot();
        return this.auth;
      case 'auth.login': {
        const input = payload<{ providerName?: string; baseUrl?: string; oauthHost?: string }>(command);
        const result = await this.harness.auth.login(input.providerName, {
          baseUrl: input.baseUrl,
          oauthHost: input.oauthHost,
          onDeviceCode: async (device) => {
            this.pushRawEvent({
              type: 'auth.device_code',
              userCode: device.userCode,
              verificationUri: device.verificationUri,
              verificationUriComplete: device.verificationUriComplete,
              expiresIn: device.expiresIn,
            });
            await this.host.openExternal(device.verificationUriComplete);
          },
        });
        await Promise.all([this.refreshAuth(), this.refreshConfig()]);
        this.publishSnapshot();
        return result;
      }
      case 'auth.logout': {
        const result = await this.harness.auth.logout(payload<{ providerName?: string }>(command).providerName);
        await Promise.all([this.refreshAuth(), this.refreshConfig()]);
        this.publishSnapshot();
        return result;
      }
      case 'auth.usage':
        return this.harness.auth.getManagedUsage(payload<{ providerName?: string }>(command).providerName);
      case 'auth.feedback': {
        const input = payload<{ content: string; contact?: string }>(command);
        return this.harness.auth.submitFeedback({
          content: input.content,
          contact: input.contact,
          sessionId: this.activeSessionId ?? 'desktop',
          version: '0.1.0',
          os: platform(),
          model: this.activeRuntime(false)?.sessionStatus?.model ?? null,
        });
      }

      case 'config.get':
        await this.refreshConfig();
        return this.config;
      case 'config.set':
        await this.harness.setConfig(prepareConfigPatch(payload<{ patch: JsonRecord }>(command).patch) as KimiConfigPatch);
        await this.refreshConfig();
        this.publishSnapshot();
        return this.config;
      case 'config.removeProvider':
        await this.harness.removeProvider(payload<{ providerId: string }>(command).providerId);
        await this.refreshConfig();
        this.publishSnapshot();
        return this.config;
      case 'config.diagnostics':
        return this.harness.getConfigDiagnostics();
      case 'config.features':
        return this.harness.getExperimentalFeatures();

      case 'session.list':
        await this.refreshSessions();
        this.scheduleSnapshot();
        return this.sessions.map((summary) => this.sessionItem(summary));
      case 'session.create': {
        const input = payload<DesktopSessionCreateOptions>(command);
        const { surface = 'chat', ...sessionInput } = input;
        if (surface === 'team') await this.ensureDesktopTeamCollaboration();
        const session = await this.harness.createSession({
          workDir: this.requireWorkspaceRoot(),
          ...applySessionCreationDefaults(this.config.value, sessionInput),
          metadata: surface === 'team' ? TEAM_SESSION_METADATA : undefined,
        });
        const runtime = await this.attachSession(session);
        if (surface === 'team') await runtime.ensureTeam();
        await this.refreshSessions();
        this.publishSnapshot();
        return session.id;
      }
      case 'session.select':
      case 'session.resume':
        await this.resumeSession(payload<{ sessionId: string }>(command).sessionId);
        this.publishSnapshot();
        return undefined;
      case 'session.reload': {
        const id = payload<{ sessionId: string }>(command).sessionId;
        await this.detachSession(id);
        const session = await this.harness.reloadSession({ id, includeSubagents: true });
        await this.attachSession(session);
        await this.refreshSessions();
        this.publishSnapshot();
        return undefined;
      }
      case 'session.rename': {
        const input = payload<{ sessionId: string; title: string }>(command);
        await this.harness.renameSession({ id: input.sessionId, title: input.title });
        await this.refreshSessions();
        this.publishSnapshot();
        return undefined;
      }
      case 'session.fork': {
        const input = payload<{ sessionId: string; title?: string; turnIndex?: number }>(command);
        const session = await this.harness.forkSession({ id: input.sessionId, title: input.title, turnIndex: input.turnIndex });
        await this.attachSession(session);
        await this.refreshSessions();
        this.publishSnapshot();
        return session.id;
      }
      case 'session.export': {
        const input = payload<{ sessionId: string; outputPath?: string }>(command);
        return this.harness.exportSession({
          id: input.sessionId,
          outputPath: input.outputPath,
          version: '0.1.0',
          installSource: 'desktop',
        });
      }
      case 'session.close': {
        const id = payload<{ sessionId: string }>(command).sessionId;
        await this.detachSession(id);
        await this.refreshSessions();
        this.publishSnapshot();
        return undefined;
      }
      case 'session.delete': {
        const id = payload<{ sessionId: string }>(command).sessionId;
        const previousActiveSessionId = this.activeSessionId;
        const wasAttached = this.sessionRuntimes.has(id);
        await this.detachSession(id);
        try {
          await this.harness.deleteSession(id);
        } catch (error) {
          try {
            await this.refreshSessions();
            if (wasAttached && this.sessions.some((session) => session.id === id)) {
              await this.resumeSession(id);
              if (
                previousActiveSessionId !== undefined &&
                previousActiveSessionId !== id &&
                this.sessionRuntimes.has(previousActiveSessionId)
              ) {
                this.activeSessionId = previousActiveSessionId;
              }
            }
            this.publishSnapshot();
          } catch (rollbackError) {
            this.publishError(rollbackError, 'session.delete.rollback');
          }
          throw error;
        }
        await this.refreshSessions();
        this.publishSnapshot();
        return undefined;
      }

      case 'turn.submit': {
        const input = payload<{ sessionId?: string; mode: 'prompt' | 'steer' | 'swarm'; text: string; media: { type: 'image_url' | 'video_url'; url: string }[] }>(command);
        const runtime = this.runtimeFor(input.sessionId);
        const media = await Promise.all(input.media.map((item) => prepareDesktopMedia(item, {
          workspaceRoot: this.requireWorkspaceRoot(),
          allowedRoots: this.allowedRoots(runtime),
          cacheDir: join(this.harness.homeDir, 'cache', 'desktop-media'),
        })));
        await runtime.submit({ ...input, media });
        return undefined;
      }
      case 'turn.cancel':
        await this.runtimeFor(payload<{ sessionId?: string }>(command).sessionId).sdkSession.cancel();
        return undefined;
      case 'turn.model': {
        const input = payload<{ sessionId?: string; model: string }>(command);
        await this.runtimeFor(input.sessionId).sdkSession.setModel(input.model);
        return this.refreshActiveSession(input.sessionId);
      }
      case 'turn.thinking': {
        const input = payload<{ sessionId?: string; effort: string }>(command);
        await this.runtimeFor(input.sessionId).sdkSession.setThinking(input.effort);
        return this.refreshActiveSession(input.sessionId);
      }
      case 'turn.permission': {
        const input = payload<{ sessionId?: string; mode: PermissionMode }>(command);
        await this.runtimeFor(input.sessionId).sdkSession.setPermission(input.mode);
        return this.refreshActiveSession(input.sessionId);
      }
      case 'turn.planMode': {
        const input = payload<{ sessionId?: string; enabled: boolean }>(command);
        await this.runtimeFor(input.sessionId).setPlanMode(input.enabled);
        return undefined;
      }
      case 'turn.swarmMode': {
        const input = payload<{ sessionId?: string; enabled: boolean; trigger: 'manual' | 'task' | 'tool' }>(command);
        await this.runtimeFor(input.sessionId).sdkSession.setSwarmMode(input.enabled, input.trigger);
        return this.refreshActiveSession(input.sessionId);
      }
      case 'turn.compact': {
        const input = payload<{ sessionId?: string; instruction?: string }>(command);
        await this.runtimeFor(input.sessionId).sdkSession.compact({ instruction: input.instruction });
        return undefined;
      }
      case 'turn.cancelCompact':
        await this.runtimeFor(payload<{ sessionId?: string }>(command).sessionId).sdkSession.cancelCompaction();
        return undefined;
      case 'turn.undo': {
        const input = payload<{ sessionId?: string; count: number }>(command);
        await this.runtimeFor(input.sessionId).sdkSession.undoHistory(input.count);
        await this.reloadRuntime(input.sessionId);
        return undefined;
      }

      case 'interaction.resolve': {
        const input = payload<{ sessionId: string; interactionId: string; response: unknown }>(command);
        this.runtimeFor(input.sessionId).resolveInteraction(input.interactionId, input.response);
        return undefined;
      }

      case 'context.get':
        return this.runtimeFor(payload<{ sessionId?: string }>(command).sessionId).sdkSession.getContext();
      case 'context.clear': {
        const id = payload<{ sessionId?: string }>(command).sessionId;
        await this.runtimeFor(id).sdkSession.clearContext();
        await this.reloadRuntime(id);
        return undefined;
      }
      case 'context.import': {
        const input = payload<{ sessionId?: string; content: string; source: string }>(command);
        await this.runtimeFor(input.sessionId).sdkSession.importContext(input.content, input.source);
        return this.refreshActiveSession(input.sessionId);
      }
      case 'context.addDirectory': {
        const input = payload<{ sessionId?: string; path: string; persist: boolean }>(command);
        const result = await this.runtimeFor(input.sessionId).sdkSession.addAdditionalDir(input.path, { persist: input.persist });
        await this.refreshActiveSession(input.sessionId);
        return result;
      }
      case 'context.initAgents':
        await this.runtimeFor(payload<{ sessionId?: string }>(command).sessionId).sdkSession.init();
        return undefined;
      case 'context.secondaryModel': {
        const id = payload<{ sessionId?: string }>(command).sessionId;
        await this.runtimeFor(id).sdkSession.applyPersistedSecondaryModel();
        return this.refreshActiveSession(id);
      }
      case 'context.clearPlan': {
        const id = payload<{ sessionId?: string }>(command).sessionId;
        await this.runtimeFor(id).sdkSession.clearPlan();
        return this.refreshActiveSession(id);
      }

      case 'extension.list':
        await this.refreshExtensions();
        this.scheduleSnapshot();
        return this.extensions;
      case 'extension.installPlugin': {
        const result = await this.harness.installPlugin(payload<{ source: string }>(command).source);
        await this.refreshExtensions();
        this.publishSnapshot();
        return result;
      }
      case 'extension.togglePlugin': {
        const input = payload<{ id: string; enabled: boolean }>(command);
        await this.harness.setPluginEnabled(input.id, input.enabled);
        await this.refreshExtensions();
        this.publishSnapshot();
        return undefined;
      }
      case 'extension.togglePluginMcp': {
        const input = payload<{ id: string; server: string; enabled: boolean }>(command);
        await this.harness.setPluginMcpServerEnabled(input.id, input.server, input.enabled);
        await this.refreshExtensions();
        this.publishSnapshot();
        return undefined;
      }
      case 'extension.removePlugin':
        await this.harness.removePlugin(payload<{ id: string }>(command).id);
        await this.refreshExtensions();
        this.publishSnapshot();
        return undefined;
      case 'extension.reloadPlugins': {
        const result = await this.harness.reloadPlugins();
        await this.refreshExtensions();
        this.publishSnapshot();
        return result;
      }
      case 'extension.installCapability': {
        const result = await this.harness.installCapability(payload<{ id: string }>(command).id);
        await this.refreshExtensions();
        this.publishSnapshot();
        return result;
      }
      case 'extension.activateSkill': {
        const input = payload<{ sessionId?: string; name: string; args?: string }>(command);
        await this.runtimeFor(input.sessionId).sdkSession.activateSkill(input.name, input.args);
        return undefined;
      }
      case 'extension.activatePlugin': {
        const input = payload<{ sessionId?: string; pluginId: string; commandName: string; args?: string }>(command);
        await this.runtimeFor(input.sessionId).sdkSession.activatePluginCommand(input.pluginId, input.commandName, input.args);
        return undefined;
      }
      case 'extension.runCommand': {
        const input = payload<{ sessionId?: string; name: string; args?: string }>(command);
        await this.runtimeFor(input.sessionId).sdkSession.runCommand(input.name, input.args);
        return undefined;
      }

      case 'mcp.list':
        await this.refreshMcp();
        this.scheduleSnapshot();
        return { servers: this.globalMcpServers, auth: this.globalMcpAuth };
      case 'mcp.add': {
        const result = await this.harness.addMcpServer(payload<{ server: JsonRecord }>(command).server as McpServerConfig);
        await this.refreshMcp();
        this.publishSnapshot();
        return result;
      }
      case 'mcp.update': {
        const result = await this.harness.updateMcpServer(payload<{ server: JsonRecord }>(command).server as McpServerConfig);
        await this.refreshMcp();
        this.publishSnapshot();
        return result;
      }
      case 'mcp.remove': {
        const result = await this.harness.removeMcpServer(payload<{ name: string }>(command).name);
        await this.refreshMcp();
        this.publishSnapshot();
        return result;
      }
      case 'mcp.authenticate': {
        const name = payload<{ name: string }>(command).name;
        await this.harness.authenticateMcpServer(name, { onAuthorizationUrl: (url) => this.host.openExternal(url) });
        await this.refreshMcp();
        this.publishSnapshot();
        return undefined;
      }
      case 'mcp.resetAuth':
        await this.harness.resetMcpServerAuth(payload<{ name: string }>(command).name);
        await this.refreshMcp();
        this.publishSnapshot();
        return undefined;
      case 'mcp.test': {
        const name = payload<{ name: string }>(command).name;
        return this.harness.testMcpServer(name, { cwd: this.requireWorkspaceRoot() });
      }
      case 'mcp.reconnect': {
        const input = payload<{ sessionId?: string; name: string }>(command);
        await this.runtimeFor(input.sessionId).sdkSession.reconnectMcpServer(input.name);
        return this.refreshActiveSession(input.sessionId);
      }

      case 'task.list':
        return this.runtimeFor(payload<{ sessionId?: string }>(command).sessionId).sdkSession.listBackgroundTasks({ limit: 200 });
      case 'task.output': {
        const input = payload<{ sessionId?: string; taskId: string; tail?: number }>(command);
        return this.runtimeFor(input.sessionId).sdkSession.getBackgroundTaskOutput(input.taskId, { tail: input.tail });
      }
      case 'task.stop': {
        const input = payload<{ sessionId?: string; taskId: string; reason?: string }>(command);
        await this.runtimeFor(input.sessionId).sdkSession.stopBackgroundTask(input.taskId, { reason: input.reason });
        return this.refreshActiveSession(input.sessionId);
      }
      case 'task.detach': {
        const input = payload<{ sessionId?: string; taskId: string }>(command);
        const result = await this.runtimeFor(input.sessionId).sdkSession.detachBackgroundTask(input.taskId);
        await this.refreshActiveSession(input.sessionId);
        return result;
      }
      case 'task.startBtw':
        return this.runtimeFor(payload<{ sessionId?: string }>(command).sessionId).startBtw();
      case 'task.replaceTodos': {
        const input = payload<{
          sessionId?: string;
          expected: readonly import('@moonshot-ai/kimi-code-sdk').TodoItem[];
          todos: readonly import('@moonshot-ai/kimi-code-sdk').TodoItem[];
        }>(command);
        return this.runtimeFor(input.sessionId).replaceTodos(input.expected, input.todos);
      }

      case 'team.snapshot': {
        const input = payload<{ sessionId: string }>(command);
        return this.runtimeFor(input.sessionId).getTeamSnapshot();
      }
      case 'team.ensure': {
        const input = payload<{ sessionId: string }>(command);
        await this.ensureDesktopTeamCollaboration();
        return this.runtimeFor(input.sessionId).ensureTeam();
      }
      case 'team.operations': {
        const input = payload<{ sessionId: string; afterSeq: number; limit?: number }>(command);
        return this.runtimeFor(input.sessionId).getTeamOperations(input.afterSeq, input.limit);
      }
      case 'team.history': {
        const input = payload<{ sessionId: string; beforeChannelSeq?: number; limit?: number }>(command);
        return this.runtimeFor(input.sessionId).getTeamHistory(input.beforeChannelSeq, input.limit);
      }
      case 'team.send': {
        const input = payload<{ sessionId: string; body: string; clientMessageId: string }>(command);
        return this.runtimeFor(input.sessionId).sendTeamMessage(input.body, input.clientMessageId);
      }
      case 'team.submit': {
        const input = payload<{ sessionId: string; body: string; clientMessageId: string }>(command);
        await this.ensureDesktopTeamCollaboration();
        return this.runtimeFor(input.sessionId).submitTeamMessage(input.body, input.clientMessageId);
      }

      case 'goal.get':
        return this.runtimeFor(payload<{ sessionId?: string }>(command).sessionId).sdkSession.getGoal();
      case 'goal.create': {
        const input = payload<{ sessionId?: string; objective: string; replace?: boolean }>(command);
        const result = await this.runtimeFor(input.sessionId).sdkSession.createGoal({ objective: input.objective, replace: input.replace });
        await this.refreshActiveSession(input.sessionId);
        return result;
      }
      case 'goal.pause':
        return this.goalMutation(command, (session) => session.pauseGoal());
      case 'goal.resume':
        return this.goalMutation(command, (session) => session.resumeGoal());
      case 'goal.cancel':
        return this.goalMutation(command, (session) => session.cancelGoal());
      case 'goal.cron':
        return this.runtimeFor(payload<{ sessionId?: string }>(command).sessionId).sdkSession.getCronTasks();

      case 'shell.run': {
        const input = payload<{ sessionId?: string; command: string }>(command);
        return this.runtimeFor(input.sessionId).runShell(input.command);
      }
      case 'shell.cancel': {
        const input = payload<{ sessionId?: string; commandId: string }>(command);
        await this.runtimeFor(input.sessionId).cancelShell(input.commandId);
        return undefined;
      }

      case 'host.snapshot':
        return this.snapshot();
      case 'host.openExternal':
        await this.host.openExternal(assertExternalUrl(payload<{ url: string }>(command).url));
        return undefined;
      case 'host.openPath':
        await this.host.openPath(await this.assertOpenPath(payload<{ path: string }>(command).path));
        return undefined;
      case 'host.setDirtyFiles':
        this.host.setDirtyFiles(payload<{ paths: readonly string[] }>(command).paths);
        return undefined;
      case 'host.resolveClose': {
        const input = payload<{ requestId: string; action: 'proceed' | 'cancel' }>(command);
        this.host.resolveClose(input.requestId, input.action);
        return undefined;
      }
    }
  }

  private async refreshGlobalState(): Promise<void> {
    this.loading = true;
    const results = await Promise.allSettled([
      this.refreshConfig(),
      this.refreshAuth(),
      this.refreshExtensions(),
      this.refreshMcp(),
    ]);
    for (const result of results) {
      if (result.status === 'rejected') this.publishError(result.reason, 'runtime.initialize');
    }
  }

  private async refreshWorkspace(changedPaths: readonly string[] = []): Promise<void> {
    const root = this.requireWorkspaceRoot();
    const [refreshed, trust] = await Promise.all([
      refreshWorkspace(root),
      this.harness.getWorkspaceTrustInfo(root),
    ]);
    this.workspace = {
      ...refreshed.workspace,
      isRepo: refreshed.isRepo,
      trusted: trust.trusted,
      gatedMcpServers: trust.gatedMcpServers,
    };
    this.tree = refreshed.tree;
    this.gitFiles = refreshed.files;
    this.host.notify({
      type: 'workspace.changed',
      workspace: this.workspace,
      tree: this.tree,
      gitFiles: this.gitFiles,
      changedPaths,
    });
  }

  private async refreshSessions(): Promise<void> {
    this.sessions = (await this.harness.listSessions({ workDir: this.requireWorkspaceRoot() }))
      .toSorted((left, right) => right.updatedAt - left.updatedAt);
  }

  private async refreshConfig(): Promise<void> {
    const [value, diagnostics, experimentalFeatures] = await Promise.all([
      this.harness.getConfig({ reload: true }),
      this.harness.getConfigDiagnostics(),
      this.harness.getExperimentalFeatures(),
    ]);
    this.config = {
      path: this.harness.configPath,
      value: sanitizeConfig(value),
      diagnostics: redactSecrets(diagnostics),
      experimentalFeatures: redactSecrets(experimentalFeatures) as readonly unknown[],
    };
  }

  private async ensureDesktopTeamCollaboration(): Promise<void> {
    const feature = this.config.experimentalFeatures.find((candidate) => {
      const value = objectValue(candidate);
      return value?.['id'] === 'team_collaboration';
    });
    if (objectValue(feature)?.['enabled'] === true) return;
    await this.harness.setConfig({
      experimental: { team_collaboration: true },
    } as KimiConfigPatch);
    await this.refreshConfig();
  }

  private async refreshAuth(): Promise<void> {
    this.auth = redactSecrets(await this.harness.auth.status());
  }

  private async refreshExtensions(): Promise<void> {
    const root = this.workspaceRoot;
    const [pluginSummaries, capabilities, workspaceSkills] = await Promise.all([
      this.harness.listPlugins(),
      this.harness.listCapabilities(),
      root === undefined ? Promise.resolve([]) : this.harness.listWorkspaceSkills(root),
    ]);
    const plugins = await Promise.all(pluginSummaries.map(async (plugin) => {
      try {
        return await this.harness.getPluginInfo(plugin.id);
      } catch {
        return plugin;
      }
    }));
    this.extensions = {
      plugins: redactSecrets(plugins) as readonly unknown[],
      capabilities: redactSecrets(capabilities) as readonly unknown[],
      workspaceSkills: redactSecrets(workspaceSkills) as readonly unknown[],
    };
  }

  private async refreshMcp(): Promise<void> {
    const [servers, auth] = await Promise.all([
      this.harness.listMcpServers(),
      this.harness.listMcpServerAuthStatuses(),
    ]);
    this.globalMcpServers = redactSecrets(servers) as readonly unknown[];
    this.globalMcpAuth = redactSecrets(auth) as readonly unknown[];
  }

  private async openWorkspace(
    path: string,
    options: { readonly remember?: boolean; readonly publish?: boolean } = {},
  ): Promise<void> {
    const root = resolve(path);
    let directory = false;
    try {
      directory = (await stat(root)).isDirectory();
    } catch {
      // The structured error below keeps missing and inaccessible paths on the same boundary.
    }
    if (!directory) {
      throw Object.assign(new Error(`Workspace is not a directory: ${root}`), {
        code: 'workspace.invalid_directory',
        details: { path: root },
      });
    }

    const [refreshed, trust, sessions] = await Promise.all([
      refreshWorkspace(root),
      this.harness.getWorkspaceTrustInfo(root),
      this.harness.listSessions({ workDir: root }),
    ]);
    const switchingWorkspace = this.workspaceRoot !== undefined && this.workspaceRoot !== root;
    if (switchingWorkspace) await this.clearWorkspaceState();

    this.workspaceRoot = root;
    this.workspace = {
      ...refreshed.workspace,
      isRepo: refreshed.isRepo,
      trusted: trust.trusted,
      gatedMcpServers: trust.gatedMcpServers,
    };
    this.tree = refreshed.tree;
    this.gitFiles = refreshed.files;
    this.sessions = sessions.toSorted((left, right) => right.updatedAt - left.updatedAt);
    this.host.notify({
      type: 'workspace.changed',
      workspace: this.workspace,
      tree: this.tree,
      gitFiles: this.gitFiles,
      changedPaths: [],
    });

    try {
      await this.refreshExtensions();
    } catch (error) {
      this.publishError(error, 'extension.list');
    }
    await this.restartWorkspaceWatcher();
    if (this.activeSessionId === undefined || !this.sessions.some((session) => session.id === this.activeSessionId)) {
      this.activeSessionId = undefined;
      const latest = this.sessions[0];
      if (latest !== undefined) {
        try {
          await this.resumeSession(latest.id);
        } catch (error) {
          this.publishError(error, 'session.resume');
        }
      }
    }
    if (options.remember !== false) {
      try {
        await this.host.rememberWorkspace(root);
      } catch (error) {
        this.publishError(Object.assign(new Error('无法记住当前工作区'), {
          code: 'workspace.remember_failed',
          details: { path: root, reason: error instanceof Error ? error.message : String(error) },
        }), 'workspace.remember');
      }
    }
    if (options.publish !== false) this.publishSnapshot();
  }

  private async restartWorkspaceWatcher(): Promise<void> {
    await this.workspaceWatcher?.close();
    const root = this.workspaceRoot;
    if (this.closing || root === undefined) return;
    this.workspaceWatcher = watch(root, {
      ignoreInitial: true,
      followSymlinks: false,
      awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 40 },
      ignored: (path) => {
        const relativePath = relative(root, path).split('\\').join('/');
        if (relativePath === '' || relativePath === '.git') return false;
        if (relativePath === '.git/index' || relativePath === '.git/HEAD') return false;
        if (relativePath.startsWith('.git/')) return true;
        return isIgnoredWorkspacePath(relativePath);
      },
    });
    this.workspaceWatcher.on('all', (_event, path) => this.scheduleWorkspaceRefresh(root, path));
    this.workspaceWatcher.on('error', (error) => this.publishError(error, 'workspace.watch'));
  }

  private scheduleWorkspaceRefresh(root: string, path: string): void {
    if (this.workspaceRoot !== root) return;
    const relativePath = relative(root, path).split('\\').join('/');
    if (relativePath.length > 0 && !relativePath.startsWith('.git/')) {
      this.pendingWorkspacePaths.add(relativePath);
    }
    if (this.workspaceRefreshTimer !== undefined) clearTimeout(this.workspaceRefreshTimer);
    this.workspaceRefreshTimer = setTimeout(() => {
      this.workspaceRefreshTimer = undefined;
      if (this.workspaceRoot !== root) return;
      const changedPaths = [...this.pendingWorkspacePaths].toSorted();
      this.pendingWorkspacePaths.clear();
      void this.refreshWorkspace(changedPaths).catch((error) => this.publishError(error, 'workspace.watch'));
    }, 180);
  }

  private async clearWorkspaceState(): Promise<void> {
    if (this.workspaceRefreshTimer !== undefined) clearTimeout(this.workspaceRefreshTimer);
    if (this.sessionIndexRefreshTimer !== undefined) clearTimeout(this.sessionIndexRefreshTimer);
    this.workspaceRefreshTimer = undefined;
    this.sessionIndexRefreshTimer = undefined;
    this.pendingWorkspacePaths.clear();
    await this.workspaceWatcher?.close();
    this.workspaceWatcher = undefined;
    await Promise.allSettled([...this.sessionRuntimes.values()].map((runtime) => runtime.close()));
    this.sessionRuntimes.clear();
    this.workspaceRoot = undefined;
    this.workspace = EMPTY_WORKSPACE;
    this.tree = [];
    this.gitFiles = [];
    this.sessions = [];
    this.activeSessionId = undefined;
    this.extensions = { ...this.extensions, workspaceSkills: [] };
    this.rawEvents = [];
  }

  private async resumeSession(id: string): Promise<void> {
    const existing = this.sessionRuntimes.get(id);
    if (existing !== undefined) {
      this.activeSessionId = id;
      await existing.refreshDetails();
      return;
    }
    const session = await this.harness.resumeSession({ id, includeSubagents: true });
    await this.attachSession(session);
    await this.refreshSessions();
  }

  private async attachSession(session: Session): Promise<SessionRuntime> {
    const existing = this.sessionRuntimes.get(session.id);
    if (existing !== undefined) {
      this.activeSessionId = session.id;
      return existing;
    }
    const runtime = new SessionRuntime({
      session,
      mediaCacheDir: join(this.harness.homeDir, 'cache', 'desktop-media'),
      emit: (notification) => this.host.notify(notification),
      onRawEvent: (event) => this.pushRawEvent(event as unknown as JsonRecord),
      onStateChanged: () => this.scheduleSnapshot(),
      onSessionMetadataChanged: (sessionId, patch) => {
        this.handleSessionMetadataChanged(sessionId, patch);
      },
      onTeamDetected: (sessionId) => {
        void this.markSessionAsTeam(sessionId);
      },
    });
    this.sessionRuntimes.set(session.id, runtime);
    try {
      await runtime.initialize();
    } catch (error) {
      this.sessionRuntimes.delete(session.id);
      await runtime.close().catch(() => undefined);
      throw error;
    }
    this.activeSessionId = session.id;
    return runtime;
  }

  private async detachSession(id: string): Promise<void> {
    const runtime = this.sessionRuntimes.get(id);
    if (runtime !== undefined) {
      await runtime.close();
      this.sessionRuntimes.delete(id);
    } else {
      await this.harness.closeSession(id);
    }
    if (this.activeSessionId === id) {
      this.activeSessionId = this.sessionRuntimes.keys().next().value as string | undefined;
    }
  }

  private runtimeFor(id?: string): SessionRuntime {
    const sessionId = id ?? this.activeSessionId;
    if (sessionId === undefined) throw new Error('No active Kimi session');
    const runtime = this.sessionRuntimes.get(sessionId);
    if (runtime === undefined) throw new Error(`Session is not active: ${sessionId}`);
    return runtime;
  }

  private activeRuntime(required = true): SessionRuntime | undefined {
    if (this.activeSessionId === undefined) {
      if (required) throw new Error('No active Kimi session');
      return undefined;
    }
    const runtime = this.sessionRuntimes.get(this.activeSessionId);
    if (runtime === undefined && required) throw new Error(`Session is not active: ${this.activeSessionId}`);
    return runtime;
  }

  private async reloadRuntime(id?: string): Promise<void> {
    const sessionId = id ?? this.activeSessionId;
    if (sessionId === undefined) throw new Error('No active Kimi session');
    await this.detachSession(sessionId);
    const session = await this.harness.reloadSession({ id: sessionId, includeSubagents: true });
    await this.attachSession(session);
    this.publishSnapshot();
  }

  private async refreshActiveSession(id?: string): Promise<void> {
    await this.runtimeFor(id).refreshDetails();
    this.scheduleSnapshot();
  }

  private async goalMutation(
    command: DesktopCommand,
    mutate: (session: Session) => Promise<unknown>,
  ): Promise<unknown> {
    const id = payload<{ sessionId?: string }>(command).sessionId;
    const result = await mutate(this.runtimeFor(id).sdkSession);
    await this.refreshActiveSession(id);
    return result;
  }

  private sessionItem(summary: SessionSummary): SessionListItem {
    const runtime = this.sessionRuntimes.get(summary.id);
    return {
      id: summary.id,
      title: summary.title,
      lastPrompt: summary.lastPrompt,
      workDir: summary.workDir,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      archived: summary.archived,
      active: this.sessionRuntimes.has(summary.id),
      selected: summary.id === this.activeSessionId,
      lastTurnReason: summary.lastTurnReason,
      surface: desktopSessionSurface(
        summary.metadata,
        runtime?.teamState?.snapshot.team !== undefined,
      ),
    };
  }

  private pushRawEvent(event: JsonRecord): void {
    const safe = redactSecrets(event) as JsonRecord;
    this.rawEvents = [...this.rawEvents.slice(-299), safe];
    this.scheduleSnapshot();
  }

  private handleSessionMetadataChanged(
    sessionId: string,
    patch: { readonly title?: string; readonly lastPrompt?: string },
  ): void {
    const runtimeSummary = this.sessionRuntimes.get(sessionId)?.sdkSession.summary;
    let found = false;
    this.sessions = this.sessions.map((summary) => {
      if (summary.id !== sessionId) return summary;
      found = true;
      return {
        ...summary,
        title: patch.title ?? summary.title,
        lastPrompt: patch.lastPrompt ?? summary.lastPrompt,
        updatedAt: runtimeSummary?.updatedAt ?? Date.now(),
      };
    });
    if (!found && runtimeSummary !== undefined) {
      this.sessions = [...this.sessions, runtimeSummary];
    }
    this.sessions = this.sessions.toSorted((left, right) => right.updatedAt - left.updatedAt);
    this.scheduleSnapshot();
    this.scheduleSessionIndexRefresh();
  }

  private async markSessionAsTeam(sessionId: string): Promise<void> {
    const session = this.sessionRuntimes.get(sessionId)?.sdkSession;
    if (session?.summary === undefined || desktopSessionSurface(session.summary.metadata) === 'team') return;
    const metadata = objectValue(session.summary.metadata);
    const desktop = objectValue(metadata?.['kimiDesktop']);
    try {
      await session.updateMetadata({
        kimiDesktop: {
          ...desktop,
          version: 1,
          surface: 'team',
        },
      });
      await this.refreshSessions();
      this.scheduleSnapshot();
    } catch (error) {
      this.host.notify({
        type: 'error',
        command: 'session.markTeam',
        error: serializeError(error),
      });
    }
  }

  private scheduleSessionIndexRefresh(): void {
    if (this.sessionIndexRefreshTimer !== undefined) clearTimeout(this.sessionIndexRefreshTimer);
    this.sessionIndexRefreshTimer = setTimeout(() => {
      this.sessionIndexRefreshTimer = undefined;
      void this.refreshSessions()
        .then(() => { this.scheduleSnapshot(); })
        .catch((error) => { this.publishError(error, 'session.list'); });
    }, 120);
  }

  private scheduleSnapshot(): void {
    if (this.snapshotTimer !== undefined || this.closing) return;
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = undefined;
      this.publishSnapshot();
    }, 80);
  }

  private publishSnapshot(): void {
    if (this.closing) return;
    this.host.notify({ type: 'snapshot.reset', snapshot: this.snapshot() });
  }

  private publishError(error: unknown, command?: string): void {
    this.host.notify({ type: 'error', error: serializeError(error), command });
  }

  private requireWorkspaceRoot(): string {
    if (this.workspaceRoot !== undefined) return this.workspaceRoot;
    throw Object.assign(new Error('请先选择一个工作区'), {
      code: 'workspace.not_selected',
    });
  }

  private allowedRoots(runtime?: SessionRuntime): readonly string[] {
    return [
      ...(this.workspaceRoot === undefined ? [] : [this.workspaceRoot]),
      this.harness.homeDir,
      ...(runtime?.sdkSession.summary?.additionalDirs ?? []),
    ];
  }

  private async assertOpenPath(path: string): Promise<string> {
    return resolveAllowedPath(path, this.allowedRoots(this.activeRuntime(false)));
  }
}

function payload<T>(command: DesktopCommand): T {
  return (command.payload ?? {}) as T;
}

function commandRequiresWorkspace(name: DesktopCommandName): boolean {
  const domain = name.split('.')[0];
  if (domain === 'workspace') return name !== 'workspace.choose' && name !== 'workspace.open';
  if (
    domain === 'session' ||
    domain === 'turn' ||
    domain === 'interaction' ||
    domain === 'context' ||
    domain === 'task' ||
    domain === 'team' ||
    domain === 'goal' ||
    domain === 'shell'
  ) return true;
  if (domain === 'extension') {
    return name === 'extension.activateSkill' || name === 'extension.activatePlugin' || name === 'extension.runCommand';
  }
  return name === 'mcp.test' || name === 'mcp.reconnect';
}

export function serializeError(error: unknown): KimiDesktopError {
  if (isKimiError(error)) {
    const payload = toKimiErrorPayload(error);
    return {
      code: payload.code,
      message: payload.message,
      details: redactSecrets(payload.details) as JsonRecord | undefined,
      retryable: payload.retryable,
    };
  }
  const structured = structuredError(error);
  if (structured !== undefined) return structured;
  if (error instanceof Error) {
    return {
      code: 'desktop.internal',
      message: error.message,
    };
  }
  return { code: 'desktop.internal', message: String(error) };
}

function structuredError(error: unknown): KimiDesktopError | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const value = error as Record<string, unknown>;
  if (typeof value['code'] !== 'string' || !/^[a-z0-9_.-]+$/i.test(value['code'])) return undefined;
  if (typeof value['message'] !== 'string') return undefined;
  const rawDetails = value['details'];
  const details = rawDetails === undefined
    ? undefined
    : rawDetails !== null && typeof rawDetails === 'object' && !Array.isArray(rawDetails)
      ? redactSecrets(rawDetails) as JsonRecord
      : { value: redactSecrets(rawDetails) };
  return {
    code: value['code'],
    message: value['message'],
    details,
    retryable: typeof value['retryable'] === 'boolean' ? value['retryable'] : undefined,
  };
}

export function sanitizeConfig(config: KimiConfig): JsonRecord {
  const safe = redactSecrets(config) as JsonRecord;
  delete safe['raw'];
  return safe;
}

export function applySessionCreationDefaults(
  config: JsonRecord,
  input: {
    readonly model?: string;
    readonly thinking?: string;
    readonly permission?: PermissionMode;
    readonly planMode?: boolean;
    readonly additionalDirs?: readonly string[];
  },
): typeof input {
  const thinking = objectValue(config['thinking']);
  const models = objectValue(config['models']);
  const configuredPermission = permissionMode(config['defaultPermissionMode'])
    ?? (config['yolo'] === true ? 'yolo' : undefined);
  return {
    ...input,
    model: input.model
      ?? stringValue(config['defaultModel'])
      ?? (models === undefined ? undefined : Object.keys(models)[0]),
    thinking: input.thinking
      ?? stringValue(thinking?.['effort'])
      ?? (thinking?.['enabled'] === false ? 'off' : undefined),
    permission: input.permission ?? configuredPermission,
    planMode: input.planMode
      ?? booleanValue(config['defaultPlanMode'])
      ?? booleanValue(config['planMode']),
  };
}

function objectValue(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function permissionMode(value: unknown): PermissionMode | undefined {
  return value === 'manual' || value === 'auto' || value === 'yolo' ? value : undefined;
}

export function prepareConfigPatch(patch: JsonRecord): JsonRecord {
  return stripUnsetSecrets(patch) as JsonRecord;
}

function stripUnsetSecrets(value: unknown, key = ''): unknown {
  if (secretKey(key) && (value === undefined || value === null || value === '' || value === '[configured]')) {
    return undefined;
  }
  if (Array.isArray(value)) return value.map((item) => stripUnsetSecrets(item));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([entryKey, entryValue]) => [entryKey, stripUnsetSecrets(entryValue, entryKey)])
      .filter(([, entryValue]) => entryValue !== undefined),
  );
}

export function redactSecrets(value: unknown, key = ''): unknown {
  if (secretKey(key)) {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value === 'object' && !Array.isArray(value)) {
      return Object.keys(value as Record<string, unknown>);
    }
    return '[configured]';
  }
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([entryKey, entryValue]) => [entryKey, redactSecrets(entryValue, entryKey)])
      .filter(([, entryValue]) => entryValue !== undefined),
  );
}

function secretKey(key: string): boolean {
  return /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|cookie|customHeaders|headers|\benv\b)/i.test(key);
}

export function assertExternalUrl(input: string): string {
  const url = new URL(input);
  if (url.protocol !== 'https:' && url.protocol !== 'mailto:') {
    throw new Error(`External protocol is not allowed: ${url.protocol}`);
  }
  return url.href;
}
