import type { AgentDescriptor, TranscriptInteraction, TranscriptStore } from '@moonshot-ai/transcript';

import type {
  TeamAssignment,
  TeamMember,
  TeamMessage,
  TeamQuestionItem,
  TeamSchedulerState,
} from '../shared/desktop-api';
import {
  agentActivityIsActive,
  type AgentActivityForest,
  type AgentActivityNode,
  type AgentActivityStatus,
} from './agent-activity';
import { array, record, text } from './ui-utils';

export interface PendingAgentInteraction {
  readonly key: string;
  readonly agent: AgentDescriptor;
  readonly interaction: TranscriptInteraction;
  readonly summary: string;
}

export interface TeamAgentActivity {
  readonly agentId: string;
  readonly status: AgentActivityStatus;
  readonly action: string;
}

export interface TeamBadge {
  readonly unread: number;
  readonly running: number;
  readonly waiting: number;
  readonly failed: number;
}

export type TeamLeaderStatusState =
  | 'waiting_user'
  | 'waiting_interaction'
  | 'retrying'
  | 'running'
  | 'waiting_children'
  | 'degraded'
  | 'paused'
  | 'scheduling'
  | 'awaiting_apply'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'syncing'
  | 'idle';

export type TeamLeaderStatusTone = 'running' | 'waiting' | 'paused' | 'success' | 'error' | 'idle';

export interface TeamLeaderStatus {
  readonly state: TeamLeaderStatusState;
  readonly tone: TeamLeaderStatusTone;
  readonly label: string;
  readonly action: string;
}

export interface ResolveTeamLeaderStatusInput {
  readonly leaderAgentId: string;
  readonly activity?: AgentActivityForest;
  readonly busy?: boolean;
  readonly pendingQuestion?: PendingLeaderQuestion;
  readonly assignments: readonly TeamAssignment[];
  readonly scheduler?: TeamSchedulerState;
  readonly snapshotState: 'ready' | 'legacy_readonly' | 'degraded';
  readonly degradedReason?: string;
  readonly activeBatchCount: number;
  readonly hasInProgressPlan: boolean;
}

export interface PendingLeaderQuestion {
  readonly message: TeamMessage;
  readonly questionId: string;
  readonly questions: readonly TeamQuestionItem[];
}

export function buildTeamBadge(
  assignments: readonly TeamAssignment[],
  unread: number,
): TeamBadge {
  return {
    unread,
    running: assignments.filter((assignment) => isRunningAssignmentStatus(assignment.status)).length,
    waiting: assignments.filter((assignment) => isWaitingAssignmentStatus(assignment.status)).length,
    failed: assignments.filter((assignment) => assignment.status === 'failed').length,
  };
}

