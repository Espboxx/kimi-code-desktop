/**
 * Scenario: renderer multi-agent coordination helpers.
 * Responsibilities: pending child interaction selection and agent activity projection.
 * Wiring: real TranscriptStore and transcript operations; no external stubs.
 * Run: pnpm --filter @moonshot-ai/kimi-code-desktop test
 */
import {
  TranscriptStore,
  type TranscriptInteraction,
  type TranscriptOperation,
} from '@moonshot-ai/transcript';
import { describe, expect, it } from 'vitest';

import type { TeamAssignment, TeamMessage, TeamSchedulerState } from '../shared/desktop-api';
import {
  agentActivityLabel,
  buildAgentActivityForest,
} from './agent-activity';
import {
  buildTeamBadge,
  collectTeamAgentActivities,
  collectPendingLeaderQuestions,
  collectPendingAgentInteractions,
  interactionSummary,
  mergePendingLeaderQuestionActivity,
  resolveTeamLeaderStatus,
} from './swarm-ui';

describe('multi-agent UI coordination', () => {
  it('returns pending interactions from the selected agent before main and other agents', () => {
    const store = transcriptFixture();

    expect(collectPendingAgentInteractions(store, 'main').map((item) => item.key)).toEqual([
      'main:approval:main',
      'agent-1:approval:a1',
      'agent-2:question:q1',
    ]);
    expect(collectPendingAgentInteractions(store, 'agent-1').map((item) => item.key)).toEqual([
      'agent-1:approval:a1',
      'main:approval:main',
      'agent-2:question:q1',
    ]);
  });

  it('preserves roster order and per-agent interaction insertion order', () => {
    const store = new TranscriptStore('s1');
    const agent = store.ensureAgent('agent-1', { agentId: 'agent-1', type: 'sub', label: 'Agent 1' });
    agent.apply([
      upsert({ interactionId: 'approval:first', interactionKind: 'approval', state: 'pending' }),
      upsert({ interactionId: 'approval:second', interactionKind: 'approval', state: 'pending' }),
    ]);

    expect(collectPendingAgentInteractions(store, 'main').map((item) => item.interaction.interactionId)).toEqual([
      'approval:first',
      'approval:second',
    ]);
  });

  it('summarizes an approval from its requested action', () => {
    expect(interactionSummary({
      interactionId: 'approval:a1',
      interactionKind: 'approval',
      state: 'pending',
      request: { action: 'Write sample.txt' },
    })).toBe('Write sample.txt');
  });

  it('summarizes a question from its first prompt', () => {
    expect(interactionSummary({
      interactionId: 'question:q1',
      interactionKind: 'question',
      state: 'pending',
      request: { questions: [{ question: 'Choose a target' }] },
    })).toBe('Choose a target');
  });
});

