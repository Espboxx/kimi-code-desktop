import type {
  TeamAssignment,
  TeamBatch,
  TeamMember,
  TeamMessage,
  TeamOperation,
  TeamSnapshot,
} from './team-types';

export interface TeamStateSnapshot {
  readonly snapshot: TeamSnapshot;
  readonly messages: readonly TeamMessage[];
}

export function createTeamState(
  snapshot: TeamSnapshot,
  messages: readonly TeamMessage[] = [],
): TeamStateSnapshot {
  return {
    snapshot,
    messages: dedupeMessages(messages).toSorted((left, right) => left.channelSeq - right.channelSeq),
  };
}

export function applyTeamOperations(
  state: TeamStateSnapshot,
  operations: readonly TeamOperation[],
): TeamStateSnapshot | undefined {
  if (!areTeamOperationsContiguous(state.snapshot.latestSeq, operations)) return undefined;
  if (operations.length === 0) return state;

  let team = state.snapshot.team;
  const members = new Map(state.snapshot.members.map((member) => [member.agentId, member]));
  const batches = new Map(state.snapshot.batches.map((batch) => [batch.id, batch]));
  const assignments = new Map(state.snapshot.assignments.map((assignment) => [assignment.id, assignment]));
  const messages = new Map(state.messages.map((message) => [message.id, message]));
  let latestSeq = state.snapshot.latestSeq;
  let latestChannelSeq = state.snapshot.latestChannelSeq;

  for (const operation of operations) {
    latestSeq = operation.seq;
    switch (operation.type) {
      case 'team.created':
        team = operation.team;
        members.set(operation.team.leaderAgentId, {
          agentId: operation.team.leaderAgentId,
          role: 'leader',
          joinedAt: operation.at,
          joinedSeq: operation.seq,
        });
        break;
      case 'batch.created':
        batches.set(operation.batch.id, operation.batch);
        for (const assignment of operation.assignments) assignments.set(assignment.id, assignment);
        break;
      case 'assignment.bound': {
        members.set(operation.agentId, operation.member);
        const assignment = assignments.get(operation.assignmentId);
        if (assignment !== undefined) {
          assignments.set(operation.assignmentId, {
            ...assignment,
            agentId: operation.agentId,
            status: 'running',
            updatedAt: operation.at,
          });
        }
        break;
      }
      case 'assignment.status': {
        const assignment = assignments.get(operation.assignmentId);
        if (assignment !== undefined) {
          assignments.set(operation.assignmentId, {
            ...assignment,
            status: operation.status,
            error: operation.error,
            updatedAt: operation.at,
          });
        }
        break;
      }
      case 'batch.status': {
        const batch = batches.get(operation.batchId);
        if (batch !== undefined) {
          batches.set(operation.batchId, {
            ...batch,
            status: operation.status,
            updatedAt: operation.at,
          });
        }
        break;
      }
      case 'message.sent':
        messages.set(operation.message.id, operation.message);
        latestChannelSeq = Math.max(latestChannelSeq, operation.message.channelSeq);
        break;
    }
  }

  return {
    snapshot: {
      ...state.snapshot,
      team,
      members: sortMembers([...members.values()]),
      batches: sortBatches([...batches.values()]),
      assignments: sortAssignments([...assignments.values()]),
      latestSeq,
      latestChannelSeq,
    },
    messages: [...messages.values()].toSorted((left, right) => left.channelSeq - right.channelSeq),
  };
}

export function areTeamOperationsContiguous(
  afterSeq: number,
  operations: readonly TeamOperation[],
): boolean {
  return operations.every((operation, index) => operation.seq === afterSeq + index + 1);
}

function dedupeMessages(messages: readonly TeamMessage[]): readonly TeamMessage[] {
  return [...new Map(messages.map((message) => [message.id, message])).values()];
}

function sortMembers(members: readonly TeamMember[]): TeamMember[] {
  return members.toSorted((left, right) => left.joinedSeq - right.joinedSeq || left.agentId.localeCompare(right.agentId));
}

function sortBatches(batches: readonly TeamBatch[]): TeamBatch[] {
  return batches.toSorted((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}

function sortAssignments(assignments: readonly TeamAssignment[]): TeamAssignment[] {
  return assignments.toSorted((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}