export function resolveTeamLeaderStatus(input: ResolveTeamLeaderStatusInput): TeamLeaderStatus {
  if (input.pendingQuestion !== undefined) {
    return {
      state: 'waiting_user',
      tone: 'waiting',
      label: '等待回答',
      action: `等待回答：${input.pendingQuestion.questions[0]?.question ?? '组长问题'}`,
    };
  }

  const leader = input.activity?.byId.get(input.leaderAgentId);
  if (input.busy === true) {
    if (leader !== undefined && agentActivityIsActive(leader.status)) {
      if (leader.status === 'waiting') {
        return {
          state: 'waiting_interaction',
          tone: 'waiting',
          label: leader.action.includes('权限') ? '等待确认' : '等待交互',
          action: leader.action,
        };
      }
      if (leader.status === 'retrying') {
        return { state: 'retrying', tone: 'running', label: '正在重试', action: leader.action };
      }
      return { state: 'running', tone: 'running', label: '运行中', action: leader.action };
    }
    return { state: 'running', tone: 'running', label: '运行中', action: '正在处理团队任务' };
  }

  const activeChildren = leader === undefined ? [] : collectActiveDescendants(leader);
  const activeAssignments = input.assignments.filter((assignment) => isRunningAssignmentStatus(assignment.status));
  const knownAgentIds = new Set([
    ...activeChildren.map((node) => node.agent.agentId),
    ...activeAssignments.flatMap((assignment) => assignment.agentId === undefined ? [] : [assignment.agentId]),
  ]);
  knownAgentIds.delete(input.leaderAgentId);
  const activeCount = Math.max(
    knownAgentIds.size,
    activeAssignments.length,
    input.scheduler?.activeCount ?? 0,
    input.activeBatchCount,
  );
  if (activeCount > 0) {
    const childWaiting = activeChildren.length > 0
      && activeChildren.every((node) => node.status === 'waiting')
      && activeAssignments.length === 0;
    const noun = knownAgentIds.size > 0 ? '子代理' : '子任务';
    const detail = activeChildSummary(activeChildren, activeAssignments);
    const paused = input.scheduler?.status === 'paused' ? ' · 调度已暂停' : '';
    return {
      state: 'waiting_children',
      tone: 'waiting',
      label: '等待子代理',
      action: `${String(activeCount)} 个${noun}${childWaiting ? '等待处理' : '正在执行'}${detail === undefined ? '' : ` · ${detail}`}${paused}`,
    };
  }

  if (input.snapshotState === 'degraded') {
    return {
      state: 'degraded',
      tone: 'error',
      label: '状态异常',
      action: input.degradedReason ?? '团队状态无法完整恢复',
    };
  }

  const badge = buildTeamBadge(input.assignments, 0);
  const waitingCount = Math.max(badge.waiting, input.scheduler?.queuedCount ?? 0);
  switch (input.scheduler?.status) {
    case 'paused':
      return {
        state: 'paused',
        tone: 'paused',
        label: '已暂停',
        action: waitingCount > 0
          ? `调度已暂停，${String(waitingCount)} 个子任务等待继续`
          : '团队调度已暂停',
      };
    case 'awaiting_apply':
      return { state: 'awaiting_apply', tone: 'waiting', label: '等待应用', action: '结果已生成，等待确认集成' };
    case 'failed':
      return { state: 'failed', tone: 'error', label: '执行失败', action: '团队调度失败' };
    case 'cancelled':
      return { state: 'cancelled', tone: 'idle', label: '已取消', action: '团队调度已取消' };
    case 'completed':
      return { state: 'completed', tone: 'success', label: '已完成', action: '团队任务已完成' };
    case 'running':
      if (waitingCount > 0) {
        return {
          state: 'scheduling',
          tone: 'running',
          label: '调度中',
          action: `${String(waitingCount)} 个子任务等待分配或解除依赖`,
        };
      }
      break;
  }

  if (input.busy === undefined) {
    return { state: 'syncing', tone: 'idle', label: '同步中', action: '正在读取组长运行状态' };
  }
  if (waitingCount > 0) {
    return {
      state: 'idle',
      tone: 'idle',
      label: '空闲',
      action: `${String(waitingCount)} 个子任务等待执行`,
    };
  }
  return {
    state: 'idle',
    tone: 'idle',
    label: '空闲',
    action: input.hasInProgressPlan
      ? '计划尚未完成，当前没有运行中的工作'
      : '当前没有运行中的工作',
  };
}

export function collectTeamAgentActivities(
  forest: AgentActivityForest | undefined,
  members: readonly TeamMember[],
): readonly TeamAgentActivity[] {
  if (forest === undefined) return [];
  return members.flatMap((member) => {
    const node = forest.byId.get(member.agentId);
    if (node === undefined || !agentActivityIsActive(node.status)) return [];
    return [{ agentId: member.agentId, status: node.status, action: node.action }];
  });
}

