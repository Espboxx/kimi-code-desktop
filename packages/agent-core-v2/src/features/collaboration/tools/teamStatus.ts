/**
 * `collaboration` domain — TeamStatus tool contract and implementation.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { toInputJsonSchema } from '#/tool/input-schema';
import { ToolAccesses, type AgentTool, type ToolExecution } from '#/tool/toolContract';

import { ISessionCollaborationService } from '../collaboration';

export const TeamStatusInputSchema = z.object({}).strict();
export type TeamStatusInput = z.infer<typeof TeamStatusInputSchema>;

export interface ITeamStatusTool extends AgentTool<TeamStatusInput> { readonly _serviceBrand: undefined }
export const ITeamStatusTool = createDecorator<ITeamStatusTool>('teamStatusTool');

export class TeamStatusTool implements ITeamStatusTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'TeamStatus' as const;
  readonly description = 'Read a compact summary of team members, batches, and assignments.';
  readonly parameters = toInputJsonSchema(TeamStatusInputSchema);

  constructor(@ISessionCollaborationService private readonly collaboration: ISessionCollaborationService) {}

  resolveExecution(_input: TeamStatusInput): ToolExecution {
    return {
      accesses: ToolAccesses.none(),
      description: 'Reading team status',
      approvalRule: this.name,
      execute: async () => {
        const snapshot = await this.collaboration.snapshot();
        return {
          output: JSON.stringify({
            state: snapshot.state,
            team: snapshot.team,
            latestSeq: snapshot.latestSeq,
            members: snapshot.members,
            batches: snapshot.batches.filter((batch) => batch.status === 'running'),
            assignments: snapshot.assignments.map(({ id, batchId, parentAssignmentId, agentId, description, status, error }) => ({
              id,
              batchId,
              parentAssignmentId,
              agentId,
              description,
              status,
              error,
            })),
          }, null, 2),
        };
      },
    };
  }
}
