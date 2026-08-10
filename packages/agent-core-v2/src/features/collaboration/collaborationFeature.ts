/**
 * `collaboration` domain — experimental Team Mode feature assembly.
 *
 * Contributes the session collaboration service, per-agent delivery service,
 * and TeamSend/TeamStatus/TeamWait tools while keeping static flag and wire
 * registrations import-discoverable.
 */

import { IFlagService } from '#/app/flag/flag';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ScopeActivation, type ServicesAccessor } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';
import { IAgentProfileWriter } from '#/workspace/workspaceAgentProfileLoader/agentProfileWriter';
import { AgentProfileWriterService } from '#/workspace/workspaceAgentProfileLoader/agentProfileWriterService';
import { IWorkspaceAgentProfileManager } from '#/workspace/workspaceAgentProfileLoader/workspaceAgentProfileManager';
import { WorkspaceAgentProfileManagerService } from '#/workspace/workspaceAgentProfileLoader/workspaceAgentProfileManagerService';

import { ISessionCollaborationService } from './collaboration';
import { SessionCollaborationService } from './collaborationService';
import { IAgentCollaborationDeliveryService } from './delivery';
import { AgentCollaborationDeliveryService } from './deliveryService';
import './deliveryOps';
import { TEAM_COLLABORATION_FLAG_ID } from './flag';
import { ITeamSendTool, TeamSendTool } from './tools/teamSend';
import { ITeamStatusTool, TeamStatusTool } from './tools/teamStatus';
import { ITeamWaitTool, TeamWaitTool } from './tools/teamWait';
import {
  AgentProfileCreateTool,
  IAgentProfileCreateTool,
} from './tools/agentProfileCreate';

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
    this.contributeService(
      LifecycleScope.Workspace,
      IWorkspaceAgentProfileManager,
      WorkspaceAgentProfileManagerService,
      { activation: ScopeActivation.OnScopeCreated },
    );
    this.contributeService(
      LifecycleScope.Workspace,
      IAgentProfileWriter,
      AgentProfileWriterService,
      { activation: ScopeActivation.OnScopeCreated },
    );
    const when = (accessor: ServicesAccessor) =>
      accessor.get(IFlagService).enabled(TEAM_COLLABORATION_FLAG_ID);
    const whenLeader = (accessor: ServicesAccessor) =>
      when(accessor) && accessor.get(IAgentScopeContext).agentId === 'main';
    this.contributeTool(ITeamSendTool, TeamSendTool, { name: 'TeamSend', domain: 'collaboration', when });
    this.contributeTool(ITeamStatusTool, TeamStatusTool, { name: 'TeamStatus', domain: 'collaboration', when });
    this.contributeTool(ITeamWaitTool, TeamWaitTool, { name: 'TeamWait', domain: 'collaboration', when });
    this.contributeTool(IAgentProfileCreateTool, AgentProfileCreateTool, {
      name: 'AgentProfileCreate',
      domain: 'collaboration',
      when: whenLeader,
    });
  }
}

registerFeature(CollaborationFeature);
