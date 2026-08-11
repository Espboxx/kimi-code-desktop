/**
 * `collaboration` domain — requester-side observer for one durable Team task.
 *
 * Adapts Session-scoped collaboration operations and artifacts to the Agent
 * task contract so the direct delegator receives the standard detached-task
 * completion notification.
 */

import type {
  AgentTask,
  AgentTaskInfoBase,
  AgentTaskSink,
} from '#/agent/task/types';
import type { SubagentTaskInfo } from '#/agent/tools/agent/subagent-task';

import type { ISessionCollaborationService } from './collaboration';
import type { TeamSnapshotV2, TeamTask, TeamTaskStatus } from './types';

const TERMINAL_TASK_STATUSES = new Set<TeamTaskStatus>([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);

const TERMINAL_BATCH_STATUSES = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);

interface TeamAssignmentOutcome {
  readonly status: 'completed' | 'failed' | 'killed';
  readonly stopReason?: string;
  readonly output: string;
}

export class TeamAssignmentTask implements AgentTask {
  readonly kind = 'agent' as const;
  readonly idPrefix = 'team';
  private agentId: string | undefined;

  constructor(
    private readonly collaboration: ISessionCollaborationService,
    private readonly assignment: Pick<
      TeamTask,
      'id' | 'batchId' | 'description' | 'profileName' | 'model' | 'agentId'
    >,
  ) {
    this.agentId = assignment.agentId;
  }

  get description(): string {
    return this.assignment.description;
  }

  async start(sink: AgentTaskSink): Promise<void> {
    let generation = 0;
    let wake: (() => void) | undefined;
    const signalWake = (): void => {
      generation += 1;
      wake?.();
      wake = undefined;
    };
    const waitForChange = (observedGeneration: number): Promise<void> =>
      new Promise<void>((resolve) => {
        wake = resolve;
        if (generation !== observedGeneration) signalWake();
      });
    const operationSubscription = this.collaboration.onDidOperate((operation) => {
      if (operation.type === 'task.bound' && operation.taskId === this.assignment.id) {
        this.agentId = operation.agentId;
      }
      if (
        (operation.type === 'task.bound' && operation.taskId === this.assignment.id)
        || (operation.type === 'task.status' && operation.taskId === this.assignment.id)
        || (operation.type === 'artifact.created' && operation.artifact.taskId === this.assignment.id)
        || (operation.type === 'batch.status' && operation.batchId === this.assignment.batchId)
      ) {
        signalWake();
      }
    });
    const onAbort = (): void => {
      signalWake();
    };
    sink.signal.addEventListener('abort', onAbort, { once: true });

    try {
      while (!sink.signal.aborted) {
        const observedGeneration = generation;
        const outcome = await this.readOutcome();
        if (sink.signal.aborted) break;
        if (outcome !== undefined) {
          sink.appendOutput(outcome.output);
          await sink.settle({ status: outcome.status, stopReason: outcome.stopReason });
          return;
        }
        if (generation !== observedGeneration) continue;
        await waitForChange(observedGeneration);
      }

      await this.cancelDurableTask();
      await sink.settle({ status: 'killed' });
    } catch (error) {
      await sink.settle({
        status: sink.signal.aborted ? 'killed' : 'failed',
        stopReason: sink.signal.aborted ? undefined : errorMessage(error),
      });
    } finally {
      operationSubscription.dispose();
      sink.signal.removeEventListener('abort', onAbort);
    }
  }

  toInfo(base: AgentTaskInfoBase): SubagentTaskInfo {
    return {
      ...base,
      kind: 'agent',
      agentId: this.agentId,
      subagentType: this.assignment.profileName,
      model: this.assignment.model,
    };
  }

  private async readOutcome(): Promise<TeamAssignmentOutcome | undefined> {
    await this.collaboration.ready;
    const snapshot = await this.collaboration.snapshot();
    if (snapshot.protocolVersion !== 2) {
      return {
        status: 'failed',
        stopReason: 'The Team session is no longer writable.',
        output: renderOutcome(this.assignment.id, 'failed', undefined, 'The Team session is no longer writable.'),
      };
    }
    const task = snapshot.tasks.find((candidate) => candidate.id === this.assignment.id);
    if (task === undefined) {
      return {
        status: 'failed',
        stopReason: 'The durable Team task is missing.',
        output: renderOutcome(this.assignment.id, 'failed', undefined, 'The durable Team task is missing.'),
      };
    }
    this.agentId = task.agentId ?? this.agentId;
    const batch = snapshot.batches.find((candidate) => candidate.id === task.batchId);
    const blockedTerminal =
      task.status === 'blocked'
      && batch !== undefined
      && TERMINAL_BATCH_STATUSES.has(batch.status);
    if (!TERMINAL_TASK_STATUSES.has(task.status) && !blockedTerminal) return undefined;

    const report = await this.latestReport(snapshot, task.id);
    const detail = report ?? task.error ?? task.blocker;
    if (task.status === 'completed') {
      return {
        status: 'completed',
        output: renderOutcome(task.id, task.status, task.agentId, detail),
      };
    }
    if (task.status === 'cancelled' || task.status === 'interrupted') {
      const reason = task.error ?? task.blocker;
      return {
        status: 'killed',
        stopReason: reason,
        output: renderOutcome(task.id, task.status, task.agentId, detail),
      };
    }
    const reason = task.error ?? task.blocker ?? 'A dependency ended before this Team task could run.';
    return {
      status: 'failed',
      stopReason: reason,
      output: renderOutcome(task.id, task.status, task.agentId, detail ?? reason),
    };
  }

  private async latestReport(snapshot: TeamSnapshotV2, taskId: string): Promise<string | undefined> {
    const report = snapshot.artifacts.findLast(
      (artifact) => artifact.taskId === taskId && artifact.kind === 'report',
    );
    if (report === undefined) return undefined;
    try {
      const content = await this.collaboration.artifact({ artifactId: report.id });
      return Buffer.from(content.dataBase64, 'base64').toString('utf8');
    } catch {
      return undefined;
    }
  }

  private async cancelDurableTask(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const snapshot = await this.collaboration.snapshot();
        if (snapshot.protocolVersion !== 2) return;
        const task = snapshot.tasks.find((candidate) => candidate.id === this.assignment.id);
        if (task === undefined || TERMINAL_TASK_STATUSES.has(task.status)) return;
        await this.collaboration.cancelTask({ taskId: task.id, expectedSeq: snapshot.latestSeq });
        return;
      } catch {}
    }
  }
}

function renderOutcome(
  taskId: string,
  status: TeamTaskStatus,
  agentId: string | undefined,
  detail: string | undefined,
): string {
  const agentAttribute = agentId === undefined ? '' : ` agent_id="${escapeXmlAttribute(agentId)}"`;
  const body = detail === undefined || detail.trim().length === 0
    ? 'No report was provided.'
    : detail;
  return [
    `<team_task_result task_id="${escapeXmlAttribute(taskId)}"${agentAttribute} status="${status}">`,
    body,
    '</team_task_result>',
  ].join('\n');
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
