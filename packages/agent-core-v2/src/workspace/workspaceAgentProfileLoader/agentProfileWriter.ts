/**
 * `workspaceAgentProfileLoader` domain — validated agent-profile file writer contract.
 *
 * Creates reusable project or user profile files and refreshes the owning
 * Workspace-scoped loader. Workspace-scoped.
 */

import { createDecorator } from '#/_base/di/instantiation';
import type { AgentModelPreference } from '#/app/agentProfileCatalog/agentProfileCatalog';

export type AgentProfileWriteScope = 'workspace' | 'user';

export interface AgentProfileWriteInput {
  readonly name: string;
  readonly description: string;
  readonly whenToUse: string;
  readonly prompt: string;
  readonly scope: AgentProfileWriteScope;
  readonly tools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly subagents?: readonly string[];
  readonly modelPreference?: AgentModelPreference;
}

export interface AgentProfileWriteResult {
  readonly name: string;
  readonly scope: AgentProfileWriteScope;
  readonly path: string;
  readonly created: boolean;
}

export interface IAgentProfileWriter {
  readonly _serviceBrand: undefined;
  create(input: AgentProfileWriteInput): Promise<AgentProfileWriteResult>;
}

export const IAgentProfileWriter = createDecorator<IAgentProfileWriter>('agentProfileWriter');
