/**
 * Scenario: durable Team collaboration state and messaging.
 * Responsibility: verify the session service's append ordering, idempotency,
 * live wakeups, limits, restart fold, and reusable-member summary through its DI contract.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IFlagService } from '#/app/flag/flag';
import { createHooks } from '#/hooks';
import { contextAppendMessage, contextClear, contextUndo } from '#/agent/contextMemory/contextOps';
import { ISessionCollaborationService } from '#/features/collaboration/collaboration';
import { SessionCollaborationService } from '#/features/collaboration/collaborationService';
import { CollaborationDeliveryModel, teamDeliveryAdvance } from '#/features/collaboration/deliveryOps';
import { TEAM_COLLABORATION_FLAG_ID } from '#/features/collaboration/flag';
import { TeamStatusTool } from '#/features/collaboration/tools/teamStatus';
import { TeamWaitTool } from '#/features/collaboration/tools/teamWait';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import {
  ISessionLifecycleHooks,
  type SessionLifecycleHookSlots,
} from '#/session/sessionLifecycleHooks/sessionLifecycleHooks';
import { ISessionSwarmService } from '#/session/swarm/sessionSwarm';

import { stubFlag } from '../../app/flag/stubs';
import { registerTestAgentWire } from '../../wire/stubs';

const SESSION_SCOPE = 'workspaces/w1/sessions/s1';
const active = new Set<DisposableStore>();

function buildService(
  enabled = true,
  storage: InMemoryStorageService = new InMemoryStorageService(),
): {
  readonly disposables: DisposableStore;
  readonly log: IAppendLogStore;
  readonly service: ISessionCollaborationService;
} {
  const disposables = new DisposableStore();
  active.add(disposables);
  const ix = disposables.add(new TestInstantiationService());
  ix.stub(IFileSystemStorageService, storage);
  ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
  ix.stub(IFlagService, stubFlag((id) => enabled && id === TEAM_COLLABORATION_FLAG_ID));
  ix.stub(ISessionContext, makeSessionContext({
    sessionId: 's1',
    workspaceId: 'w1',
    sessionDir: 'sessions/s1',
    sessionScope: SESSION_SCOPE,
    cwd: '/workspace',
  }));
  const lifecycleHooks = createHooks<SessionLifecycleHookSlots, keyof SessionLifecycleHookSlots>([
    'onDidCreateSession',
    'onWillCloseSession',
  ]);
  lifecycleHooks.onWillCloseSession.register('sessionSwarm', async (_event, next) => next());
  ix.stub(ISessionLifecycleHooks, lifecycleHooks);
  ix.stub(ISessionSwarmService, {
    getSwarmItem: async () => undefined,
    launch: () => ({ batchId: 'unused', accepted: [], completion: Promise.resolve([]) }),
    run: async () => [],
    cancel: () => {},
    settle: async () => {},
  });
  ix.set(ISessionCollaborationService, new SyncDescriptor(SessionCollaborationService));
  return { disposables, log: ix.get(IAppendLogStore), service: ix.get(ISessionCollaborationService) };
}

afterEach(() => {
  for (const disposables of active) disposables.dispose();
  active.clear();
});

describe('SessionCollaborationService', () => {
  it('initializes one durable empty team before the first swarm batch', async () => {
    const { service } = buildService();

    const [first, second] = await Promise.all([service.ensureTeam(), service.ensureTeam()]);

    expect(first.team).toMatchObject({ sessionId: 's1', leaderAgentId: 'main', channelId: 'general' });
    expect(second.team).toEqual(first.team);
    expect(first.members).toEqual([
      expect.objectContaining({ agentId: 'main', role: 'leader', joinedSeq: 1 }),
    ]);
    expect((await service.operations({ afterSeq: 0 })).filter(
      (operation) => operation.type === 'team.created',
    )).toHaveLength(1);
  });

  it('serializes concurrent operations and isolates message idempotency by actor', async () => {
    const { service } = buildService();
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

  it('wakes TeamWait without losing a raced operation and folds active work as interrupted on restart', async () => {
    const persistence = new InMemoryStorageService();
    const first = buildService(true, persistence);
    const receipt = await first.service.prepareSwarmBatch({
      callerAgentId: 'main',
      assignments: [{ assignmentId: 'a-restart', displayName: 'long-runner', profileName: 'coder', description: 'Long work' }],
    });
    await first.service.bindAssignment({ assignmentId: 'a-restart', agentId: 'agent-restart', parentAgentId: 'main' });
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

    await first.service.settleBatch({ batchId: receipt.batchId, status: 'completed' });
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
      status: 'completed',
    }));
    expect(await second.service.operations({ afterSeq: before, limit: 100 })).toContainEqual(
      expect.objectContaining({
        type: 'assignment.status',
        assignmentId: 'a-restart',
        status: 'interrupted',
      }),
    );
    expect((await second.service.history()).at(-1)).toMatchObject({ body: 'New direction', attachments });
  });

  it('bootstraps members with an explicit communication and handoff protocol', async () => {
    const { service } = buildService();
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

    expect(delivery?.bootstrap).toContain('call TeamStatus');
    expect(delivery?.bootstrap).toContain('TeamSend');
    expect(delivery?.bootstrap).toContain('Do not duplicate an active teammate assignment');
    expect(delivery?.bootstrap).toContain('use TeamWait');
    expect(delivery?.bootstrap).toContain('Before your final response');
  });

  it('enforces feature and burst limits with structured errors', async () => {
    const disabled = buildService(false);
    await expect(disabled.service.snapshot()).rejects.toMatchObject({ code: 'collaboration.not_enabled' });
    disabled.disposables.dispose();
    active.delete(disabled.disposables);

    const { service } = buildService();
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
    await first.service.prepareSwarmBatch({
      callerAgentId: 'main',
      assignments: [{ assignmentId: 'a-corrupt', displayName: 'corrupt-worker', profileName: 'coder', description: 'Work' }],
    });
    first.log.append(SESSION_SCOPE + '/collaboration', 'events.jsonl', {
      version: 2,
      type: 'future.operation',
      seq: 3,
      at: Date.now(),
    });
    await first.log.flush();
    first.disposables.dispose();
    active.delete(first.disposables);

    const second = buildService(true, persistence);
    await expect(second.service.snapshot()).resolves.toMatchObject({
      state: 'degraded',
      latestSeq: 2,
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

describe('TeamStatus tool', () => {
  it('returns only idle terminal members as reusable follow-up candidates', async () => {
    const { service } = buildService();
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
