/**
 * `collaboration` domain — session-level Team Mode service contract.
 *
 * Exposes the durable snapshot/history surface, user and agent messaging,
 * Swarm lifecycle projection, and bounded per-agent delivery reads. Bound at
 * Session scope.
 */

import { createDecorator } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';

import type {
  TeamAssignmentStatus,
  TeamBatchAssignmentInput,
  TeamBatchReceipt,
  TeamBatchStatus,
  TeamDelivery,
  TeamMessage,
  TeamOperation,
  TeamSnapshot,
} from './types';

export interface ISessionCollaborationService {
  readonly _serviceBrand: undefined;
  readonly ready: Promise<void>;
  readonly onDidOperate: Event<TeamOperation>;

  isEnabled(): boolean;
  ensureTeam(): Promise<TeamSnapshot>;
  snapshot(): Promise<TeamSnapshot>;
  operations(input: { readonly afterSeq: number; readonly limit?: number }): Promise<readonly TeamOperation[]>;
  history(input?: { readonly beforeChannelSeq?: number; readonly limit?: number }): Promise<readonly TeamMessage[]>;
  sendUserMessage(input: { readonly body: string; readonly clientMessageId: string }): Promise<TeamMessage>;
  sendAgentMessage(input: {
    readonly agentId: string;
    readonly body: string;
    readonly clientMessageId: string;
  }): Promise<TeamMessage>;
  waitForOperation(input: {
    readonly afterSeq: number;
    readonly timeoutMs: number;
    readonly signal: AbortSignal;
  }): Promise<TeamOperation | undefined>;
  prepareSwarmBatch(input: {
    readonly callerAgentId: string;
    readonly assignments: readonly TeamBatchAssignmentInput[];
  }): Promise<TeamBatchReceipt>;
  bindAssignment(input: {
    readonly assignmentId: string;
    readonly agentId: string;
    readonly parentAgentId: string;
  }): Promise<void>;
  settleAssignment(input: {
    readonly assignmentId: string;
    readonly status: TeamAssignmentStatus;
    readonly error?: string;
  }): Promise<void>;
  settleBatch(input: { readonly batchId: string; readonly status: TeamBatchStatus }): Promise<void>;
  delivery(input: { readonly agentId: string; readonly afterSeq: number }): Promise<TeamDelivery | undefined>;
}

export const ISessionCollaborationService = createDecorator<ISessionCollaborationService>(
  'sessionCollaborationService',
);
