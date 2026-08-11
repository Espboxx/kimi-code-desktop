/**
 * `sessionCollaborationService` — versioned Team Mode session contract.
 *
 * Legacy v1 operations remain readable while every new mutation uses the v2
 * task graph, scheduler, budget, artifact, review, and integration schemas.
 */

import { z } from 'zod';

import { maybe } from '../helpers.js';
import type { ServiceContract } from '../types.js';

const teamDisplayNameSchema = z.string().trim().min(1).max(24)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N}_-]{0,23}$/u)
  .refine((name) => name.toLowerCase() !== 'main' && !/^agent-\d+$/i.test(name));

export const teamRoleSchema = z.enum(['leader', 'member']);
export type TeamRole = z.infer<typeof teamRoleSchema>;

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
  'running', 'paused', 'completed', 'failed', 'cancelled', 'interrupted',
]);
export type TeamBatchStatus = z.infer<typeof teamBatchStatusSchema>;

export const teamSchedulerStatusSchema = z.enum([
  'running', 'paused', 'awaiting_apply', 'completed', 'failed', 'cancelled',
]);
export type TeamSchedulerStatus = z.infer<typeof teamSchedulerStatusSchema>;
export const teamWorkspaceModeSchema = z.enum(['shared_readonly', 'isolated_write']);
export const teamValidationModeSchema = z.enum(['none', 'required']);
export type TeamWorkspaceMode = z.infer<typeof teamWorkspaceModeSchema>;
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
export const teamPolicyInputSchema = teamPolicySchema.partial().strict();
export type TeamPolicy = z.infer<typeof teamPolicySchema>;
export type TeamPolicyInput = z.infer<typeof teamPolicyInputSchema>;

export const teamSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  channelId: z.literal('general'),
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

export const teamArtifactContentSchema = z.object({
  artifact: teamArtifactSchema,
  dataBase64: z.string(),
}).strict();
export type TeamArtifactContent = z.infer<typeof teamArtifactContentSchema>;

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
  status: z.enum(['idle', 'preparing', 'integrating', 'awaiting_apply', 'applied', 'discarded', 'conflicted']),
  baselineHead: z.string().min(1).optional(),
  integrationHead: z.string().min(1).optional(),
  diffArtifactId: z.string().min(1).optional(),
  error: z.string().optional(),
  updatedAt: z.number().nonnegative(),
}).strict();
export type TeamIntegrationState = z.infer<typeof teamIntegrationStateSchema>;

export const teamMessageAttachmentSchema = z.object({
  type: z.literal('image_url'),
  url: z.string().min(1).max(4_096),
  name: z.string().min(1).max(255).optional(),
}).strict();
export type TeamMessageAttachment = z.infer<typeof teamMessageAttachmentSchema>;

export const teamMessageSenderSchema = z.object({
  actorKind: z.enum(['agent', 'user', 'system']),
  actorId: z.string().min(1),
  role: z.enum(['leader', 'member', 'user', 'system']),
}).strict();
export type TeamMessageSender = z.infer<typeof teamMessageSenderSchema>;

export const teamMessageSchema = z.object({
  id: z.string().min(1),
  teamId: z.string().min(1),
  channelId: z.literal('general'),
  seq: z.number().int().positive(),
  channelSeq: z.number().int().positive(),
  sender: teamMessageSenderSchema,
  recipientAgentIds: z.array(z.string().min(1)).min(1).max(16).optional(),
  body: z.string().min(1),
  attachments: z.array(teamMessageAttachmentSchema).max(8).optional(),
  clientMessageId: z.string().min(1),
  taskId: z.string().min(1).optional(),
  createdAt: z.number().nonnegative(),
}).strict();
export type TeamMessage = z.infer<typeof teamMessageSchema>;

const legacyBatchStatusSchema = z.enum(['running', 'completed', 'failed', 'cancelled', 'interrupted']);
const legacyAssignmentStatusSchema = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']);
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
  channelId: z.literal('general'),
  seq: z.number().int().positive(),
  channelSeq: z.number().int().positive(),
  sender: z.object({
    actorKind: z.enum(['agent', 'user']),
    actorId: z.string().min(1),
    role: z.enum(['leader', 'member', 'user']),
  }).strict(),
  body: z.string().min(1),
  attachments: z.array(teamMessageAttachmentSchema).max(8).optional(),
  clientMessageId: z.string().min(1),
  assignmentId: z.string().min(1).optional(),
  createdAt: z.number().nonnegative(),
}).strict();

