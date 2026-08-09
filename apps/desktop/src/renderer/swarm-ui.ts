import type { AgentDescriptor, TranscriptInteraction, TranscriptStore } from '@moonshot-ai/transcript';

import { array, record, text } from './ui-utils';

export interface PendingAgentInteraction {
  readonly key: string;
  readonly agent: AgentDescriptor;
  readonly interaction: TranscriptInteraction;
  readonly summary: string;
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
