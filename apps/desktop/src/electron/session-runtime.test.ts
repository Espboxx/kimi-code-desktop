import type {
  ApprovalHandler,
  ApprovalRequest,
  Event,
  QuestionHandler,
  QuestionHandlerRequest,
  QuestionRequest,
  Session,
  TeamOperation,
  TeamQuestionAnswers,
  TeamSnapshot,
  TodoItem,
} from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import type { KimiDesktopNotification } from '../shared/desktop-api';
import { SessionRuntime } from './session-runtime';

describe('SessionRuntime interactions', () => {
  it('keeps an approval pending after invalid input and resolves it once', async () => {
    const fixture = createSessionFixture();
    const notifications: KimiDesktopNotification[] = [];
    const runtime = new SessionRuntime({
      session: fixture.session,
      mediaCacheDir: 'D:\\workspace\\.media-cache',
      emit: (event) => notifications.push(event),
      onRawEvent: () => undefined,
      onStateChanged: () => undefined,
      onSessionMetadataChanged: () => undefined,
    });
    await runtime.initialize();

    const request = { toolCallId: 'call-1', action: 'Run shell command' } as ApprovalRequest;
    const response = fixture.approvalHandler?.(request);
    expect(response).toBeDefined();
    expect(() => runtime.resolveInteraction('approval:call-1', { decision: 'invalid' })).toThrow();
    runtime.resolveInteraction('approval:call-1', { decision: 'approved', scope: 'session' });

    await expect(response).resolves.toEqual({ decision: 'approved', scope: 'session' });
    const batches = notifications.filter((event) => event.type === 'transcript.ops');
    const sequences = batches.map((event) => event.type === 'transcript.ops' ? event.batch.seq : 0);
    expect(sequences).toHaveLength(2);
    expect(sequences[1]).toBe((sequences[0] ?? 0) + 1);
    expect(notifications).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'interaction.pending', interactionId: 'approval:call-1' }),
      expect.objectContaining({ type: 'interaction.resolved', interactionId: 'approval:call-1', state: 'approved' }),
    ]));
    await runtime.close();
  });

  it('resolves questions and cancels unresolved requests during close', async () => {
    const fixture = createSessionFixture();
    const runtime = new SessionRuntime({
      session: fixture.session,
      mediaCacheDir: 'D:\\workspace\\.media-cache',
      emit: () => undefined,
      onRawEvent: () => undefined,
      onStateChanged: () => undefined,
      onSessionMetadataChanged: () => undefined,
    });
    await runtime.initialize();

    const answered = fixture.questionHandler?.({
      sessionId: 's1',
      agentId: 'main',
      toolCallId: 'question-1',
      questions: [],
    });
    runtime.resolveInteraction('question:question-1', { answer: 'yes' });
    await expect(answered).resolves.toEqual({ answer: 'yes' });

    const cancelled = fixture.approvalHandler?.({ toolCallId: 'call-2', action: 'Write file' } as ApprovalRequest);
    await runtime.close();
    await expect(cancelled).resolves.toEqual({ decision: 'cancelled' });
    expect(fixture.close).toHaveBeenCalledOnce();
  });

  it('persists a Team leader question and resolves its live turn from the channel answer', async () => {
    const fixture = createSessionFixture({ initialTeam: activeTeamSnapshot() });
    const notifications: KimiDesktopNotification[] = [];
    const runtime = new SessionRuntime({
      session: fixture.session,
      mediaCacheDir: 'D:\\workspace\\.media-cache',
      emit: (notification) => notifications.push(notification),
      onRawEvent: () => undefined,
      onStateChanged: () => undefined,
      onSessionMetadataChanged: () => undefined,
    });
    await runtime.initialize();
    const request: QuestionHandlerRequest = {
      sessionId: 's1',
      agentId: 'main',
      toolCallId: 'leader-question-1',
      questions: [{
        question: 'Continue after restart?',
        header: 'Recovery',
        options: [{ label: 'Continue' }, { label: 'Stop' }],
      }],
    };

    const result = fixture.questionHandler?.(request);
    await vi.waitFor(() => {
      expect(fixture.publishTeamUserQuestion).toHaveBeenCalledWith({
        questionId: 'leader-question-1',
        questions: request.questions,
      });
    });
    expect(notifications.some((notification) => notification.type === 'interaction.pending')).toBe(false);

    await runtime.answerTeamQuestion('leader-question-1', {
      'Continue after restart?': 'Continue',
    });

    await expect(result).resolves.toEqual({
      answers: { 'Continue after restart?': 'Continue' },
      method: 'enter',
    });
    expect(fixture.answerTeamUserQuestion).toHaveBeenCalledWith({
      questionId: 'leader-question-1',
      answers: { 'Continue after restart?': 'Continue' },
    });
    expect(notifications.some((notification) => notification.type === 'interaction.resolved')).toBe(false);
    await runtime.close();
  });

  it('answers a restored Team leader question without a process-local interaction', async () => {
    const fixture = createSessionFixture({ initialTeam: activeTeamSnapshot() });
    const runtime = createRuntime(fixture);
    await runtime.initialize();

    await expect(runtime.answerTeamQuestion('leader-question-restored', null)).resolves.toMatchObject({
      payload: { type: 'question_answer', dismissed: true },
    });
    expect(fixture.answerTeamUserQuestion).toHaveBeenCalledWith({
      questionId: 'leader-question-restored',
      answers: null,
    });
    await runtime.close();
  });

  it('publishes busy state immediately from main turn lifecycle events', async () => {
    const fixture = createSessionFixture();
    const notifications: KimiDesktopNotification[] = [];
    const runtime = new SessionRuntime({
      session: fixture.session,
      mediaCacheDir: 'D:\\workspace\\.media-cache',
      emit: (event) => notifications.push(event),
      onRawEvent: () => undefined,
      onStateChanged: () => undefined,
      onSessionMetadataChanged: () => undefined,
    });
    await runtime.initialize();

    fixture.emitEvent({ type: 'turn.started', sessionId: 's1', agentId: 'main', turnId: 1 } as Event);
    fixture.emitEvent({ type: 'turn.ended', sessionId: 's1', agentId: 'main', turnId: 1, reason: 'cancelled' } as Event);

    expect(notifications.filter((event) => event.type === 'session.status').slice(-2)).toEqual([
      expect.objectContaining({ type: 'session.status', status: expect.objectContaining({ busy: true }) }),
      expect.objectContaining({ type: 'session.status', status: expect.objectContaining({ busy: false }) }),
    ]);
    await runtime.close();
  });

  it('publishes, replaces, rejects stale, and locks the TodoList while an Agent runs', async () => {
    const initial = [{ title: 'Inspect runtime', status: 'pending' as const }];
    const fixture = createSessionFixture({ initialTodos: initial });
    const runtime = createRuntime(fixture);
    await runtime.initialize();

    expect(runtime.store.getAgent('main')?.getTodo('todo')?.items).toEqual(initial);
    const next = [{ title: 'Inspect runtime', status: 'in_progress' as const }];
    await runtime.replaceTodos(initial, next);
    expect(fixture.setTodos).toHaveBeenCalledWith(next);
    expect(runtime.store.getAgent('main')?.getTodo('todo')?.items).toEqual(next);

    await expect(runtime.replaceTodos(initial, [])).rejects.toMatchObject({
      code: 'task.todo_conflict',
    });

    fixture.emitEvent({ type: 'turn.started', sessionId: 's1', agentId: 'main', turnId: 1 } as Event);
    await expect(runtime.replaceTodos(next, [])).rejects.toMatchObject({
      code: 'task.todo_edit_busy',
    });
    await runtime.close();
  });

  it('restores nested agent descriptors without losing parent metadata on later events', async () => {
    const fixture = createSessionFixture({
      resumeState: {
        sessionMetadata: {
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          title: '',
          isCustomTitle: false,
          agents: {
            main: { type: 'main' },
            'agent-1': { type: 'sub', parentAgentId: 'main' },
            'agent-2': { type: 'sub', parentAgentId: 'agent-1' },
          },
          custom: {},
        },
        agents: {
          main: resumedAgent('main', 'Main Agent'),
          'agent-1': resumedAgent('sub', 'Explorer'),
          'agent-2': resumedAgent('sub', 'Reviewer'),
        },
      },
    });
    const runtime = new SessionRuntime({
      session: fixture.session,
      mediaCacheDir: 'D:\\workspace\\.media-cache',
      emit: () => undefined,
      onRawEvent: () => undefined,
      onStateChanged: () => undefined,
      onSessionMetadataChanged: () => undefined,
    });
    await runtime.initialize();

    fixture.emitEvent({
      type: 'agent.status.updated',
      sessionId: 's1',
      agentId: 'agent-2',
      phase: { kind: 'running', turnId: 1, step: 1, stepId: '', since: 1 },
    } as Event);

    expect(runtime.transcriptSnapshot().agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: 'agent-1', parentAgentId: 'main', label: 'Explorer' }),
      expect.objectContaining({ agentId: 'agent-2', parentAgentId: 'agent-1', label: 'Reviewer' }),
    ]));
    await runtime.close();
  });

  it('publishes title and last-prompt metadata immediately', async () => {
    const fixture = createSessionFixture();
    const changed = vi.fn();
    const runtime = new SessionRuntime({
      session: fixture.session,
      mediaCacheDir: 'D:\\workspace\\.media-cache',
      emit: () => undefined,
      onRawEvent: () => undefined,
      onStateChanged: () => undefined,
      onSessionMetadataChanged: changed,
    });
    await runtime.initialize();

    fixture.emitEvent({
      type: 'session.meta.updated',
      sessionId: 's1',
      agentId: 'main',
      title: 'Live title',
      patch: { lastPrompt: 'Latest prompt' },
    } as Event);

    expect(fixture.session.summary).toMatchObject({ title: 'Live title', lastPrompt: 'Latest prompt' });
    expect(changed).toHaveBeenCalledWith('s1', { title: 'Live title', lastPrompt: 'Latest prompt' });
    await runtime.close();
  });

  it('serializes concurrent plan changes and skips an already-satisfied target', async () => {
    const fixture = createSessionFixture();
    const runtime = createRuntime(fixture);
    await runtime.initialize();

    await Promise.all([runtime.setPlanMode(true), runtime.setPlanMode(true)]);

    expect(fixture.setPlanMode).toHaveBeenCalledOnce();
    expect(runtime.sessionStatus?.planMode).toBe(true);
    await runtime.close();
  });

  it('accepts a plan-mode conflict only when the refreshed state reached the target', async () => {
    const conflict = Object.assign(new Error('Already in plan mode'), { code: 'session.plan_mode_invalid' });
    const fixture = createSessionFixture({
      planMutation: async (enabled, update) => {
        update(enabled);
        throw conflict;
      },
    });
    const runtime = createRuntime(fixture);
    await runtime.initialize();

    await expect(runtime.setPlanMode(true)).resolves.toBeUndefined();
    expect(runtime.sessionStatus?.planMode).toBe(true);
    await runtime.close();
  });

  it('preserves a real plan-mode failure when the target state was not reached', async () => {
    const failure = Object.assign(new Error('Plan transition failed'), { code: 'session.plan_mode_invalid' });
    const fixture = createSessionFixture({ planMutation: async () => { throw failure; } });
    const runtime = createRuntime(fixture);
    await runtime.initialize();

    await expect(runtime.setPlanMode(true)).rejects.toBe(failure);
    expect(runtime.sessionStatus?.planMode).toBe(false);
    await runtime.close();
  });

  it('publishes a separate Team baseline and contiguous live operations', async () => {
    const initialTeam: TeamSnapshot = {
      protocolVersion: 2,
      state: 'ready',
      team: { id: 'team-1', sessionId: 's1', channelId: 'general', leaderAgentId: 'main', createdAt: 1 },
      members: [{ agentId: 'main', role: 'leader', joinedAt: 1, joinedSeq: 1 }],
      batches: [],
      tasks: [],
      assignments: [],
      attempts: [],
      artifacts: [],
      reviews: [],
      policy: {
        maxConcurrency: 4,
        maxMembers: 16,
        maxDelegationDepth: 2,
        executionRetries: 1,
        validationRetries: 2,
      },
      scheduler: { status: 'running', activeCount: 0, queuedCount: 0, updatedAt: 1 },
      budget: { startedAt: 1, inputTokens: 0, outputTokens: 0, totalTokens: 0, elapsedMs: 0 },
      integration: { status: 'idle', updatedAt: 1 },
      latestSeq: 1,
      latestChannelSeq: 0,
    };
    const fixture = createSessionFixture({ initialTeam });
    const notifications: KimiDesktopNotification[] = [];
    const runtime = new SessionRuntime({
      session: fixture.session,
      mediaCacheDir: 'D:\\workspace\\.media-cache',
      emit: (notification) => notifications.push(notification),
      onRawEvent: () => undefined,
      onStateChanged: () => undefined,
      onSessionMetadataChanged: () => undefined,
    });
    await runtime.initialize();

    fixture.emitTeamOperation({
      version: 2,
      operationId: 'op-2',
      type: 'message.sent',
      seq: 2,
      at: 2,
      message: {
        id: 'm1', teamId: 'team-1', channelId: 'general', seq: 2, channelSeq: 1,
        sender: { actorKind: 'user', actorId: 'desktop-user', role: 'user' },
        body: 'Proceed', clientMessageId: 'client-1', createdAt: 2,
      },
    });

    await vi.waitFor(() => expect(runtime.teamState?.snapshot.latestSeq).toBe(2));
    expect(runtime.teamState?.messages.at(-1)?.body).toBe('Proceed');
    expect(notifications).toContainEqual(expect.objectContaining({
      type: 'team.ops', sessionId: 's1', operations: [expect.objectContaining({ seq: 2 })],
    }));
    await runtime.close();
  });

  it('initializes Team state explicitly and publishes the reset baseline', async () => {
    const fixture = createSessionFixture();
    const notifications: KimiDesktopNotification[] = [];
    const detected = vi.fn();
    const runtime = new SessionRuntime({
      session: fixture.session,
      mediaCacheDir: 'D:\\workspace\\.media-cache',
      emit: (notification) => notifications.push(notification),
      onRawEvent: () => undefined,
      onStateChanged: () => undefined,
      onSessionMetadataChanged: () => undefined,
      onTeamDetected: detected,
    });
    await runtime.initialize();

    const snapshot = await runtime.ensureTeam();

    expect(fixture.ensureTeam).toHaveBeenCalledOnce();
    expect(detected).toHaveBeenCalledOnce();
    expect(snapshot.team?.id).toBe('team-1');
    expect(notifications).toContainEqual(expect.objectContaining({
      type: 'team.reset',
      sessionId: 's1',
      state: expect.objectContaining({ snapshot: expect.objectContaining({ team: expect.any(Object) }) }),
    }));
    await runtime.close();
  });

  it('posts a Team message once and relies on automatic delivery while the leader is idle', async () => {
    const fixture = createSessionFixture();
    const runtime = createRuntime(fixture);
    await runtime.initialize();

    const media = [{
      type: 'image_url' as const,
      url: 'data:image/png;base64,iVBORw0KGgo=',
      displayUrl: 'file:///cache/desktop-media/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.png',
      name: 'diagram.png',
    }];
    const first = runtime.submitTeamMessage('Coordinate the implementation', 'client-1', media);
    const retry = runtime.submitTeamMessage('Coordinate the implementation', 'client-1', media);

    await expect(first).resolves.toMatchObject({ wake: 'automatic', message: { channelSeq: 1 } });
    await expect(retry).resolves.toMatchObject({ wake: 'automatic', message: { channelSeq: 1 } });
    expect(fixture.sendTeamMessage).toHaveBeenCalledOnce();
    expect(fixture.sendTeamMessage).toHaveBeenCalledWith({
      body: 'Coordinate the implementation',
      clientMessageId: 'client-1',
      attachments: [{
        type: 'image_url',
        url: media[0]!.displayUrl,
        name: 'diagram.png',
      }],
      modelAttachments: [{
        type: 'image_url',
        url: media[0]!.url,
      }],
    });
    expect(fixture.swarm).not.toHaveBeenCalled();
    expect(fixture.steer).not.toHaveBeenCalled();
    expect(() => runtime.submitTeamMessage('A different message', 'client-1')).toThrow(
      /reused with different content/,
    );
    expect(() => runtime.submitTeamMessage('Coordinate the implementation', 'client-1', [{
      ...media[0]!,
      name: 'other.png',
    }])).toThrow(
      /reused with different content/,
    );
    await runtime.close();
  });

  it('relies on automatic delivery while the leader is busy', async () => {
    const fixture = createSessionFixture();
    const runtime = createRuntime(fixture);
    await runtime.initialize();
    fixture.emitEvent({ type: 'turn.started', sessionId: 's1', agentId: 'main', turnId: 1 } as Event);

    await expect(runtime.submitTeamMessage('New priority', 'client-2', [], ['agent-2'])).resolves.toMatchObject({
      wake: 'automatic',
    });
    expect(fixture.sendTeamMessage).toHaveBeenCalledWith(expect.objectContaining({
      recipientAgentIds: ['agent-2'],
    }));
    expect(fixture.steer).not.toHaveBeenCalled();
    expect(fixture.swarm).not.toHaveBeenCalled();
    await runtime.close();
  });
});

