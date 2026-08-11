/**
 * `collaboration` domain — Team task worktree and integration contract.
 *
 * Defines the Session-scoped Git isolation capability used by the coordinator
 * to prepare worker/validator workspaces, commit candidates, integrate them,
 * preview the aggregate diff, and apply or discard it.
 */

import { createDecorator } from '#/_base/di/instantiation';
import type { AgentExecutionWorkspaceInput } from '#/agent/executionWorkspace/executionWorkspace';
import type { TeamIntegrationState, TeamWorkspaceMode } from './types';

export interface TeamPreparedWorkspace {
  readonly execution: AgentExecutionWorkspaceInput;
  readonly path: string;
  readonly head?: string;
}

export interface TeamCandidate {
  readonly workspacePath: string;
  readonly candidateHead: string;
  readonly patch: Uint8Array;
}

export interface ITeamWorkspaceService {
  readonly _serviceBrand: undefined;
  prepareTask(input: {
    readonly taskId: string;
    readonly mode: TeamWorkspaceMode;
    readonly integration: TeamIntegrationState;
    readonly resumeHead?: string;
  }): Promise<{ readonly workspace: TeamPreparedWorkspace; readonly integration: TeamIntegrationState }>;
  finalizeTask(input: {
    readonly taskId: string;
    readonly workspacePath: string;
    readonly baseHead?: string;
  }): Promise<TeamCandidate>;
  prepareValidation(input: { readonly taskId: string; readonly candidateHead: string }): Promise<TeamPreparedWorkspace>;
  integrate(input: { readonly candidateHead: string; readonly integration: TeamIntegrationState }): Promise<TeamIntegrationState>;
  preview(integration: TeamIntegrationState): Promise<Uint8Array | undefined>;
  apply(integration: TeamIntegrationState): Promise<void>;
  discard(integration: TeamIntegrationState, taskIds: readonly string[]): Promise<void>;
}

export const ITeamWorkspaceService = createDecorator<ITeamWorkspaceService>('teamWorkspaceService');
