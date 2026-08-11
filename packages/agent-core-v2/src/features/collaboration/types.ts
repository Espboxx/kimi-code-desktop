/**
 * `collaboration` domain — versioned Team Mode data contracts.
 *
 * Keeps the released v1 append-log vocabulary readable while defining the v2
 * task graph, scheduler, budget, artifact, review, integration, and addressed
 * messaging records used by new teams.
 */

import { z } from 'zod';

export const TEAM_CHANNEL_ID = 'general' as const;
export const TEAM_LEGACY_OPERATION_VERSION = 1 as const;
export const TEAM_OPERATION_VERSION = 2 as const;
export const TEAM_MESSAGE_MAX_BYTES = 8 * 1024;
export const TEAM_MESSAGE_MAX_ATTACHMENTS = 8;
export const TEAM_MESSAGE_ATTACHMENT_URL_MAX_LENGTH = 4_096;
export const TEAM_MESSAGE_ATTACHMENT_NAME_MAX_LENGTH = 255;
export const TEAM_MESSAGE_MODEL_URL_MAX_LENGTH = 36 * 1024 * 1024;
export const TEAM_HISTORY_DEFAULT_LIMIT = 100;
export const TEAM_HISTORY_MAX_LIMIT = 200;
export const TEAM_OPERATION_MAX_LIMIT = 1_000;
export const TEAM_DELIVERY_MAX_MESSAGES = 20;
export const TEAM_DELIVERY_MAX_BYTES = 24 * 1024;
export const TEAM_DEFAULT_MAX_CONCURRENCY = 4;
export const TEAM_DEFAULT_MAX_MEMBERS = 16;
export const TEAM_DEFAULT_MAX_DELEGATION_DEPTH = 2;
export const TEAM_DEFAULT_EXECUTION_RETRIES = 1;
export const TEAM_DEFAULT_VALIDATION_RETRIES = 2;

const TEAM_DISPLAY_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,23}$/u;

export const teamDisplayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(24)
  .refine((name) => TEAM_DISPLAY_NAME_PATTERN.test(name), {
    message: 'Team display names may contain only letters, numbers, underscores, and hyphens',
  })
  .refine((name) => name.toLowerCase() !== 'main' && !/^agent-\d+$/i.test(name), {
    message: 'Team display names must not use reserved agent identifiers',
  });

export const teamRoleSchema = z.enum(['leader', 'member']);
export type TeamRole = z.infer<typeof teamRoleSchema>;

const legacyAssignmentStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);