export function collectPendingLeaderQuestions(
  messages: readonly TeamMessage[],
  leaderAgentId: string,
): readonly PendingLeaderQuestion[] {
  const pending = new Map<string, PendingLeaderQuestion>();
  for (const message of messages) {
    if (
      message.payload?.type === 'question'
      && message.sender.actorKind === 'agent'
      && message.sender.actorId === leaderAgentId
    ) {
      pending.set(message.payload.questionId, {
        message,
        questionId: message.payload.questionId,
        questions: message.payload.questions,
      });
      continue;
    }
    if (message.payload?.type === 'question_answer' && message.sender.actorKind === 'user') {
      pending.delete(message.payload.questionId);
    }
  }
  return [...pending.values()];
}

export function mergePendingLeaderQuestionActivity(
  activities: readonly TeamAgentActivity[],
  leaderAgentId: string,
  pending: PendingLeaderQuestion | undefined,
): readonly TeamAgentActivity[] {
  if (pending === undefined) return activities;
  const waiting: TeamAgentActivity = {
    agentId: leaderAgentId,
    status: 'waiting',
    action: `等待回答：${pending.questions[0]?.question ?? '组长问题'}`,
  };
  const leaderIndex = activities.findIndex((activity) => activity.agentId === leaderAgentId);
  if (leaderIndex < 0) return [waiting, ...activities];
  return activities.map((activity, index) => index === leaderIndex ? waiting : activity);
}

export function collectPendingAgentInteractions(
  store: TranscriptStore | undefined,
  selectedAgentId: string,
): readonly PendingAgentInteraction[] {
  if (store === undefined) return [];
  const pending: PendingAgentInteraction[] = [];
  const agents = store.agents()
    .map((agent, index) => ({ agent, index }))
    .sort((left, right) => {
      const leftRank = agentInteractionRank(left.agent.agentId, selectedAgentId);
      const rightRank = agentInteractionRank(right.agent.agentId, selectedAgentId);
      return leftRank - rightRank || left.index - right.index;
    });
  for (const { agent } of agents) {
    const transcript = store.getAgent(agent.agentId);
    if (transcript === undefined) continue;
    for (const interaction of transcript.getInteractions().values()) {
      if (interaction.state !== 'pending') continue;
      pending.push({
        key: `${agent.agentId}:${interaction.interactionId}`,
        agent,
        interaction,
        summary: interactionSummary(interaction),
      });
    }
  }
  return pending;
}

function agentInteractionRank(agentId: string, selectedAgentId: string): number {
  if (agentId === selectedAgentId) return 0;
  if (agentId === 'main') return 1;
  return 2;
}

export function interactionSummary(interaction: TranscriptInteraction): string {
  const request = record(interaction.request);
  if (interaction.interactionKind === 'approval') {
    return text(request['action'], text(request['toolName'], '工具操作'));
  }
  const firstQuestion = record(array(request['questions'])[0]);
  return text(firstQuestion['question'], text(firstQuestion['body'], 'Kimi 有问题'));
}

function collectActiveDescendants(root: AgentActivityNode): readonly AgentActivityNode[] {
  const active: AgentActivityNode[] = [];
  const pending = [...root.children];
  while (pending.length > 0) {
    const node = pending.shift();
    if (node === undefined) continue;
    if (agentActivityIsActive(node.status)) active.push(node);
    pending.push(...node.children);
  }
  return active;
}

function activeChildSummary(
  children: readonly AgentActivityNode[],
  assignments: readonly TeamAssignment[],
): string | undefined {
  const child = children[0];
  if (child !== undefined) {
    const label = child.agent.label ?? child.agent.agentId;
    const action = child.task?.description ?? child.action;
    return action.length > 0 ? `${label} · ${action}` : label;
  }
  const assignment = assignments[0];
  if (assignment === undefined) return undefined;
  const label = assignment.displayName ?? assignment.agentId;
  return label === undefined ? assignment.description : `${label} · ${assignment.description}`;
}

function isRunningAssignmentStatus(status: TeamAssignment['status']): boolean {
  return status === 'running' || status === 'awaiting_validation' || status === 'integrating';
}

function isWaitingAssignmentStatus(status: TeamAssignment['status']): boolean {
  return status === 'queued' || status === 'blocked' || status === 'ready';
}
