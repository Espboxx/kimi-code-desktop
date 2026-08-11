/**
 * `sessionSwarm` domain — `ISessionSwarmService` implementation.
 *
 * Runs a batch of agents on behalf of a caller agent: builds an
 * `AgentRunBatchLauncher` on top of the `agentLifecycle` primitives
 * (`create({ binding })`, `run`), drives the internal `AgentRunBatch`
 * scheduler, and tracks one `AbortController` per caller so `cancel` can abort
 * every in-flight run. The caller ↔ child association is this domain's own
 * business data: requester-side display facts (`subagent.spawned` wire signals
 * carrying the swarm's tool-call context, `subagent.suspended` when a task is
 * requeued after a provider rate limit) are emitted from this layer; the
 * lifecycle registry itself stays flat. Spawn tasks may carry a concrete
 * `binding` resolved by the caller; without
 * one, spawns inherit the caller agent's model and thinking level. Spawn
 * bindings are resolved through the model catalog before lifecycle allocation.
 * Ordinary resumed agents keep the profile and model recorded in their own
 * wire journal. A durable Team task may explicitly reconfigure the agent's
 * execution workspace and rebind its task-owned profile/model before resume.
 * Bound at Session scope.
 */

import type { TokenUsage } from '#/kosong/contract/usage';
import { randomUUID } from 'node:crypto';
import { IModelCatalog } from '#/kosong/model/catalog';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Error2, ErrorCodes } from '#/errors';
import { linkAbortSignal, userCancellationReason } from '#/_base/utils/abort';
import { Disposable } from '#/_base/di/lifecycle';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentExecutionWorkspace } from '#/agent/executionWorkspace/executionWorkspace';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentUserToolService } from '#/agent/userTool/userTool';
import { IEventBus } from '#/app/event/eventBus';
import { IConfigService } from '#/app/config/config';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { applyProfilePromptPrefix } from '#/app/agentProfileCatalog/promptPrefix';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import {
  isSubagentMeta,
  subagentLabels,
  subagentParentAgentId,
  subagentSwarmItem,
} from '#/session/agentLifecycle/subagentMetadata';
import { emitAgentRunSpawned, mirrorAgentRun } from '#/session/subagent/mirrorAgentRun';
import { ISessionSubagentService } from '#/session/subagent/subagent';
import {
  subagentDisplayModel,
  wrapSubagentModelError,
} from '#/session/subagent/configSection';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata, type AgentMeta } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionProcessRunner } from '#/session/process/processRunner';
import { ILogService } from '#/_base/log/log';
import type { Hooks } from '#/hooks';
import {
  ISessionLifecycleHooks,
  type SessionLifecycleHookSlots,
} from '#/session/sessionLifecycleHooks/sessionLifecycleHooks';

import {
  ISessionSwarmService,
  type SessionSwarmRunArgs,
  type SessionSwarmLaunchReceipt,
  type SessionSwarmRunResult,
  type SessionSwarmTask,
} from './sessionSwarm';
import {
  resolveSwarmMaxConcurrency,
  AgentRunBatch,
  type AgentRunAttemptOptions,
  type AgentSpawnAttemptOptions,
  type AgentRunBatchLauncher,
  type AgentRunAttemptHandle,
} from './agentRunBatch';

export interface SubagentSuspendedEvent {
  readonly type: 'subagent.suspended';
  readonly subagentId: string;
  readonly reason: string;
}

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'subagent.suspended': SubagentSuspendedEvent;
  }
}

const RESUMED_PROFILE_FALLBACK = 'subagent';

export class SessionSwarmService extends Disposable implements ISessionSwarmService {
  declare readonly _serviceBrand: undefined;

  private readonly inFlight = new Map<
    string,
    {
      readonly callerAgentId: string;
      readonly controller: AbortController;
      readonly completion: Promise<readonly SessionSwarmRunResult<unknown>[]>;
    }
  >();

  constructor(
    @IAgentLifecycleService private readonly lifecycle: IAgentLifecycleService,
    @ISessionSubagentService private readonly subagents: ISessionSubagentService,
    @ISessionAgentProfileCatalog private readonly catalog: ISessionAgentProfileCatalog,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @ISessionProcessRunner private readonly processRunner: ISessionProcessRunner,
    @ILogService private readonly log: ILogService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @IConfigService private readonly config: IConfigService,
    @ISessionLifecycleHooks lifecycleHooks: Hooks<SessionLifecycleHookSlots>,
  ) {
    super();
    this._register(
      lifecycleHooks.onWillCloseSession.register('sessionSwarm', async (_event, next) => {
        this.cancelAll();
        await this.settle();
        await next();
      }),
    );
  }

  override dispose(): void {
    this.cancelAll();
    this.inFlight.clear();
    super.dispose();
  }

  async getSwarmItem(args: {
    readonly callerAgentId: string;
    readonly agentId: string;
  }): Promise<string | undefined> {
    const meta = await this.agentMeta(args.agentId);
    if (!isSubagentMeta(meta)) return undefined;
    if (subagentParentAgentId(meta) !== args.callerAgentId) return undefined;
    return subagentSwarmItem(meta);
  }