describe('Agent activity view model', () => {
  it('builds a recursive tree and isolates missing or cyclic relationships', () => {
    const store = new TranscriptStore('s1');
    store.ensureAgent('main', { agentId: 'main', type: 'main', label: 'Main Agent' });
    store.ensureAgent('agent-1', { agentId: 'agent-1', type: 'sub', parentAgentId: 'main' });
    store.ensureAgent('agent-2', { agentId: 'agent-2', type: 'sub', parentAgentId: 'agent-1' });
    store.ensureAgent('orphan', { agentId: 'orphan', type: 'sub', parentAgentId: 'missing' });
    store.ensureAgent('cycle-a', { agentId: 'cycle-a', type: 'sub', parentAgentId: 'cycle-b' });
    store.ensureAgent('cycle-b', { agentId: 'cycle-b', type: 'sub', parentAgentId: 'cycle-a' });

    const forest = buildAgentActivityForest(store);

    expect(forest.roots).toHaveLength(1);
    expect(forest.roots[0]?.agent.agentId).toBe('main');
    expect(forest.roots[0]?.children[0]?.agent.agentId).toBe('agent-1');
    expect(forest.roots[0]?.children[0]?.children[0]?.agent.agentId).toBe('agent-2');
    expect(forest.unattached.map((node) => node.agent.agentId)).toEqual(['cycle-a', 'cycle-b', 'orphan']);
  });

  it('keeps a completed child terminal when its phase later reports idle', () => {
    const store = new TranscriptStore('s1');
    const main = store.ensureAgent('main', { agentId: 'main', type: 'main', label: 'Main Agent' });
    const child = store.ensureAgent('agent-1', {
      agentId: 'agent-1',
      type: 'sub',
      parentAgentId: 'main',
      label: 'Explorer',
    });
    main.apply([{
      op: 'task.upsert',
      task: {
        taskId: 'agent-agent-1',
        kind: 'subagent',
        state: 'completed',
        detached: false,
        agentId: 'agent-1',
        outputTail: '',
        startedAt: new Date(10).toISOString(),
        endedAt: new Date(20).toISOString(),
      },
    }]);
    child.apply([{ op: 'meta.merge', meta: { agent: { phase: { kind: 'idle' } } } }]);

    const node = buildAgentActivityForest(store).byId.get('agent-1');

    expect(node?.status).toBe('completed');
    expect(agentActivityLabel(node?.status ?? 'idle')).toBe('已完成（保留）');
  });

  it('prioritizes pending interaction and active work over older terminal tasks', () => {
    const store = new TranscriptStore('s1');
    const main = store.ensureAgent('main', { agentId: 'main', type: 'main' });
    const child = store.ensureAgent('agent-1', { agentId: 'agent-1', type: 'sub', parentAgentId: 'main' });
    main.apply([{
      op: 'task.upsert',
      task: { taskId: 'agent-agent-1', kind: 'subagent', state: 'completed', detached: false, agentId: 'agent-1', outputTail: '' },
    }]);
    child.apply([
      { op: 'meta.merge', meta: { agent: { phase: { kind: 'running', turnId: 2, step: 1, stepId: '', since: 1 } } } },
      upsert({ interactionId: 'approval:next', interactionKind: 'approval', state: 'pending' }),
    ]);

    const node = buildAgentActivityForest(store).byId.get('agent-1');

    expect(node?.status).toBe('waiting');
    expect(node?.action).toBe('等待权限确认');
    expect(buildAgentActivityForest(store).roots[0]?.counts.waiting).toBe(1);
  });

  it('returns active Team members in roster order with their current actions', () => {
    const store = new TranscriptStore('s1');
    const main = store.ensureAgent('main', { agentId: 'main', type: 'main' });
    const worker = store.ensureAgent('agent-1', { agentId: 'agent-1', type: 'sub', parentAgentId: 'main' });
    const completed = store.ensureAgent('agent-2', { agentId: 'agent-2', type: 'sub', parentAgentId: 'main' });
    main.apply([upsert({ interactionId: 'approval:main', interactionKind: 'approval', state: 'pending' })]);
    worker.apply([{
      op: 'meta.merge',
      meta: { agent: { phase: { kind: 'streaming', turnId: 1, step: 1, stepId: '1.1', stream: 'assistant', since: 1 } } },
    }]);
    completed.apply([{
      op: 'meta.merge',
      meta: { agent: { phase: { kind: 'ended', turnId: 1, reason: 'completed', at: 2 } } },
    }]);

    expect(collectTeamAgentActivities(buildAgentActivityForest(store), [
      { agentId: 'main', role: 'leader', joinedAt: 1, joinedSeq: 1 },
      { agentId: 'agent-2', role: 'member', joinedAt: 2, joinedSeq: 2 },
      { agentId: 'agent-1', role: 'member', joinedAt: 3, joinedSeq: 3 },
    ])).toEqual([
      { agentId: 'main', status: 'waiting', action: '等待权限确认' },
      { agentId: 'agent-1', status: 'running', action: '生成回复' },
    ]);
  });
});

