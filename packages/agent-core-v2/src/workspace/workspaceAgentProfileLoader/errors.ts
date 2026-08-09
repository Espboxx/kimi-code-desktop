/**
 * `workspaceAgentProfileLoader` domain — coded profile-file creation failures.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const AgentProfileWriterErrors = {
  codes: {
    PROFILE_CREATE_CONFLICT: 'profile.create_conflict',
    PROFILE_CREATE_FAILED: 'profile.create_failed',
    PROFILE_CREATE_FORBIDDEN: 'profile.create_forbidden',
  },
} as const satisfies ErrorDomain;

registerErrorDomain(AgentProfileWriterErrors);
