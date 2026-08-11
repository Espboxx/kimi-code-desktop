/**
 * `collaboration` domain — independent validator decision tool.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { toInputJsonSchema } from '#/tool/input-schema';
import { ToolAccesses, type AgentTool, type ToolExecution } from '#/tool/toolContract';

import { ISessionCollaborationService } from '../collaboration';

export const TeamReviewSubmitInputSchema = z.object({
  task_id: z.string().min(1),
  decision: z.enum(['approved', 'changes_requested', 'rejected']),
  summary: z.string().trim().min(1).max(16_384),
}).strict();
export type TeamReviewSubmitInput = z.infer<typeof TeamReviewSubmitInputSchema>;

export interface ITeamReviewSubmitTool extends AgentTool<TeamReviewSubmitInput> {
  readonly _serviceBrand: undefined;
}
export const ITeamReviewSubmitTool = createDecorator<ITeamReviewSubmitTool>('teamReviewSubmitTool');

export class TeamReviewSubmitTool implements ITeamReviewSubmitTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'TeamReviewSubmit' as const;
  readonly description =
    'Submit the independent validation decision and evidence for the assigned Team task.';
  readonly parameters = toInputJsonSchema(TeamReviewSubmitInputSchema);
  private readonly agentId: string;

  constructor(
    @IAgentScopeContext scope: IAgentScopeContext,
    @ISessionCollaborationService private readonly collaboration: ISessionCollaborationService,
  ) {
    this.agentId = scope.agentId;
  }

  resolveExecution(input: TeamReviewSubmitInput): ToolExecution {
    return {
      accesses: ToolAccesses.none(),
      description: `Reviewing Team task ${input.task_id}`,
      approvalRule: this.name,
      execute: async () => {
        const review = await this.collaboration.submitReview({
          reviewerAgentId: this.agentId,
          taskId: input.task_id,
          decision: input.decision,
          summary: input.summary,
        });
        return {
          output: JSON.stringify({
            submitted: true,
            reviewId: review.id,
            taskId: review.taskId,
            decision: review.decision,
          }),
        };
      },
    };
  }
}