const legacyOperationBase = {
  version: z.literal(1),
  seq: z.number().int().positive(),
  at: z.number().nonnegative(),
};
export const legacyTeamOperationSchema = z.discriminatedUnion('type', [
  z.object({ ...legacyOperationBase, type: z.literal('team.created'), team: teamSchema }).strict(),
  z.object({ ...legacyOperationBase, type: z.literal('batch.created'), batch: legacyTeamBatchSchema, assignments: z.array(legacyTeamAssignmentSchema).min(1) }).strict(),
  z.object({ ...legacyOperationBase, type: z.literal('assignment.bound'), assignmentId: z.string().min(1), agentId: z.string().min(1), member: teamMemberSchema }).strict(),
  z.object({ ...legacyOperationBase, type: z.literal('assignment.status'), assignmentId: z.string().min(1), status: legacyAssignmentStatusSchema, error: z.string().optional() }).strict(),
  z.object({ ...legacyOperationBase, type: z.literal('batch.status'), batchId: z.string().min(1), status: legacyBatchStatusSchema }).strict(),
  z.object({ ...legacyOperationBase, type: z.literal('message.sent'), message: legacyTeamMessageSchema }).strict(),
]);

const operationBase = {
  version: z.literal(2),
  seq: z.number().int().positive(),
  at: z.number().nonnegative(),
  operationId: z.string().min(1),
};
export const teamOperationV2Schema = z.discriminatedUnion('type', [
  z.object({ ...operationBase, type: z.literal('team.created'), team: teamSchema, policy: teamPolicySchema, scheduler: teamSchedulerStateSchema, budget: teamBudgetReportSchema, integration: teamIntegrationStateSchema }).strict(),
  z.object({ ...operationBase, type: z.literal('team.policy_updated'), policy: teamPolicySchema }).strict(),
  z.object({ ...operationBase, type: z.literal('scheduler.updated'), scheduler: teamSchedulerStateSchema }).strict(),
  z.object({ ...operationBase, type: z.literal('batch.created'), batch: teamBatchSchema, tasks: z.array(teamTaskSchema).min(1) }).strict(),
  z.object({ ...operationBase, type: z.literal('task.bound'), taskId: z.string().min(1), agentId: z.string().min(1), member: teamMemberSchema }).strict(),
  z.object({ ...operationBase, type: z.literal('task.status'), taskId: z.string().min(1), status: teamTaskStatusSchema, attemptId: z.string().min(1).optional(), blocker: z.string().optional(), error: z.string().optional() }).strict(),
  z.object({ ...operationBase, type: z.literal('task.reassigned'), taskId: z.string().min(1), profileName: z.string().min(1), model: z.string().min(1).optional() }).strict(),
  z.object({ ...operationBase, type: z.literal('attempt.started'), attempt: teamAttemptSchema }).strict(),
  z.object({ ...operationBase, type: z.literal('attempt.completed'), attempt: teamAttemptSchema }).strict(),
  z.object({ ...operationBase, type: z.literal('artifact.created'), artifact: teamArtifactSchema }).strict(),
  z.object({ ...operationBase, type: z.literal('review.submitted'), review: teamReviewSchema }).strict(),
  z.object({ ...operationBase, type: z.literal('budget.updated'), budget: teamBudgetReportSchema }).strict(),
  z.object({ ...operationBase, type: z.literal('integration.updated'), integration: teamIntegrationStateSchema }).strict(),
  z.object({ ...operationBase, type: z.literal('batch.status'), batchId: z.string().min(1), status: teamBatchStatusSchema }).strict(),
  z.object({ ...operationBase, type: z.literal('message.sent'), message: teamMessageSchema }).strict(),
]);
export type LegacyTeamOperation = z.infer<typeof legacyTeamOperationSchema>;
export type TeamOperationV2 = z.infer<typeof teamOperationV2Schema>;
export const teamOperationSchema = z.union([legacyTeamOperationSchema, teamOperationV2Schema]);
export type TeamOperation = z.infer<typeof teamOperationSchema>;

