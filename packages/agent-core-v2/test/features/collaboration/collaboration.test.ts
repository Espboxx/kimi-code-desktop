/**
 * Scenario: durable Team collaboration state and messaging.
 * Responsibility: verify the session service's append ordering, idempotency,
 * live wakeups, limits, restart fold, and reusable-member summary through its DI contract.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IFlagService } from '#/app/flag/flag';
import {
  ITelemetryService,
  noopTelemetryService,
  type TelemetryProperties,
} from '#/app/telemetry/telemetry';
import { createHooks } from '#/hooks';
import { contextAppendMessage, contextClear, contextUndo } from '#/agent/contextMemory/contextOps';
import type { AgentTaskSink } from '#/agent/task/types';
import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ISessionCollaborationService } from '#/features/collaboration/collaboration';
import { SessionCollaborationService } from '#/features/collaboration/collaborationService';
import { AgentCollaborationDeliveryService } from '#/features/collaboration/deliveryService';
import { CollaborationDeliveryModel, teamDeliveryAdvance } from '#/features/collaboration/deliveryOps';
import { TeamAssignmentTask } from '#/features/collaboration/teamAssignmentTask';
import { TEAM_COLLABORATION_FLAG_ID } from '#/features/collaboration/flag';
import { ITeamWorkspaceService } from '#/features/collaboration/teamWorkspace';
import { TeamWorkspaceService } from '#/features/collaboration/teamWorkspaceService';
import type { TeamIntegrationState } from '#/features/collaboration/types';
import { TeamAnswerQuestionTool } from '#/features/collaboration/tools/teamAnswerQuestion';
import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import { TeamStatusTool } from '#/features/collaboration/tools/teamStatus';
import { TeamWaitTool } from '#/features/collaboration/tools/teamWait';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { BlobStoreService } from '#/persistence/backends/node-fs/blobStoreService';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IBlobStore } from '#/persistence/interface/blobStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import {
  ISessionQuestionService,
  type QuestionRequest,
} from '#/session/question/question';
import {
  ISessionLifecycleHooks,
  type SessionLifecycleHookSlots,
} from '#/session/sessionLifecycleHooks/sessionLifecycleHooks';
import {
  ISessionSwarmService,
  type SessionSwarmRunArgs,
  type SessionSwarmRunResult,
} from '#/session/swarm/sessionSwarm';

import { stubFlag } from '../../app/flag/stubs';
import { registerTestAgentWire } from '../../wire/stubs';
import { stubContextMemory } from '../../agent/contextMemory/stubs';
import { runWillBeginStepHooks, stubLoopWithHooks, stubWire } from '../../agent/loop/stubs';

const SESSION_SCOPE = 'workspaces/w1/sessions/s1';
const active = new Set<DisposableStore>();
const execFileAsync = promisify(execFile);

function buildService(
  enabled = true,
  storage: InMemoryStorageService = new InMemoryStorageService(),
  options: {
    readonly swarm?: ISessionSwarmService;
    readonly teamWorkspace?: ITeamWorkspaceService;
    readonly pendingQuestions?: readonly QuestionRequest[];
  } = {},
): {
  readonly disposables: DisposableStore;
  readonly log: IAppendLogStore;
  readonly service: ISessionCollaborationService;
  readonly telemetryEvents: Array<{ readonly event: string; readonly properties: TelemetryProperties }>;
} {
  const disposables = new DisposableStore();
  active.add(disposables);
  const ix = disposables.add(new TestInstantiationService());
  ix.stub(IFileSystemStorageService, storage);
  ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
  ix.set(IBlobStore, new SyncDescriptor(BlobStoreService));
  ix.stub(IFlagService, stubFlag((id) => enabled && id === TEAM_COLLABORATION_FLAG_ID));
  ix.stub(ISessionContext, makeSessionContext({
    sessionId: 's1',
    workspaceId: 'w1',
    sessionDir: 'sessions/s1',
    sessionScope: SESSION_SCOPE,
    cwd: '/workspace',
  }));
  ix.stub(ISessionQuestionService, {
    request: async () => null,
    enqueue: (request) => ({ ...request, id: request.id ?? request.toolCallId ?? 'question-test' }),
    answer: () => {},
    dismiss: () => {},
    listPending: () => options.pendingQuestions ?? [],
  });
  const lifecycleHooks = createHooks<SessionLifecycleHookSlots, keyof SessionLifecycleHookSlots>([
    'onDidCreateSession',
    'onWillCloseSession',
  ]);
  lifecycleHooks.onWillCloseSession.register('sessionSwarm', async (_event, next) => next());
  ix.stub(ISessionLifecycleHooks, lifecycleHooks);
  ix.stub(ISessionSwarmService, options.swarm ?? {
    getSwarmItem: async () => undefined,
    launch: () => ({ batchId: 'unused', accepted: [], completion: Promise.resolve([]) }),
    run: async () => [],
    cancel: () => {},
    settle: async () => {},
  });
  ix.stub(ITeamWorkspaceService, options.teamWorkspace ?? {
    prepareTask: async ({ mode, integration }) => ({
      workspace: {
        execution: {
          workDir: '/workspace',
          access: mode === 'shared_readonly' ? 'read' : 'write',
          confined: true,
        },
        path: '/workspace',
        head: 'candidate',
      },
      integration,
    }),
    finalizeTask: async () => ({
      workspacePath: '/workspace',
      candidateHead: 'candidate',
      patch: new Uint8Array(),
    }),
    prepareValidation: async () => ({
      execution: { workDir: '/workspace', access: 'write', confined: true },
      path: '/workspace',
      head: 'candidate',
    }),
    integrate: async ({ integration }) => ({
      ...integration,
      status: 'integrating',
      baselineHead: integration.baselineHead ?? 'base',
      integrationHead: 'candidate',
      updatedAt: Date.now(),
    }),
    preview: async () => new Uint8Array(),
    apply: async () => {},
    discard: async () => {},
  });
  const telemetryEvents: Array<{ event: string; properties: TelemetryProperties }> = [];
  ix.stub(ITelemetryService, {
    ...noopTelemetryService,
    track2: (event, properties) => {
      telemetryEvents.push({
        event,
        properties: (properties as TelemetryProperties | undefined) ?? {},
      });
    },
  });
  ix.set(ISessionCollaborationService, new SyncDescriptor(SessionCollaborationService));
  return {
    disposables,
    log: ix.get(IAppendLogStore),
    service: ix.get(ISessionCollaborationService),
    telemetryEvents,
  };
}

interface ControlledLaunch {
  readonly tasks: SessionSwarmRunArgs['tasks'];
  readonly agentIds: readonly string[];
  readonly bound: Promise<void>;
  complete(results: readonly Omit<SessionSwarmRunResult, 'task' | 'agentId'>[]): Promise<void>;
}

function controlledSwarm(): { readonly service: ISessionSwarmService; readonly launches: ControlledLaunch[] } {
  const launches: ControlledLaunch[] = [];
  const service = {
    _serviceBrand: undefined,
    getSwarmItem: async () => undefined,
    launch: (args: SessionSwarmRunArgs) => {
      const index = launches.length + 1;
      const agentIds = args.tasks.map((task, taskIndex) =>
        task.kind === 'resume' ? task.resumeAgentId : `agent-${String(index)}-${String(taskIndex + 1)}`,
      );
      const bound = Promise.all(args.tasks.map(async (task, taskIndex) => {
        await task.onAgentBound?.(agentIds[taskIndex]!);
      })).then(() => undefined);
      let settle!: (results: readonly SessionSwarmRunResult[]) => void;
      const completion = new Promise<readonly SessionSwarmRunResult[]>((resolve) => { settle = resolve; });
      const pending: ControlledLaunch = {
        tasks: args.tasks,
        agentIds,
        bound,
        complete: async (results) => {
          await bound;
          settle(results.map((result, taskIndex) => ({
            ...result,
            task: args.tasks[taskIndex]!,
            agentId: agentIds[taskIndex],
          })));
        },
      };
      launches.push(pending);
      return { batchId: `swarm-${String(index)}`, accepted: args.tasks, completion };
    },
    run: async () => [],
    cancel: () => {},
    cancelBatch: () => {},
    settle: async () => {},
  } as unknown as ISessionSwarmService;
  return { service, launches };
}

function integrationWorkspace(): {
  readonly service: ITeamWorkspaceService;
  readonly apply: ReturnType<typeof vi.fn>;
  readonly discard: ReturnType<typeof vi.fn>;
} {
  let candidate = 0;
  const apply = vi.fn(async () => undefined);
  const discard = vi.fn(async () => undefined);
  const service: ITeamWorkspaceService = {
    _serviceBrand: undefined,
    prepareTask: async ({ taskId, mode, integration }) => ({
      workspace: {
        execution: {
          workDir: `/team/${taskId}`,
          access: mode === 'shared_readonly' ? 'read' : 'write',
          confined: true,
        },
        path: `/team/${taskId}`,
        head: mode === 'shared_readonly' ? undefined : integration.integrationHead ?? 'base',
      },
      integration: mode === 'shared_readonly'
        ? integration
        : {
            ...integration,
            status: 'preparing',
            baselineHead: integration.baselineHead ?? 'base',
            integrationHead: integration.integrationHead ?? 'base',
            updatedAt: Date.now(),
          },
    }),
    finalizeTask: async ({ workspacePath }) => {
      candidate += 1;
      return {
        workspacePath,
        candidateHead: `candidate-${String(candidate)}`,
        patch: new TextEncoder().encode(`diff-${String(candidate)}`),
      };
    },
    prepareValidation: async ({ taskId, candidateHead }) => ({
      execution: { workDir: `/validate/${taskId}`, access: 'write', confined: true },
      path: `/validate/${taskId}`,
      head: candidateHead,
    }),
    integrate: async ({ candidateHead, integration }) => ({
      ...integration,
      status: 'integrating',
      integrationHead: candidateHead,
      updatedAt: Date.now(),
    }),
    preview: async (integration: TeamIntegrationState) =>
      new TextEncoder().encode(`${integration.baselineHead ?? ''}..${integration.integrationHead ?? ''}`),
    apply,
    discard,
  };
  return { service, apply, discard };
}

function runtimeTask(
  service: ISessionCollaborationService,
  taskId: string,
  description: string,
): SessionSwarmRunArgs['tasks'][number] {
  return {
    kind: 'spawn',
    data: { taskId },
    profileName: 'coder',
    parentToolCallId: `test:${taskId}`,
    prompt: description,
    description,
    runInBackground: true,
    onAgentBound: (agentId) => service.bindAssignment({
      assignmentId: taskId,
      agentId,
      parentAgentId: 'main',
    }),
  };
}

afterEach(() => {
  for (const disposables of active) disposables.dispose();
  active.clear();
});

describe('SessionCollaborationService', () => {
  it('initializes one durable empty team before the first swarm batch', async () => {
    const { service, telemetryEvents } = buildService();

    const [first, second] = await Promise.all([service.ensureTeam(), service.ensureTeam()]);

    expect(first.team).toMatchObject({ sessionId: 's1', leaderAgentId: 'main', channelId: 'general' });
    expect(second.team).toEqual(first.team);
    expect(first.members).toEqual([
      expect.objectContaining({ agentId: 'main', role: 'leader', joinedSeq: 1 }),
    ]);
    expect((await service.operations({ afterSeq: 0 })).filter(
      (operation) => operation.type === 'team.created',
    )).toHaveLength(1);
    expect(telemetryEvents).toContainEqual({
      event: 'team_started',
      properties: {
        max_concurrency: 4,
        max_members: 16,
        max_delegation_depth: 2,
        execution_retries: 1,
        validation_retries: 2,
        has_token_budget: false,
        has_wall_clock_budget: false,
      },
    });
  });

  it('pauses at the next model boundary after the shared token budget is consumed', async () => {
    const { service, telemetryEvents } = buildService();
    await service.ensureTeam({ maxTokens: 10 });

    await service.recordModelRequestUsage({
      inputOther: 7,
      output: 3,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    });

    const snapshot = await service.snapshot();
    expect(snapshot).toMatchObject({
      protocolVersion: 2,
      budget: { totalTokens: 10, exhaustedReason: 'tokens' },
      scheduler: { status: 'paused' },
    });
    await expect(service.assertModelRequestAllowed()).rejects.toMatchObject({
      code: 'collaboration.budget_exhausted',
    });
    expect((await service.history()).at(-1)?.body).toContain('token budget was exhausted');
    expect(telemetryEvents).toContainEqual({
      event: 'team_budget_exhausted',
      properties: expect.objectContaining({ reason: 'tokens', tokens_used: 10 }),
    });
  });

  it('requires a higher exhausted budget before Team scheduling can resume', async () => {
    const { service } = buildService();
    await service.ensureTeam({ maxTokens: 10 });
    await service.recordModelRequestUsage({
      inputOther: 6,
      output: 4,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    });
    const exhausted = await service.snapshot();

    await expect(service.resume({ expectedSeq: exhausted.latestSeq })).rejects.toMatchObject({
      code: 'collaboration.budget_exhausted',
    });
    const raised = await service.updatePolicy({
      policy: { maxTokens: 20 },
      expectedSeq: exhausted.latestSeq,
    });
    if (raised.protocolVersion !== 2) throw new Error('expected Team v2 snapshot');
    expect(raised.budget.exhaustedReason).toBeUndefined();
    await expect(service.resume({ expectedSeq: raised.latestSeq })).resolves.toMatchObject({
      scheduler: { status: 'running' },
    });
  });

  it('validates and aggregates an isolated write task before one explicit apply', async () => {
    const swarm = controlledSwarm();
    const workspace = integrationWorkspace();
    const { service } = buildService(true, new InMemoryStorageService(), {
      swarm: swarm.service,
      teamWorkspace: workspace.service,
    });
    await service.ensureTeam();
    const receipt = await service.prepareSwarmBatch({
      callerAgentId: 'main',
      assignments: [{
        assignmentId: 'write-1',
        taskKey: 'write-core',
        displayName: 'core-writer',
        profileName: 'coder',
        description: 'Implement the core change',
        workspaceMode: 'isolated_write',
        validationMode: 'required',
      }],
    });
    await service.scheduleSwarmBatch({
      batchId: receipt.batchId,
      tasks: [runtimeTask(service, 'write-1', 'Implement the core change')],
    });

    await vi.waitFor(() => { expect(swarm.launches).toHaveLength(1); });
    await swarm.launches[0]!.bound;
    await swarm.launches[0]!.complete([{ status: 'completed', result: 'Implemented and tested.' }]);
    await vi.waitFor(() => { expect(swarm.launches).toHaveLength(2); });
    await swarm.launches[1]!.bound;
    const beforeReview = await service.snapshot();
    if (beforeReview.protocolVersion !== 2) throw new Error('expected Team v2 snapshot');
    const validationAttempt = beforeReview.attempts.find(
      (attempt) => attempt.taskId === 'write-1' && attempt.kind === 'validation' && attempt.status === 'running',
    );
    expect(validationAttempt?.agentId).toBe(swarm.launches[1]!.agentIds[0]);
    expect(validationAttempt?.agentId).not.toBe(swarm.launches[0]!.agentIds[0]);
    await service.submitReview({
      reviewerAgentId: validationAttempt!.agentId!,
      taskId: 'write-1',
      decision: 'approved',
      summary: 'Diff is focused and the verification passes.',
    });
    await swarm.launches[1]!.complete([{ status: 'completed', result: 'Approved with test evidence.' }]);

    await vi.waitFor(async () => {
      const snapshot = await service.snapshot();
      expect(snapshot).toMatchObject({
        protocolVersion: 2,
        scheduler: { status: 'awaiting_apply' },
        integration: { status: 'awaiting_apply', baselineHead: 'base', integrationHead: 'candidate-1' },
      });
    });
    const ready = await service.snapshot();
    if (ready.protocolVersion !== 2) throw new Error('expected Team v2 snapshot');
    expect(ready.tasks).toContainEqual(expect.objectContaining({ id: 'write-1', status: 'completed' }));
    expect(ready.artifacts.map((artifact) => artifact.kind)).toEqual(expect.arrayContaining([
      'job_prompt',
      'report',
      'patch',
      'validation',
      'integration_diff',
    ]));

    const applied = await service.applyIntegration({ expectedSeq: ready.latestSeq });
    expect(applied).toMatchObject({ scheduler: { status: 'completed' }, integration: { status: 'applied' } });
    expect(workspace.apply).toHaveBeenCalledOnce();
    expect(workspace.discard).toHaveBeenCalledOnce();
  });

  it('does not start validation while Team scheduling is paused', async () => {
    const swarm = controlledSwarm();
    const workspace = integrationWorkspace();
    const { service } = buildService(true, new InMemoryStorageService(), {
      swarm: swarm.service,
      teamWorkspace: workspace.service,
    });
    await service.ensureTeam();
    const receipt = await service.prepareSwarmBatch({
      callerAgentId: 'main',
      assignments: [{
        assignmentId: 'write-paused',
        displayName: 'paused-writer',
        profileName: 'coder',
        description: 'Implement while scheduling may pause',
        workspaceMode: 'isolated_write',
        validationMode: 'required',
      }],
    });
    await service.scheduleSwarmBatch({
      batchId: receipt.batchId,
      tasks: [runtimeTask(service, 'write-paused', 'Implement while scheduling may pause')],
    });
    await vi.waitFor(() => { expect(swarm.launches).toHaveLength(1); });
    await swarm.launches[0]!.bound;
    const running = await service.snapshot();
    await service.pause({ expectedSeq: running.latestSeq });

    await swarm.launches[0]!.complete([{ status: 'completed', result: 'Implementation ready.' }]);
    await vi.waitFor(async () => {
      expect(await service.snapshot()).toMatchObject({
        scheduler: { status: 'paused' },
        tasks: [expect.objectContaining({ id: 'write-paused', status: 'awaiting_validation' })],
      });
    });
    expect(swarm.launches).toHaveLength(1);

    const paused = await service.snapshot();
    await service.resume({ expectedSeq: paused.latestSeq });
    await vi.waitFor(() => { expect(swarm.launches).toHaveLength(2); });
    expect(swarm.launches[1]!.tasks[0]?.profileName).toBe('explore');
  });

  it('waits for trailing read work before opening the aggregate apply gate', async () => {
    const swarm = controlledSwarm();
    const workspace = integrationWorkspace();
    const { service } = buildService(true, new InMemoryStorageService(), {
      swarm: swarm.service,
      teamWorkspace: workspace.service,
    });
    await service.ensureTeam();
    const receipt = await service.prepareSwarmBatch({
      callerAgentId: 'main',
      assignments: [
        {
          assignmentId: 'write-before-read',
          taskKey: 'implementation',
          displayName: 'implementation-writer',
          profileName: 'coder',
          description: 'Implement the change',
          workspaceMode: 'isolated_write',
          validationMode: 'required',
        },
        {
          assignmentId: 'read-after-write',
          taskKey: 'final-inspection',
          dependsOn: ['implementation'],
          displayName: 'final-inspector',
          profileName: 'explore',
          description: 'Inspect the integrated result',
          workspaceMode: 'shared_readonly',
          validationMode: 'none',
        },
      ],
    });
    await service.scheduleSwarmBatch({
      batchId: receipt.batchId,
      tasks: [
        runtimeTask(service, 'write-before-read', 'Implement the change'),
        runtimeTask(service, 'read-after-write', 'Inspect the integrated result'),
      ],
    });

    await vi.waitFor(() => { expect(swarm.launches).toHaveLength(1); });
    await swarm.launches[0]!.complete([{ status: 'completed', result: 'Implemented.' }]);
    await vi.waitFor(() => { expect(swarm.launches).toHaveLength(2); });
    await swarm.launches[1]!.bound;
    const validating = await service.snapshot();
    if (validating.protocolVersion !== 2) throw new Error('expected Team v2 snapshot');
    const validation = validating.attempts.find(
      (attempt) => attempt.taskId === 'write-before-read' && attempt.kind === 'validation' && attempt.status === 'running',
    );
    await service.submitReview({
      reviewerAgentId: validation!.agentId!,
      taskId: 'write-before-read',
      decision: 'approved',
      summary: 'Verified independently.',
    });
    await swarm.launches[1]!.complete([{ status: 'completed', result: 'Approved.' }]);
    await vi.waitFor(() => { expect(swarm.launches).toHaveLength(3); });
    const beforeInspection = await service.snapshot();
    if (beforeInspection.protocolVersion !== 2) throw new Error('expected Team v2 snapshot');
    expect(beforeInspection.scheduler.status).toBe('running');

    await swarm.launches[2]!.complete([{ status: 'completed', result: 'Final inspection complete.' }]);
    await vi.waitFor(async () => {
      expect(await service.snapshot()).toMatchObject({
        scheduler: { status: 'awaiting_apply' },
        integration: { status: 'awaiting_apply', integrationHead: 'candidate-1' },
      });
    });
  });

  it('completes a read-only Team without creating a validator or apply gate', async () => {
    const swarm = controlledSwarm();
    const { service } = buildService(true, new InMemoryStorageService(), { swarm: swarm.service });
    await service.ensureTeam();
    const receipt = await service.prepareSwarmBatch({
      callerAgentId: 'main',
      assignments: [{
        assignmentId: 'read-only-finish',
        taskKey: 'read-only-finish',
        displayName: 'read-only-worker',
        profileName: 'explore',
        description: 'Inspect without modifying files',
        workspaceMode: 'shared_readonly',
        validationMode: 'required',
      }],
    });
    await service.scheduleSwarmBatch({
      batchId: receipt.batchId,
      tasks: [runtimeTask(service, 'read-only-finish', 'Inspect without modifying files')],
    });
    await vi.waitFor(() => { expect(swarm.launches).toHaveLength(1); });
    await swarm.launches[0]!.complete([{ status: 'completed', result: 'Inspection complete.' }]);

    await vi.waitFor(async () => {
      expect(await service.snapshot()).toMatchObject({
        scheduler: { status: 'completed', activeCount: 0, queuedCount: 0 },
        integration: { status: 'idle' },
        tasks: [expect.objectContaining({ validationMode: 'none' })],
      });
    });
    await expect(service.previewIntegration()).resolves.toBeUndefined();
  });

  it('marks the scheduler failed when terminal work leaves no schedulable task', async () => {
    const swarm = controlledSwarm();
    const { service } = buildService(true, new InMemoryStorageService(), { swarm: swarm.service });
    await service.ensureTeam({ executionRetries: 0 });
    const receipt = await service.prepareSwarmBatch({
      callerAgentId: 'main',
      assignments: [{
        assignmentId: 'failed-read',
        taskKey: 'failed-read',
        displayName: 'failed-reader',
        profileName: 'explore',
        description: 'Inspect a failing target',
        workspaceMode: 'shared_readonly',
        validationMode: 'none',
      }],
    });
    await service.scheduleSwarmBatch({
      batchId: receipt.batchId,
      tasks: [runtimeTask(service, 'failed-read', 'Inspect a failing target')],
    });
    await vi.waitFor(() => { expect(swarm.launches).toHaveLength(1); });

    await swarm.launches[0]!.complete([{ status: 'failed', error: 'Inspection failed.' }]);

    await vi.waitFor(async () => {
      expect(await service.snapshot()).toMatchObject({
        scheduler: {
          status: 'failed',
          activeCount: 0,
          pauseReason: expect.stringContaining('retry or discard'),
        },
        batches: [expect.objectContaining({ id: receipt.batchId, status: 'failed' })],
        tasks: [expect.objectContaining({ id: 'failed-read', status: 'failed' })],
      });
    });
  });

  it('reopens the failed batch when a user retries its unfinished task', async () => {
    const swarm = controlledSwarm();
    const { service } = buildService(true, new InMemoryStorageService(), { swarm: swarm.service });
    await service.ensureTeam({ executionRetries: 0 });
    const receipt = await service.prepareSwarmBatch({
      callerAgentId: 'main',
      assignments: [{
        assignmentId: 'retry-read',
        taskKey: 'retry-read',
        displayName: 'retry-reader',
        profileName: 'explore',
        description: 'Inspect, then retry',
        workspaceMode: 'shared_readonly',
        validationMode: 'none',
      }],
    });
    await service.scheduleSwarmBatch({
      batchId: receipt.batchId,
      tasks: [runtimeTask(service, 'retry-read', 'Inspect, then retry')],
    });
    await vi.waitFor(() => { expect(swarm.launches).toHaveLength(1); });
    await swarm.launches[0]!.complete([{ status: 'failed', error: 'Retry me.' }]);
    await vi.waitFor(async () => {
      expect(await service.snapshot()).toMatchObject({ scheduler: { status: 'failed' } });
    });
    const failed = await service.snapshot();

    const retried = await service.retryTask({ taskId: 'retry-read', expectedSeq: failed.latestSeq });

    expect(retried).toMatchObject({
      scheduler: { status: 'running' },
      batches: [expect.objectContaining({ id: receipt.batchId, status: 'running' })],
    });
    await vi.waitFor(() => { expect(swarm.launches).toHaveLength(2); });
  });

  it('keeps a completed Team terminal when incompatible controls are requested', async () => {
    const swarm = controlledSwarm();
    const { service } = buildService(true, new InMemoryStorageService(), { swarm: swarm.service });
    await service.ensureTeam();
    const receipt = await service.prepareSwarmBatch({
      callerAgentId: 'main',
      assignments: [{
        assignmentId: 'terminal-read',
        taskKey: 'terminal-read',
        displayName: 'terminal-reader',
        profileName: 'explore',
        description: 'Finish once',
        workspaceMode: 'shared_readonly',
        validationMode: 'none',
      }],
    });
    await service.scheduleSwarmBatch({
      batchId: receipt.batchId,
      tasks: [runtimeTask(service, 'terminal-read', 'Finish once')],
    });
    await vi.waitFor(() => { expect(swarm.launches).toHaveLength(1); });
    await swarm.launches[0]!.complete([{ status: 'completed', result: 'Done.' }]);
    await vi.waitFor(async () => {
      expect(await service.snapshot()).toMatchObject({ scheduler: { status: 'completed' } });
    });
    const completed = await service.snapshot();

    await expect(service.pause({ expectedSeq: completed.latestSeq })).rejects.toMatchObject({
      code: 'request.invalid',
    });
    await expect(service.resume({ expectedSeq: completed.latestSeq })).rejects.toMatchObject({
      code: 'request.invalid',
    });
    await expect(service.cancelTask({
      taskId: 'terminal-read',
      expectedSeq: completed.latestSeq,
    })).rejects.toMatchObject({ code: 'request.invalid' });
    await expect(service.reassignTask({
      taskId: 'terminal-read',
      expectedSeq: completed.latestSeq,
      profileName: 'coder',
    })).rejects.toMatchObject({ code: 'request.invalid' });
    const unchanged = await service.snapshot();
    expect(unchanged.latestSeq).toBe(completed.latestSeq);
    expect(unchanged).toMatchObject({
      scheduler: { status: 'completed' },
      tasks: [expect.objectContaining({ id: 'terminal-read', status: 'completed' })],
    });
  });

  it('reuses an idle Team member without consuming another member slot', async () => {
    const swarm = controlledSwarm();
    const { service } = buildService(true, new InMemoryStorageService(), { swarm: swarm.service });
    await service.ensureTeam({ maxMembers: 2 });
    await service.prepareSwarmBatch({
      callerAgentId: 'main',
      assignments: [{
        assignmentId: 'first-member-task',
        taskKey: 'first-member-task',
        displayName: 'reusable-worker',
        profileName: 'explore',
        description: 'Initial inspection',
        workspaceMode: 'shared_readonly',
        validationMode: 'none',
      }],
    });
    await service.bindAssignment({
      assignmentId: 'first-member-task',
      agentId: 'agent-reusable',
      parentAgentId: 'main',
    });
    await service.settleAssignment({ assignmentId: 'first-member-task', status: 'completed' });

    const second = await service.prepareSwarmBatch({
      callerAgentId: 'main',
      assignments: [{
        assignmentId: 'second-member-task',
        taskKey: 'second-member-task',
        displayName: 'reusable-worker',
        profileName: 'explore',
        description: 'Follow-up inspection',
        workspaceMode: 'shared_readonly',
        validationMode: 'none',
        resumeAgentId: 'agent-reusable',
      }],
    });
    expect(second).toMatchObject({
      assignments: [expect.objectContaining({ resumeAgentId: 'agent-reusable' })],
    });
    await service.scheduleSwarmBatch({
      batchId: second.batchId,
      tasks: [{
        kind: 'resume',
        data: { taskId: 'second-member-task' },
        profileName: 'explore',
        parentToolCallId: 'test:second-member-task',
        prompt: 'Follow-up inspection',
        description: 'Follow-up inspection',
        runInBackground: true,
        resumeAgentId: 'agent-reusable',
        onAgentBound: (agentId) => service.bindAssignment({
          assignmentId: 'second-member-task',
          agentId,
          parentAgentId: 'main',
        }),
      }],
    });
    await vi.waitFor(() => { expect(swarm.launches).toHaveLength(1); });
    expect(swarm.launches[0]!.tasks[0]).toMatchObject({
      kind: 'resume',
      resumeAgentId: 'agent-reusable',
      rebind: { profileName: 'explore' },
      executionWorkspace: { workDir: '/workspace', access: 'read', confined: true },
    });
  });

  it('rejects a resumed member task that attempts to rename its persistent identity', async () => {
    const { service } = buildService();
    await service.ensureTeam();
    await service.prepareSwarmBatch({
      callerAgentId: 'main',
      assignments: [{
        assignmentId: 'named-member-task',
        taskKey: 'named-member-task',
        displayName: 'persistent-name',
        profileName: 'explore',
        description: 'Initial work',
        workspaceMode: 'shared_readonly',
        validationMode: 'none',
      }],
    });
    await service.bindAssignment({
      assignmentId: 'named-member-task',
      agentId: 'agent-named',
      parentAgentId: 'main',
    });
    await service.settleAssignment({ assignmentId: 'named-member-task', status: 'completed' });

    await expect(service.prepareSwarmBatch({
      callerAgentId: 'main',
      assignments: [{
        assignmentId: 'renamed-member-task',
        taskKey: 'renamed-member-task',
        displayName: 'different-name',
        profileName: 'explore',
        description: 'Follow-up work',
        workspaceMode: 'shared_readonly',
        validationMode: 'none',
        resumeAgentId: 'agent-named',
      }],
    })).rejects.toMatchObject({ code: 'request.invalid' });
  });

  it('releases a blocked read task only after its dependency completes', async () => {
    const swarm = controlledSwarm();
    const workspace = integrationWorkspace();
    const { service } = buildService(true, new InMemoryStorageService(), {
      swarm: swarm.service,
      teamWorkspace: workspace.service,
    });
    await service.ensureTeam({ maxConcurrency: 4 });
    const receipt = await service.prepareSwarmBatch({
      callerAgentId: 'main',
      assignments: [
        {
          assignmentId: 'read-1',
          taskKey: 'inventory',
          displayName: 'inventory-reader',
          profileName: 'explore',
          description: 'Inventory the implementation',
          workspaceMode: 'shared_readonly',
          validationMode: 'none',
        },
        {
          assignmentId: 'read-2',
          taskKey: 'analysis',
          dependsOn: ['inventory'],
          displayName: 'analysis-reader',
          profileName: 'explore',
          description: 'Analyze the inventory',
          workspaceMode: 'shared_readonly',
          validationMode: 'none',
        },
      ],
    });
    await service.scheduleSwarmBatch({
      batchId: receipt.batchId,
      tasks: [
        runtimeTask(service, 'read-1', 'Inventory the implementation'),
        runtimeTask(service, 'read-2', 'Analyze the inventory'),
      ],
    });

    await vi.waitFor(() => { expect(swarm.launches).toHaveLength(1); });
    expect(swarm.launches[0]!.tasks[0]?.data).toEqual({ taskId: 'read-1' });
    await swarm.launches[0]!.complete([{ status: 'completed', result: 'Inventory ready.' }]);
    await vi.waitFor(() => { expect(swarm.launches).toHaveLength(2); });
    expect(swarm.launches[1]!.tasks[0]?.data).toEqual({ taskId: 'read-2' });
    await swarm.launches[1]!.complete([{ status: 'completed', result: 'Analysis ready.' }]);
    await vi.waitFor(async () => {
      const snapshot = await service.snapshot();
      expect(snapshot.assignments).toEqual([
        expect.objectContaining({ id: 'read-1', status: 'completed' }),
        expect.objectContaining({ id: 'read-2', status: 'completed' }),
      ]);
    });
    expect(swarm.launches).toHaveLength(2);
  });

  it('serializes concurrent operations and isolates message idempotency by actor', async () => {
    const { service } = buildService();
    await service.ensureTeam();
    const [receipt] = await Promise.all([
      service.prepareSwarmBatch({
        callerAgentId: 'main',
        assignments: [
          { assignmentId: 'a1', displayName: 'builder', profileName: 'coder', model: 'fast', description: 'Implement A' },
          { assignmentId: 'a2', displayName: 'scout', profileName: 'explore', description: 'Inspect B' },
        ],
      }),
      service.prepareSwarmBatch({
        callerAgentId: 'main',
        assignments: [
          { assignmentId: 'a3', displayName: 'reviewer', profileName: 'explore', description: 'Inspect C' },
        ],
      }),
    ]);
    await Promise.all([
      service.bindAssignment({ assignmentId: 'a1', agentId: 'agent-1', parentAgentId: 'main' }),
      service.bindAssignment({ assignmentId: 'a2', agentId: 'agent-2', parentAgentId: 'main' }),
    ]);
    const [leaderMessage, retriedLeaderMessage] = await Promise.all([
      service.sendAgentMessage({ agentId: 'main', body: 'Coordinate now', clientMessageId: 'same-id' }),
      service.sendAgentMessage({ agentId: 'main', body: 'Coordinate now', clientMessageId: 'same-id' }),
    ]);
    const memberMessage = await service.sendAgentMessage({
      agentId: 'agent-1',
      body: 'Working',
      clientMessageId: 'same-id',
    });

    expect(receipt.batchId).toMatch(/^batch_/);
    const snapshot = await service.snapshot();
    expect(snapshot.members).toContainEqual(expect.objectContaining({
      agentId: 'agent-1',
      displayName: 'builder',
    }));
    expect(snapshot.assignments).toContainEqual(expect.objectContaining({
      id: 'a1',
      model: 'fast',
    }));
    expect(retriedLeaderMessage).toEqual(leaderMessage);
    expect(memberMessage.channelSeq).toBe(leaderMessage.channelSeq + 1);
    await expect(service.sendAgentMessage({
      agentId: 'main',
      body: 'Coordinate now',
      clientMessageId: 'same-id',
    })).resolves.toEqual(leaderMessage);
    await expect(service.sendAgentMessage({
      agentId: 'main',
      body: 'Different body',
      clientMessageId: 'same-id',
    })).rejects.toMatchObject({ code: 'collaboration.idempotency_conflict' });

    const operations = await service.operations({ afterSeq: 0, limit: 100 });
    expect(operations.filter((operation) => operation.type === 'team.created')).toHaveLength(1);
    expect(operations.filter((operation) => operation.type === 'batch.created')).toHaveLength(2);
    expect(operations.filter((operation) => operation.type === 'message.sent')).toHaveLength(2);
    expect(operations.map((operation) => operation.seq)).toEqual(
      Array.from({ length: operations.length }, (_, index) => index + 1),
    );
    expect((await service.history()).map((message) => message.body)).toEqual([
      'Coordinate now',
      'Working',
    ]);
  });

  it('wakes the leader automatically when a user message targets another member', async () => {
    const { service } = buildService();
    await service.ensureTeam();
    await service.prepareSwarmBatch({
      callerAgentId: 'main',
      assignments: [{
        assignmentId: 'directed-task',
        displayName: 'directed-member',
        profileName: 'coder',
        description: 'Handle the directed work',
      }],
    });
    await service.bindAssignment({
      assignmentId: 'directed-task',
      agentId: 'agent-directed',
      parentAgentId: 'main',
    });
    const leaderLoop = stubLoopWithHooks();
    const delivery = new AgentCollaborationDeliveryService(
      { agentId: 'main' } as IAgentScopeContext,
      service,
      stubContextMemory(),
      stubWire(),
      leaderLoop,
    );

    try {
      await service.sendUserMessage({
        body: 'New priority for the directed member',
        clientMessageId: 'directed-user-message',
        recipientAgentIds: ['agent-directed'],
      });

      await vi.waitFor(() => {
        expect(leaderLoop.launches).toHaveLength(1);
      });
    } finally {
      delivery.dispose();
    }
  });

  it('delivers transient user images with the persisted Team message', async () => {
    const { service } = buildService();
    await service.ensureTeam();
    const leaderLoop = stubLoopWithHooks();
    const context = stubContextMemory();
    const delivery = new AgentCollaborationDeliveryService(
      { agentId: 'main' } as IAgentScopeContext,
      service,
      context,
      stubWire(),
      leaderLoop,
    );
    const modelUrl = 'data:image/png;base64,iVBORw0KGgo=';

    try {
      await service.sendUserMessage({
        body: 'Inspect the attached diagram',
        clientMessageId: 'user-image-message',
        attachments: [{
          type: 'image_url',
          url: 'file:///workspace/.media-cache/diagram.png',
          name: 'diagram.png',
        }],
        modelAttachments: [{ type: 'image_url', url: modelUrl }],
      });
      await vi.waitFor(() => {
        expect(leaderLoop.launches).toHaveLength(1);
      });

      await runWillBeginStepHooks(leaderLoop);

      expect(context.messages.at(-1)?.content).toEqual([
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('Inspect the attached diagram'),
        }),
        { type: 'image_url', imageUrl: { url: modelUrl } },
      ]);
      expect((await service.history()).at(-1)).not.toHaveProperty('modelAttachments');
    } finally {
      delivery.dispose();
    }
  });

  it('routes a structured member question to the leader and returns the leader answer', async () => {
    const { service } = buildService();
    await service.ensureTeam();
    await service.prepareSwarmBatch({
      callerAgentId: 'main',
      assignments: [{
        assignmentId: 'question-task',
        displayName: 'questioner',
        profileName: 'coder',
        description: 'Implement parser',
      }],
    });
    await service.bindAssignment({
      assignmentId: 'question-task',
      agentId: 'agent-questioner',
      parentAgentId: 'main',
    });
    const leaderLoop = stubLoopWithHooks();
    const delivery = new AgentCollaborationDeliveryService(
      { agentId: 'main' } as IAgentScopeContext,
      service,
      stubContextMemory(),
      stubWire(),
      leaderLoop,
    );
    const controller = new AbortController();

    try {
      const pending = service.requestLeaderQuestion({
        agentId: 'agent-questioner',
        questionId: 'question-1',
        questions: [{
          question: 'Which parser should we use?',
          header: 'Parser',
          options: [
            { label: 'Native', description: 'No dependency' },
            { label: 'Library', description: 'More features' },
          ],
          multiSelect: false,
        }],
        signal: controller.signal,
      });
      await vi.waitFor(() => {
        expect(leaderLoop.launches).toHaveLength(1);
      });
      const questionMessage = (await service.history()).at(-1);
      expect(questionMessage).toMatchObject({
        sender: { actorId: 'agent-questioner', role: 'member' },
        recipientAgentIds: ['main'],
        payload: {
          type: 'question',
          questionId: 'question-1',
        },
      });
      expect(questionMessage?.body).toContain('Native: No dependency');
      expect(questionMessage?.body).toContain('Library: More features');

      const execution = new TeamAnswerQuestionTool(
        { agentId: 'main' } as IAgentScopeContext,
        service,
      ).resolveExecution({
        question_id: 'question-1',
        answers: [{ question: 'Which parser should we use?', answer: 'Native' }],
      });
      if (execution.isError === true) throw new Error(JSON.stringify(execution.output));
      const answerResult = await execution.execute({
        turnId: 1,
        toolCallId: 'team-answer-question-1',
        signal: controller.signal,
      });
      expect(answerResult.isError).toBeUndefined();

      await expect(pending).resolves.toEqual({ 'Which parser should we use?': 'Native' });
      expect((await service.history()).at(-1)).toMatchObject({
        sender: { actorId: 'main', role: 'leader' },
        recipientAgentIds: ['agent-questioner'],
        payload: {
          type: 'question_answer',
          questionId: 'question-1',
          answers: { 'Which parser should we use?': 'Native' },
        },
      });
    } finally {
      delivery.dispose();
    }
  });

  it('persists a structured leader question and resolves it with a user answer', async () => {
    const pendingQuestions: QuestionRequest[] = [{
      toolCallId: 'leader-question-1',
      questions: [{
        question: 'Which recovery path should run?',
        header: 'Recovery',
        options: [
          { label: 'Resume turn', description: 'Continue the parked turn' },
          { label: 'Start turn', description: 'Start a recovered turn' },
        ],
      }],
    }];
    const { service } = buildService(true, new InMemoryStorageService(), { pendingQuestions });
    await service.ensureTeam();

    const question = await service.publishUserQuestion({
      questionId: 'leader-question-1',
      questions: pendingQuestions[0]!.questions,
    });
    const answer = await service.answerUserQuestion({
      questionId: 'leader-question-1',
      answers: { 'Which recovery path should run?': 'Resume turn' },
    });

    expect(question).toMatchObject({
      sender: { actorKind: 'agent', actorId: 'main', role: 'leader' },
      recipientAgentIds: ['main'],
      payload: { type: 'question', questionId: 'leader-question-1' },
    });
    expect(answer).toMatchObject({
      sender: { actorKind: 'user', role: 'user' },
      recipientAgentIds: ['main'],
      payload: {
        type: 'question_answer',
        questionId: 'leader-question-1',
        answers: { 'Which recovery path should run?': 'Resume turn' },
      },
    });
  });

  it('persists a skipped leader question as a dismissed user answer', async () => {
    const { service } = buildService();
    await service.ensureTeam();
    await service.publishUserQuestion({
      questionId: 'leader-question-skip',
      questions: [{
        question: 'Continue the recovery?',
        options: [{ label: 'Continue' }, { label: 'Stop' }],
      }],
    });

    const answer = await service.answerUserQuestion({
      questionId: 'leader-question-skip',
      answers: null,
    });

    expect(answer).toMatchObject({
      payload: {
        type: 'question_answer',
        questionId: 'leader-question-skip',
        answers: {},
        dismissed: true,
      },
    });
    expect(answer.body).toContain('User skipped question');
  });

  it('does not wake the leader twice when its original question is still pending', async () => {
    const pendingQuestions: QuestionRequest[] = [{
      toolCallId: 'leader-question-live',
      questions: [{
        question: 'Use the live turn?',
        options: [{ label: 'Yes' }, { label: 'No' }],
      }],
    }];
    const { service } = buildService(true, new InMemoryStorageService(), { pendingQuestions });
    await service.ensureTeam();
    const question = await service.publishUserQuestion({
      questionId: 'leader-question-live',
      questions: pendingQuestions[0]!.questions,
    });
    const leaderLoop = stubLoopWithHooks();
    const delivery = new AgentCollaborationDeliveryService(
      { agentId: 'main' } as IAgentScopeContext,
      service,
      stubContextMemory(),
      stubWire(),
      leaderLoop,
    );

    try {
      const answer = await service.answerUserQuestion({
        questionId: 'leader-question-live',
        answers: { 'Use the live turn?': 'Yes' },
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(leaderLoop.launches).toHaveLength(0);
      await expect(service.delivery({ agentId: 'main', afterSeq: question.seq })).resolves.toMatchObject({
        toSeq: answer.seq,
        messages: [],
      });
    } finally {
      delivery.dispose();
    }
  });

  it('wakes the leader from an unanswered delivery after a session restart', async () => {
    const persistence = new InMemoryStorageService();
    const first = buildService(true, persistence);
    await first.service.ensureTeam();
    await first.service.publishUserQuestion({
      questionId: 'leader-question-restart',
      questions: [{
        question: 'Resume after restart?',
        options: [{ label: 'Resume' }, { label: 'Stop' }],
      }],
    });
    await first.service.answerUserQuestion({
      questionId: 'leader-question-restart',
      answers: { 'Resume after restart?': 'Resume' },
    });
    first.disposables.dispose();

    const second = buildService(true, persistence);
    await second.service.ready;
    const leaderLoop = stubLoopWithHooks();
    const context = stubContextMemory();
    const delivery = new AgentCollaborationDeliveryService(
      { agentId: 'main' } as IAgentScopeContext,
      second.service,
      context,
      stubWire(),
      leaderLoop,
    );

    try {
      await vi.waitFor(() => {
        expect(leaderLoop.launches).toHaveLength(1);
      });
      await runWillBeginStepHooks(leaderLoop);
      expect(context.messages.at(-1)?.content).toEqual([
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('Resume after restart?: Resume'),
        }),
      ]);
    } finally {
      delivery.dispose();
    }
  });

  it('projects one completed durable assignment into an Agent task callback result', async () => {
    const { service } = buildService();
    await service.ensureTeam();
    const receipt = await service.prepareSwarmBatch({
      callerAgentId: 'main',
      assignments: [{
        assignmentId: 'callback-task',
        displayName: 'callback-worker',
        profileName: 'coder',
        description: 'Implement callback',
      }],
    });
    await service.bindAssignment({
      assignmentId: 'callback-task',
      agentId: 'agent-callback',
      parentAgentId: 'main',
    });
    await service.submitTaskReport({
      agentId: 'agent-callback',
      taskId: 'callback-task',
      summary: 'Callback implementation verified.',
    });
    const task = new TeamAssignmentTask(service, receipt.assignments[0]!);
    const appendOutput = vi.fn();
    const settle = vi.fn(async () => true);
    const running = task.start({
      signal: new AbortController().signal,
      appendOutput,
      settle,
    } satisfies AgentTaskSink);

    await service.settleAssignment({ assignmentId: 'callback-task', status: 'completed' });
    await running;

    expect(settle).toHaveBeenCalledWith({ status: 'completed', stopReason: undefined });
    expect(appendOutput).toHaveBeenCalledWith(expect.stringContaining('Callback implementation verified.'));
    expect(task.toInfo({
      taskId: 'observer-1',
      description: task.description,
      status: 'completed',
      detached: true,
      startedAt: 1,
      endedAt: 2,
    })).toMatchObject({ kind: 'agent', agentId: 'agent-callback', subagentType: 'coder' });
  });

  it('wakes TeamWait without losing a raced operation and folds active work as interrupted on restart', async () => {
    const persistence = new InMemoryStorageService();
    const first = buildService(true, persistence);
    await first.service.ensureTeam();
    const receipt = await first.service.prepareSwarmBatch({
      callerAgentId: 'main',
      assignments: [{ assignmentId: 'a-restart', displayName: 'long-runner', profileName: 'coder', description: 'Long work' }],
    });
    await first.service.bindAssignment({ assignmentId: 'a-restart', agentId: 'agent-restart', parentAgentId: 'main' });
    await first.service.settleAssignment({ assignmentId: 'a-restart', status: 'running' });
    const before = (await first.service.snapshot()).latestSeq;
    const controller = new AbortController();
    const waiting = first.service.waitForOperation({ afterSeq: before, timeoutMs: 1_000, signal: controller.signal });
    const attachments = [{
      type: 'image_url' as const,
      url: 'file:///cache/desktop-media/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.png',
      name: 'diagram.png',
    }];
    const message = await first.service.sendUserMessage({
      body: 'New direction',
      clientMessageId: 'wake-1',
      attachments,
    });
    await expect(waiting).resolves.toMatchObject({ type: 'message.sent', message: { id: message.id } });
    await expect(first.service.sendUserMessage({
      body: 'New direction',
      clientMessageId: 'wake-1',
      attachments,
    })).resolves.toEqual(message);
    await expect(first.service.sendUserMessage({
      body: 'New direction',
      clientMessageId: 'wake-1',
      attachments: [{ ...attachments[0]!, name: 'other.png' }],
    })).rejects.toMatchObject({ code: 'collaboration.idempotency_conflict' });

    first.disposables.dispose();
    active.delete(first.disposables);

    const second = buildService(true, persistence);
    const snapshot = await second.service.snapshot();
    expect(snapshot.assignments).toContainEqual(expect.objectContaining({
      id: 'a-restart',
      status: 'interrupted',
    }));
    expect(snapshot.batches).toContainEqual(expect.objectContaining({
      id: receipt.batchId,
      status: 'interrupted',
    }));
    expect(await second.service.operations({ afterSeq: before, limit: 100 })).toContainEqual(
      expect.objectContaining({
        type: 'task.status',
        taskId: 'a-restart',
        status: 'interrupted',
      }),
    );
    expect((await second.service.history()).at(-1)).toMatchObject({ body: 'New direction', attachments });
  });

  it('bootstraps members with an explicit communication and handoff protocol', async () => {
    const { service } = buildService();
    await service.ensureTeam();
    await service.prepareSwarmBatch({
      callerAgentId: 'main',
      assignments: [{ assignmentId: 'a-protocol', displayName: 'protocol-builder', profileName: 'coder', description: 'Implement protocol' }],
    });
    await service.bindAssignment({
      assignmentId: 'a-protocol',
      agentId: 'agent-protocol',
      parentAgentId: 'main',
    });

    const delivery = await service.delivery({ agentId: 'agent-protocol', afterSeq: 0 });

    expect(delivery?.bootstrap).toContain('Call TeamStatus');
    expect(delivery?.bootstrap).toContain('TeamSend');
    expect(delivery?.bootstrap).toContain('Do not duplicate an active teammate task');
    expect(delivery?.bootstrap).toContain('use TeamWait only for an explicit one-off');
    expect(delivery?.bootstrap).toContain('AskUserQuestion');
    expect(delivery?.bootstrap).toContain('Before finishing execution work');
  });

  it('enforces feature and burst limits with structured errors', async () => {
    const disabled = buildService(false);
    await expect(disabled.service.snapshot()).resolves.toMatchObject({ protocolVersion: 2, team: undefined });
    await expect(disabled.service.ensureTeam()).rejects.toMatchObject({ code: 'collaboration.not_enabled' });
    disabled.disposables.dispose();
    active.delete(disabled.disposables);

    const { service } = buildService();
    await service.ensureTeam();
    await service.prepareSwarmBatch({
      callerAgentId: 'main',
      assignments: [{ assignmentId: 'a-limit', displayName: 'limit-worker', profileName: 'coder', description: 'Work' }],
    });
    await expect(service.sendUserMessage({
      body: 'too many images',
      clientMessageId: 'invalid-attachments',
      attachments: Array.from({ length: 9 }, (_, index) => ({
        type: 'image_url' as const,
        url: `file:///cache/desktop-media/${String(index).padStart(64, '0')}.png`,
      })),
    })).rejects.toMatchObject({ code: 'request.invalid' });
    for (let index = 0; index < 10; index += 1) {
      await service.sendUserMessage({ body: `message-${String(index)}`, clientMessageId: `id-${String(index)}` });
    }
    await expect(service.sendUserMessage({ body: 'overflow', clientMessageId: 'id-overflow' }))
      .rejects.toMatchObject({ code: 'collaboration.rate_limited' });
    await expect(service.sendUserMessage({ body: 'x'.repeat(8_193), clientMessageId: 'large' }))
      .rejects.toMatchObject({ code: 'collaboration.message_too_large' });
  });

  it('enters degraded read-only mode when a persisted operation is unknown', async () => {
    const persistence = new InMemoryStorageService();
    const first = buildService(true, persistence);
    await first.service.ensureTeam();
    await first.service.prepareSwarmBatch({
      callerAgentId: 'main',
      assignments: [{ assignmentId: 'a-corrupt', displayName: 'corrupt-worker', profileName: 'coder', description: 'Work' }],
    });
    const beforeCorruption = await first.service.snapshot();
    first.log.append(SESSION_SCOPE + '/collaboration', 'events-v2.jsonl', {
      version: 2,
      type: 'future.operation',
      seq: beforeCorruption.latestSeq + 1,
      at: Date.now(),
    });
    await first.log.flush();
    first.disposables.dispose();
    active.delete(first.disposables);

    const second = buildService(true, persistence);
    await expect(second.service.snapshot()).resolves.toMatchObject({
      state: 'degraded',
      latestSeq: beforeCorruption.latestSeq,
    });
    await expect(second.service.sendUserMessage({ body: 'blocked', clientMessageId: 'degraded' }))
      .rejects.toMatchObject({ code: 'collaboration.degraded_read_only' });
  });

  it('keeps the delivery cursor in world time across undo and context clear', () => {
    const disposables = new DisposableStore();
    active.add(disposables);
    const ix = disposables.add(new TestInstantiationService());
    const wire = registerTestAgentWire(ix, 'wire/collaboration-delivery');

    wire.dispatch(contextAppendMessage({
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'teammate update' }],
        toolCalls: [],
        origin: {
          kind: 'team_message',
          teamId: 'team-1',
          channelId: 'general',
          fromSeq: 1,
          toSeq: 4,
          messageIds: ['message-1'],
        },
      },
    }));
    expect(wire.getModel(CollaborationDeliveryModel)).toEqual({ 'team-1': 4 });

    wire.dispatch(contextUndo({ count: 1 }));
    expect(wire.getModel(CollaborationDeliveryModel)).toEqual({ 'team-1': 4 });

    wire.dispatch(teamDeliveryAdvance({ teamId: 'team-1', toSeq: 7 }));
    wire.dispatch(contextClear({}));
    expect(wire.getModel(CollaborationDeliveryModel)).toEqual({ 'team-1': 7 });
  });

  it('rejects invalid or duplicate display names before creating a batch', async () => {
    const { service } = buildService();
    await service.ensureTeam();

    await expect(service.prepareSwarmBatch({
      callerAgentId: 'main',
      assignments: [
        { assignmentId: 'a-duplicate-1', displayName: 'same-name', profileName: 'coder', description: 'First' },
        { assignmentId: 'a-duplicate-2', displayName: 'SAME-NAME', profileName: 'explore', description: 'Second' },
      ],
    })).rejects.toMatchObject({ code: 'request.invalid' });
    await expect(service.prepareSwarmBatch({
      callerAgentId: 'main',
      assignments: [
        { assignmentId: 'a-reserved', displayName: 'agent-2', profileName: 'coder', description: 'Reserved' },
      ],
    })).rejects.toMatchObject({ code: 'request.invalid' });
    expect((await service.snapshot()).batches).toEqual([]);
  });
});

describe('TeamWorkspaceService', () => {
  it('isolates, validates, aggregates, and applies a write candidate as an unstaged main-worktree change', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kimi-team-worktree-'));
    const repository = join(root, 'repository');
    const home = join(root, 'home');
    try {
      await execFileAsync('git', ['init', repository]);
      await writeFile(join(repository, 'base.txt'), 'base\n');
      await execFileAsync('git', ['add', 'base.txt'], { cwd: repository });
      await execFileAsync(
        'git',
        ['-c', 'user.name=Test User', '-c', 'user.email=test@example.test', 'commit', '-m', 'base'],
        { cwd: repository },
      );
      const session = makeSessionContext({
        sessionId: 'workspace-test',
        workspaceId: 'workspace',
        sessionDir: 'sessions/workspace-test',
        sessionScope: 'workspaces/workspace/sessions/workspace-test',
        cwd: repository,
      });
      const workspace = new TeamWorkspaceService(
        { homeDir: home } as IBootstrapService,
        session,
        new HostFileSystem(),
        new HostProcessService(),
      );
      const initial: TeamIntegrationState = { status: 'idle', updatedAt: Date.now() };
      const prepared = await workspace.prepareTask({
        taskId: 'write-one',
        mode: 'isolated_write',
        integration: initial,
      });
      await writeFile(join(prepared.workspace.path, 'added.txt'), 'candidate\n');
      const candidate = await workspace.finalizeTask({
        taskId: 'write-one',
        workspacePath: prepared.workspace.path,
        baseHead: prepared.workspace.head,
      });
      expect(new TextDecoder().decode(candidate.patch)).toContain('added.txt');

      const validation = await workspace.prepareValidation({
        taskId: 'write-one',
        candidateHead: candidate.candidateHead,
      });
      expect((await readFile(join(validation.path, 'added.txt'), 'utf8')).replaceAll('\r\n', '\n')).toBe('candidate\n');
      await expect(readFile(join(repository, 'added.txt'), 'utf8')).rejects.toBeDefined();

      const integrated = await workspace.integrate({
        candidateHead: candidate.candidateHead,
        integration: prepared.integration,
      });
      const preview = await workspace.preview(integrated);
      expect(new TextDecoder().decode(preview)).toContain('added.txt');
      await workspace.apply(integrated);

      expect((await readFile(join(repository, 'added.txt'), 'utf8')).replaceAll('\r\n', '\n')).toBe('candidate\n');
      const status = await execFileAsync('git', ['status', '--porcelain=v1'], { cwd: repository });
      expect(status.stdout).toContain('?? added.txt');
      await workspace.discard(integrated, ['write-one']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('TeamStatus tool', () => {
  it('returns only idle terminal members as reusable follow-up candidates', async () => {
    const { service } = buildService();
    await service.ensureTeam();
    await service.prepareSwarmBatch({
      callerAgentId: 'main',
      assignments: [
        { assignmentId: 'a-complete', displayName: 'renderer-scout', profileName: 'explore', description: 'Inspect renderer', item: 'renderer' },
        { assignmentId: 'a-running', displayName: 'runtime-builder', profileName: 'coder', description: 'Implement runtime', item: 'runtime' },
      ],
    });
    await service.bindAssignment({ assignmentId: 'a-complete', agentId: 'agent-1', parentAgentId: 'main' });
    await service.bindAssignment({ assignmentId: 'a-running', agentId: 'agent-2', parentAgentId: 'main' });
    await service.settleAssignment({ assignmentId: 'a-complete', status: 'completed' });

    const execution = new TeamStatusTool(service).resolveExecution({});
    if (execution.isError === true) throw new Error(JSON.stringify(execution.output));
    const result = await execution.execute({
      turnId: 1,
      toolCallId: 'team-status-1',
      signal: new AbortController().signal,
    });
    if (typeof result.output !== 'string') throw new Error('TeamStatus must return JSON text');
    const output = JSON.parse(result.output) as {
      readonly reusableMembers: readonly unknown[];
    };

    expect(output.reusableMembers).toEqual([expect.objectContaining({
      agentId: 'agent-1',
      displayName: 'renderer-scout',
      availability: 'reusable',
      latestAssignment: expect.objectContaining({
        profileName: 'explore',
        displayName: 'renderer-scout',
        description: 'Inspect renderer',
        item: 'renderer',
        status: 'completed',
      }),
    })]);
  });
});

describe('TeamWait tool', () => {
  it('returns the message body so teammates can act on channel communication', async () => {
    const { service } = buildService();
    await service.ensureTeam();
    const execution = new TeamWaitTool(service).resolveExecution({ timeout_seconds: 1 });
    if (execution.isError === true) throw new Error(JSON.stringify(execution.output));
    const waiting = execution.execute({
      turnId: 1,
      toolCallId: 'team-wait-1',
      signal: new AbortController().signal,
    });
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    await service.sendUserMessage({ body: '@agent-1 Please review the failing test', clientMessageId: 'wait-message-1' });

    const result = await waiting;
    if (typeof result.output !== 'string') throw new Error('TeamWait must return JSON text');
    expect(JSON.parse(result.output)).toMatchObject({
      timeout: false,
      operation: {
        type: 'message.sent',
        message: { body: '@agent-1 Please review the failing test' },
      },
    });
  });
});