const legacyBatchStatusSchema = z.enum([
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);

export const teamTaskStatusSchema = z.enum([
  'blocked',
  'ready',
  'running',
  'awaiting_validation',
  'integrating',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);
export type TeamTaskStatus = z.infer<typeof teamTaskStatusSchema>;
export const teamAssignmentStatusSchema = teamTaskStatusSchema;
export type TeamAssignmentStatus = TeamTaskStatus;

export const teamBatchStatusSchema = z.enum([
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);
export type TeamBatchStatus = z.infer<typeof teamBatchStatusSchema>;

export const teamSchedulerStatusSchema = z.enum([
  'running',
  'paused',
  'awaiting_apply',
  'completed',
  'failed',
  'cancelled',
]);
export type TeamSchedulerStatus = z.infer<typeof teamSchedulerStatusSchema>;

export const teamWorkspaceModeSchema = z.enum(['shared_readonly', 'isolated_write']);
export type TeamWorkspaceMode = z.infer<typeof teamWorkspaceModeSchema>;

export const teamValidationModeSchema = z.enum(['none', 'required']);
export type TeamValidationMode = z.infer<typeof teamValidationModeSchema>;

export const teamPolicySchema = z.object({
  maxConcurrency: z.number().int().min(1).max(16),
  maxMembers: z.number().int().min(2).max(64),
  maxDelegationDepth: z.number().int().min(1).max(8),
  executionRetries: z.number().int().min(0).max(5),
  validationRetries: z.number().int().min(0).max(5),
  maxTokens: z.number().int().positive().optional(),
  maxDurationMs: z.number().int().positive().optional(),
}).strict();
export type TeamPolicy = z.infer<typeof teamPolicySchema>;

export const DEFAULT_TEAM_POLICY: TeamPolicy = {
  maxConcurrency: TEAM_DEFAULT_MAX_CONCURRENCY,
  maxMembers: TEAM_DEFAULT_MAX_MEMBERS,
  maxDelegationDepth: TEAM_DEFAULT_MAX_DELEGATION_DEPTH,
  executionRetries: TEAM_DEFAULT_EXECUTION_RETRIES,
  validationRetries: TEAM_DEFAULT_VALIDATION_RETRIES,
};

export const teamPolicyInputSchema = teamPolicySchema.partial().strict();
export type TeamPolicyInput = z.infer<typeof teamPolicyInputSchema>;

export const teamSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  channelId: z.literal(TEAM_CHANNEL_ID),
  leaderAgentId: z.string().min(1),
  createdAt: z.number().nonnegative(),
}).strict();
export type Team = z.infer<typeof teamSchema>;

export const teamMemberSchema = z.object({
  agentId: z.string().min(1),
  displayName: teamDisplayNameSchema.optional(),
  role: teamRoleSchema,
  parentAgentId: z.string().min(1).optional(),
  joinedAt: z.number().nonnegative(),
  joinedSeq: z.number().int().positive(),
}).strict();
export type TeamMember = z.infer<typeof teamMemberSchema>;

export const teamBatchSchema = z.object({
  id: z.string().min(1),
  callerAgentId: z.string().min(1),
  parentTaskId: z.string().min(1).optional(),
  status: teamBatchStatusSchema,
  createdAt: z.number().nonnegative(),
  updatedAt: z.number().nonnegative(),
}).strict();
export type TeamBatch = z.infer<typeof teamBatchSchema>;

export const teamTaskSchema = z.object({
  id: z.string().min(1),
  taskKey: z.string().trim().min(1).max(80),
  batchId: z.string().min(1),
  parentTaskId: z.string().min(1).optional(),
  dependsOn: z.array(z.string().trim().min(1).max(80)).max(32),
  delegationDepth: z.number().int().nonnegative(),
  agentId: z.string().min(1).optional(),
  displayName: teamDisplayNameSchema.optional(),
  profileName: z.string().min(1),
  model: z.string().min(1).optional(),
  description: z.string().min(1),
  item: z.string().optional(),
  promptRef: z.string().min(1),
  workspaceMode: teamWorkspaceModeSchema,
  validationMode: teamValidationModeSchema,
  resumeAgentId: z.string().min(1).optional(),
  status: teamTaskStatusSchema,
  currentAttemptId: z.string().min(1).optional(),
  artifactIds: z.array(z.string().min(1)),
  reviewId: z.string().min(1).optional(),
  blocker: z.string().optional(),
  createdAt: z.number().nonnegative(),
  updatedAt: z.number().nonnegative(),
  error: z.string().optional(),
}).strict();
export type TeamTask = z.infer<typeof teamTaskSchema>;
export type TeamAssignment = TeamTask;

export const teamAttemptSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  kind: z.enum(['execution', 'validation']),
  ordinal: z.number().int().positive(),
  agentId: z.string().min(1).optional(),
  workspacePath: z.string().min(1).optional(),
  workspaceHead: z.string().min(1).optional(),
  status: z.enum(['running', 'completed', 'failed', 'cancelled', 'interrupted']),
  startedAt: z.number().nonnegative(),
  completedAt: z.number().nonnegative().optional(),
  error: z.string().optional(),
}).strict();
export type TeamAttempt = z.infer<typeof teamAttemptSchema>;

export const teamArtifactSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1).optional(),
  attemptId: z.string().min(1).optional(),
  kind: z.enum(['job_prompt', 'report', 'patch', 'validation', 'integration_diff']),
  contentRef: z.string().min(1),
  mediaType: z.string().min(1),
  byteLength: z.number().int().nonnegative(),
  createdAt: z.number().nonnegative(),
}).strict();
export type TeamArtifact = z.infer<typeof teamArtifactSchema>;

