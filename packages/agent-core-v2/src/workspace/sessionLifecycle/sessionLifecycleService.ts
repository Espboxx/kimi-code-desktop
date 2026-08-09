/**
 * `sessionLifecycle` domain — `ISessionLifecycleService` implementation.
 *
 * Owns the registry of THIS handler's open Session child scopes, creating
 * them through the DI scope tree (children of the handler's Workspace
 * scope) and seeding each with its identity, storage addressing derived
 * from the handler's persistence scope, and a per-session lifecycle-hooks
 * slots instance it runs around create/close,
 * tearing sessions down on close/archive — archiving flags the session's
 * metadata, removes its agents, restoring clears
 * the archived flag, and broadcasts the transition; deleting closes a live
 * session through the same flow, then removes the session directory
 * (metadata, agent wire records, plans, logs), evicts the index read-model
 * entry, and appends a `deleted` tombstone to the shared
 * `session_index.jsonl`, raising `session.not_found` for ids this handler
 * never persisted. Pending metadata writes and the index mirror are
 * drained before any teardown, so a listing right after close/archive/delete
 * never reads a stale outcome. Session start and
 * resume failures are reported through telemetry. Each Session scope
 * receives a telemetry view bound to its session id, while failures before
 * a scope is available use an ephemeral context view. Closing a session
 * never touches the handler itself.
 * Every Session scope is also seeded with the handler's shared workspace
 * resources as pure-data read views (the injection contracts) — discovery,
 * watching and connecting all live on the Workspace-scope services; session
 * consumers read the seeds and refresh off their change events. The five
 * workspace-projection seeds are provided by the seed-adapter units
 * assembled with the scope (`assembleSessionSeedAdapters`), not by `extra`.
 * Materializes the session's initial metadata on
 * creation. Bound at Workspace scope.
 * Persisted sessions are discovered through the session-index read model.
 * On create / fork the
 * session is also appended to the shared `session_index.jsonl` so v1 clients
 * (TUI, export) can discover sessions created by the v2 engine; the entry is
 * indexed under the handler's workspace id — the same id seeding the
 * session's storage scope — so an alias spelling of the workDir cannot split
 * the session into a bucket v1 readers never look in. Fork flushes
 * live Agent wire journals, normalizes a missing protocol envelope, and
 * appends the fork boundary before restoring the target Agent; fork is
 * confined to this handler (source and target share the workspace bucket).
 * Historical fork truncates the main wire at a validated user-visible turn,
 * trims subagent wires at the same time boundary, and drops later task/cron
 * state before materialization; any failed fork removes its partial files,
 * index entry, and duplicated cron tasks.
 * On
 * materialize, the agent-profile loaders' `ready` is awaited
 * before the handle is published — agent-file discovery is local-
 * fs and cheap, and a resumed session's first turn must see file-defined
 * agent types in the `Agent` tool description; only the `fatal` explicit
 * loader rejects, exactly the case that should
 * fail fast, and on that failure the half-materialized handle is disposed
 * instead of poisoning the session cache, and the explicit loader is re-armed
 * with a fire-and-forget `reload()` so a fixed agent file unblocks later
 * creates
 * (the workspace skill catalog, by contrast, is kicked fire-and-forget).
 * The handler's shared MCP manager is NOT awaited before create/resume
 * returns — it connects fire-and-forget at Workspace scope, and the seeded
 * handle's `ready` promise lets the agent's LLM steps wait on it instead
 * (see `AgentMcpService`). A session created with ephemeral `mcpServers`
 * additionally gets a session overlay from `workspaceMcp` (session-owned
 * connections, seeded as a merged view, shut down when the session handle
 * disposes — with a backstop in the service's own dispose for teardown
 * paths that bypass the handle wrapper), likewise connected in the
 * background.
 * The session-level services whose subscriptions
 * must exist before the first agent / turn (external hooks, cron, the
 * secondary-model startup warning) opt into `OnScopeCreated` activation.
 */

import { randomUUID } from 'node:crypto';

import { join } from 'pathe';
import { ulid } from 'ulid';