  launch<T>(args: SessionSwarmRunArgs<T>): SessionSwarmLaunchReceipt<T> {
    const { callerAgentId, tasks } = args;
    const batchId = `swarm_${randomUUID()}`;
    const controller = new AbortController();
    const unlinks: Array<() => void> = [];
    const linkedTasks: SessionSwarmTask<T>[] = tasks.map((task) => {
      if (task.signal !== undefined) unlinks.push(linkAbortSignal(task.signal, controller));
      return { ...task, signal: controller.signal };
    });
    const launcher: AgentRunBatchLauncher = {
      spawn: (options) => this.spawnAttempt(callerAgentId, options),
      resume: (agentId, options) => this.resumeAttempt(callerAgentId, agentId, options, false),
      retry: (agentId, options) => this.resumeAttempt(callerAgentId, agentId, options, true),
      suspended: (event) => {
        const caller = this.lifecycle.get(callerAgentId);
        caller?.accessor.get(IEventBus)?.publish({
          type: 'subagent.suspended',
          subagentId: event.agentId,
          reason: event.reason,
        });
      },
    };
    let maxConcurrency: number | undefined;
    try {
      maxConcurrency = resolveSwarmMaxConcurrency();
    } catch (error) {
      for (const unlink of unlinks) unlink();
      throw error;
    }
    const settlementWrites: Promise<void>[] = [];
    const promise = new AgentRunBatch(launcher, linkedTasks, {
      maxConcurrency,
      onResult: (result) => {
        if (args.onResult === undefined) return;
        settlementWrites.push(Promise.resolve(args.onResult(result)));
      },
    }).run().then(async (results) => {
      await Promise.allSettled(settlementWrites);
      return results;
    });
    this.inFlight.set(batchId, {
      callerAgentId,
      controller,
      completion: promise as Promise<readonly SessionSwarmRunResult<unknown>[]>,
    });
    void promise.then(() => {
      for (const unlink of unlinks) unlink();
      this.inFlight.delete(batchId);
    }, () => {
      for (const unlink of unlinks) unlink();
      this.inFlight.delete(batchId);
    });
    return { batchId, accepted: tasks, completion: promise };
  }

  run<T>(args: SessionSwarmRunArgs<T>): Promise<readonly SessionSwarmRunResult<T>[]> {
    return this.launch(args).completion;
  }

  cancel({ callerAgentId }: { readonly callerAgentId: string }): void {
    for (const entry of this.inFlight.values()) {
      if (entry.callerAgentId === callerAgentId) entry.controller.abort(userCancellationReason());
    }
  }

  cancelBatch({ batchId }: { readonly batchId: string }): void {
    this.inFlight.get(batchId)?.controller.abort(userCancellationReason());
  }