export const teamReviewSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  attemptId: z.string().min(1),
  reviewerAgentId: z.string().min(1),
  decision: z.enum(['approved', 'changes_requested', 'rejected']),
  summary: z.string().min(1),
  createdAt: z.number().nonnegative(),
}).strict();
export type TeamReview = z.infer<typeof teamReviewSchema>;

export const teamBudgetReportSchema = z.object({
  startedAt: z.number().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  elapsedMs: z.number().int().nonnegative(),
  exhaustedReason: z.enum(['tokens', 'duration']).optional(),
}).strict();
export type TeamBudgetReport = z.infer<typeof teamBudgetReportSchema>;

export const teamSchedulerStateSchema = z.object({
  status: teamSchedulerStatusSchema,
  activeCount: z.number().int().nonnegative(),
  queuedCount: z.number().int().nonnegative(),
  pauseReason: z.string().optional(),
  updatedAt: z.number().nonnegative(),
}).strict();
export type TeamSchedulerState = z.infer<typeof teamSchedulerStateSchema>;

export const teamIntegrationStateSchema = z.object({
  status: z.enum([
    'idle',
    'preparing',
    'integrating',
    'awaiting_apply',
    'applied',
    'discarded',
    'conflicted',
  ]),
  baselineHead: z.string().min(1).optional(),
  integrationHead: z.string().min(1).optional(),
  diffArtifactId: z.string().min(1).optional(),
  error: z.string().optional(),
  updatedAt: z.number().nonnegative(),
}).strict();
export type TeamIntegrationState = z.infer<typeof teamIntegrationStateSchema>;

export const teamMessageSenderSchema = z.object({
  actorKind: z.enum(['agent', 'user', 'system']),
  actorId: z.string().min(1),
  role: z.enum(['leader', 'member', 'user', 'system']),
}).strict();
export type TeamMessageSender = z.infer<typeof teamMessageSenderSchema>;

export const teamMessageAttachmentSchema = z.object({
  type: z.literal('image_url'),
  url: z.string().min(1).max(TEAM_MESSAGE_ATTACHMENT_URL_MAX_LENGTH),
  name: z.string().min(1).max(TEAM_MESSAGE_ATTACHMENT_NAME_MAX_LENGTH).optional(),
}).strict();
export type TeamMessageAttachment = z.infer<typeof teamMessageAttachmentSchema>;

export const teamMessageModelAttachmentSchema = z.object({
  type: z.literal('image_url'),
  url: z.string().min(1).max(TEAM_MESSAGE_MODEL_URL_MAX_LENGTH),
}).strict();
export type TeamMessageModelAttachment = z.infer<typeof teamMessageModelAttachmentSchema>;

export const teamQuestionOptionSchema = z.object({
  label: z.string().min(1),
  description: z.string().optional(),
}).strict();
export type TeamQuestionOption = z.infer<typeof teamQuestionOptionSchema>;

export const teamQuestionItemSchema = z.object({
  question: z.string().min(1),
  header: z.string().optional(),
  options: z.array(teamQuestionOptionSchema).min(2).max(4),
  multiSelect: z.boolean().optional(),
}).strict();
export type TeamQuestionItem = z.infer<typeof teamQuestionItemSchema>;

export const teamQuestionAnswersSchema = z.record(z.string().min(1), z.union([
  z.string(),
  z.literal(true),
]));
export type TeamQuestionAnswers = z.infer<typeof teamQuestionAnswersSchema>;

export const teamMessagePayloadSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('question'),
    questionId: z.string().min(1),
    questions: z.array(teamQuestionItemSchema).min(1).max(4),
  }).strict(),
  z.object({
    type: z.literal('question_answer'),
    questionId: z.string().min(1),
    answers: teamQuestionAnswersSchema,
  }).strict(),
]);
export type TeamMessagePayload = z.infer<typeof teamMessagePayloadSchema>;

