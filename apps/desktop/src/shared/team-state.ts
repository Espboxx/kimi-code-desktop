import type {
  TeamArtifact,
  TeamAttempt,
  TeamBatch,
  TeamMember,
  TeamMessage,
  TeamOperation,
  TeamReview,
  TeamSnapshot,
  TeamSnapshotV2,
  TeamTask,
} from './team-types';
import { isTeamSnapshotV2 } from './team-types';

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
  if (!isTeamSnapshotV2(state.snapshot) || operations.some((operation) => operation.version !== 2)) {
    return undefined;
  }

  let team = state.snapshot.team;
  let policy = state.snapshot.policy;
  let scheduler = state.snapshot.scheduler;
  let budget = state.snapshot.budget;
  let integration = state.snapshot.integration;
  const members = new Map(state.snapshot.members.map((member) => [member.agentId, member]));
  const batches = new Map(state.snapshot.batches.map((batch) => [batch.id, batch]));
  const tasks = new Map(state.snapshot.tasks.map((task) => [task.id, task]));
  const attempts = new Map(state.snapshot.attempts.map((attempt) => [attempt.id, attempt]));
  const artifacts = new Map(state.snapshot.artifacts.map((artifact) => [artifact.id, artifact]));
  const reviews = new Map(state.snapshot.reviews.map((review) => [review.id, review]));
  const messages = new Map(state.messages.map((message) => [message.id, message]));
  let latestSeq = state.snapshot.latestSeq;
  let latestChannelSeq = state.snapshot.latestChannelSeq;

  for (const operation of operations) {
    if (operation.version !== 2) return undefined;
    latestSeq = operation.seq;
    switch (operation.type) {
      case 'team.created':
        team = operation.team;
        policy = operation.policy;
        scheduler = operation.scheduler;
        budget = operation.budget;
        integration = operation.integration;
        members.set(operation.team.leaderAgentId, {
          agentId: operation.team.leaderAgentId,
          role: 'leader',
          joinedAt: operation.at,
          joinedSeq: operation.seq,
        });
        break;
      case 'team.policy_updated':
        policy = operation.policy;
        break;
      case 'scheduler.updated':
        scheduler = operation.scheduler;
        break;
      case 'batch.created':
        batches.set(operation.batch.id, operation.batch);
        for (const task of operation.tasks) tasks.set(task.id, task);
        break;
      case 'task.bound': {
        members.set(operation.agentId, operation.member);
        const task = tasks.get(operation.taskId);
        if (task !== undefined) {
          tasks.set(task.id, { ...task, agentId: operation.agentId, updatedAt: operation.at });
        }
        break;
      }
      case 'task.status': {
        const task = tasks.get(operation.taskId);
        if (task !== undefined) {
          tasks.set(task.id, {
            ...task,
            status: operation.status,
            currentAttemptId: operation.attemptId ?? task.currentAttemptId,
            blocker: operation.blocker,
            error: operation.error,
            updatedAt: operation.at,
          });
        }
        break;
      }
      case 'task.reassigned': {
        const task = tasks.get(operation.taskId);
        if (task !== undefined) {
          tasks.set(task.id, {
            ...task,
            profileName: operation.profileName,
            model: operation.model,
            updatedAt: operation.at,
          });
        }
        break;
      }
      case 'attempt.started':
      case 'attempt.completed':
        attempts.set(operation.attempt.id, operation.attempt);
        break;
      case 'artifact.created': {
        artifacts.set(operation.artifact.id, operation.artifact);
        const task = operation.artifact.taskId === undefined
          ? undefined
          : tasks.get(operation.artifact.taskId);
        if (task !== undefined && !task.artifactIds.includes(operation.artifact.id)) {
          tasks.set(task.id, {
            ...task,
            artifactIds: [...task.artifactIds, operation.artifact.id],
            updatedAt: operation.at,
          });
        }
        break;
      }
      case 'review.submitted': {
        reviews.set(operation.review.id, operation.review);
        const task = tasks.get(operation.review.taskId);
        if (task !== undefined) {
          tasks.set(task.id, { ...task, reviewId: operation.review.id, updatedAt: operation.at });
        }
        break;
      }
      case 'budget.updated':
        budget = operation.budget;
        break;
      case 'integration.updated':
        integration = operation.integration;
        break;
      case 'batch.status': {
        const batch = batches.get(operation.batchId);
        if (batch !== undefined) {
          batches.set(batch.id, { ...batch, status: operation.status, updatedAt: operation.at });
        }
        break;
      }
      case 'message.sent':
        messages.set(operation.message.id, operation.message);
        latestChannelSeq = Math.max(latestChannelSeq, operation.message.channelSeq);
        break;
    }
  }

  const sortedTasks = sortTasks([...tasks.values()]);
  const snapshot: TeamSnapshotV2 = {
    ...state.snapshot,
    team,
    members: sortMembers([...members.values()]),
    batches: sortBatches([...batches.values()]),
    tasks: sortedTasks,
    assignments: sortedTasks,
    attempts: sortAttempts([...attempts.values()]),
    artifacts: sortArtifacts([...artifacts.values()]),
    reviews: sortReviews([...reviews.values()]),
    policy,
    scheduler,
    budget,
    integration,
    latestSeq,
    latestChannelSeq,
  };
  return {
    snapshot,
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
  return members.toSorted(
    (left, right) => left.joinedSeq - right.joinedSeq || left.agentId.localeCompare(right.agentId),
  );
}

function sortBatches(batches: readonly TeamBatch[]): TeamBatch[] {
  return batches.toSorted(
    (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
  );
}

function sortTasks(tasks: readonly TeamTask[]): TeamTask[] {
  return tasks.toSorted(
    (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
  );
}

function sortAttempts(attempts: readonly TeamAttempt[]): TeamAttempt[] {
  return attempts.toSorted(
    (left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id),
  );
}

function sortArtifacts(artifacts: readonly TeamArtifact[]): TeamArtifact[] {
  return artifacts.toSorted(
    (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
  );
}

function sortReviews(reviews: readonly TeamReview[]): TeamReview[] {
  return reviews.toSorted(
    (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
  );
}