  async settle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight.values()].map((entry) => entry.completion));
    }
  }

  private cancelAll(): void {
    for (const entry of this.inFlight.values()) {
      entry.controller.abort(userCancellationReason());
    }
  }

  private async spawnAttempt(
    callerAgentId: string,
    options: AgentSpawnAttemptOptions,
  ): Promise<AgentRunAttemptHandle> {
    options.signal.throwIfAborted();
    const caller = this.requireHandle(callerAgentId, 'Caller agent');
    await this.catalog.ready;
    const profile = this.catalog.get(options.profileName);
    if (profile === undefined) {
      throw new Error2(ErrorCodes.PROFILE_UNKNOWN, `Unknown agent type: "${options.profileName}"`, {
        details: { profileName: options.profileName },
      });
    }
    const callerData = caller.accessor.get(IAgentProfileService).data();
    if (callerData.modelAlias === undefined) {
      throw new Error2(ErrorCodes.MODEL_NOT_CONFIGURED, 'Caller agent has no model bound', {
        details: { agentId: callerAgentId },
      });
    }
    const binding = options.binding ?? {
      model: callerData.modelAlias,
      thinking: callerData.thinkingLevel,
    };
    let child: IAgentScopeHandle;
    try {
      this.modelCatalog.get(binding.model);
      child = await this.lifecycle.create({
        binding: {
          profile: profile.name,
          model: binding.model,
          thinking: binding.thinking,
        },
        labels: subagentLabels(callerAgentId, { swarmItem: options.swarmItem }),
        executionWorkspace: options.executionWorkspace,
      });
    } catch (error) {
      throw wrapSubagentModelError(error, binding.model, callerData.modelAlias, this.config);
    }
    try {
      await options.onAgentBound?.(child.id);
    } catch (error) {
      await this.lifecycle.remove(child.id).catch(() => undefined);
      throw error;
    }
    child.accessor
      .get(IAgentPermissionModeService)
      .setMode(caller.accessor.get(IAgentPermissionModeService).mode);
    child.accessor
      .get(IAgentUserToolService)
      .inheritUserTools(caller.accessor.get(IAgentUserToolService));
    emitAgentRunSpawned(caller, child.id, {
      profileName: options.profileName,
      parentToolCallId: options.parentToolCallId,
      parentToolCallUuid: options.parentToolCallUuid,
      description: options.description,
      swarmIndex: options.swarmIndex,
      runInBackground: options.runInBackground,
      model: subagentDisplayModel(this.config, binding.model),
    });
    const promptText = await applyProfilePromptPrefix(profile, options.prompt, {
      cwd: options.executionWorkspace?.workDir ?? this.sessionContext.cwd,
      runner: this.processRunner,
      log: this.log,
    });
    return this.observe(caller, child.id, options.profileName, {
      kind: 'prompt',
      prompt: promptText,
    }, options);
  }

  private async resumeAttempt(
    callerAgentId: string,
    agentId: string,
    options: AgentRunAttemptOptions,
    retryTurn: boolean,
  ): Promise<AgentRunAttemptHandle> {
    options.signal.throwIfAborted();
    await this.requireOwnedSubagent(callerAgentId, agentId);
    const caller = this.requireHandle(callerAgentId, 'Caller agent');
    const child = this.requireHandle(agentId, 'Agent instance');
    this.requireIdleSubagent(agentId, child);
    const workspaceChanged = options.executionWorkspace === undefined
      ? false
      : child.accessor.get(IAgentExecutionWorkspace).configure(options.executionWorkspace);
    const profile = child.accessor.get(IAgentProfileService);
    const currentProfile = profile.data();
    const rebind = options.rebind;
    const profileChanged = rebind !== undefined && (
      currentProfile.profileName !== rebind.profileName
      || (rebind.model !== undefined && currentProfile.modelAlias !== rebind.model)
    );
    if (profileChanged) {
      await profile.bind({
        profile: rebind.profileName,
        model: rebind.model ?? currentProfile.modelAlias,
        thinking: currentProfile.thinkingLevel,
      });
    } else if (workspaceChanged) {
      await profile.refreshSystemPrompt();
    }
    await options.onAgentBound?.(agentId);
    const profileName = profile.data().profileName ?? RESUMED_PROFILE_FALLBACK;
    if (!retryTurn) {
      const resumedModel = profile.data().modelAlias;
      emitAgentRunSpawned(caller, agentId, {
        profileName,
        parentToolCallId: options.parentToolCallId,
        parentToolCallUuid: options.parentToolCallUuid,
        description: options.description,
        swarmIndex: options.swarmIndex,
        runInBackground: options.runInBackground,
        model:
          resumedModel === undefined
            ? undefined
            : subagentDisplayModel(this.config, resumedModel),
      });
    }
    const request = retryTurn
      ? ({ kind: 'retry' } as const)
      : ({ kind: 'prompt', prompt: options.prompt } as const);
    return this.observe(caller, child.id, profileName, request, options);
  }

  private async observe(
    caller: IAgentScopeHandle,
    agentId: string,
    profileName: string,
    request: { kind: 'prompt'; prompt: string } | { kind: 'retry' },
    options: AgentRunAttemptOptions,
  ): Promise<AgentRunAttemptHandle> {
    const run = await this.subagents.run(agentId, request, {
      signal: options.signal,
      onReady: options.onReady,
    });
    const mirrored = mirrorAgentRun(caller, run, {
      profileName,
      prompt: request.kind === 'prompt' ? request.prompt : undefined,
      suppressRateLimitFailureEvent: options.suppressRateLimitFailureEvent,
      signal: options.signal,
    });
    return {
      agentId,
      profileName,
      completion: mirrored.then((r) => ({ result: r.summary, usage: r.usage })),
    };
  }

  private requireHandle(agentId: string, label: string): IAgentScopeHandle {
    const handle = this.lifecycle.get(agentId);
    if (handle === undefined) {
      throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `${label} "${agentId}" does not exist`, {
        details: { agentId },
      });
    }
    return handle;
  }

  private requireIdleSubagent(agentId: string, child: IAgentScopeHandle): void {
    if (child.accessor.get(IAgentLoopService).status().state === 'running') {
      throw new Error2(
        ErrorCodes.AGENT_ALREADY_RUNNING,
        `Agent instance "${agentId}" is already running and cannot run concurrently`,
        { details: { agentId } },
      );
    }
  }

  private async requireOwnedSubagent(callerAgentId: string, agentId: string): Promise<void> {
    const meta = await this.agentMeta(agentId);
    if (!isSubagentMeta(meta)) {
      throw new Error2(ErrorCodes.AGENT_NOT_A_SUBAGENT, `Agent instance "${agentId}" is not a subagent`, {
        details: { agentId },
      });
    }
    if (subagentParentAgentId(meta) !== callerAgentId) {
      throw new Error2(
        ErrorCodes.AGENT_NOT_OWNED,
        `Agent instance "${agentId}" does not belong to this parent agent`,
        { details: { agentId, callerAgentId } },
      );
    }
  }

  private async agentMeta(agentId: string): Promise<AgentMeta | undefined> {
    const meta = await this.metadata.read();
    return meta.agents?.[agentId];
  }
}

export type _AgentRunUsage = TokenUsage;

registerScopedService(
  LifecycleScope.Session,
  ISessionSwarmService,
  SessionSwarmService,
  ScopeActivation.OnScopeCreated,
  'sessionSwarm',
);