export const teamMessageSchema = z.object({
  id: z.string().min(1),
  teamId: z.string().min(1),
  channelId: z.literal(TEAM_CHANNEL_ID),
  seq: z.number().int().positive(),
  channelSeq: z.number().int().positive(),
  sender: teamMessageSenderSchema,
  recipientAgentIds: z.array(z.string().min(1)).min(1).max(16).optional(),
  body: z.string().min(1),
  attachments: z.array(teamMessageAttachmentSchema).max(TEAM_MESSAGE_MAX_ATTACHMENTS).optional(),
  payload: teamMessagePayloadSchema.optional(),
  clientMessageId: z.string().min(1),
  taskId: z.string().min(1).optional(),
  createdAt: z.number().nonnegative(),
}).strict();
export type TeamMessage = z.infer<typeof teamMessageSchema>;

export interface TeamMessageSentEvent {
  readonly message: TeamMessage;
  readonly modelAttachments?: readonly TeamMessageModelAttachment[];
}

const legacyTeamBatchSchema = z.object({
  id: z.string().min(1),
  callerAgentId: z.string().min(1),
  parentAssignmentId: z.string().min(1).optional(),
  status: legacyBatchStatusSchema,
  createdAt: z.number().nonnegative(),
  updatedAt: z.number().nonnegative(),
}).strict();

const legacyTeamAssignmentSchema = z.object({
  id: z.string().min(1),
  batchId: z.string().min(1),
  parentAssignmentId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  displayName: teamDisplayNameSchema.optional(),
  profileName: z.string().min(1),
  model: z.string().min(1).optional(),
  description: z.string().min(1),
  item: z.string().optional(),
  status: legacyAssignmentStatusSchema,
  createdAt: z.number().nonnegative(),
  updatedAt: z.number().nonnegative(),
  error: z.string().optional(),
}).strict();

const legacyTeamMessageSchema = z.object({
  id: z.string().min(1),
  teamId: z.string().min(1),
  channelId: z.literal(TEAM_CHANNEL_ID),
  seq: z.number().int().positive(),
  channelSeq: z.number().int().positive(),
  sender: z.object({
    actorKind: z.enum(['agent', 'user']),
    actorId: z.string().min(1),
    role: z.enum(['leader', 'member', 'user']),
  }).strict(),
  body: z.string().min(1),
  attachments: z.array(teamMessageAttachmentSchema).max(TEAM_MESSAGE_MAX_ATTACHMENTS).optional(),
  clientMessageId: z.string().min(1),
  assignmentId: z.string().min(1).optional(),
  createdAt: z.number().nonnegative(),
}).strict();

const legacyOperationBase = {
  version: z.literal(TEAM_LEGACY_OPERATION_VERSION),
  seq: z.number().int().positive(),
  at: z.number().nonnegative(),
};

export const legacyTeamOperationSchema = z.discriminatedUnion('type', [
  z.object({ ...legacyOperationBase, type: z.literal('team.created'), team: teamSchema }).strict(),
  z.object({
    ...legacyOperationBase,
    type: z.literal('batch.created'),
    batch: legacyTeamBatchSchema,
    assignments: z.array(legacyTeamAssignmentSchema).min(1),
  }).strict(),
  z.object({
    ...legacyOperationBase,
    type: z.literal('assignment.bound'),
    assignmentId: z.string().min(1),
    agentId: z.string().min(1),
    member: teamMemberSchema,
  }).strict(),
  z.object({
    ...legacyOperationBase,
    type: z.literal('assignment.status'),
    assignmentId: z.string().min(1),
    status: legacyAssignmentStatusSchema,
    error: z.string().optional(),
  }).strict(),
  z.object({
    ...legacyOperationBase,
    type: z.literal('batch.status'),
    batchId: z.string().min(1),
    status: legacyBatchStatusSchema,
  }).strict(),
  z.object({ ...legacyOperationBase, type: z.literal('message.sent'), message: legacyTeamMessageSchema }).strict(),
]);
export type LegacyTeamOperation = z.infer<typeof legacyTeamOperationSchema>;

const operationBase = {
  version: z.literal(TEAM_OPERATION_VERSION),
  seq: z.number().int().positive(),
  at: z.number().nonnegative(),
  operationId: z.string().min(1),
};

