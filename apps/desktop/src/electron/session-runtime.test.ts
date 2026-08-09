import type {
  ApprovalHandler,
  ApprovalRequest,
  Event,
  QuestionHandler,
  QuestionRequest,
  Session,
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
    expect(batches.map((event) => event.type === 'transcript.ops' ? event.batch.seq : 0)).toEqual([1, 2]);
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

    const answered = fixture.questionHandler?.({ toolCallId: 'question-1', questions: [] } as unknown as QuestionRequest);
    runtime.resolveInteraction('question:question-1', { answer: 'yes' });
    await expect(answered).resolves.toEqual({ answer: 'yes' });

    const cancelled = fixture.approvalHandler?.({ toolCallId: 'call-2', action: 'Write file' } as ApprovalRequest);
    await runtime.close();
    await expect(cancelled).resolves.toEqual({ decision: 'cancelled' });
    expect(fixture.close).toHaveBeenCalledOnce();
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
});

interface SessionFixtureOptions {
  readonly resumeState?: unknown;
  readonly initialPlanMode?: boolean;
  readonly planMutation?: (
    enabled: boolean,
    update: (enabled: boolean) => void,
  ) => Promise<void>;
}

function createSessionFixture(options: SessionFixtureOptions = {}): {
  readonly session: Session;
  readonly close: ReturnType<typeof vi.fn>;
  readonly setPlanMode: ReturnType<typeof vi.fn>;
  readonly emitEvent: (event: Event) => void;
  readonly approvalHandler?: ApprovalHandler;
  readonly questionHandler?: QuestionHandler;
} {
  let approvalHandler: ApprovalHandler | undefined;
  let questionHandler: QuestionHandler | undefined;
  let eventHandler: ((event: Event) => void) | undefined;
  let planMode = options.initialPlanMode ?? false;
  const close = vi.fn(async () => undefined);
  const setPlanMode = vi.fn(async (enabled: boolean) => {
    if (options.planMutation !== undefined) {
      await options.planMutation(enabled, (next) => { planMode = next; });
      return;
    }
    planMode = enabled;
  });
  const session = {
    id: 's1',
    summary: { id: 's1', workDir: 'D:\\workspace', additionalDirs: [] },
    onEvent: (handler: (event: Event) => void) => {
      eventHandler = handler;
      return () => { eventHandler = undefined; };
    },
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
    emitEvent: (event) => eventHandler?.(event),
    get approvalHandler() { return approvalHandler; },
    get questionHandler() { return questionHandler; },
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
