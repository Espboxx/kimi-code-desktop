/**
 * `collaboration` domain — leader-only structured teammate-question answer tool.
 *
 * Uses the Agent scope identity to answer through the Session-scoped
 * collaboration service. Contributed at Agent scope by `CollaborationFeature`.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { toInputJsonSchema } from '#/tool/input-schema';
import { ToolAccesses, type AgentTool, type ToolExecution } from '#/tool/toolContract';

import { ISessionCollaborationService } from '../collaboration';

export const TeamAnswerQuestionInputSchema = z.object({
  question_id: z.string().min(1),
  answers: z.array(z.object({
    question: z.string().min(1),
    answer: z.string().min(1),
  }).strict()).min(1).max(4),
}).strict();
export type TeamAnswerQuestionInput = z.infer<typeof TeamAnswerQuestionInputSchema>;

export interface ITeamAnswerQuestionTool extends AgentTool<TeamAnswerQuestionInput> {
  readonly _serviceBrand: undefined;
}
export const ITeamAnswerQuestionTool =
  createDecorator<ITeamAnswerQuestionTool>('teamAnswerQuestionTool');

export class TeamAnswerQuestionTool implements ITeamAnswerQuestionTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'TeamAnswerQuestion' as const;
  readonly description =
    'Answer a structured AskUserQuestion sent by a teammate. Copy question_id and every original question text from the Team message; provide one non-empty answer for each. Multi-select answers use comma-separated labels, and free-form answers are accepted.';
  readonly parameters = toInputJsonSchema(TeamAnswerQuestionInputSchema);
  private readonly agentId: string;

  constructor(
    @IAgentScopeContext scope: IAgentScopeContext,
    @ISessionCollaborationService private readonly collaboration: ISessionCollaborationService,
  ) {
    this.agentId = scope.agentId;
  }

  resolveExecution(input: TeamAnswerQuestionInput): ToolExecution {
    return {
      accesses: ToolAccesses.none(),
      description: 'Answering a teammate question',
      approvalRule: this.name,
      execute: async () => {
        const questions = input.answers.map((answer) => answer.question);
        if (new Set(questions).size !== questions.length) {
          return {
            isError: true,
            output: 'Each original question text must appear exactly once.',
          };
        }
        const message = await this.collaboration.answerLeaderQuestion({
          leaderAgentId: this.agentId,
          questionId: input.question_id,
          answers: Object.fromEntries(
            input.answers.map((answer) => [answer.question, answer.answer]),
          ),
        });
        return {
          output: JSON.stringify({
            answered: true,
            id: message.id,
            seq: message.seq,
            channelSeq: message.channelSeq,
          }),
        };
      },
    };
  }
}
