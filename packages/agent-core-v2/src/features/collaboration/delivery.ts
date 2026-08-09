/**
 * `collaboration` domain — Agent-scope team-message delivery contract.
 */

import { createDecorator } from '#/_base/di/instantiation';

export interface IAgentCollaborationDeliveryService {
  readonly _serviceBrand: undefined;
}

export const IAgentCollaborationDeliveryService =
  createDecorator<IAgentCollaborationDeliveryService>('agentCollaborationDeliveryService');