interface SessionFixtureOptions {
  readonly resumeState?: unknown;
  readonly initialPlanMode?: boolean;
  readonly initialTodos?: readonly TodoItem[];
  readonly planMutation?: (
    enabled: boolean,
    update: (enabled: boolean) => void,
  ) => Promise<void>;
  readonly initialTeam?: TeamSnapshot;
}

function createSessionFixture(options: SessionFixtureOptions = {}): {
  readonly session: Session;
  readonly close: ReturnType<typeof vi.fn>;
  readonly setPlanMode: ReturnType<typeof vi.fn>;
  readonly setTodos: ReturnType<typeof vi.fn>;
  readonly ensureTeam: ReturnType<typeof vi.fn>;
  readonly sendTeamMessage: ReturnType<typeof vi.fn>;
  readonly publishTeamUserQuestion: ReturnType<typeof vi.fn>;
  readonly answerTeamUserQuestion: ReturnType<typeof vi.fn>;
  readonly swarm: ReturnType<typeof vi.fn>;
  readonly steer: ReturnType<typeof vi.fn>;
  readonly emitEvent: (event: Event) => void;
  readonly emitTeamOperation: (operation: TeamOperation) => void;
  readonly approvalHandler?: ApprovalHandler;
  readonly questionHandler?: QuestionHandler;
} {
  let approvalHandler: ApprovalHandler | undefined;
  let questionHandler: QuestionHandler | undefined;
  let eventHandler: ((event: Event) => void) | undefined;
  let todoHandler: ((todos: readonly TodoItem[]) => void) | undefined;
  let teamHandler: ((operation: TeamOperation) => void) | undefined;
  let planMode = options.initialPlanMode ?? false;
  let todos = options.initialTodos ?? [];
  const close = vi.fn(async () => undefined);
  const setPlanMode = vi.fn(async (enabled: boolean) => {
    if (options.planMutation !== undefined) {
      await options.planMutation(enabled, (next) => { planMode = next; });
      return;
    }
    planMode = enabled;
  });
  const setTodos = vi.fn(async (next: readonly TodoItem[]) => {
    todos = next.map((todo) => ({ ...todo }));
    todoHandler?.(todos);
  });
  const ensuredTeam: TeamSnapshot = options.initialTeam ?? {
    protocolVersion: 2,
    state: 'ready',
    team: { id: 'team-1', sessionId: 's1', channelId: 'general', leaderAgentId: 'main', createdAt: 1 },
    members: [{ agentId: 'main', role: 'leader', joinedAt: 1, joinedSeq: 1 }],
    batches: [],
    tasks: [],
    assignments: [],
    attempts: [],
    artifacts: [],
    reviews: [],
    policy: {
      maxConcurrency: 4,
      maxMembers: 16,
      maxDelegationDepth: 2,
      executionRetries: 1,
      validationRetries: 2,
    },
    scheduler: { status: 'running', activeCount: 0, queuedCount: 0, updatedAt: 1 },
    budget: { startedAt: 1, inputTokens: 0, outputTokens: 0, totalTokens: 0, elapsedMs: 0 },
    integration: { status: 'idle', updatedAt: 1 },
    latestSeq: 1,
    latestChannelSeq: 0,
  };
  const ensureTeam = vi.fn(async () => ensuredTeam);
  const sendTeamMessage = vi.fn(async ({ body, clientMessageId, attachments, recipientAgentIds }: {
    readonly body: string;
    readonly clientMessageId: string;
    readonly attachments?: readonly {
      readonly type: 'image_url';
      readonly url: string;
      readonly name?: string;
    }[];
    readonly modelAttachments?: readonly {
      readonly type: 'image_url';
      readonly url: string;
    }[];
    readonly recipientAgentIds?: readonly string[];
  }) => ({
    id: `message-${clientMessageId}`,
    teamId: ensuredTeam.team?.id ?? 'team-1',
    channelId: ensuredTeam.team?.channelId ?? 'general',
    seq: ensuredTeam.latestSeq + 1,
    channelSeq: 1,
    sender: { actorKind: 'user' as const, actorId: 'desktop-user', role: 'user' as const },
    recipientAgentIds,
    body,
    attachments,
    clientMessageId,
    createdAt: 2,
  }));
  const publishTeamUserQuestion = vi.fn(async ({ questionId, questions }: {
    readonly questionId: string;
    readonly questions: QuestionRequest['questions'];
  }) => ({
    id: `question-${questionId}`,
    teamId: ensuredTeam.team?.id ?? 'team-1',
    channelId: 'general' as const,
    seq: ensuredTeam.latestSeq + 1,
    channelSeq: 1,
    sender: { actorKind: 'agent' as const, actorId: 'main', role: 'leader' as const },
    recipientAgentIds: ['main'],
    body: 'Leader question',
    payload: { type: 'question' as const, questionId, questions },
    clientMessageId: `user-question:${questionId}`,
    createdAt: 2,
  }));
  const answerTeamUserQuestion = vi.fn(async ({ questionId, answers }: {
    readonly questionId: string;
    readonly answers: TeamQuestionAnswers | null;
  }) => ({
    id: `answer-${questionId}`,
    teamId: ensuredTeam.team?.id ?? 'team-1',
    channelId: 'general' as const,
    seq: ensuredTeam.latestSeq + 2,
    channelSeq: 2,
    sender: { actorKind: 'user' as const, actorId: 'desktop-user', role: 'user' as const },
    recipientAgentIds: ['main'],
    body: answers === null ? 'Skipped' : 'Answered',
    payload: {
      type: 'question_answer' as const,
      questionId,
      answers: answers ?? {},
      dismissed: answers === null ? true as const : undefined,
    },
    clientMessageId: `user-question-answer:${questionId}`,
    createdAt: 3,
  }));
  const swarm = vi.fn(async () => undefined);
  const steer = vi.fn(async () => undefined);
  const session = {
    id: 's1',
    summary: { id: 's1', workDir: 'D:\\workspace', additionalDirs: [] },
    onEvent: (handler: (event: Event) => void) => {
      eventHandler = handler;
      return () => { eventHandler = undefined; };
    },
    onTodosChanged: (handler: (next: readonly TodoItem[]) => void) => {
      todoHandler = handler;
      return () => { todoHandler = undefined; };
    },
    onTeamOperation: (handler: (operation: TeamOperation) => void) => {
      teamHandler = handler;
      return () => { teamHandler = undefined; };
    },
    ensureTeam,
    getTeamSnapshot: async () => options.initialTeam ?? ({
      protocolVersion: 2,
      state: 'ready',
      members: [],
      batches: [],
      tasks: [],
      assignments: [],
      attempts: [],
      artifacts: [],
      reviews: [],
      policy: {
        maxConcurrency: 4,
        maxMembers: 16,
        maxDelegationDepth: 2,
        executionRetries: 1,
        validationRetries: 2,
      },
      scheduler: { status: 'running', activeCount: 0, queuedCount: 0, updatedAt: 1 },
      budget: { startedAt: 1, inputTokens: 0, outputTokens: 0, totalTokens: 0, elapsedMs: 0 },
      integration: { status: 'idle', updatedAt: 1 },
      latestSeq: 0,
      latestChannelSeq: 0,
    }),
    getTeamHistory: async () => [],
    getTeamOperations: async ({ afterSeq }: { readonly afterSeq: number }) => [],
    sendTeamMessage,
    publishTeamUserQuestion,
    answerTeamUserQuestion,
    getTodos: async () => todos,
    setTodos,
    setApprovalHandler: (handler?: ApprovalHandler) => { approvalHandler = handler; },
    setQuestionHandler: (handler?: QuestionHandler) => { questionHandler = handler; },
    getResumeState: () => options.resumeState,
    getStatus: async () => ({ model: 'kimi-test', thinkingEffort: 'off', permission: 'manual', planMode, contextTokens: 0, maxContextTokens: 0, contextUsage: 0 }),
    setPlanMode,
    getPlan: async () => null,
    listBackgroundTasks: async () => [],
    getGoal: async () => null,
    getCronTasks: async () => ({ tasks: [] }),
    getContext: async () => ({ tokenCount: 0, history: [] }),
    swarm,
    steer,
    listSkills: async () => [],
    listPluginCommands: async () => [],
    listCommands: async () => [],
    listMcpServers: async () => [],
    getMcpStartupMetrics: async () => ({ durationMs: 0 }),
    close,
  } as unknown as Session;
  return {
    session,
    close,
    setPlanMode,
    setTodos,
    ensureTeam,
    sendTeamMessage,
    publishTeamUserQuestion,
    answerTeamUserQuestion,
    swarm,
    steer,
    emitEvent: (event) => eventHandler?.(event),
    emitTeamOperation: (operation) => teamHandler?.(operation),
    get approvalHandler() { return approvalHandler; },
    get questionHandler() { return questionHandler; },
  };
}

