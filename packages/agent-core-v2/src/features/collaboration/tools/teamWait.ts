/**
 * `collaboration` domain — TeamWait tool contract and implementation.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { toInputJsonSchema } from '#/tool/input-schema';
import { ToolAccesses, type AgentTool, type ToolExecution } from '#/tool/toolContract';

import { ISessionCollaborationService } from '../collaboration';

export const TeamWaitInputSchema = z.object({
  timeout_seconds: z.number().int().min(1).max(300).optional(),
}).strict();
export type TeamWaitInput = z.infer<typeof TeamWaitInputSchema>;

export interface ITeamWaitTool extends AgentTool<TeamWaitInput> { readonly _serviceBrand: undefined }
export const ITeamWaitTool = createDecorator<ITeamWaitTool>('teamWaitTool');

export class TeamWaitTool implements ITeamWaitTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'TeamWait' as const;
  readonly description = 'Wait without polling for the next team message or assignment status change.';
  readonly parameters = toInputJsonSchema(TeamWaitInputSchema);

  constructor(@ISessionCollaborationService private readonly collaboration: ISessionCollaborationService) {}

  resolveExecution(input: TeamWaitInput): ToolExecution {
    return {
      accesses: ToolAccesses.none(),
      description: 'Waiting for team activity',
      approvalRule: this.name,
      execute: async (context) => {
        const snapshot = await this.collaboration.snapshot();
        const operation = await this.collaboration.waitForOperation({
          afterSeq: snapshot.latestSeq,
          timeoutMs: (input.timeout_seconds ?? 60) * 1_000,
          signal: context.signal,
        });
        return {
          output: operation === undefined
            ? JSON.stringify({ timeout: true, afterSeq: snapshot.latestSeq })
            : JSON.stringify({ timeout: false, seq: operation.seq, type: operation.type }),
        };
      },
    };
  }
}
