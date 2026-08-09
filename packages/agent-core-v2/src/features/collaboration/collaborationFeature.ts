/**
 * `collaboration` domain — experimental Team Mode feature assembly.
 *
 * Contributes the session collaboration service, per-agent delivery service,
 * and TeamSend/TeamStatus/TeamWait tools while keeping static flag and wire
 * registrations import-discoverable.
 */

import { IFlagService } from '#/app/flag/flag';
import type { ServicesAccessor } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import { ISessionCollaborationService } from './collaboration';
import { SessionCollaborationService } from './collaborationService';
import { IAgentCollaborationDeliveryService } from './delivery';
import { AgentCollaborationDeliveryService } from './deliveryService';
import './deliveryOps';
import { TEAM_COLLABORATION_FLAG_ID } from './flag';
import { ITeamSendTool, TeamSendTool } from './tools/teamSend';
import { ITeamStatusTool, TeamStatusTool } from './tools/teamStatus';
import { ITeamWaitTool, TeamWaitTool } from './tools/teamWait';

export class CollaborationFeature extends Feature {
  static override readonly name = 'collaboration';

  constructor() {
    super();
    this.contributeService(
      LifecycleScope.Session,
      ISessionCollaborationService,
      SessionCollaborationService,
    );
    this.contributeAgentService(
      IAgentCollaborationDeliveryService,
      AgentCollaborationDeliveryService,
    );
    const when = (accessor: ServicesAccessor) =>
      accessor.get(IFlagService).enabled(TEAM_COLLABORATION_FLAG_ID);
    this.contributeTool(ITeamSendTool, TeamSendTool, { name: 'TeamSend', domain: 'collaboration', when });
    this.contributeTool(ITeamStatusTool, TeamStatusTool, { name: 'TeamStatus', domain: 'collaboration', when });
    this.contributeTool(ITeamWaitTool, TeamWaitTool, { name: 'TeamWait', domain: 'collaboration', when });
  }
}

registerFeature(CollaborationFeature);
