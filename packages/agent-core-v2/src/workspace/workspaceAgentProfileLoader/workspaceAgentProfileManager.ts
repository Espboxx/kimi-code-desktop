/**
 * `workspaceAgentProfileLoader` domain — structured agent-profile management contract.
 *
 * Lists every effective and suppressed profession visible to a workspace while
 * allowing optimistic create, update, and delete operations only for canonical
 * workspace and user profile files. Workspace-scoped.
 */

import { createDecorator } from '#/_base/di/instantiation';
import type { AgentModelPreference } from '#/app/agentProfileCatalog/agentProfileCatalog';

export type AgentProfileManageScope = 'workspace' | 'user';
export type AgentProfileManagedModelPreference = 'auto' | AgentModelPreference;

export interface AgentProfileDraft {
  readonly name: string;
  readonly description: string;
  readonly whenToUse?: string;
  readonly prompt: string;
  readonly scope: AgentProfileManageScope;
  readonly override?: boolean;
  readonly tools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly subagents?: readonly string[];
  readonly modelPreference?: AgentProfileManagedModelPreference;
}

export interface AgentProfileUpdateInput extends AgentProfileDraft {
  readonly revision: string;
}

export interface AgentProfileDeleteInput {
  readonly name: string;
  readonly scope: AgentProfileManageScope;
  readonly revision: string;
}

export interface AgentProfileDescriptor {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly whenToUse?: string;
  readonly prompt?: string;
  readonly override: boolean;
  readonly tools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly subagents?: readonly string[];
  readonly modelPreference: AgentProfileManagedModelPreference;
  readonly sourceId: string;
  readonly scope?: AgentProfileManageScope;
  readonly editable: boolean;
  readonly effective: boolean;
  readonly path?: string;
  readonly revision?: string;
}

export interface AgentProfileDiagnostic {
  readonly sourceId: string;
  readonly path?: string;
  readonly message: string;
}

export interface AgentProfileListResult {
  readonly profiles: readonly AgentProfileDescriptor[];
  readonly diagnostics: readonly AgentProfileDiagnostic[];
}

export interface AgentProfileMutationResult {
  readonly profile: AgentProfileDescriptor;
  readonly created?: boolean;
}

export interface AgentProfileDeleteResult {
  readonly id: string;
  readonly name: string;
  readonly scope: AgentProfileManageScope;
  readonly deleted: true;
}

export interface IWorkspaceAgentProfileManager {
  readonly _serviceBrand: undefined;

  list(): Promise<AgentProfileListResult>;
  create(input: AgentProfileDraft): Promise<AgentProfileMutationResult>;
  update(input: AgentProfileUpdateInput): Promise<AgentProfileMutationResult>;
  delete(input: AgentProfileDeleteInput): Promise<AgentProfileDeleteResult>;
}

export const IWorkspaceAgentProfileManager =
  createDecorator<IWorkspaceAgentProfileManager>('workspaceAgentProfileManager');