describe('Team runtime status view model', () => {
  it('counts only executing assignments as running and keeps ready work waiting', () => {
    expect(buildTeamBadge([
      assignment('ready', 'ready'),
      assignment('running', 'running', 'worker-1'),
      assignment('validating', 'awaiting_validation', 'worker-2'),
      assignment('blocked', 'blocked'),
      assignment('failed', 'failed', 'worker-3'),
    ], 2)).toEqual({ unread: 2, running: 2, waiting: 2, failed: 1 });
  });

  it('prioritizes a durable leader question over live execution', () => {
    const pendingQuestion = collectPendingLeaderQuestions([
      teamQuestionMessage('leader-question-1', 'main', 1),
    ], 'main')[0];

    expect(resolveTeamLeaderStatus({
      leaderAgentId: 'main',
      busy: true,
      pendingQuestion,
      assignments: [],
      scheduler: scheduler('running'),
      snapshotState: 'ready',
      activeBatchCount: 0,
      hasInProgressPlan: true,
    })).toMatchObject({ state: 'waiting_user', label: '等待回答', action: '等待回答：Continue?' });
  });

  it('uses the live leader action while busy and a deterministic fallback before activity arrives', () => {
    const store = new TranscriptStore('s1');
    const main = store.ensureAgent('main', { agentId: 'main', type: 'main' });
    main.apply([{
      op: 'meta.merge',
      meta: { agent: { phase: { kind: 'streaming', turnId: 1, step: 1, stepId: '1.1', stream: 'thinking', since: 1 } } },
    }]);
    const base = {
      leaderAgentId: 'main',
      busy: true,
      assignments: [],
      scheduler: scheduler('running'),
      snapshotState: 'ready' as const,
      activeBatchCount: 0,
      hasInProgressPlan: true,
    };

    expect(resolveTeamLeaderStatus({ ...base, activity: buildAgentActivityForest(store) }))
      .toMatchObject({ state: 'running', label: '运行中', action: 'Thinking' });
    expect(resolveTeamLeaderStatus(base))
      .toMatchObject({ state: 'running', label: '运行中', action: '正在处理团队任务' });
  });

  it('shows the leader waiting when a direct child agent remains active', () => {
    const store = new TranscriptStore('s1');
    store.ensureAgent('main', { agentId: 'main', type: 'main' });
    const child = store.ensureAgent('agent-1', {
      agentId: 'agent-1',
      type: 'sub',
      parentAgentId: 'main',
      label: 'Coder',
    });
    child.apply([{
      op: 'meta.merge',
      meta: { agent: { phase: { kind: 'running', turnId: 1, step: 1, stepId: '1.1', since: 1 } } },
    }]);

    expect(resolveTeamLeaderStatus({
      leaderAgentId: 'main',
      activity: buildAgentActivityForest(store),
      busy: false,
      assignments: [],
      scheduler: scheduler('running'),
      snapshotState: 'ready',
      activeBatchCount: 0,
      hasInProgressPlan: true,
    })).toMatchObject({ state: 'waiting_children', label: '等待子代理' });
  });

  it('reproduces a paused Team with one ready task without claiming it is running', () => {
    const status = resolveTeamLeaderStatus({
      leaderAgentId: 'main',
      busy: false,
      assignments: [assignment('probe', 'ready')],
      scheduler: scheduler('paused', 0, 1),
      snapshotState: 'ready',
      activeBatchCount: 0,
      hasInProgressPlan: true,
    });

    expect(status).toEqual({
      state: 'paused',
      tone: 'paused',
      label: '已暂停',
      action: '调度已暂停，1 个子任务等待继续',
    });
    expect(buildTeamBadge([assignment('probe', 'ready')], 0).running).toBe(0);
  });

  it('states explicitly when the plan is still active but no runtime work exists', () => {
    expect(resolveTeamLeaderStatus({
      leaderAgentId: 'main',
      busy: false,
      assignments: [],
      scheduler: scheduler('running'),
      snapshotState: 'ready',
      activeBatchCount: 0,
      hasInProgressPlan: true,
    })).toEqual({
      state: 'idle',
      tone: 'idle',
      label: '空闲',
      action: '计划尚未完成，当前没有运行中的工作',
    });
  });
});

