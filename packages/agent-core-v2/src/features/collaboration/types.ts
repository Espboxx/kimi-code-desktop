/**
 * `collaboration` domain — versioned Team Mode data contracts.
 *
 * Defines the session-owned team, member, batch, assignment, message, and
 * append-log operation shapes shared by the core service and edge adapters.
 */

import { z } from 'zod';

export const TEAM_CHANNEL_ID = 'general' as const;
export const TEAM_OPERATION_VERSION = 1 as const;
export const TEAM_MESSAGE_MAX_BYTES = 8 * 1024;
export const TEAM_HISTORY_DEFAULT_LIMIT = 100;
export const TEAM_HISTORY_MAX_LIMIT = 200;
export const TEAM_OPERATION_MAX_LIMIT = 1_000;
export const TEAM_DELIVERY_MAX_MESSAGES = 20;
export const TEAM_DELIVERY_MAX_BYTES = 24 * 1024;

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

export const teamAssignmentStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);
export type TeamAssignmentStatus = z.infer<typeof teamAssignmentStatusSchema>;

export const teamBatchStatusSchema = z.enum([
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);
export type TeamBatchStatus = z.infer<typeof teamBatchStatusSchema>;

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
  parentAssignmentId: z.string().min(1).optional(),
  status: teamBatchStatusSchema,
  createdAt: z.number().nonnegative(),
  updatedAt: z.number().nonnegative(),
}).strict();
export type TeamBatch = z.infer<typeof teamBatchSchema>;

export const teamAssignmentSchema = z.object({
  id: z.string().min(1),
  batchId: z.string().min(1),
  parentAssignmentId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  displayName: teamDisplayNameSchema.optional(),
  profileName: z.string().min(1),
  model: z.string().min(1).optional(),
  description: z.string().min(1),
  item: z.string().optional(),
  status: teamAssignmentStatusSchema,
  createdAt: z.number().nonnegative(),
  updatedAt: z.number().nonnegative(),
  error: z.string().optional(),
}).strict();
export type TeamAssignment = z.infer<typeof teamAssignmentSchema>;

export const teamMessageSenderSchema = z.object({
  actorKind: z.enum(['agent', 'user']),
  actorId: z.string().min(1),
  role: z.enum(['leader', 'member', 'user']),
}).strict();
export type TeamMessageSender = z.infer<typeof teamMessageSenderSchema>;

export const teamMessageSchema = z.object({
  id: z.string().min(1),
  teamId: z.string().min(1),
  channelId: z.literal(TEAM_CHANNEL_ID),
  seq: z.number().int().positive(),
  channelSeq: z.number().int().positive(),
  sender: teamMessageSenderSchema,
  body: z.string().min(1),
  clientMessageId: z.string().min(1),
  assignmentId: z.string().min(1).optional(),
  createdAt: z.number().nonnegative(),
}).strict();
export type TeamMessage = z.infer<typeof teamMessageSchema>;

const operationBase = {
  version: z.literal(TEAM_OPERATION_VERSION),
  seq: z.number().int().positive(),
  at: z.number().nonnegative(),
};

export const teamOperationSchema = z.discriminatedUnion('type', [
  z.object({ ...operationBase, type: z.literal('team.created'), team: teamSchema }).strict(),
  z.object({
    ...operationBase,
    type: z.literal('batch.created'),
    batch: teamBatchSchema,
    assignments: z.array(teamAssignmentSchema).min(1),
  }).strict(),
  z.object({
    ...operationBase,
    type: z.literal('assignment.bound'),
    assignmentId: z.string().min(1),
    agentId: z.string().min(1),
    member: teamMemberSchema,
  }).strict(),
  z.object({
    ...operationBase,
    type: z.literal('assignment.status'),
    assignmentId: z.string().min(1),
    status: teamAssignmentStatusSchema,
    error: z.string().optional(),
  }).strict(),
  z.object({
    ...operationBase,
    type: z.literal('batch.status'),
    batchId: z.string().min(1),
    status: teamBatchStatusSchema,
  }).strict(),
  z.object({
    ...operationBase,
    type: z.literal('message.sent'),
    message: teamMessageSchema,
  }).strict(),
]);
export type TeamOperation = z.infer<typeof teamOperationSchema>;

export interface TeamSnapshot {
  readonly state: 'ready' | 'degraded';
  readonly team?: Team;
  readonly members: readonly TeamMember[];
  readonly batches: readonly TeamBatch[];
  readonly assignments: readonly TeamAssignment[];
  readonly latestSeq: number;
  readonly latestChannelSeq: number;
  readonly degradedReason?: string;
}

export interface TeamBatchAssignmentInput {
  readonly assignmentId: string;
  readonly displayName?: string;
  readonly profileName: string;
  readonly model?: string;
  readonly description: string;
  readonly item?: string;
  readonly resumeAgentId?: string;
}

export interface TeamBatchReceipt {
  readonly batchId: string;
  readonly assignments: readonly TeamAssignment[];
}

export interface TeamDelivery {
  readonly teamId: string;
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly messages: readonly TeamMessage[];
  readonly bootstrap?: string;
}
