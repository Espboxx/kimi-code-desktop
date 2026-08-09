/**
 * `collaboration` domain — TeamSend tool contract and implementation.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { toInputJsonSchema } from '#/tool/input-schema';
import { ToolAccesses, type AgentTool, type ToolExecution } from '#/tool/toolContract';

import { ISessionCollaborationService } from '../collaboration';

export const TeamSendInputSchema = z.object({ message: z.string().min(1) }).strict();
export type TeamSendInput = z.infer<typeof TeamSendInputSchema>;

export interface ITeamSendTool extends AgentTool<TeamSendInput> { readonly _serviceBrand: undefined }
export const ITeamSendTool = createDecorator<ITeamSendTool>('teamSendTool');

export class TeamSendTool implements ITeamSendTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'TeamSend' as const;
  readonly description =
    'Send a plan, dependency, finding, blocker, or final handoff to the current session team general channel.';
  readonly parameters = toInputJsonSchema(TeamSendInputSchema);
  private readonly agentId: string;

  constructor(
    @IAgentScopeContext scope: IAgentScopeContext,
    @ISessionCollaborationService private readonly collaboration: ISessionCollaborationService,
  ) {
    this.agentId = scope.agentId;
  }

  resolveExecution(input: TeamSendInput): ToolExecution {
    return {
      accesses: ToolAccesses.none(),
      description: 'Sending a team message',
      approvalRule: this.name,
      execute: async (context) => {
        const message = await this.collaboration.sendAgentMessage({
          agentId: this.agentId,
          body: input.message,
          clientMessageId: context.toolCallId,
        });
        return { output: JSON.stringify({ sent: true, id: message.id, seq: message.seq, channelSeq: message.channelSeq }) };
      },
    };
  }
}