function activeTeamSnapshot(): TeamSnapshot {
  return {
    protocolVersion: 2,
    state: 'ready',
    team: { id: 'team-1', sessionId: 's1', channelId: 'general', leaderAgentId: 'main', createdAt: 1 },
    members: [{ agentId: 'main', role: 'leader', joinedAt: 1, joinedSeq: 1 }],
    batches: [],
    tasks: [],
    assignments: [],
    attempts: [],
    artifacts: [],
    reviews: [],
    policy: {
      maxConcurrency: 4,
      maxMembers: 16,
      maxDelegationDepth: 2,
      executionRetries: 1,
      validationRetries: 2,
    },
    scheduler: { status: 'running', activeCount: 0, queuedCount: 0, updatedAt: 1 },
    budget: { startedAt: 1, inputTokens: 0, outputTokens: 0, totalTokens: 0, elapsedMs: 0 },
    integration: { status: 'idle', updatedAt: 1 },
    latestSeq: 1,
    latestChannelSeq: 0,
  };
}

function createRuntime(fixture: ReturnType<typeof createSessionFixture>): SessionRuntime {
  return new SessionRuntime({
    session: fixture.session,
    mediaCacheDir: 'D:\\workspace\\.media-cache',
    emit: () => undefined,
    onRawEvent: () => undefined,
    onStateChanged: () => undefined,
    onSessionMetadataChanged: () => undefined,
  });
}

function resumedAgent(type: 'main' | 'sub', profileName: string): unknown {
  return {
    type,
    config: { profileName, thinkingEffort: 'off' },
    context: { history: [], tokenCount: 0 },
    replay: [],
    permission: { mode: 'manual' },
    plan: null,
    usage: {},
    tools: [],
    background: [],
  };
}
