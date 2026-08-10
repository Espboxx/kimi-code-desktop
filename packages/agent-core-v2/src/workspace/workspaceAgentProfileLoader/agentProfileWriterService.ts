/**
 * `workspaceAgentProfileLoader` domain — validated agent-profile file writer.
 *
 * Preserves the original create-only contract as a compatibility adapter over
 * the structured workspace profile manager. Workspace-scoped.
 */

import {
  IAgentProfileWriter,
  type AgentProfileWriteInput,
  type AgentProfileWriteResult,
} from './agentProfileWriter';
import { IWorkspaceAgentProfileManager } from './workspaceAgentProfileManager';

export class AgentProfileWriterService implements IAgentProfileWriter {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IWorkspaceAgentProfileManager private readonly manager: IWorkspaceAgentProfileManager,
  ) {}

  async create(input: AgentProfileWriteInput): Promise<AgentProfileWriteResult> {
    const result = await this.manager.create({ ...input });
    return {
      name: result.profile.name,
      scope: input.scope,
      path: result.profile.path ?? `${input.scope === 'user' ? 'agents' : '.kimi-code/agents'}/${input.name}.md`,
      created: result.created === true,
    };
  }
}
