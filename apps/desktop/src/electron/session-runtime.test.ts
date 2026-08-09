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
});

function createSessionFixture(): {
  readonly session: Session;
  readonly close: ReturnType<typeof vi.fn>;
  readonly emitEvent: (event: Event) => void;
  readonly approvalHandler?: ApprovalHandler;
  readonly questionHandler?: QuestionHandler;
} {
  let approvalHandler: ApprovalHandler | undefined;
  let questionHandler: QuestionHandler | undefined;
  let eventHandler: ((event: Event) => void) | undefined;
  const close = vi.fn(async () => undefined);
  const session = {
    id: 's1',
    summary: { id: 's1', workDir: 'D:\\workspace', additionalDirs: [] },
    onEvent: (handler: (event: Event) => void) => {
      eventHandler = handler;
      return () => { eventHandler = undefined; };
    },
    setApprovalHandler: (handler?: ApprovalHandler) => { approvalHandler = handler; },
    setQuestionHandler: (handler?: QuestionHandler) => { questionHandler = handler; },
    getResumeState: () => undefined,
    getStatus: async () => ({ model: 'kimi-test', thinkingEffort: 'off', permission: 'manual', planMode: false, contextTokens: 0, maxContextTokens: 0, contextUsage: 0 }),
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
    emitEvent: (event) => eventHandler?.(event),
    get approvalHandler() { return approvalHandler; },
    get questionHandler() { return questionHandler; },
  };
}