export const teamOperationV2Schema = z.discriminatedUnion('type', [
  z.object({
    ...operationBase,
    type: z.literal('team.created'),
    team: teamSchema,
    policy: teamPolicySchema,
    scheduler: teamSchedulerStateSchema,
    budget: teamBudgetReportSchema,
    integration: teamIntegrationStateSchema,
  }).strict(),
  z.object({ ...operationBase, type: z.literal('team.policy_updated'), policy: teamPolicySchema }).strict(),
  z.object({ ...operationBase, type: z.literal('scheduler.updated'), scheduler: teamSchedulerStateSchema }).strict(),
  z.object({
    ...operationBase,
    type: z.literal('batch.created'),
    batch: teamBatchSchema,
    tasks: z.array(teamTaskSchema).min(1),
  }).strict(),
  z.object({
    ...operationBase,
    type: z.literal('task.bound'),
    taskId: z.string().min(1),
    agentId: z.string().min(1),
    member: teamMemberSchema,
  }).strict(),
  z.object({
    ...operationBase,
    type: z.literal('task.status'),
    taskId: z.string().min(1),
    status: teamTaskStatusSchema,
    attemptId: z.string().min(1).optional(),
    blocker: z.string().optional(),
    error: z.string().optional(),
  }).strict(),
  z.object({
    ...operationBase,
    type: z.literal('task.reassigned'),
    taskId: z.string().min(1),
    profileName: z.string().min(1),
    model: z.string().min(1).optional(),
  }).strict(),
  z.object({ ...operationBase, type: z.literal('attempt.started'), attempt: teamAttemptSchema }).strict(),
  z.object({ ...operationBase, type: z.literal('attempt.completed'), attempt: teamAttemptSchema }).strict(),
  z.object({ ...operationBase, type: z.literal('artifact.created'), artifact: teamArtifactSchema }).strict(),
  z.object({ ...operationBase, type: z.literal('review.submitted'), review: teamReviewSchema }).strict(),
  z.object({ ...operationBase, type: z.literal('budget.updated'), budget: teamBudgetReportSchema }).strict(),
  z.object({ ...operationBase, type: z.literal('integration.updated'), integration: teamIntegrationStateSchema }).strict(),
  z.object({
    ...operationBase,
    type: z.literal('batch.status'),
    batchId: z.string().min(1),
    status: teamBatchStatusSchema,
  }).strict(),
  z.object({ ...operationBase, type: z.literal('message.sent'), message: teamMessageSchema }).strict(),
]);
export type TeamOperationV2 = z.infer<typeof teamOperationV2Schema>;

export const teamOperationSchema = z.union([legacyTeamOperationSchema, teamOperationV2Schema]);
export type TeamOperation = z.infer<typeof teamOperationSchema>;

export interface LegacyTeamSnapshot {
  readonly protocolVersion: 1;
  readonly state: 'legacy_readonly' | 'degraded';
  readonly team?: Team;
  readonly members: readonly TeamMember[];
  readonly batches: readonly z.infer<typeof legacyTeamBatchSchema>[];
  readonly assignments: readonly z.infer<typeof legacyTeamAssignmentSchema>[];
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

export interface TeamBatchAssignmentInput {
  readonly assignmentId: string;
  readonly taskKey?: string;
  readonly dependsOn?: readonly string[];
  readonly displayName?: string;
  readonly profileName: string;
  readonly model?: string;
  readonly description: string;
  readonly item?: string;
  readonly prompt?: string;
  readonly workspaceMode?: TeamWorkspaceMode;
  readonly validationMode?: TeamValidationMode;
  readonly resumeAgentId?: string;
}

export interface TeamBatchReceipt {
  readonly batchId: string;
  readonly assignments: readonly TeamTask[];
  readonly tasks: readonly TeamTask[];
}

export interface TeamDelivery {
  readonly teamId: string;
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly messages: readonly TeamMessage[];
  readonly bootstrap?: string;
}

export interface TeamArtifactContent {
  readonly artifact: TeamArtifact;
  readonly dataBase64: string;
}
