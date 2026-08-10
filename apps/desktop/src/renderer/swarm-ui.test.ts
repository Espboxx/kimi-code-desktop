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

import {
  agentActivityLabel,
  buildAgentActivityForest,
} from './agent-activity';
import {
  collectTeamAgentActivities,
  collectPendingAgentInteractions,
  interactionSummary,
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
