/**
 * `collaboration` domain — Agent-scoped Team model-request budget guard.
 *
 * Registers at the generic LLM requester boundary so every provider attempt,
 * including retries and recovery projections, checks the shared Team budget
 * immediately before launch and records usage immediately after completion.
 */

import { createDecorator } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import { IAgentLLMRequesterService } from '#/agent/llmRequester/llmRequester';

import { ISessionCollaborationService } from './collaboration';

export interface ITeamBudgetGuardService {
  readonly _serviceBrand: undefined;
}

export const ITeamBudgetGuardService =
  createDecorator<ITeamBudgetGuardService>('teamBudgetGuardService');

export class TeamBudgetGuardService extends Service implements ITeamBudgetGuardService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentLLMRequesterService requester: IAgentLLMRequesterService,
    @ISessionCollaborationService collaboration: ISessionCollaborationService,
  ) {
    super();
    this._register(requester.hooks.onWillRequest.register('teamBudget', async (_context, next) => {
      await collaboration.assertModelRequestAllowed();
      await next();
    }));
    this._register(requester.hooks.onDidRequest.register('teamBudget', async (context, next) => {
      await collaboration.recordModelRequestUsage(context.finish.usage);
      await next();
    }));
  }
}
