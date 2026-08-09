/**
 * `collaboration` domain — Team Mode experimental flag contribution.
 */

import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const TEAM_COLLABORATION_FLAG_ID = 'team_collaboration';

export const teamCollaborationFlag: FlagDefinitionInput = {
  id: TEAM_COLLABORATION_FLAG_ID,
  title: 'Team collaboration',
  description: 'Enable durable Team Mode channels and non-blocking AgentSwarm coordination.',
  env: 'KIMI_CODE_EXPERIMENTAL_TEAM_COLLABORATION',
  default: false,
  surface: 'both',
};

registerFlagDefinition(teamCollaborationFlag);
