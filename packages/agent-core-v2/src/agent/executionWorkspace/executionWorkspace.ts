/**
 * `executionWorkspace` domain — per-agent workspace boundary.
 *
 * Defines the Agent-scoped cwd and maximum read/write access seeded by agent
 * lifecycle. Team workers may receive isolated worktrees while ordinary
 * agents inherit the session workspace unchanged.
 */

import { isAbsolute, relative, resolve } from 'node:path';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Error2, ErrorCodes } from '#/errors';
import type { ISessionWorkspaceContext, PathAccessOperation } from '#/session/workspaceContext/workspaceContext';

export type AgentWorkspaceAccess = 'read' | 'write';

export interface AgentExecutionWorkspaceInput {
  readonly workDir: string;
  readonly access: AgentWorkspaceAccess;
  readonly confined?: boolean;
  readonly additionalDirs?: readonly string[];
}

export interface IAgentExecutionWorkspace {
  readonly _serviceBrand: undefined;
  readonly workDir: string;
  readonly access: AgentWorkspaceAccess;
  readonly confined: boolean;
  readonly additionalDirs: readonly string[];
  resolve(path: string): string;
  isWithin(path: string): boolean;
  assertAllowed(path: string, operation: PathAccessOperation): string;
  configure(input: AgentExecutionWorkspaceInput): boolean;
}

export const IAgentExecutionWorkspace: ServiceIdentifier<IAgentExecutionWorkspace> =
  createDecorator<IAgentExecutionWorkspace>('agentExecutionWorkspace');

export function makeAgentExecutionWorkspace(
  session: ISessionWorkspaceContext,
  input?: AgentExecutionWorkspaceInput,
): IAgentExecutionWorkspace {
  let state = normalizeWorkspaceInput(session, input);
  const isWithin = (path: string): boolean => {
    const target = resolve(path);
    const roots = [state.workDir, ...state.additionalDirs].map((root) => resolve(root));
    return roots.some((root) => {
      const rel = relative(root, target);
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
    });
  };
  return {
    _serviceBrand: undefined,
    get workDir() { return state.workDir; },
    get access() { return state.access; },
    get confined() { return state.confined; },
    get additionalDirs() { return state.additionalDirs; },
    resolve: (path) => isAbsolute(path) ? resolve(path) : resolve(state.workDir, path),
    isWithin,
    assertAllowed: (path, operation) => {
      const target = isAbsolute(path) ? resolve(path) : resolve(state.workDir, path);
      if (state.confined && !isWithin(target)) {
        throw new Error2(ErrorCodes.FS_PATH_ESCAPES, `Path outside agent workspace (${operation}): ${target}`, {
          details: { operation, path: target },
        });
      }
      if (state.access === 'read' && operation === 'write') {
        throw new Error2(ErrorCodes.COLLABORATION_WORKSPACE_UNAVAILABLE, `Agent workspace is read-only: ${target}`, {
          details: { operation, path: target },
        });
      }
      return target;
    },
    configure: (next) => {
      const normalized = normalizeWorkspaceInput(session, next);
      if (sameWorkspaceInput(state, normalized)) return false;
      state = normalized;
      return true;
    },
  };
}

function normalizeWorkspaceInput(
  session: ISessionWorkspaceContext,
  input?: AgentExecutionWorkspaceInput,
): Required<AgentExecutionWorkspaceInput> {
  return {
    workDir: input?.workDir ?? session.workDir,
    access: input?.access ?? 'write',
    confined: input?.confined ?? false,
    additionalDirs: [...new Set(input?.additionalDirs ?? session.additionalDirs)],
  };
}

function sameWorkspaceInput(
  left: Required<AgentExecutionWorkspaceInput>,
  right: Required<AgentExecutionWorkspaceInput>,
): boolean {
  return left.workDir === right.workDir
    && left.access === right.access
    && left.confined === right.confined
    && left.additionalDirs.length === right.additionalDirs.length
    && left.additionalDirs.every((path, index) => path === right.additionalDirs[index]);
}
