import type { AgentDescriptor, TranscriptInteraction, TranscriptStore } from '@moonshot-ai/transcript';

import type { TeamMember, TeamMessage, TeamQuestionItem } from '../shared/desktop-api';
import {
  agentActivityIsActive,
  type AgentActivityForest,
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

export interface PendingLeaderQuestion {
  readonly message: TeamMessage;
  readonly questionId: string;
  readonly questions: readonly TeamQuestionItem[];
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
