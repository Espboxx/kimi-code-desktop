// Scenario: renderer Todo view models for one session and its Team projection.
// Responsibilities: preserve authoritative order, map statuses, and expose explicit Team ownership.
// Wiring: pure view-model functions with literal Todo, member, and assignment fixtures.
// Run: pnpm --filter @moonshot-ai/kimi-code-desktop test -- todo-list.test.ts
import { describe, expect, it } from 'vitest';

import type { TeamAssignment, TeamMember } from '../shared/desktop-api';
import {
  buildTeamTodoEntries,
  countTeamTodos,
  nextTodoStatus,
  partitionTeamTodos,
  partitionTodos,
  removeTodo,
  replaceTodo,
} from './todo-list';

const todos = [
  { title: 'Running', status: 'in_progress' as const },
  { title: 'Pending', status: 'pending' as const },
  { title: 'Done', status: 'done' as const },
  { title: 'Pending two', status: 'pending' as const },
];

const members: readonly TeamMember[] = [
  { agentId: 'main', displayName: '协调组长', role: 'leader', joinedAt: 1, joinedSeq: 1 },
  { agentId: 'worker-1', displayName: '构建代理', role: 'member', parentAgentId: 'main', joinedAt: 2, joinedSeq: 2 },
];

const assignments: readonly TeamAssignment[] = [
  {
    id: 'task-running',
    batchId: 'batch-1',
    agentId: 'worker-1',
    profileName: 'builder',
    description: 'Shared title',
    status: 'running',
    createdAt: 3,
    updatedAt: 4,
  },
  {
    id: 'task-waiting',
    taskKey: 'review-result',
    batchId: 'batch-1',
    dependsOn: ['task-running'],
    delegationDepth: 1,
    profileName: 'reviewer',
    description: 'Review result',
    promptRef: 'artifact://team/prompts/review-result',
    workspaceMode: 'shared_readonly',
    validationMode: 'required',
    status: 'blocked',
    artifactIds: [],
    createdAt: 5,
    updatedAt: 6,
  },
  {
    id: 'task-failed',
    batchId: 'batch-1',
    agentId: 'worker-1',
    profileName: 'builder',
    description: 'Package result',
    status: 'failed',
    createdAt: 7,
    updatedAt: 8,
  },
];

describe('TodoList view model', () => {
  it('separates active and completed cards without changing authoritative order', () => {
    const sections = partitionTodos(todos);
    expect(sections.active).toEqual([
      { index: 0, item: todos[0] },
      { index: 1, item: todos[1] },
      { index: 3, item: todos[3] },
    ]);
    expect(sections.completed).toEqual([{ index: 2, item: todos[2] }]);
  });

  it('cycles a task through pending, in-progress, done, and back to pending', () => {
    expect(nextTodoStatus('pending')).toBe('in_progress');
    expect(nextTodoStatus('in_progress')).toBe('done');
    expect(nextTodoStatus('done')).toBe('pending');
  });

  it('updates and removes by authoritative index', () => {
    expect(replaceTodo(todos, 1, { status: 'done', title: 'Updated' })).toEqual([
      todos[0],
      { title: 'Updated', status: 'done' },
      todos[2],
      todos[3],
    ]);
    expect(removeTodo(todos, 1)).toEqual([todos[0], todos[2], todos[3]]);
  });

  it('keeps matching titles from both Team sources as separate entries', () => {
    const entries = buildTeamTodoEntries(
      [{ title: 'Shared title', status: 'in_progress' }],
      assignments.slice(0, 1),
      members,
      'main',
    );

    expect(entries.map((entry) => ({ id: entry.id, source: entry.source, title: entry.title }))).toEqual([
      { id: 'leader:0', source: 'leader', title: 'Shared title' },
      { id: 'assignment:task-running', source: 'assignment', title: 'Shared title' },
    ]);
  });

  it('uses the bound member display name for an assigned Team task', () => {
    const entries = buildTeamTodoEntries([], assignments.slice(0, 1), members, 'main');

    expect(entries[0]).toMatchObject({ ownerAgentId: 'worker-1', ownerLabel: '构建代理' });
  });

  it('uses a waiting owner label for an unbound Team task', () => {
    const entries = buildTeamTodoEntries([], assignments.slice(1, 2), members, 'main');

    expect(entries[0]).toMatchObject({ ownerAgentId: undefined, ownerLabel: '等待分配' });
  });

  it('maps exact Team states into aggregate status buckets', () => {
    const entries = buildTeamTodoEntries(
      [
        { title: 'Leader running', status: 'in_progress' },
        { title: 'Leader pending', status: 'pending' },
        { title: 'Leader done', status: 'done' },
      ],
      assignments,
      members,
      'main',
    );

    expect(entries.map((entry) => ({ status: entry.status, label: entry.statusLabel, bucket: entry.bucket }))).toEqual([
      { status: 'in_progress', label: '计划进行中', bucket: 'running' },
      { status: 'pending', label: '未完成', bucket: 'waiting' },
      { status: 'done', label: '已完成', bucket: 'terminal' },
      { status: 'running', label: '运行中', bucket: 'running' },
      { status: 'blocked', label: '依赖阻塞', bucket: 'waiting' },
      { status: 'failed', label: '失败', bucket: 'terminal' },
    ]);
  });

  it('partitions aggregate entries without changing source order', () => {
    const entries = buildTeamTodoEntries(
      [
        { title: 'Leader waiting', status: 'pending' },
        { title: 'Leader running', status: 'in_progress' },
      ],
      assignments,
      members,
      'main',
    );
    const sections = partitionTeamTodos(entries);

    expect(sections.running.map((entry) => entry.id)).toEqual(['leader:1', 'assignment:task-running']);
    expect(sections.waiting.map((entry) => entry.id)).toEqual(['leader:0', 'assignment:task-waiting']);
    expect(sections.terminal.map((entry) => entry.id)).toEqual(['assignment:task-failed']);
  });

  it('counts aggregate entries by status bucket', () => {
    const entries = buildTeamTodoEntries(
      [
        { title: 'Leader waiting', status: 'pending' },
        { title: 'Leader running', status: 'in_progress' },
      ],
      assignments,
      members,
      'main',
    );

    expect(countTeamTodos(entries)).toEqual({ running: 2, waiting: 2, terminal: 1 });
  });
});
