/**
 * `collaboration` domain — coded Team Mode failures.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const CollaborationErrors = {
  codes: {
    COLLABORATION_NOT_ENABLED: 'collaboration.not_enabled',
    COLLABORATION_NO_TEAM: 'collaboration.no_team',
    COLLABORATION_NOT_MEMBER: 'collaboration.not_member',
    COLLABORATION_MESSAGE_TOO_LARGE: 'collaboration.message_too_large',
    COLLABORATION_RATE_LIMITED: 'collaboration.rate_limited',
    COLLABORATION_IDEMPOTENCY_CONFLICT: 'collaboration.idempotency_conflict',
    COLLABORATION_PERSISTENCE_FAILED: 'collaboration.persistence_failed',
    COLLABORATION_DEGRADED_READ_ONLY: 'collaboration.degraded_read_only',
    COLLABORATION_LEGACY_READ_ONLY: 'collaboration.legacy_read_only',
    COLLABORATION_STALE_STATE: 'collaboration.stale_state',
    COLLABORATION_TASK_NOT_FOUND: 'collaboration.task_not_found',
    COLLABORATION_INVALID_GRAPH: 'collaboration.invalid_graph',
    COLLABORATION_BUDGET_EXHAUSTED: 'collaboration.budget_exhausted',
    COLLABORATION_WORKSPACE_UNAVAILABLE: 'collaboration.workspace_unavailable',
    COLLABORATION_INTEGRATION_CONFLICT: 'collaboration.integration_conflict',
  },
  retryable: [
    'collaboration.rate_limited',
    'collaboration.persistence_failed',
  ],
} as const satisfies ErrorDomain;

registerErrorDomain(CollaborationErrors);