describe('Team leader question recovery', () => {
  it('returns only unanswered questions published by the Team leader', () => {
    const messages: TeamMessage[] = [
      teamQuestionMessage('leader-question-1', 'main', 1),
      teamQuestionMessage('member-question-1', 'agent-1', 2),
      teamQuestionMessage('leader-question-2', 'main', 3),
      teamAnswerMessage('leader-question-1', 4),
    ];

    expect(collectPendingLeaderQuestions(messages, 'main').map((item) => item.questionId)).toEqual([
      'leader-question-2',
    ]);
  });

  it('keeps the leader visible as waiting when a durable question is pending', () => {
    const pending = collectPendingLeaderQuestions([
      teamQuestionMessage('leader-question-1', 'main', 1),
    ], 'main')[0];

    expect(mergePendingLeaderQuestionActivity([
      { agentId: 'agent-1', status: 'running', action: '执行工具 Bash' },
    ], 'main', pending)).toEqual([
      { agentId: 'main', status: 'waiting', action: '等待回答：Continue?' },
      { agentId: 'agent-1', status: 'running', action: '执行工具 Bash' },
    ]);
  });
});

function transcriptFixture(): TranscriptStore {
  const store = new TranscriptStore('s1');
  const main = store.ensureAgent('main', { agentId: 'main', type: 'main', label: 'Main Agent' });
  const first = store.ensureAgent('agent-1', { agentId: 'agent-1', type: 'sub', label: 'Agent 1' });
  const second = store.ensureAgent('agent-2', { agentId: 'agent-2', type: 'sub', label: 'Agent 2' });
  main.apply([upsert({ interactionId: 'approval:main', interactionKind: 'approval', state: 'pending' })]);
  first.apply([
    upsert({ interactionId: 'approval:a1', interactionKind: 'approval', state: 'pending' }),
    upsert({ interactionId: 'approval:done', interactionKind: 'approval', state: 'approved' }),
  ]);
  second.apply([upsert({ interactionId: 'question:q1', interactionKind: 'question', state: 'pending' })]);
  return store;
}

function upsert(interaction: TranscriptInteraction): TranscriptOperation {
  return { op: 'interaction.upsert', interaction };
}

function assignment(
  id: string,
  status: Exclude<TeamAssignment['status'], 'queued'>,
  agentId?: string,
): TeamAssignment {
  return {
    id,
    taskKey: id,
    batchId: 'batch-1',
    dependsOn: [],
    delegationDepth: 1,
    agentId,
    profileName: 'worker',
    description: `Task ${id}`,
    promptRef: `artifact://team/prompts/${id}`,
    workspaceMode: 'shared_readonly',
    validationMode: 'none',
    status,
    artifactIds: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

function scheduler(
  status: TeamSchedulerState['status'],
  activeCount = 0,
  queuedCount = 0,
): TeamSchedulerState {
  return { status, activeCount, queuedCount, updatedAt: 1 };
}

function teamQuestionMessage(questionId: string, agentId: string, seq: number): TeamMessage {
  return {
    id: `message-${String(seq)}`,
    teamId: 'team-1',
    channelId: 'general',
    seq,
    channelSeq: seq,
    sender: {
      actorKind: 'agent',
      actorId: agentId,
      role: agentId === 'main' ? 'leader' : 'member',
    },
    recipientAgentIds: ['main'],
    body: 'Question',
    payload: {
      type: 'question',
      questionId,
      questions: [{
        question: 'Continue?',
        options: [{ label: 'Continue' }, { label: 'Stop' }],
      }],
    },
    clientMessageId: `question:${questionId}`,
    createdAt: seq,
  };
}

function teamAnswerMessage(questionId: string, seq: number): TeamMessage {
  return {
    id: `message-${String(seq)}`,
    teamId: 'team-1',
    channelId: 'general',
    seq,
    channelSeq: seq,
    sender: { actorKind: 'user', actorId: 'desktop-user', role: 'user' },
    recipientAgentIds: ['main'],
    body: 'Answer',
    payload: {
      type: 'question_answer',
      questionId,
      answers: { 'Continue?': 'Continue' },
    },
    clientMessageId: `answer:${questionId}`,
    createdAt: seq,
  };
}
