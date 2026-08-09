/**
 * `workspaceAgentProfileLoader` domain — validated agent-profile file writer.
 *
 * Resolves project and Kimi-home roots through `workspaceContext` and
 * `bootstrap`, writes through `hostFs`, validates with the agent-file parser,
 * and reloads the matching workspace or user loader. Workspace-scoped.
 */

import { join } from 'pathe';

import { Error2, ErrorCodes } from '#/errors';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';

import {
  IAgentProfileWriter,
  type AgentProfileWriteInput,
  type AgentProfileWriteResult,
} from './agentProfileWriter';
import { parseAgentFileText } from './internal/agentFile';
import { projectAgentRootCandidates } from './internal/agentRoots';
import { IUserAgentProfileLoader } from './userAgentProfileLoader';
import { IWorkspaceAgentProfileLoader } from './workspaceAgentProfileLoader';

export class AgentProfileWriterService implements IAgentProfileWriter {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IWorkspaceContext private readonly workspace: IWorkspaceContext,
    @IWorkspaceAgentProfileLoader private readonly workspaceLoader: IWorkspaceAgentProfileLoader,
    @IUserAgentProfileLoader private readonly userLoader: IUserAgentProfileLoader,
  ) {}

  async create(input: AgentProfileWriteInput): Promise<AgentProfileWriteResult> {
    const target = await this.target(input);
    const text = serializeAgentProfile(input);
    parseAgentFileText({ path: target.relativePath, source: target.source, text });
    try {
      await this.fs.mkdir(target.directory, { recursive: true });
      const created = await this.fs.createExclusive(target.absolutePath, new TextEncoder().encode(text));
      if (!created) {
        const existing = await this.fs.readText(target.absolutePath);
        if (existing !== text) {
          throw new Error2(
            ErrorCodes.PROFILE_CREATE_CONFLICT,
            `Agent profile "${input.name}" already exists with different content`,
            { details: { name: input.name, scope: input.scope, path: target.relativePath } },
          );
        }
      }
      await target.reload();
      return {
        name: input.name,
        scope: input.scope,
        path: target.relativePath,
        created,
      };
    } catch (error) {
      if (error instanceof Error2 && error.code === ErrorCodes.PROFILE_CREATE_CONFLICT) throw error;
      throw new Error2(
        ErrorCodes.PROFILE_CREATE_FAILED,
        `Failed to create agent profile "${input.name}"`,
        { details: { name: input.name, scope: input.scope, path: target.relativePath }, cause: error },
      );
    }
  }

  private async target(input: AgentProfileWriteInput): Promise<{
    readonly source: 'project' | 'user';
    readonly directory: string;
    readonly absolutePath: string;
    readonly relativePath: string;
    readonly reload: () => Promise<void>;
  }> {
    if (input.scope === 'user') {
      const directory = join(this.bootstrap.homeDir, 'agents');
      return {
        source: 'user',
        directory,
        absolutePath: join(directory, `${input.name}.md`),
        relativePath: `agents/${input.name}.md`,
        reload: () => this.userLoader.reload(),
      };
    }
    const { projectRoot } = await projectAgentRootCandidates(this.fs, this.workspace.cwd);
    const directory = join(projectRoot, '.kimi-code/agents');
    return {
      source: 'project',
      directory,
      absolutePath: join(directory, `${input.name}.md`),
      relativePath: `.kimi-code/agents/${input.name}.md`,
      reload: () => this.workspaceLoader.reload(),
    };
  }
}

function serializeAgentProfile(input: AgentProfileWriteInput): string {
  const lines = [
    '---',
    `name: ${yamlString(input.name)}`,
    `description: ${yamlString(input.description)}`,
    `whenToUse: ${yamlString(input.whenToUse)}`,
  ];
  appendList(lines, 'tools', input.tools);
  appendList(lines, 'disallowedTools', input.disallowedTools);
  appendList(lines, 'subagents', input.subagents);
  if (input.modelPreference !== undefined) {
    lines.push(`model_preference: ${input.modelPreference}`);
  }
  lines.push('---', '', input.prompt.trim(), '');
  return lines.join('\n');
}

function appendList(lines: string[], name: string, values: readonly string[] | undefined): void {
  if (values === undefined) return;
  if (values.length === 0) {
    lines.push(`${name}: []`);
    return;
  }
  lines.push(`${name}:`);
  for (const value of values) lines.push(`  - ${yamlString(value)}`);
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}
