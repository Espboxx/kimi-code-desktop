export type TeamAssignmentStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type TeamBatchStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

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

export interface TeamBatch {
  readonly id: string;
  readonly callerAgentId: string;
  readonly parentAssignmentId?: string;
  readonly status: TeamBatchStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface TeamAssignment {
  readonly id: string;
  readonly batchId: string;
  readonly parentAssignmentId?: string;
  readonly agentId?: string;
  readonly displayName?: string;
  readonly profileName: string;
  readonly model?: string;
  readonly description: string;
  readonly item?: string;
  readonly status: TeamAssignmentStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly error?: string;
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
    readonly actorKind: 'agent' | 'user';
    readonly actorId: string;
    readonly role: 'leader' | 'member' | 'user';
  };
  readonly body: string;
  readonly attachments?: readonly TeamMessageAttachment[];
  readonly clientMessageId: string;
  readonly assignmentId?: string;
  readonly createdAt: number;
}

export type TeamOperation =
  | { readonly version: 1; readonly type: 'team.created'; readonly seq: number; readonly at: number; readonly team: Team }
  | { readonly version: 1; readonly type: 'batch.created'; readonly seq: number; readonly at: number; readonly batch: TeamBatch; readonly assignments: readonly TeamAssignment[] }
  | { readonly version: 1; readonly type: 'assignment.bound'; readonly seq: number; readonly at: number; readonly assignmentId: string; readonly agentId: string; readonly member: TeamMember }
  | { readonly version: 1; readonly type: 'assignment.status'; readonly seq: number; readonly at: number; readonly assignmentId: string; readonly status: TeamAssignmentStatus; readonly error?: string }
  | { readonly version: 1; readonly type: 'batch.status'; readonly seq: number; readonly at: number; readonly batchId: string; readonly status: TeamBatchStatus }
  | { readonly version: 1; readonly type: 'message.sent'; readonly seq: number; readonly at: number; readonly message: TeamMessage };

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