export const legacyTeamSnapshotSchema = z.object({
  protocolVersion: z.literal(1),
  state: z.enum(['legacy_readonly', 'degraded']),
  team: teamSchema.optional(),
  members: z.array(teamMemberSchema),
  batches: z.array(legacyTeamBatchSchema),
  assignments: z.array(legacyTeamAssignmentSchema),
  latestSeq: z.number().int().nonnegative(),
  latestChannelSeq: z.number().int().nonnegative(),
  degradedReason: z.string().optional(),
}).strict();
export type LegacyTeamSnapshot = z.infer<typeof legacyTeamSnapshotSchema>;

export const teamSnapshotV2Schema = z.object({
  protocolVersion: z.literal(2),
  state: z.enum(['ready', 'degraded']),
  team: teamSchema.optional(),
  members: z.array(teamMemberSchema),
  batches: z.array(teamBatchSchema),
  tasks: z.array(teamTaskSchema),
  assignments: z.array(teamTaskSchema),
  attempts: z.array(teamAttemptSchema),
  artifacts: z.array(teamArtifactSchema),
  reviews: z.array(teamReviewSchema),
  policy: teamPolicySchema,
  scheduler: teamSchedulerStateSchema,
  budget: teamBudgetReportSchema,
  integration: teamIntegrationStateSchema,
  latestSeq: z.number().int().nonnegative(),
  latestChannelSeq: z.number().int().nonnegative(),
  degradedReason: z.string().optional(),
}).strict();
export type TeamSnapshotV2 = z.infer<typeof teamSnapshotV2Schema>;
export const teamSnapshotSchema = z.union([legacyTeamSnapshotSchema, teamSnapshotV2Schema]);
export type TeamSnapshot = z.infer<typeof teamSnapshotSchema>;

const expectedSeqSchema = z.object({ expectedSeq: z.number().int().nonnegative() }).strict();

export const sessionCollaborationContract = {
  ensureTeam: { input: z.tuple([teamPolicyInputSchema]), output: teamSnapshotSchema },
  snapshot: { input: z.tuple([]), output: teamSnapshotSchema },
  operations: {
    input: z.tuple([z.object({ afterSeq: z.number().int().nonnegative(), limit: z.number().int().positive().max(1_000).optional() }).strict()]),
    output: z.array(teamOperationSchema),
  },
  history: {
    input: z.tuple([z.object({ beforeChannelSeq: z.number().int().positive().optional(), limit: z.number().int().positive().max(200).optional() }).strict()]),
    output: z.array(teamMessageSchema),
  },
  sendUserMessage: {
    input: z.tuple([z.object({
      body: z.string().min(1),
      clientMessageId: z.string().min(1),
      attachments: z.array(teamMessageAttachmentSchema).max(8).optional(),
      recipientAgentIds: z.array(z.string().min(1)).min(1).max(16).optional(),
    }).strict()]),
    output: teamMessageSchema,
  },
  updatePolicy: {
    input: z.tuple([z.object({ policy: teamPolicyInputSchema, expectedSeq: z.number().int().nonnegative() }).strict()]),
    output: teamSnapshotSchema,
  },
  pause: {
    input: z.tuple([z.object({ expectedSeq: z.number().int().nonnegative(), reason: z.string().optional() }).strict()]),
    output: teamSnapshotSchema,
  },
  resume: { input: z.tuple([expectedSeqSchema]), output: teamSnapshotSchema },
  cancelTask: {
    input: z.tuple([z.object({ taskId: z.string().min(1), expectedSeq: z.number().int().nonnegative() }).strict()]),
    output: teamSnapshotSchema,
  },
  retryTask: {
    input: z.tuple([z.object({ taskId: z.string().min(1), expectedSeq: z.number().int().nonnegative() }).strict()]),
    output: teamSnapshotSchema,
  },
  reassignTask: {
    input: z.tuple([z.object({ taskId: z.string().min(1), expectedSeq: z.number().int().nonnegative(), profileName: z.string().min(1).optional(), model: z.string().min(1).optional() }).strict()]),
    output: teamSnapshotSchema,
  },
  artifact: {
    input: z.tuple([z.object({ artifactId: z.string().min(1) }).strict()]),
    output: teamArtifactContentSchema,
  },
  previewIntegration: { input: z.tuple([]), output: maybe(teamArtifactContentSchema) },
  applyIntegration: { input: z.tuple([expectedSeqSchema]), output: teamSnapshotSchema },
  discardIntegration: { input: z.tuple([expectedSeqSchema]), output: teamSnapshotSchema },
} satisfies ServiceContract;
