/**
 * `workspaceAgentProfileLoader` domain — coded profile-file management failures.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const AgentProfileWriterErrors = {
  codes: {
    PROFILE_CREATE_CONFLICT: 'profile.create_conflict',
    PROFILE_CREATE_FAILED: 'profile.create_failed',
    PROFILE_CREATE_FORBIDDEN: 'profile.create_forbidden',
    PROFILE_UPDATE_CONFLICT: 'profile.update_conflict',
    PROFILE_UPDATE_FAILED: 'profile.update_failed',
    PROFILE_DELETE_FAILED: 'profile.delete_failed',
    PROFILE_MANAGE_FORBIDDEN: 'profile.manage_forbidden',
    PROFILE_NOT_FOUND: 'profile.not_found',
  },
} as const satisfies ErrorDomain;

registerErrorDomain(AgentProfileWriterErrors);
