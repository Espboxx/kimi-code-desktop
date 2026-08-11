/**
 * `collaboration` domain — durable worker report submission tool.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { toInputJsonSchema } from '#/tool/input-schema';
import { ToolAccesses, type AgentTool, type ToolExecution } from '#/tool/toolContract';

import { ISessionCollaborationService } from '../collaboration';

export const TeamTaskReportInputSchema = z.object({
  task_id: z.string().min(1),
  summary: z.string().trim().min(1).max(16_384),
}).strict();
export type TeamTaskReportInput = z.infer<typeof TeamTaskReportInputSchema>;

export interface ITeamTaskReportTool extends AgentTool<TeamTaskReportInput> {
  readonly _serviceBrand: undefined;
}
export const ITeamTaskReportTool = createDecorator<ITeamTaskReportTool>('teamTaskReportTool');

export class TeamTaskReportTool implements ITeamTaskReportTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'TeamTaskReport' as const;
  readonly description =
    'Persist the result and verification summary for your active Team task before finishing the run.';
  readonly parameters = toInputJsonSchema(TeamTaskReportInputSchema);
  private readonly agentId: string;

  constructor(
    @IAgentScopeContext scope: IAgentScopeContext,
    @ISessionCollaborationService private readonly collaboration: ISessionCollaborationService,
  ) {
    this.agentId = scope.agentId;
  }

  resolveExecution(input: TeamTaskReportInput): ToolExecution {
    return {
      accesses: ToolAccesses.none(),
      description: `Reporting Team task ${input.task_id}`,
      approvalRule: this.name,
      execute: async () => {
        await this.collaboration.submitTaskReport({
          agentId: this.agentId,
          taskId: input.task_id,
          summary: input.summary,
        });
        return { output: JSON.stringify({ submitted: true, taskId: input.task_id }) };
      },
    };
  }
}
