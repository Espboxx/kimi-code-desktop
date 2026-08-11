/**
 * `collaboration` domain — Agent-scoped Team delegation policy.
 *
 * Vetoes ordinary Agent tool calls through `toolExecutor` while the
 * Session-scoped collaboration service owns an active Team. Bound at Agent
 * scope by `CollaborationFeature`.
 */

import { createDecorator } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import { denyToolExecution } from '#/agent/toolExecutor/beforeToolExecuteEvent';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';

import { ISessionCollaborationService } from './collaboration';

export interface IAgentCollaborationPolicyService {
  readonly _serviceBrand: undefined;
}

export const IAgentCollaborationPolicyService =
  createDecorator<IAgentCollaborationPolicyService>('agentCollaborationPolicyService');

export class AgentCollaborationPolicyService extends Service implements IAgentCollaborationPolicyService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
    @ISessionCollaborationService collaboration: ISessionCollaborationService,
  ) {
    super();
    this._register(
      toolExecutor.onBeforeExecuteTool((event) => {
        if (event.toolCall.name !== 'Agent') return;
        event.waitUntil(async () => {
          await collaboration.ready;
          if (!collaboration.isActive()) return undefined;
          return {
            veto: denyToolExecution(
              'Ordinary Agent delegation is disabled while Team Mode is active. ' +
              'Use AgentSwarm as the only tool call so every child assignment is durable and its completion notifies the direct delegator automatically.',
            ),
          };
        });
      }),
    );
  }
}
