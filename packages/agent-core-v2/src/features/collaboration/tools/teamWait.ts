/**
 * `collaboration` domain — TeamWait tool contract and implementation.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
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
  readonly description =
    'Wait without polling for one explicit Team synchronization event. Child task completion already notifies and wakes the direct delegator automatically, so do not use TeamWait merely to await AgentSwarm work.';
  readonly parameters = toInputJsonSchema(TeamWaitInputSchema);

  private readonly agentId: string;

  constructor(
    @ISessionCollaborationService private readonly collaboration: ISessionCollaborationService,
    @IAgentScopeContext scope?: IAgentScopeContext,
  ) {
    this.agentId = scope?.agentId ?? 'main';
  }

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
          agentId: this.agentId,
        });
        return {
          output: operation === undefined
            ? JSON.stringify({ timeout: true, afterSeq: snapshot.latestSeq })
            : JSON.stringify({ timeout: false, operation }),
        };
      },
    };
  }
}
