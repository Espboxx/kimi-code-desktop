/**
 * v2 → v1 event translation for the SDK event channel (pure mapping layer).
 *
 * The v2 engine's per-agent `IEventBus` publishes `DomainEvent`s whose
 * payloads are already v1-protocol-shaped — the same shapes the v1 core emits
 * through `Agent.emitEvent` (the run-v2-print runner renders them untranslated
 * for the same reason). What the bus does not carry is the
 * `sessionId` / `agentId` stamping: the bus is per-agent, so the engine-side
 * consumer knows both (kap-server's broadcaster stamps them the same way).
 * This module restores the stamping and reconciles the two streams' type
 * sets: v2-only types are dropped (the v1 `Event` union is closed), the task
 * lifecycle pair is renamed back to the legacy spelling, and the one
 * v1-visible fact the v2 engine publishes on the process-global
 * `IEventService` (`session.meta.updated`) is unwrapped from its
 * `{type, payload}` envelope.
 */
import type { Event } from '@moonshot-ai/agent-core';
import type { AgentActivityState, DomainEvent } from '@moonshot-ai/agent-core-v2';

type AgentStatusEvent = Extract<Event, { type: 'agent.status.updated' }>;
type AgentPhase = NonNullable<AgentStatusEvent['phase']>;

/**
 * DomainEvent types the v1 SDK event stream never carries:
 * - v2-internal facts with no v1 protocol counterpart: `context.spliced`,
 *   `task.notified`, `plan.revision`, and the
 *   `permission.approval.*` pair (v1 surfaces approvals through the
 *   `requestApproval` callback, never as events).
 * - `prompt.*`: the v2 prompt service publishes them on the agent bus, but in
 *   v1 they are synthesized by the daemon services layer onto the global
 *   `IEventService` — the in-process SDK client never sees them.
 */
const DROPPED_DOMAIN_EVENT_TYPES: ReadonlySet<string> = new Set([
  'context.spliced',
  'task.notified',
  'plan.revision',
  'permission.approval.requested',
  'permission.approval.resolved',
  'prompt.submitted',
  'prompt.completed',
  'prompt.aborted',
  'prompt.steered',
]);

/**
 * Type renames needed to reproduce the v1 stream: the v1 core emits task
 * lifecycle facts under the legacy `background.task.*` spelling where v2 uses
 * `task.*`. The payloads are field-identical ports (kap-server fans out both
 * spellings; the v1 SDK client only ever saw the legacy one).
 */
const RENAMED_DOMAIN_EVENT_TYPES: Readonly<Record<string, string>> = {
  'task.started': 'background.task.started',
  'task.terminated': 'background.task.terminated',
};

/**
 * Translate one agent-bus event into the v1 `Event` shape (payload plus the
 * `sessionId` / `agentId` stamping), or `undefined` when the type has no
 * place in the v1 stream (see {@link DROPPED_DOMAIN_EVENT_TYPES}). The cast
 * only bridges the two packages' type declarations — every type not dropped
 * or renamed carries a payload that is field-identical with its v1 protocol
 * counterpart.
 */
export function translateDomainEvent(
  event: DomainEvent,
  sessionId: string,
  agentId: string,
): Event | undefined {
  if (event.type === 'agent.activity.updated') {
    const phase = toLegacyPhase(event);
    if (phase === undefined) return undefined;
    return { type: 'agent.status.updated', phase, sessionId, agentId } as AgentStatusEvent;
  }
  if (
    event.type === 'agent.status.updated' &&
    (event as { readonly phase?: unknown }).phase !== undefined
  ) {
    return undefined;
  }
  if (DROPPED_DOMAIN_EVENT_TYPES.has(event.type)) return undefined;
  const type = RENAMED_DOMAIN_EVENT_TYPES[event.type] ?? event.type;
  return { ...event, type, sessionId, agentId } as unknown as Event;
}

/** Keep the in-process SDK's v1 phase projection aligned with kap-server. */
export function toLegacyPhase(state: AgentActivityState): AgentPhase | undefined {
  const { lifecycle, turn, lastTurn } = state;

  if (turn === undefined && lifecycle === 'ready') {
    if (lastTurn !== undefined) {
      return {
        kind: 'ended',
        turnId: lastTurn.turnId,
        reason: lastTurn.reason,
        durationMs: lastTurn.durationMs,
        at: lastTurn.at,
      };
    }
    return { kind: 'idle' };
  }

  if (lifecycle === 'ready' && turn !== undefined) {
    const latestApproval = turn.pendingApprovals.at(-1);
    if (latestApproval !== undefined) {
      return {
        kind: 'awaiting_approval',
        turnId: turn.turnId,
        step: turn.step || undefined,
        approval: {
          approvalId: latestApproval.approvalId,
          toolCallId: latestApproval.toolCallId,
        },
        since: latestApproval.since,
      };
    }
    if (turn.ending && turn.endingReason !== undefined) {
      return {
        kind: 'interrupted',
        turnId: turn.turnId,
        step: turn.step,
        reason: turn.endingReason,
        at: turn.since,
      };
    }
    switch (turn.phase) {
      case 'running':
        return {
          kind: 'running',
          turnId: turn.turnId,
          step: turn.step,
          stepId: '',
          since: turn.since,
        };
      case 'streaming':
        return {
          kind: 'streaming',
          turnId: turn.turnId,
          step: turn.step,
          stepId: '',
          stream: turn.stream ?? 'assistant',
          since: turn.since,
        };
      case 'retrying':
        return {
          kind: 'retrying',
          turnId: turn.turnId,
          step: turn.step,
          stepId: '',
          failedAttempt: turn.retry?.failedAttempt ?? 0,
          nextAttempt: turn.retry?.nextAttempt ?? 0,
          maxAttempts: turn.retry?.maxAttempts ?? 0,
          delayMs: turn.retry?.delayMs ?? 0,
          errorName: turn.retry?.errorName,
          statusCode: turn.retry?.statusCode,
          since: turn.since,
        };
      case 'tool_call': {
        const latestTool = turn.activeToolCalls.at(-1);
        return {
          kind: 'tool_call',
          turnId: turn.turnId,
          step: turn.step,
          toolCallId: latestTool?.toolCallId ?? '',
          name: latestTool?.name ?? '',
          since: latestTool?.since ?? turn.since,
        };
      }
    }
  }

  return undefined;
}

/**
 * Translate one process-global `IEventService` fact (`{type, payload}`
 * envelope) into the v1 `Event` shape. Only `session.meta.updated` crosses:
 * it is the one fact v1 publishes through the session RPC (the prompt
 * metadata path, with the same payload fields nested under `payload`); every
 * other global-bus type is a daemon/WS-edge event the in-process v1 client
 * never saw.
 */
export function translateGlobalEvent(event: {
  readonly type: string;
  readonly payload: unknown;
}): Event | undefined {
  if (event.type !== 'session.meta.updated' || typeof event.payload !== 'object') {
    return undefined;
  }
  return { type: event.type, ...event.payload } as unknown as Event;
}
