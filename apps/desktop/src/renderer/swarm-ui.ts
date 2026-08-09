import type { AgentDescriptor, TranscriptInteraction, TranscriptStore } from '@moonshot-ai/transcript';

import { array, record, text } from './ui-utils';

export type SessionPermission = 'manual' | 'auto' | 'yolo';

export interface SwarmPermissionPrompt {
  readonly sessionId: string;
  readonly permission: SessionPermission;
}

type SwarmActivation = () => Promise<void> | void;

interface PendingSwarmEntry {
  readonly sessionId: string;
  readonly permission: Exclude<SessionPermission, 'yolo'>;
  readonly activate: SwarmActivation;
  readonly resolve: (allowed: boolean) => void;
}

export interface PendingAgentInteraction {
  readonly key: string;
  readonly agent: AgentDescriptor;
  readonly interaction: TranscriptInteraction;
  readonly summary: string;
}

export function requiresSwarmPermissionChoice(permission?: SessionPermission): boolean {
  return permission !== 'yolo';
}

export class SwarmEntryController {
  private pending?: PendingSwarmEntry;

  constructor(
    private readonly applyYolo: (sessionId: string) => Promise<void>,
    private readonly publishPrompt: (prompt?: SwarmPermissionPrompt) => void,
  ) {}

  get hasPending(): boolean {
    return this.pending !== undefined;
  }

  async enter(sessionId: string, permission: SessionPermission, activate: SwarmActivation): Promise<boolean> {
    if (this.pending !== undefined) return false;
    if (!requiresSwarmPermissionChoice(permission)) {
      await activate();
      return true;
    }
    const promptPermission: Exclude<SessionPermission, 'yolo'> = permission === 'auto' ? 'auto' : 'manual';
    const deferred = Promise.withResolvers<boolean>();
    this.pending = { sessionId, permission: promptPermission, activate, resolve: deferred.resolve };
    this.publishPrompt({ sessionId, permission: promptPermission });
    return deferred.promise;
  }

  async choose(choice: 'yolo' | 'current'): Promise<void> {
    const pending = this.pending;
    if (pending === undefined) return;
    if (choice === 'yolo') {
      await this.applyYolo(pending.sessionId);
      if (this.pending !== pending) return;
      this.publishPrompt({ sessionId: pending.sessionId, permission: 'yolo' });
    }
    await pending.activate();
    if (this.pending !== pending) return;
    this.pending = undefined;
    this.publishPrompt(undefined);
    pending.resolve(true);
  }

  cancelOutside(activeSessionId?: string): void {
    if (this.pending !== undefined && this.pending.sessionId !== activeSessionId) this.cancel();
  }

  cancel(): void {
    const pending = this.pending;
    if (pending === undefined) return;
    this.pending = undefined;
    this.publishPrompt(undefined);
    pending.resolve(false);
  }

  dispose(): void {
    const pending = this.pending;
    this.pending = undefined;
    pending?.resolve(false);
  }
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
