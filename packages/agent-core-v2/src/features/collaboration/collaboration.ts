/**
 * `collaboration` domain — session-level Team Mode service contract.
 *
 * Exposes the durable snapshot/history surface, user and agent messaging,
 * Swarm lifecycle projection, and bounded per-agent delivery reads. Bound at
 * Session scope.
 */

import { createDecorator } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import type { SessionSwarmTask } from '#/session/swarm/sessionSwarm';
import type { TokenUsage } from '#/kosong/contract/usage';

import type {
  TeamArtifactContent,
  TeamAssignmentStatus,
  TeamBatchAssignmentInput,
  TeamBatchReceipt,
  TeamBatchStatus,
  TeamDelivery,
  TeamMessage,
  TeamMessageAttachment,
  TeamQuestionAnswers,
  TeamQuestionItem,
  TeamOperation,
  TeamPolicyInput,
  TeamReview,
  TeamSnapshot,
} from './types';

export interface ISessionCollaborationService {
  readonly _serviceBrand: undefined;
  readonly ready: Promise<void>;
  readonly onDidOperate: Event<TeamOperation>;

  isEnabled(): boolean;
  isActive(): boolean;
  assertModelRequestAllowed(): Promise<void>;
  recordModelRequestUsage(usage: TokenUsage): Promise<void>;
  ensureTeam(policy?: TeamPolicyInput): Promise<TeamSnapshot>;
  snapshot(): Promise<TeamSnapshot>;
  operations(input: { readonly afterSeq: number; readonly limit?: number }): Promise<readonly TeamOperation[]>;
  history(input?: { readonly beforeChannelSeq?: number; readonly limit?: number }): Promise<readonly TeamMessage[]>;
  sendUserMessage(input: {
    readonly body: string;
    readonly clientMessageId: string;
    readonly attachments?: readonly TeamMessageAttachment[];
    readonly recipientAgentIds?: readonly string[];
  }): Promise<TeamMessage>;
  submitUserMessage(input: {
    readonly body: string;
    readonly clientMessageId: string;
    readonly attachments?: readonly TeamMessageAttachment[];
    readonly recipientAgentIds?: readonly string[];
  }): Promise<TeamMessage>;
  sendAgentMessage(input: {
    readonly agentId: string;
    readonly body: string;
    readonly clientMessageId: string;
    readonly recipientAgentIds?: readonly string[];
  }): Promise<TeamMessage>;
  requestLeaderQuestion(input: {
    readonly agentId: string;
    readonly questionId: string;
    readonly questions: readonly TeamQuestionItem[];
    readonly signal: AbortSignal;
  }): Promise<TeamQuestionAnswers>;
  answerLeaderQuestion(input: {
    readonly leaderAgentId: string;
    readonly questionId: string;
    readonly answers: TeamQuestionAnswers;
  }): Promise<TeamMessage>;
  waitForOperation(input: {
    readonly afterSeq: number;
    readonly timeoutMs: number;
    readonly signal: AbortSignal;
    readonly agentId?: string;
  }): Promise<TeamOperation | undefined>;
  prepareSwarmBatch(input: {
    readonly callerAgentId: string;
    readonly assignments: readonly TeamBatchAssignmentInput[];
  }): Promise<TeamBatchReceipt>;
  scheduleSwarmBatch(input: {
    readonly batchId: string;
    readonly tasks: readonly SessionSwarmTask[];
  }): Promise<void>;
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
  updatePolicy(input: { readonly policy: TeamPolicyInput; readonly expectedSeq: number }): Promise<TeamSnapshot>;
  pause(input: { readonly expectedSeq: number; readonly reason?: string }): Promise<TeamSnapshot>;
  resume(input: { readonly expectedSeq: number }): Promise<TeamSnapshot>;
  cancelTask(input: { readonly taskId: string; readonly expectedSeq: number }): Promise<TeamSnapshot>;
  retryTask(input: { readonly taskId: string; readonly expectedSeq: number }): Promise<TeamSnapshot>;
  reassignTask(input: {
    readonly taskId: string;
    readonly expectedSeq: number;
    readonly profileName?: string;
    readonly model?: string;
  }): Promise<TeamSnapshot>;
  submitTaskReport(input: {
    readonly agentId: string;
    readonly taskId: string;
    readonly summary: string;
  }): Promise<void>;
  submitReview(input: {
    readonly reviewerAgentId: string;
    readonly taskId: string;
    readonly decision: TeamReview['decision'];
    readonly summary: string;
  }): Promise<TeamReview>;
  artifact(input: { readonly artifactId: string }): Promise<TeamArtifactContent>;
  previewIntegration(): Promise<TeamArtifactContent | undefined>;
  applyIntegration(input: { readonly expectedSeq: number }): Promise<TeamSnapshot>;
  discardIntegration(input: { readonly expectedSeq: number }): Promise<TeamSnapshot>;
  delivery(input: { readonly agentId: string; readonly afterSeq: number }): Promise<TeamDelivery | undefined>;
}

export const ISessionCollaborationService = createDecorator<ISessionCollaborationService>(
  'sessionCollaborationService',
);
