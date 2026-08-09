/**
 * `sessionCollaborationService` — strict Team Mode session contract.
 */

import { z } from 'zod';

import type { ServiceContract } from '../types.js';

export const teamAssignmentStatusSchema = z.enum([
  'queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted',
]);
export type TeamAssignmentStatus = z.infer<typeof teamAssignmentStatusSchema>;
export const teamBatchStatusSchema = z.enum([
  'running', 'completed', 'failed', 'cancelled', 'interrupted',
]);
export type TeamBatchStatus = z.infer<typeof teamBatchStatusSchema>;
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
  role: z.enum(['leader', 'member']),
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
  profileName: z.string().min(1),
  description: z.string().min(1),
  item: z.string().optional(),
  status: teamAssignmentStatusSchema,
  createdAt: z.number().nonnegative(),
  updatedAt: z.number().nonnegative(),
  error: z.string().optional(),
}).strict();
export type TeamAssignment = z.infer<typeof teamAssignmentSchema>;
export const teamMessageSchema = z.object({
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
  clientMessageId: z.string().min(1),
  assignmentId: z.string().min(1).optional(),
  createdAt: z.number().nonnegative(),
}).strict();
export type TeamMessage = z.infer<typeof teamMessageSchema>;

const operationBase = {
  version: z.literal(1),
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
  z.object({ ...operationBase, type: z.literal('message.sent'), message: teamMessageSchema }).strict(),
]);
export type TeamOperation = z.infer<typeof teamOperationSchema>;

export const teamSnapshotSchema = z.object({
  state: z.enum(['ready', 'degraded']),
  team: teamSchema.optional(),
  members: z.array(teamMemberSchema),
  batches: z.array(teamBatchSchema),
  assignments: z.array(teamAssignmentSchema),
  latestSeq: z.number().int().nonnegative(),
  latestChannelSeq: z.number().int().nonnegative(),
  degradedReason: z.string().optional(),
}).strict();
export type TeamSnapshot = z.infer<typeof teamSnapshotSchema>;

export const sessionCollaborationContract = {
  snapshot: { input: z.tuple([]), output: teamSnapshotSchema },
  operations: {
    input: z.tuple([z.object({
      afterSeq: z.number().int().nonnegative(),
      limit: z.number().int().positive().max(1_000).optional(),
    }).strict()]),
    output: z.array(teamOperationSchema),
  },
  history: {
    input: z.tuple([z.object({
      beforeChannelSeq: z.number().int().positive().optional(),
      limit: z.number().int().positive().max(200).optional(),
    }).strict()]),
    output: z.array(teamMessageSchema),
  },
  sendUserMessage: {
    input: z.tuple([z.object({ body: z.string().min(1), clientMessageId: z.string().min(1) }).strict()]),
    output: teamMessageSchema,
  },
} satisfies ServiceContract;
