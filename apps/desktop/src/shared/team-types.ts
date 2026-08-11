export type TeamTaskStatus =
  | 'blocked'
  | 'ready'
  | 'running'
  | 'awaiting_validation'
  | 'integrating'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';
export type LegacyTeamAssignmentStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';
export type TeamAssignmentStatus = TeamTaskStatus | LegacyTeamAssignmentStatus;
export type TeamBatchStatus =
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export interface Team {
  readonly id: string;
  readonly sessionId: string;
  readonly channelId: 'general';
  readonly leaderAgentId: string;
  readonly createdAt: number;
}

export interface TeamMember {
  readonly agentId: string;
  readonly displayName?: string;
  readonly role: 'leader' | 'member';
  readonly parentAgentId?: string;
  readonly joinedAt: number;
  readonly joinedSeq: number;
}

export interface LegacyTeamBatch {
  readonly id: string;
  readonly callerAgentId: string;
  readonly parentAssignmentId?: string;
  readonly status: Exclude<TeamBatchStatus, 'paused'>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface TeamBatch {
  readonly id: string;
  readonly callerAgentId: string;
  readonly parentTaskId?: string;
  readonly status: TeamBatchStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface LegacyTeamAssignment {
  readonly id: string;
  readonly batchId: string;
  readonly parentAssignmentId?: string;
  readonly agentId?: string;
  readonly displayName?: string;
  readonly profileName: string;
  readonly model?: string;
  readonly description: string;
  readonly item?: string;
  readonly status: LegacyTeamAssignmentStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly error?: string;
}

export interface TeamTask {
  readonly id: string;
  readonly taskKey: string;
  readonly batchId: string;
  readonly parentTaskId?: string;
  readonly dependsOn: readonly string[];
  readonly delegationDepth: number;
  readonly agentId?: string;
  readonly displayName?: string;
  readonly profileName: string;
  readonly model?: string;
  readonly description: string;
  readonly item?: string;
  readonly promptRef: string;
  readonly workspaceMode: 'shared_readonly' | 'isolated_write';
  readonly validationMode: 'none' | 'required';
  readonly resumeAgentId?: string;
  readonly status: TeamTaskStatus;
  readonly currentAttemptId?: string;
  readonly artifactIds: readonly string[];
  readonly reviewId?: string;
  readonly blocker?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly error?: string;
}

export type TeamAssignment = LegacyTeamAssignment | TeamTask;

export interface TeamAttempt {
  readonly id: string;
  readonly taskId: string;
  readonly kind: 'execution' | 'validation';
  readonly ordinal: number;
  readonly agentId?: string;
  readonly workspacePath?: string;
  readonly workspaceHead?: string;
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly error?: string;
}

export interface TeamArtifact {
  readonly id: string;
  readonly taskId?: string;
  readonly attemptId?: string;
  readonly kind: 'job_prompt' | 'report' | 'patch' | 'validation' | 'integration_diff';
  readonly contentRef: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly createdAt: number;
}

export interface TeamArtifactContent {
  readonly artifact: TeamArtifact;
  readonly dataBase64: string;
}

export interface TeamReview {
  readonly id: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly reviewerAgentId: string;
  readonly decision: 'approved' | 'changes_requested' | 'rejected';
  readonly summary: string;
  readonly createdAt: number;
}

export interface TeamPolicy {
  readonly maxConcurrency: number;
  readonly maxMembers: number;
  readonly maxDelegationDepth: number;
  readonly executionRetries: number;
  readonly validationRetries: number;
  readonly maxTokens?: number;
  readonly maxDurationMs?: number;
}

export type TeamPolicyInput = Partial<TeamPolicy>;

export interface TeamSchedulerState {
  readonly status: 'running' | 'paused' | 'awaiting_apply' | 'completed' | 'failed' | 'cancelled';
  readonly activeCount: number;
  readonly queuedCount: number;
  readonly pauseReason?: string;
  readonly updatedAt: number;
}

export interface TeamBudgetReport {
  readonly startedAt: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly elapsedMs: number;
  readonly exhaustedReason?: 'tokens' | 'duration';
}

export interface TeamIntegrationState {
  readonly status:
    | 'idle'
    | 'preparing'
    | 'integrating'
    | 'awaiting_apply'
    | 'applied'
    | 'discarded'
    | 'conflicted';
  readonly baselineHead?: string;
  readonly integrationHead?: string;
  readonly diffArtifactId?: string;
  readonly error?: string;
  readonly updatedAt: number;
}

export interface TeamMessageAttachment {
  readonly type: 'image_url';
  readonly url: string;
  readonly name?: string;
}

export interface TeamMessage {
  readonly id: string;
  readonly teamId: string;
  readonly channelId: 'general';
  readonly seq: number;
  readonly channelSeq: number;
  readonly sender: {
    readonly actorKind: 'agent' | 'user' | 'system';
    readonly actorId: string;
    readonly role: 'leader' | 'member' | 'user' | 'system';
  };
  readonly recipientAgentIds?: readonly string[];
  readonly body: string;
  readonly attachments?: readonly TeamMessageAttachment[];
  readonly clientMessageId: string;
  readonly taskId?: string;
  readonly createdAt: number;
}

interface LegacyTeamMessage extends Omit<TeamMessage, 'sender' | 'recipientAgentIds' | 'taskId'> {
  readonly sender: {
    readonly actorKind: 'agent' | 'user';
    readonly actorId: string;
    readonly role: 'leader' | 'member' | 'user';
  };
  readonly assignmentId?: string;
}

interface TeamOperationBase {
  readonly seq: number;
  readonly at: number;
}

export type TeamOperation =
  | (TeamOperationBase & { readonly version: 1; readonly type: 'team.created'; readonly team: Team })
  | (TeamOperationBase & { readonly version: 1; readonly type: 'batch.created'; readonly batch: LegacyTeamBatch; readonly assignments: readonly LegacyTeamAssignment[] })
  | (TeamOperationBase & { readonly version: 1; readonly type: 'assignment.bound'; readonly assignmentId: string; readonly agentId: string; readonly member: TeamMember })
  | (TeamOperationBase & { readonly version: 1; readonly type: 'assignment.status'; readonly assignmentId: string; readonly status: LegacyTeamAssignmentStatus; readonly error?: string })
  | (TeamOperationBase & { readonly version: 1; readonly type: 'batch.status'; readonly batchId: string; readonly status: Exclude<TeamBatchStatus, 'paused'> })
  | (TeamOperationBase & { readonly version: 1; readonly type: 'message.sent'; readonly message: LegacyTeamMessage })
  | (TeamOperationBase & { readonly version: 2; readonly operationId: string; readonly type: 'team.created'; readonly team: Team; readonly policy: TeamPolicy; readonly scheduler: TeamSchedulerState; readonly budget: TeamBudgetReport; readonly integration: TeamIntegrationState })
  | (TeamOperationBase & { readonly version: 2; readonly operationId: string; readonly type: 'team.policy_updated'; readonly policy: TeamPolicy })
  | (TeamOperationBase & { readonly version: 2; readonly operationId: string; readonly type: 'scheduler.updated'; readonly scheduler: TeamSchedulerState })
  | (TeamOperationBase & { readonly version: 2; readonly operationId: string; readonly type: 'batch.created'; readonly batch: TeamBatch; readonly tasks: readonly TeamTask[] })
  | (TeamOperationBase & { readonly version: 2; readonly operationId: string; readonly type: 'task.bound'; readonly taskId: string; readonly agentId: string; readonly member: TeamMember })
  | (TeamOperationBase & { readonly version: 2; readonly operationId: string; readonly type: 'task.status'; readonly taskId: string; readonly status: TeamTaskStatus; readonly attemptId?: string; readonly blocker?: string; readonly error?: string })
  | (TeamOperationBase & { readonly version: 2; readonly operationId: string; readonly type: 'task.reassigned'; readonly taskId: string; readonly profileName: string; readonly model?: string })
  | (TeamOperationBase & { readonly version: 2; readonly operationId: string; readonly type: 'attempt.started' | 'attempt.completed'; readonly attempt: TeamAttempt })
  | (TeamOperationBase & { readonly version: 2; readonly operationId: string; readonly type: 'artifact.created'; readonly artifact: TeamArtifact })
  | (TeamOperationBase & { readonly version: 2; readonly operationId: string; readonly type: 'review.submitted'; readonly review: TeamReview })
  | (TeamOperationBase & { readonly version: 2; readonly operationId: string; readonly type: 'budget.updated'; readonly budget: TeamBudgetReport })
  | (TeamOperationBase & { readonly version: 2; readonly operationId: string; readonly type: 'integration.updated'; readonly integration: TeamIntegrationState })
  | (TeamOperationBase & { readonly version: 2; readonly operationId: string; readonly type: 'batch.status'; readonly batchId: string; readonly status: TeamBatchStatus })
  | (TeamOperationBase & { readonly version: 2; readonly operationId: string; readonly type: 'message.sent'; readonly message: TeamMessage });

export interface LegacyTeamSnapshot {
  readonly protocolVersion: 1;
  readonly state: 'legacy_readonly' | 'degraded';
  readonly team?: Team;
  readonly members: readonly TeamMember[];
  readonly batches: readonly LegacyTeamBatch[];
  readonly assignments: readonly LegacyTeamAssignment[];
  readonly latestSeq: number;
  readonly latestChannelSeq: number;
  readonly degradedReason?: string;
}

export interface TeamSnapshotV2 {
  readonly protocolVersion: 2;
  readonly state: 'ready' | 'degraded';
  readonly team?: Team;
  readonly members: readonly TeamMember[];
  readonly batches: readonly TeamBatch[];
  readonly tasks: readonly TeamTask[];
  readonly assignments: readonly TeamTask[];
  readonly attempts: readonly TeamAttempt[];
  readonly artifacts: readonly TeamArtifact[];
  readonly reviews: readonly TeamReview[];
  readonly policy: TeamPolicy;
  readonly scheduler: TeamSchedulerState;
  readonly budget: TeamBudgetReport;
  readonly integration: TeamIntegrationState;
  readonly latestSeq: number;
  readonly latestChannelSeq: number;
  readonly degradedReason?: string;
}

export type TeamSnapshot = LegacyTeamSnapshot | TeamSnapshotV2;

export function isTeamSnapshotV2(snapshot: TeamSnapshot): snapshot is TeamSnapshotV2 {
  return snapshot.protocolVersion === 2;
}

export function teamTaskParentId(task: TeamAssignment): string | undefined {
  return 'taskKey' in task ? task.parentTaskId : task.parentAssignmentId;
}