import { IInstantiationService } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import {
  createScopedChildHandle,
  type ISessionScopeHandle,
  ScopeActivation,
  registerScopedService,
} from '#/_base/di/scope';
import { unwrapErrorCause } from '#/_base/errors/errors';
import { Emitter, type Event } from '#/_base/event';
import { DEFAULT_PLAN_MODE_SECTION } from '#/features/plan/configSection';
import { IAgentPlanService } from '#/features/plan/plan';
import { IAgentLoopService } from '#/agent/loop/loop';
import { promptMetadataTextFromText } from '#/agent/prompt/promptMetadataText';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { CRON_SESSION_TAG, type CronTask } from '#/app/cron/cronTask';
import { ICronTaskPersistence } from '#/app/cron/cronTaskPersistence';
import { IConfigService } from '#/app/config/config';
import { IEventService } from '#/app/event/event';
import {
  CHILD_SESSION_KIND,
  CHILD_SESSION_KIND_KEY,
  ISessionIndex,
  ISessionIndexMirror,
  PARENT_SESSION_ID_KEY,
} from '#/app/sessionIndex/sessionIndex';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ErrorCodes, Error2, isError2 } from '#/errors';
import { createHooks } from '#/hooks';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem, type HostDirEntry } from '#/os/interface/hostFileSystem';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ensureMainAgent } from '#/session/agentLifecycle/mainAgent';
import {
  labelsFromAgentMeta,
  subagentParentAgentId,
} from '#/session/agentLifecycle/subagentMetadata';
import { ISessionContext, sessionContextSeed } from '#/session/sessionContext/sessionContext';
import { sessionAgentProfileCatalogSeed } from '#/session/sessionAgentProfileCatalog/agentProfileCatalogSeed';
import { assembleSessionSeedAdapters } from '#/session/sessionSeed/sessionSeedAdapters';
import {
  ISessionLifecycleHooks,
  sessionLifecycleHooksSeed,
  type SessionLifecycleHookSlots,
} from '#/session/sessionLifecycleHooks/sessionLifecycleHooks';
import {
  ISessionMetadata,
  type AgentMeta,
  type SessionMeta,
} from '#/session/sessionMetadata/sessionMetadata';
import { drainSessionMetadataWrites } from '#/session/sessionMetadata/sessionMetadataService';
import { ISessionProcessRunner } from '#/session/process/processRunner';
import { ISessionToolPolicy } from '#/session/sessionToolPolicy/sessionToolPolicy';
import { IWireService } from '#/wire/wire';
import {
  AGENT_WIRE_RECORD_KEY,
  createWireMetadataRecord,
  type WireRecord,
} from '#/wire/record';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import { IUserAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/userAgentProfileLoader';
import { IPluginAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/pluginAgentProfileLoader';
import {
  IExplicitAgentProfileLoader,
} from '#/workspace/workspaceAgentProfileLoader/explicitAgentProfileLoader';
import {
  IExtraAgentProfileLoader,
} from '#/workspace/workspaceAgentProfileLoader/extraAgentProfileLoader';
import {
  IWorkspaceAgentProfileLoader,
} from '#/workspace/workspaceAgentProfileLoader/workspaceAgentProfileLoader';
import { IWorkspaceDirs } from '#/workspace/workspaceDirs/workspaceDirs';
import {
  IWorkspaceMcpService,
  type ISessionMcpOverlay,
} from '#/workspace/workspaceMcp/workspaceMcp';

import { agentScopeOf, sessionDirOf, sessionScopeOf } from './internal/addressing';
import {
  type CreateChildSessionOptions,
  type CreateSessionOptions,
  type ForkSessionOptions,
  type ResumeSessionOptions,
  type SessionArchivedEvent,
  type SessionClosedEvent,
  type SessionCreatedEvent,
  type SessionForkedEvent,
  type SessionWillCloseEvent,
  ISessionLifecycleService,
} from './sessionLifecycle';

type MaterializeSessionOptions = Omit<CreateSessionOptions, 'sessionId'> & {
  readonly sessionId: string;
};

// NOTE: stays Disposable — its own 'get' and 'config' collide with the Fiber
export class SessionLifecycleService extends Disposable implements ISessionLifecycleService {
  declare readonly _serviceBrand: undefined;
  private readonly sessions = new Map<string, ISessionScopeHandle>();
  private readonly _onDidCreateSession = this._register(new Emitter<SessionCreatedEvent>());
  readonly onDidCreateSession: Event<SessionCreatedEvent> = this._onDidCreateSession.event;
  private readonly _onDidCloseSession = this._register(new Emitter<SessionClosedEvent>());
  readonly onDidCloseSession: Event<SessionClosedEvent> = this._onDidCloseSession.event;
  private readonly _onDidArchiveSession = this._register(new Emitter<SessionArchivedEvent>());
  readonly onDidArchiveSession: Event<SessionArchivedEvent> = this._onDidArchiveSession.event;
  private readonly _onDidForkSession = this._register(new Emitter<SessionForkedEvent>());
  readonly onDidForkSession: Event<SessionForkedEvent> = this._onDidForkSession.event;
  private readonly resuming = new Map<string, Promise<ISessionScopeHandle | undefined>>();
  /**
   * Live per-session MCP overlays keyed by session id. The session handle's
   * dispose removes its overlay here before shutting it down, so whatever
   * remains at service teardown (the DI container disposes session scopes
   * directly, bypassing the handle wrapper) is shut down from the
   * service's own dispose instead — no overlay outlives the lifecycle.
   */
  private readonly liveOverlays = new Map<string, ISessionMcpOverlay>();

  constructor(
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @IWorkspaceContext private readonly workspaceContext: IWorkspaceContext,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IConfigService private readonly config: IConfigService,
    @IHostEnvironment private readonly hostEnv: IHostEnvironment,
    @ISessionIndex private readonly index: ISessionIndex,
    @ISessionIndexMirror private readonly indexMirror: ISessionIndexMirror,
    @IAppendLogStore private readonly appendLogStore: IAppendLogStore,
    @IAtomicDocumentStore private readonly docs: IAtomicDocumentStore,
    @IHostFileSystem private readonly hostFs: IHostFileSystem,
    @ICronTaskPersistence private readonly cronStore: ICronTaskPersistence,
    @IEventService private readonly event: IEventService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IWorkspaceAgentProfileLoader
    private readonly workspaceAgentProfileLoader: IWorkspaceAgentProfileLoader,
    @IExtraAgentProfileLoader
    private readonly extraAgentProfileLoader: IExtraAgentProfileLoader,
    @IExplicitAgentProfileLoader
    private readonly explicitAgentProfileLoader: IExplicitAgentProfileLoader,
    @IUserAgentProfileLoader
    private readonly userAgentProfileLoader: IUserAgentProfileLoader,
    @IPluginAgentProfileLoader
    private readonly pluginAgentProfileLoader: IPluginAgentProfileLoader,
    @IWorkspaceMcpService private readonly mcp: IWorkspaceMcpService,
    @IWorkspaceDirs private readonly workspaceDirs: IWorkspaceDirs,
    @ISessionProcessRunner private readonly processRunner: ISessionProcessRunner,
  ) {
    super();
    this._register({
      dispose: () => {
        // Service teardown (e.g. workspace/root scope disposal) bypasses the
        // per-session handle wrappers — shut down every overlay still live.
        for (const overlay of this.liveOverlays.values()) {
          void overlay.shutdown();
        }
        this.liveOverlays.clear();
      },
    });
  }

  private get workspaceId(): string {
    return this.workspaceContext.workspaceId;
  }

  private get handlerScope(): string {
    return this.workspaceContext.persistenceScope;
  }

  async create(opts: CreateSessionOptions): Promise<ISessionScopeHandle> {
    const sessionId = opts.sessionId ?? createSessionId();
    const handle = await this.materializeSession({ ...opts, sessionId });
    try {
      const main =
        opts.mainAgentBinding === undefined
          ? undefined
          : await handle.accessor.get(IAgentLifecycleService).create({
              agentId: MAIN_AGENT_ID,
              binding: opts.mainAgentBinding,
            });
      if (this.config.get<boolean>(DEFAULT_PLAN_MODE_SECTION) === true) {
        const planAgent = main ?? (await ensureMainAgent(handle));
        await planAgent.accessor.get(IAgentPlanService).enter();
      }
      await this.appendSessionIndexEntry(sessionId, opts.workDir);
    } catch (error) {
      const sessionDir = handle.accessor.get(ISessionContext).sessionDir;
      this.sessions.delete(sessionId);
      await this.drainAgents(handle).catch(() => {});
      handle.dispose();
      await this.hostFs.remove(sessionDir).catch(() => {});
      throw error;
    }
    await this.announceCreated({ sessionId, handle, source: 'startup' });
    return handle;
  }

  private async materializeSession(opts: MaterializeSessionOptions): Promise<ISessionScopeHandle> {
    const workspaceId = this.workspaceId;
    const sessionScope = sessionScopeOf(this.handlerScope, opts.sessionId);
    const sessionDir = sessionDirOf(this.bootstrap.homeDir, this.handlerScope, opts.sessionId);
    const metaScope = sessionScope;
    await this.workspaceDirs.ready;
    await this.workspaceDirs.mergeAdditionalDirs(opts.workDir, opts.additionalDirs ?? []);
    const ctx: ISessionContext = {
      _serviceBrand: undefined,
      sessionId: opts.sessionId,
      workspaceId,
      sessionDir,
      metaScope,
      cwd: opts.workDir,
      scope: (subKey?: string): string =>
        subKey === undefined || subKey === '' ? sessionScope : `${sessionScope}/${subKey}`,
    };
    const hooks = createHooks<SessionLifecycleHookSlots, keyof SessionLifecycleHookSlots>([
      'onDidCreateSession',
      'onWillCloseSession',
    ]);
    await this.hostEnv.ready;
    const mcpOverlay =
      opts.mcpServers !== undefined && Object.keys(opts.mcpServers).length > 0
        ? this.mcp.sessionOverlay(opts.mcpServers, { stdioCwd: opts.workDir })
        : undefined;
    if (mcpOverlay !== undefined) {
      this.liveOverlays.set(opts.sessionId, mcpOverlay);
    }
    const scopeHandle = createScopedChildHandle(
      this.instantiation,
      LifecycleScope.Session,
      opts.sessionId,
      {
        extra: [
          ...sessionContextSeed(ctx),
          ...sessionLifecycleHooksSeed(hooks),
          [ITelemetryService, this.telemetry.withContext({ sessionId: opts.sessionId })],
          ...sessionAgentProfileCatalogSeed({
            _serviceBrand: undefined,
            workspaceKey: workspaceId,
          }),
          [ISessionProcessRunner, this.processRunner],
        ],
        assemble: (container) => assembleSessionSeedAdapters(container, mcpOverlay?.handle),
      },
    ) as ISessionScopeHandle;
    const handle: ISessionScopeHandle =
      mcpOverlay === undefined
        ? scopeHandle
        : {
            ...scopeHandle,
            dispose: () => {
              // Delete-then-shutdown is atomic (single-threaded): the service
              // teardown path only shuts down overlays still in the map, so a
              // handle dispose and a service dispose can never double-shutdown.
              if (this.liveOverlays.delete(opts.sessionId)) {
                void mcpOverlay.shutdown();
              }
              scopeHandle.dispose();
            },
          };
    try {
      await handle.accessor.get(ISessionMetadata).ready;
      await handle.accessor.get(ISessionToolPolicy).ready;
      await Promise.all([
        this.workspaceAgentProfileLoader.ready,
        this.extraAgentProfileLoader.ready,
        this.explicitAgentProfileLoader.ready,
        this.userAgentProfileLoader.ready,
        this.pluginAgentProfileLoader.ready,
      ]);
    } catch (error) {
      handle.dispose();
      void this.explicitAgentProfileLoader.reload().catch(() => undefined);
      throw error;
    }
    this.sessions.set(opts.sessionId, handle);
    return handle;
  }

  private async appendSessionIndexEntry(sessionId: string, workDir: string): Promise<void> {
    const sessionDir = sessionDirOf(this.bootstrap.homeDir, this.handlerScope, sessionId);
    this.appendLogStore.append('', 'session_index.jsonl', {
      sessionId,
      sessionDir,
      workDir,
    });
    await this.appendLogStore.flush();
  }

  private async announceCreated(event: SessionCreatedEvent): Promise<void> {
    await event.handle.accessor
      .get(ISessionLifecycleHooks)
      .onDidCreateSession.run({ source: event.source });
    this._onDidCreateSession.fire(event);
    event.handle.accessor
      .get(ITelemetryService)
      .track2('session_started', { resumed: event.source === 'resume' });
  }

  get(sessionId: string): ISessionScopeHandle | undefined {
    if (this.resuming.has(sessionId)) return undefined;
    return this.sessions.get(sessionId);
  }

  resume(sessionId: string, opts?: ResumeSessionOptions): Promise<ISessionScopeHandle | undefined> {
    const inflight = this.resuming.get(sessionId);
    if (inflight !== undefined) return inflight;
    const live = this.sessions.get(sessionId);
    if (live !== undefined) return Promise.resolve(live);
    const promise = this.doResume(sessionId, opts)
      .catch((error: unknown) => {
        this.telemetry
          .withContext({ sessionId })
          .track2('session_load_failed', {
            reason: isError2(error) ? error.code : error instanceof Error ? error.name : 'unknown',
          });
        throw error;
      })
      .finally(() => this.resuming.delete(sessionId));
    this.resuming.set(sessionId, promise);
    return promise;
  }

  private async doResume(
    sessionId: string,
    opts?: ResumeSessionOptions,
  ): Promise<ISessionScopeHandle | undefined> {
    const live = this.sessions.get(sessionId);
    if (live !== undefined) return live;

    const summary = await this.index.get(sessionId);
    if (summary === undefined || summary.workspaceId !== this.workspaceId) return undefined;
    const workDir = summary.cwd ?? this.workspaceContext.cwd;

    const handle = await this.materializeSession({
      sessionId,
      workDir,
      additionalDirs: opts?.additionalDirs,
      mcpServers: opts?.mcpServers,
    });
    const agents = handle.accessor.get(IAgentLifecycleService);
    if (agents.get(MAIN_AGENT_ID) === undefined) {
      await agents.create({ agentId: MAIN_AGENT_ID });
    }
    await this.announceCreated({ sessionId, handle, source: 'resume' });
    return handle;
  }

  list(): readonly ISessionScopeHandle[] {
    const ready: ISessionScopeHandle[] = [];
    for (const [id, handle] of this.sessions) {
      if (!this.resuming.has(id)) ready.push(handle);
    }
    return ready;
  }

  async close(sessionId: string): Promise<void> {
    const handle = this.sessions.get(sessionId);
    if (handle === undefined) return;
    await this.announceWillClose({ sessionId, handle, reason: 'exit' });
    this.sessions.delete(sessionId);
    await this.drainAgents(handle);
    await drainSessionMetadataWrites();
    await this.indexMirror.drain();
    handle.dispose();
    this._onDidCloseSession.fire({ sessionId });
  }

  async archive(sessionId: string): Promise<void> {
    const handle = this.sessions.get(sessionId);
    if (handle === undefined) return;
    const meta = handle.accessor.get(ISessionMetadata);
    await meta.setArchived(true);
    await this.drainAgents(handle);
    this.event.publish({
      type: 'event.session.archived',
      payload: { sessionId },
    });
    await this.announceWillClose({ sessionId, handle, reason: 'archive' });
    this.sessions.delete(sessionId);
    await drainSessionMetadataWrites();
    await this.indexMirror.drain();
    handle.dispose();
    this._onDidArchiveSession.fire({ sessionId });
  }

  async restore(
    sessionId: string,
    opts?: ResumeSessionOptions,
  ): Promise<ISessionScopeHandle | undefined> {
    const handle = await this.resume(sessionId, opts);
    if (handle === undefined) return undefined;
    await handle.accessor.get(ISessionMetadata).setArchived(false);
    return handle;
  }

  async delete(sessionId: string): Promise<void> {
    const inflight = this.resuming.get(sessionId);
    if (inflight !== undefined) {
      await inflight.catch(() => undefined);
    }
    const handle = this.sessions.get(sessionId);
    const summary = await this.index.get(sessionId);
    const persistedHere = summary !== undefined && summary.workspaceId === this.workspaceId;
    if (handle === undefined && !persistedHere) {
      throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
    }
    if (handle !== undefined) {
      await this.close(sessionId);
    }
    await this.hostFs.remove(sessionDirOf(this.bootstrap.homeDir, this.handlerScope, sessionId));
    await this.index.remove(sessionId);
    this.appendLogStore.append('', 'session_index.jsonl', { sessionId, deleted: true });
    await this.appendLogStore.flush();
  }

  private async announceWillClose(event: SessionWillCloseEvent): Promise<void> {
    await event.handle.accessor
      .get(ISessionLifecycleHooks)
      .onWillCloseSession.run({ reason: event.reason });
  }

  private async drainAgents(handle: ISessionScopeHandle): Promise<void> {
    const agentLifecycle = handle.accessor.get(IAgentLifecycleService);
    for (const agent of agentLifecycle.list()) {
      await agentLifecycle.remove(agent.id);
    }
  }

  async fork(opts: ForkSessionOptions): Promise<ISessionScopeHandle> {
    assertForkTurnIndex(opts.turnIndex);
    const sourceId = opts.sourceSessionId;

    const sourceHandle = this.sessions.get(sourceId);
    const indexSummary = await this.index.get(sourceId);
    if (
      (sourceHandle === undefined && indexSummary === undefined) ||
      (indexSummary !== undefined && indexSummary.workspaceId !== this.workspaceId)
    ) {
      throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sourceId} does not exist`);
    }

    let targetId: string | undefined;
    let target: ISessionScopeHandle | undefined;
    let targetSessionDir: string | undefined;
    let targetIndexAttempted = false;
    const duplicatedCronTaskIds: string[] = [];
    try {
      // A turn that just ended may still have its outcome write queued;
      // settle pending metadata writes before reading the source for
      // inheritance, or the fork could copy a stale (or absent) outcome.
      await drainSessionMetadataWrites();
      const sourceMeta =
        sourceHandle !== undefined
          ? await sourceHandle.accessor.get(ISessionMetadata).read()
          : await this.readMetaFromDisk(sourceId);
      this.assertForkSourceIdle(sourceId, sourceHandle);

      targetId = opts.newSessionId ?? createSessionId();
      if (this.sessions.has(targetId) || (await this.index.get(targetId)) !== undefined) {
        throw new Error2(
          ErrorCodes.SESSION_ALREADY_EXISTS,
          `Session "${targetId}" already exists`,
        );
      }

      targetSessionDir = sessionDirOf(this.bootstrap.homeDir, this.handlerScope, targetId);
      await this.copySessionFiles(
        sessionDirOf(this.bootstrap.homeDir, this.handlerScope, sourceId),
        targetSessionDir,
      );

      const sourceAgents = sourceMeta?.agents ?? {};
      const agentIds = Object.keys(sourceAgents);
      const retainedAgentIds = new Set(agentIds);
      let historical: HistoricalMainSlice | undefined;
      if (opts.turnIndex === undefined) {
        for (const agentId of agentIds) {
          await this.copyAgentWire({
            sourceHandle,
            sourceSessionId: sourceId,
            agentId,
            targetSessionId: targetId,
          });
        }
      } else {
        if (sourceAgents[MAIN_AGENT_ID] === undefined) {
          throw new Error2(
            ErrorCodes.REQUEST_INVALID,
            `Session "${sourceId}" has no main agent metadata`,
          );
        }
        historical = await this.copyMainAgentWireAtTurn({
          sourceHandle,
          sourceSessionId: sourceId,
          targetSessionId: targetId,
          turnIndex: opts.turnIndex,
        });
        retainedAgentIds.clear();
        retainedAgentIds.add(MAIN_AGENT_ID);
        for (const agentId of agentIds) {
          if (agentId === MAIN_AGENT_ID) continue;
          const retained = await this.copySubagentWireAtTime({
            sourceHandle,
            sourceSessionId: sourceId,
            agentId,
            targetSessionId: targetId,
            cutoffTime: historical.cutoffTime,
          });
          if (retained) retainedAgentIds.add(agentId);
        }
        dropAgentsWithMissingParents(retainedAgentIds, sourceAgents);
        await this.pruneHistoricalSessionFiles(targetSessionDir, agentIds, retainedAgentIds);
      }

      target = await this.materializeSession({
        sessionId: targetId,
        workDir: this.workspaceContext.cwd,
      });
      const targetMeta = target.accessor.get(ISessionMetadata);

      const title = opts.title ?? `Fork: ${sourceMeta?.title || sourceId}`;
      await targetMeta.update({
        title,
        isCustomTitle: opts.title !== undefined ? true : sourceMeta?.isCustomTitle === true,
        forkedFrom: sourceId,
        archived: false,
        lastPrompt: opts.turnIndex === undefined ? sourceMeta?.lastPrompt : historical?.lastPrompt,
        // The fork continues the source's conversation, so it inherits the
        // last turn's outcome too — otherwise a restart would drop a failure
        // the warm fork was still reporting.
        lastTurnReason:
          opts.turnIndex === undefined ? sourceMeta?.lastTurnReason : historical?.lastTurnReason,
        custom: forkCustomMetadata(sourceMeta?.custom, opts.metadata),
      });

      if (opts.turnIndex === undefined) {
        duplicatedCronTaskIds.push(...await this.duplicateCronTasks(sourceId, targetId));
      }

      for (const agentId of retainedAgentIds) {
        const sourceAgent = sourceAgents[agentId]!;
        await target.accessor.get(IAgentLifecycleService).create({
          agentId,
          forkedFrom: sourceAgent.forkedFrom,
          labels: labelsFromAgentMeta(sourceAgent),
        });
      }

      targetIndexAttempted = true;
      await this.appendSessionIndexEntry(targetId, this.workspaceContext.cwd);
      this._onDidForkSession.fire({
        sourceSessionId: sourceId,
        sessionId: targetId,
        handle: target,
      });
      await this.announceCreated({ sessionId: targetId, handle: target, source: 'fork' });
      return target;
    } catch (error) {
      if (targetId !== undefined) {
        this.sessions.delete(targetId);
      }
      if (target !== undefined) {
        try {
          target.dispose();
        } catch {
        }
      }
      await drainSessionMetadataWrites().catch(() => {});
      if (targetSessionDir !== undefined) {
        await this.hostFs.remove(targetSessionDir).catch(() => {});
      }
      if (targetIndexAttempted && targetId !== undefined) {
        await this.index.remove(targetId).catch(() => {});
        this.appendLogStore.append('', 'session_index.jsonl', { sessionId: targetId, deleted: true });
        await this.appendLogStore.flush().catch(() => {});
      }
      await Promise.all(
        duplicatedCronTaskIds.map((taskId) =>
          this.cronStore.delete(this.workspaceId, taskId).catch(() => {}),
        ),
      );
      throw error;
    }
  }

  private assertForkSourceIdle(
    sourceSessionId: string,
    sourceHandle: ISessionScopeHandle | undefined,
  ): void {
    if (sourceHandle === undefined) return;
    for (const agent of sourceHandle.accessor.get(IAgentLifecycleService).list()) {
      const status = agent.accessor.get(IAgentLoopService).status();
      if (
        status.state === 'idle' &&
        status.pendingTurnIds.length === 0 &&
        !status.hasPendingRequests
      ) {
        continue;
      }
      throw new Error2(
        ErrorCodes.SESSION_FORK_ACTIVE_TURN,
        `Session "${sourceSessionId}" cannot be forked while a turn is running`,
        { details: { sessionId: sourceSessionId, agentId: agent.id } },
      );
    }
  }

  async createChild(opts: CreateChildSessionOptions): Promise<ISessionScopeHandle> {
    const title =
      opts.title ??
      `Child: ${(await this.resolveSourceTitle(opts.sourceSessionId)) ?? opts.sourceSessionId}`;
    const metadata = {
      ...opts.metadata,
      [PARENT_SESSION_ID_KEY]: opts.sourceSessionId,
      [CHILD_SESSION_KIND_KEY]: CHILD_SESSION_KIND,
    };
    return this.fork({
      sourceSessionId: opts.sourceSessionId,
      newSessionId: opts.newSessionId,
      title,
      metadata,
    });
  }

  private async resolveSourceTitle(sourceId: string): Promise<string | undefined> {
    const live = this.sessions.get(sourceId);
    if (live !== undefined) {
      return (await live.accessor.get(ISessionMetadata).read()).title;
    }
    return (await this.index.get(sourceId))?.title;
  }

  private async copyAgentWire(args: {
    readonly sourceHandle: ISessionScopeHandle | undefined;
    readonly sourceSessionId: string;
    readonly agentId: string;
    readonly targetSessionId: string;
  }): Promise<void> {
    if (args.sourceHandle !== undefined) {
      const agentHandle = args.sourceHandle.accessor
        .get(IAgentLifecycleService)
        .get(args.agentId);
      if (agentHandle !== undefined) {
        await agentHandle.accessor.get(IWireService).flush();
      }
    }

    const records = await collect(
      this.appendLogStore.read<WireRecord>(
        agentScopeOf(sessionScopeOf(this.handlerScope, args.sourceSessionId), args.agentId),
        AGENT_WIRE_RECORD_KEY,
      ),
    );
    if (records.length === 0) {
      records.push(createWireMetadataRecord());
    } else if (records[0]?.type !== 'metadata') {
      records.unshift(createWireMetadataRecord());
    }
    records.push(forkedRecord());

    await this.appendLogStore.rewrite(
      agentScopeOf(sessionScopeOf(this.handlerScope, args.targetSessionId), args.agentId),
      AGENT_WIRE_RECORD_KEY,
      records,
    );
  }

  private async copyMainAgentWireAtTurn(args: {
    readonly sourceHandle: ISessionScopeHandle | undefined;
    readonly sourceSessionId: string;
    readonly targetSessionId: string;
    readonly turnIndex: number;
  }): Promise<HistoricalMainSlice> {
    await this.flushLiveAgent(args.sourceHandle, MAIN_AGENT_ID);
    const records = await this.readAgentWire(args.sourceSessionId, MAIN_AGENT_ID);
    const slice = sliceMainWireRecordsAtTurn(records, args.sourceSessionId, args.turnIndex);
    await this.rewriteAgentWire(args.targetSessionId, MAIN_AGENT_ID, [...slice.records, forkedRecord()]);
    return slice;
  }

  private async copySubagentWireAtTime(args: {
    readonly sourceHandle: ISessionScopeHandle | undefined;
    readonly sourceSessionId: string;
    readonly agentId: string;
    readonly targetSessionId: string;
    readonly cutoffTime: number | undefined;
  }): Promise<boolean> {
    if (args.cutoffTime === undefined) return false;
    await this.flushLiveAgent(args.sourceHandle, args.agentId);
    const records = await this.readAgentWire(args.sourceSessionId, args.agentId);
    const retained = sliceWireRecordsAtTime(records, args.cutoffTime);
    if (retained.length === 0) return false;
    await this.rewriteAgentWire(args.targetSessionId, args.agentId, [
      ...retained,
      forkedRecord(),
    ]);
    return true;
  }

  private async flushLiveAgent(
    sourceHandle: ISessionScopeHandle | undefined,
    agentId: string,
  ): Promise<void> {
    const agent = sourceHandle?.accessor.get(IAgentLifecycleService).get(agentId);
    if (agent !== undefined) await agent.accessor.get(IWireService).flush();
  }

  private async readAgentWire(sessionId: string, agentId: string): Promise<WireRecord[]> {
    return collect(
      this.appendLogStore.read<WireRecord>(
        agentScopeOf(sessionScopeOf(this.handlerScope, sessionId), agentId),
        AGENT_WIRE_RECORD_KEY,
      ),
    );
  }

  private async rewriteAgentWire(
    sessionId: string,
    agentId: string,
    records: readonly WireRecord[],
  ): Promise<void> {
    await this.appendLogStore.rewrite(
      agentScopeOf(sessionScopeOf(this.handlerScope, sessionId), agentId),
      AGENT_WIRE_RECORD_KEY,
      records,
    );
  }

  private async pruneHistoricalSessionFiles(
    targetSessionDir: string,
    sourceAgentIds: readonly string[],
    retainedAgentIds: ReadonlySet<string>,
  ): Promise<void> {
    for (const agentId of sourceAgentIds) {
      const agentDir = join(targetSessionDir, 'agents', agentId);
      if (!retainedAgentIds.has(agentId)) {
        await this.hostFs.remove(agentDir).catch(() => {});
        continue;
      }
      await this.hostFs.remove(join(agentDir, 'tasks')).catch(() => {});
      await this.hostFs.remove(join(agentDir, 'cron')).catch(() => {});
    }
  }

  private async copySessionFiles(sourceDir: string, targetDir: string): Promise<void> {
    let entries: readonly HostDirEntry[];
    try {
      entries = await this.hostFs.readdir(sourceDir);
    } catch (error) {
      if (isMissingFileError(error)) return;
      throw error;
    }
    await this.copySessionDirEntries(sourceDir, targetDir, entries, '');
  }

  private async copySessionDirEntries(
    sourceDir: string,
    targetDir: string,
    entries: readonly HostDirEntry[],
    relBase: string,
  ): Promise<void> {
    for (const entry of entries) {
      const rel = relBase === '' ? entry.name : `${relBase}/${entry.name}`;
      if (rel === 'state.json' || rel === 'logs' || entry.name === AGENT_WIRE_RECORD_KEY) {
        continue;
      }
      if (entry.isSymbolicLink === true) continue;
      const sourcePath = join(sourceDir, entry.name);
      const targetPath = join(targetDir, entry.name);
      if (entry.isDirectory) {
        let children: readonly HostDirEntry[];
        try {
          children = await this.hostFs.readdir(sourcePath);
        } catch (error) {
          if (isMissingFileError(error)) continue;
          throw error;
        }
        await this.hostFs.mkdir(targetPath, { recursive: true });
        await this.copySessionDirEntries(sourcePath, targetPath, children, rel);
      } else if (entry.isFile) {
        const data = await this.hostFs.readBytes(sourcePath);
        await this.hostFs.mkdir(targetDir, { recursive: true });
        await this.hostFs.writeBytes(targetPath, data);
      }
    }
  }

  private async duplicateCronTasks(sourceId: string, targetId: string): Promise<readonly string[]> {
    const tasks = await this.cronStore.list({ workspaceId: this.workspaceId });
    const created: string[] = [];
    for (const task of tasks) {
      if (task.tags?.[CRON_SESSION_TAG] !== sourceId) continue;
      const clone: CronTask = {
        ...task,
        id: ulid(),
        tags: { ...task.tags, [CRON_SESSION_TAG]: targetId },
      };
      created.push(clone.id);
      await this.cronStore.save(this.workspaceId, clone);
    }
    return created;
  }

  private async readMetaFromDisk(sessionId: string): Promise<SessionMeta | undefined> {
    return this.docs.get<SessionMeta>(sessionScopeOf(this.handlerScope, sessionId), 'state.json');
  }
}

registerScopedService(
  LifecycleScope.Workspace,
  ISessionLifecycleService,
  SessionLifecycleService,
  ScopeActivation.OnScopeCreated,
  'sessionLifecycle',
);

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

interface HistoricalMainSlice {
  readonly records: readonly WireRecord[];
  readonly cutoffTime?: number;
  readonly lastPrompt?: string;
  readonly lastTurnReason?: 'completed' | 'cancelled' | 'failed';
}

function assertForkTurnIndex(turnIndex: number | undefined): void {
  if (turnIndex === undefined) return;
  if (Number.isSafeInteger(turnIndex) && turnIndex >= 0) return;
  throw new Error2(
    ErrorCodes.REQUEST_INVALID,
    'forkSession turnIndex must be a non-negative safe integer',
    { details: { turnIndex } },
  );
}

function sliceMainWireRecordsAtTurn(
  input: readonly WireRecord[],
  sourceSessionId: string,
  turnIndex: number,
): HistoricalMainSlice {
  const records = ensureWireMetadata(input);
  const turnStarts: number[] = [];
  for (let index = 0; index < records.length; index += 1) {
    if (isUserVisibleTurnRecord(records[index]!)) turnStarts.push(index);
  }
  const start = turnStarts[turnIndex];
  if (start === undefined) {
    throw new Error2(
      ErrorCodes.REQUEST_INVALID,
      `Turn ${String(turnIndex)} was not found in session "${sourceSessionId}"`,
      { details: { turnIndex, availableTurns: turnStarts.length } },
    );
  }

  const end = turnStarts[turnIndex + 1] ?? records.length;
  const retainedInputs = turnInputIndicesThrough(records, turnIndex);
  const retained = records
    .slice(0, end)
    .filter(
      (record, index) => !isUserVisibleTurnInputRecord(record) || retainedInputs.has(index),
    );
  const times = retained.map(recordTime).filter((time): time is number => time !== undefined);
  return {
    records: retained,
    cutoffTime: times.length === 0 ? undefined : Math.max(...times),
    lastPrompt: promptMetadataFromTurnRecord(records[start]!),
    lastTurnReason: lastTurnReasonFromRecords(retained),
  };
}

function sliceWireRecordsAtTime(
  records: readonly WireRecord[],
  cutoffTime: number,
): readonly WireRecord[] {
  let end = records.length;
  for (let index = 0; index < records.length; index += 1) {
    const time = recordTime(records[index]!);
    if (time !== undefined && time > cutoffTime) {
      end = index;
      break;
    }
  }
  const retained = records.slice(0, end);
  return retained.length === 0 ? retained : ensureWireMetadata(retained);
}

function ensureWireMetadata(records: readonly WireRecord[]): WireRecord[] {
  if (records[0]?.type === 'metadata') return [...records];
  const createdAt = records.map(recordTime).find((time) => time !== undefined) ?? Date.now();
  return [createWireMetadataRecord(createdAt), ...records];
}

function recordTime(record: WireRecord): number | undefined {
  if (typeof record.time === 'number' && Number.isFinite(record.time)) return record.time;
  const createdAt = record['created_at'];
  return typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : undefined;
}

function isUserVisibleTurnRecord(record: WireRecord): boolean {
  if (record.type !== 'context.append_message') return false;
  const message = asRecord(record['message']);
  if (message?.['role'] !== 'user') return false;
  return isUserVisibleOrigin(asRecord(message['origin']));
}

function isUserVisibleTurnInputRecord(record: WireRecord): boolean {
  if (record.type !== 'turn.prompt' && record.type !== 'turn.steer') return false;
  return isUserVisibleOrigin(asRecord(record['origin']));
}

function isUserVisibleOrigin(origin: Readonly<Record<string, unknown>> | undefined): boolean {
  const kind = origin?.['kind'];
  if (kind === undefined || kind === 'user') return true;
  if (kind === 'skill_activation' || kind === 'plugin_command') {
    return origin?.['trigger'] === 'user-slash';
  }
  return kind === 'shell_command' && origin?.['phase'] === 'input';
}

function turnInputIndicesThrough(
  records: readonly WireRecord[],
  turnIndex: number,
): ReadonlySet<number> {
  const pending: number[] = [];
  const retained = new Set<number>();
  let visibleTurnIndex = 0;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (isUserVisibleTurnInputRecord(record)) {
      pending.push(index);
      continue;
    }
    if (!isUserVisibleTurnRecord(record)) continue;
    const matchAt = findMatchingTurnInput(records, pending, record);
    if (matchAt !== -1) {
      const [inputIndex] = pending.splice(matchAt, 1);
      if (visibleTurnIndex <= turnIndex && inputIndex !== undefined) retained.add(inputIndex);
    }
    visibleTurnIndex += 1;
  }
  return retained;
}

function findMatchingTurnInput(
  records: readonly WireRecord[],
  pending: readonly number[],
  turnRecord: WireRecord,
): number {
  const exact = pending.findIndex((index) =>
    turnInputMatchesRecord(records[index]!, turnRecord, true),
  );
  if (exact !== -1) return exact;
  return pending.findIndex((index) =>
    turnInputMatchesRecord(records[index]!, turnRecord, false),
  );
}

function turnInputMatchesRecord(
  inputRecord: WireRecord,
  turnRecord: WireRecord,
  compareContent: boolean,
): boolean {
  if (
    (inputRecord.type !== 'turn.prompt' && inputRecord.type !== 'turn.steer') ||
    turnRecord.type !== 'context.append_message'
  ) {
    return false;
  }
  const message = asRecord(turnRecord['message']);
  if (message?.['role'] !== 'user') return false;
  const inputOrigin = asRecord(inputRecord['origin'])?.['kind'];
  const messageOrigin = asRecord(message['origin'])?.['kind'];
  if (inputOrigin === 'user' ? messageOrigin !== undefined && messageOrigin !== 'user' : inputOrigin !== messageOrigin) {
    return false;
  }
  return !compareContent || JSON.stringify(inputRecord['input']) === JSON.stringify(message['content']);
}

function promptMetadataFromTurnRecord(record: WireRecord): string | undefined {
  const message = asRecord(record['message']);
  if (record.type !== 'context.append_message' || message?.['role'] !== 'user') return undefined;
  const origin = asRecord(message['origin']);
  if (origin?.['kind'] === 'skill_activation') {
    return slashPrompt(typeof origin['skillName'] === 'string' ? origin['skillName'] : '', origin['skillArgs']);
  }
  if (origin?.['kind'] === 'plugin_command') {
    const pluginId = typeof origin['pluginId'] === 'string' ? origin['pluginId'] : '';
    const commandName = typeof origin['commandName'] === 'string' ? origin['commandName'] : '';
    const name = `${pluginId}:${commandName}`;
    return slashPrompt(name, origin['commandArgs']);
  }
  const content = message['content'];
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((part) => {
      const item = asRecord(part);
      if (item?.['type'] === 'text' && typeof item['text'] === 'string') return item['text'];
      if (item?.['type'] === 'image_url') return '[image]';
      if (item?.['type'] === 'audio_url') return '[audio]';
      if (item?.['type'] === 'video_url') return '[video]';
      return '';
    })
    .filter((part) => part.length > 0)
    .join('\n');
  return promptMetadataTextFromText(text);
}

function slashPrompt(name: string, rawArgs: unknown): string | undefined {
  const args = typeof rawArgs === 'string' ? rawArgs.trim() : '';
  return promptMetadataTextFromText(args.length === 0 ? `/${name}` : `/${name} ${args}`);
}

function lastTurnReasonFromRecords(
  records: readonly WireRecord[],
): 'completed' | 'cancelled' | 'failed' | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]!;
    if (record.type !== 'turn.ended') continue;
    const reason = record['reason'];
    if (reason === 'completed' || reason === 'cancelled') return reason;
    if (reason === 'failed' || reason === 'blocked') return 'failed';
  }
  return undefined;
}

function dropAgentsWithMissingParents(
  retained: Set<string>,
  agents: Readonly<Record<string, AgentMeta>>,
): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const agentId of retained) {
      if (agentId === MAIN_AGENT_ID) continue;
      const parentId = subagentParentAgentId(agents[agentId]);
      if (parentId === undefined || parentId === MAIN_AGENT_ID || retained.has(parentId)) continue;
      retained.delete(agentId);
      changed = true;
    }
  }
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function isMissingFileError(error: unknown): boolean {
  const unwrapped = unwrapErrorCause(error);
  if (unwrapped === null || typeof unwrapped !== 'object') return false;
  const code = (unwrapped as { readonly code?: unknown }).code;
  return code === 'ENOENT';
}

function createSessionId(): string {
  return `session_${randomUUID()}`;
}

function forkedRecord(): WireRecord {
  return { type: 'forked', time: Date.now() };
}

function forkCustomMetadata(
  source: Record<string, unknown> | undefined,
  input: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const merged = { ...withoutGoal(source), ...withoutGoal(input) };
  return Object.keys(merged).length === 0 ? undefined : merged;
}

function withoutGoal(value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (value === undefined) return {};
  const { goal: _drop, ...rest } = value as { goal?: unknown; [key: string]: unknown };
  return rest;
}
