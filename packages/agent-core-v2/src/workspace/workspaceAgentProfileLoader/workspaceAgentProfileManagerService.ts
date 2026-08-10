/**
 * `workspaceAgentProfileLoader` domain — structured agent-profile manager.
 *
 * Reads live contributions through `agentProfileCatalog`, resolves canonical
 * roots through `workspaceContext` and `bootstrap`, persists through `hostFs`,
 * and refreshes the workspace and user loaders. Workspace-scoped.
 */

import { createHash } from 'node:crypto';

import { basename, join } from 'pathe';

import { Error2, ErrorCodes } from '#/errors';
import type { AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { IAgentProfileRegistry } from '#/app/agentProfileCatalog/agentProfileRegistry';
import { projectAgentProfiles } from '#/app/agentProfileCatalog/profileProjection';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IHostFileSystem, type HostFileStat } from '#/os/interface/hostFileSystem';
import { HostFsError, OsFsErrors } from '#/os/interface/hostFsErrors';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';

import { parseAgentFileText } from './internal/agentFile';
import { projectAgentRootCandidates } from './internal/agentRoots';
import type { AgentFileDefinition } from './internal/types';
import { IUserAgentProfileLoader } from './userAgentProfileLoader';
import { IWorkspaceAgentProfileLoader } from './workspaceAgentProfileLoader';
import {
  IWorkspaceAgentProfileManager,
  type AgentProfileDeleteInput,
  type AgentProfileDeleteResult,
  type AgentProfileDescriptor,
  type AgentProfileDiagnostic,
  type AgentProfileDraft,
  type AgentProfileListResult,
  type AgentProfileManageScope,
  type AgentProfileMutationResult,
  type AgentProfileUpdateInput,
} from './workspaceAgentProfileManager';

interface ManagedRoot {
  readonly scope: AgentProfileManageScope;
  readonly sourceId: 'workspace' | 'user';
  readonly source: 'project' | 'user';
  readonly base: string;
  readonly directoryParts: readonly string[];
  readonly directory: string;
  readonly logicalDirectory: string;
  readonly reload: () => Promise<void>;
}

interface ManagedDefinition {
  readonly definition: AgentFileDefinition;
  readonly scope: AgentProfileManageScope;
  readonly sourceId: 'workspace' | 'user';
  readonly path: string;
  readonly revision: string;
}

export class WorkspaceAgentProfileManagerService implements IWorkspaceAgentProfileManager {
  declare readonly _serviceBrand: undefined;

  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IWorkspaceContext private readonly workspace: IWorkspaceContext,
    @IAgentProfileRegistry private readonly registry: IAgentProfileRegistry,
    @IWorkspaceAgentProfileLoader private readonly workspaceLoader: IWorkspaceAgentProfileLoader,
    @IUserAgentProfileLoader private readonly userLoader: IUserAgentProfileLoader,
  ) {}

  async list(): Promise<AgentProfileListResult> {
    await Promise.all([this.workspaceLoader.ready, this.userLoader.ready]);
    const roots = await this.roots();
    const diagnostics: AgentProfileDiagnostic[] = [];
    const managed = new Map<string, ManagedDefinition>();
    for (const root of roots) {
      for (const definition of await this.scanManagedRoot(root, diagnostics)) {
        managed.set(profileKey(definition.sourceId, definition.definition.name), definition);
      }
    }

    const entries = this.registry
      .entries()
      .filter(
        (entry) =>
          entry.workspaceKey === undefined || entry.workspaceKey === this.workspace.workspaceId,
      );
    const projection = projectAgentProfiles(entries);
    const descriptors: AgentProfileDescriptor[] = [];
    const represented = new Set<string>();

    for (const entry of entries) {
      for (const profile of dedupeProfiles(entry.contribution.profiles)) {
        const key = profileKey(entry.sourceId, profile.name);
        const editable = managed.get(key);
        const inspection = projection.inspections.get(profile.name);
        descriptors.push(
          descriptorFromProfile(
            profile,
            entry.sourceId,
            inspection?.sourceId === entry.sourceId && inspection.profile === profile,
            editable,
          ),
        );
        represented.add(key);
      }
      for (const skipped of entry.contribution.skipped ?? []) {
        diagnostics.push({
          sourceId: entry.sourceId,
          path: `${entry.sourceId}/${basename(skipped.path)}`,
          message: 'Profile file could not be loaded.',
        });
      }
    }

    for (const [key, editable] of managed) {
      if (represented.has(key)) continue;
      descriptors.push(descriptorFromDefinition(editable));
    }

    return {
      profiles: descriptors.toSorted(
        (left, right) =>
          left.name.localeCompare(right.name) || left.sourceId.localeCompare(right.sourceId),
      ),
      diagnostics: dedupeDiagnostics(diagnostics),
    };
  }

  create(input: AgentProfileDraft): Promise<AgentProfileMutationResult> {
    return this.enqueueMutation(async () => {
      const text = serializeAgentProfile(input);
      const root = await this.root(input.scope);
      const target = join(root.directory, `${input.name}.md`);
      parseAgentFileText({ path: this.logicalPath(root, input.name), source: root.source, text });
      try {
        await this.ensureManagedDirectory(root, true);
        const existing = await this.tryLstat(target);
        if (existing?.isSymbolicLink === true || (existing !== undefined && !existing.isFile)) {
          throw this.forbidden(input, 'Profile target is not a regular file');
        }
        const created = await this.fs.createExclusive(target, new TextEncoder().encode(text));
        if (!created) {
          const current = await this.fs.readText(target);
          if (current !== text) {
            throw new Error2(
              ErrorCodes.PROFILE_CREATE_CONFLICT,
              `Agent profile "${input.name}" already exists with different content`,
              { details: { name: input.name, scope: input.scope } },
            );
          }
        }
        await root.reload();
        return { profile: await this.requireDescriptor(input.scope, input.name), created };
      } catch (error) {
        if (isProfileManagementError(error)) throw error;
        throw new Error2(
          ErrorCodes.PROFILE_CREATE_FAILED,
          `Failed to create agent profile "${input.name}"`,
          { details: { name: input.name, scope: input.scope }, cause: error },
        );
      }
    });
  }

  update(input: AgentProfileUpdateInput): Promise<AgentProfileMutationResult> {
    return this.enqueueMutation(async () => {
      const text = serializeAgentProfile(input);
      const root = await this.root(input.scope);
      const target = join(root.directory, `${input.name}.md`);
      parseAgentFileText({ path: this.logicalPath(root, input.name), source: root.source, text });
      try {
        await this.ensureManagedDirectory(root, false);
        await this.assertRegularFile(target, input);
        const current = await this.fs.readText(target);
        if (revisionOf(current) !== input.revision) {
          throw new Error2(
            ErrorCodes.PROFILE_UPDATE_CONFLICT,
            `Agent profile "${input.name}" changed since it was loaded`,
            { details: { name: input.name, scope: input.scope } },
          );
        }
        await this.fs.writeText(target, text);
        await root.reload();
        return { profile: await this.requireDescriptor(input.scope, input.name) };
      } catch (error) {
        if (isProfileManagementError(error)) throw error;
        throw new Error2(
          ErrorCodes.PROFILE_UPDATE_FAILED,
          `Failed to update agent profile "${input.name}"`,
          { details: { name: input.name, scope: input.scope }, cause: error },
        );
      }
    });
  }

  delete(input: AgentProfileDeleteInput): Promise<AgentProfileDeleteResult> {
    return this.enqueueMutation(async () => {
      const root = await this.root(input.scope);
      const target = join(root.directory, `${input.name}.md`);
      try {
        await this.ensureManagedDirectory(root, false);
        await this.assertRegularFile(target, input);
        const current = await this.fs.readText(target);
        if (revisionOf(current) !== input.revision) {
          throw new Error2(
            ErrorCodes.PROFILE_UPDATE_CONFLICT,
            `Agent profile "${input.name}" changed since it was loaded`,
            { details: { name: input.name, scope: input.scope } },
          );
        }
        await this.fs.remove(target);
        await root.reload();
        return {
          id: profileKey(root.sourceId, input.name),
          name: input.name,
          scope: input.scope,
          deleted: true,
        };
      } catch (error) {
        if (isProfileManagementError(error)) throw error;
        throw new Error2(
          ErrorCodes.PROFILE_DELETE_FAILED,
          `Failed to delete agent profile "${input.name}"`,
          { details: { name: input.name, scope: input.scope }, cause: error },
        );
      }
    });
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.mutationTail.then(operation, operation);
    this.mutationTail = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }

  private async roots(): Promise<readonly ManagedRoot[]> {
    return Promise.all([this.root('workspace'), this.root('user')]);
  }

  private async root(scope: AgentProfileManageScope): Promise<ManagedRoot> {
    if (scope === 'user') {
      const base = await this.fs.realpath(this.bootstrap.homeDir);
      return {
        scope,
        sourceId: 'user',
        source: 'user',
        base,
        directoryParts: ['agents'],
        directory: join(base, 'agents'),
        logicalDirectory: 'agents',
        reload: () => this.userLoader.reload(),
      };
    }
    const { projectRoot } = await projectAgentRootCandidates(this.fs, this.workspace.cwd);
    const base = await this.fs.realpath(projectRoot);
    return {
      scope,
      sourceId: 'workspace',
      source: 'project',
      base,
      directoryParts: ['.kimi-code', 'agents'],
      directory: join(base, '.kimi-code/agents'),
      logicalDirectory: '.kimi-code/agents',
      reload: () => this.workspaceLoader.reload(),
    };
  }

  private async scanManagedRoot(
    root: ManagedRoot,
    diagnostics: AgentProfileDiagnostic[],
  ): Promise<readonly ManagedDefinition[]> {
    const directory = await this.tryLstat(root.directory);
    if (directory === undefined) return [];
    if (directory.isSymbolicLink === true || !directory.isDirectory) {
      diagnostics.push({
        sourceId: root.sourceId,
        path: root.logicalDirectory,
        message: 'Managed profile directory must be a regular directory and cannot be a symlink.',
      });
      return [];
    }
    const definitions: ManagedDefinition[] = [];
    for (const entry of (await this.fs.readdir(root.directory)).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (!entry.name.endsWith('.md')) continue;
      const logicalPath = `${root.logicalDirectory}/${entry.name}`;
      const absolutePath = join(root.directory, entry.name);
      try {
        const stat = await this.fs.lstat(absolutePath);
        if (stat.isSymbolicLink === true || !stat.isFile) {
          diagnostics.push({
            sourceId: root.sourceId,
            path: logicalPath,
            message: 'Managed profile must be a regular Markdown file and cannot be a symlink.',
          });
          continue;
        }
        const text = await this.fs.readText(absolutePath);
        const definition = parseAgentFileText({ path: logicalPath, source: root.source, text });
        if (entry.name !== `${definition.name}.md`) {
          diagnostics.push({
            sourceId: root.sourceId,
            path: logicalPath,
            message: 'Profile filename must match its immutable name before it can be edited.',
          });
          continue;
        }
        definitions.push({
          definition,
          scope: root.scope,
          sourceId: root.sourceId,
          path: logicalPath,
          revision: revisionOf(text),
        });
      } catch {
        diagnostics.push({
          sourceId: root.sourceId,
          path: logicalPath,
          message: 'Profile file could not be parsed or read.',
        });
      }
    }
    return definitions;
  }

  private async ensureManagedDirectory(root: ManagedRoot, create: boolean): Promise<void> {
    let current = root.base;
    for (const part of root.directoryParts) {
      current = join(current, part);
      const stat = await this.tryLstat(current);
      if (stat === undefined) continue;
      if (stat.isSymbolicLink === true || !stat.isDirectory) {
        throw new Error2(
          ErrorCodes.PROFILE_MANAGE_FORBIDDEN,
          'Managed profile directories cannot traverse a symlink or non-directory path',
          { details: { scope: root.scope } },
        );
      }
    }
    if (create) await this.fs.mkdir(root.directory, { recursive: true });
    const directory = await this.tryLstat(root.directory);
    if (directory === undefined || directory.isSymbolicLink === true || !directory.isDirectory) {
      throw new Error2(
        create ? ErrorCodes.PROFILE_MANAGE_FORBIDDEN : ErrorCodes.PROFILE_NOT_FOUND,
        create ? 'Managed profile directory is unsafe' : 'Managed profile directory does not exist',
        { details: { scope: root.scope } },
      );
    }
  }

  private async assertRegularFile(
    target: string,
    input: { readonly name: string; readonly scope: AgentProfileManageScope },
  ): Promise<void> {
    const stat = await this.tryLstat(target);
    if (stat === undefined) {
      throw new Error2(
        ErrorCodes.PROFILE_NOT_FOUND,
        `Agent profile "${input.name}" does not exist`,
        { details: { name: input.name, scope: input.scope } },
      );
    }
    if (stat.isSymbolicLink === true || !stat.isFile) throw this.forbidden(input, 'Profile target is not a regular file');
  }

  private forbidden(
    input: { readonly name: string; readonly scope: AgentProfileManageScope },
    message: string,
  ): Error2 {
    return new Error2(ErrorCodes.PROFILE_MANAGE_FORBIDDEN, message, {
      details: { name: input.name, scope: input.scope },
    });
  }

  private async tryLstat(path: string): Promise<HostFileStat | undefined> {
    try {
      return await this.fs.lstat(path);
    } catch (error) {
      if (isMissingPathError(error)) return undefined;
      throw error;
    }
  }

  private logicalPath(root: ManagedRoot, name: string): string {
    return `${root.logicalDirectory}/${name}.md`;
  }

  private async requireDescriptor(
    scope: AgentProfileManageScope,
    name: string,
  ): Promise<AgentProfileDescriptor> {
    const sourceId = scope === 'user' ? 'user' : 'workspace';
    const descriptor = (await this.list()).profiles.find(
      (profile) => profile.sourceId === sourceId && profile.name === name && profile.editable,
    );
    if (descriptor !== undefined) return descriptor;
    throw new Error2(
      ErrorCodes.PROFILE_NOT_FOUND,
      `Agent profile "${name}" was written but did not become manageable`,
      { details: { name, scope } },
    );
  }
}

function descriptorFromProfile(
  profile: AgentProfile,
  sourceId: string,
  effective: boolean,
  managed: ManagedDefinition | undefined,
): AgentProfileDescriptor {
  if (managed !== undefined) {
    return {
      ...descriptorFields(managed.definition),
      id: profileKey(sourceId, profile.name),
      sourceId,
      scope: managed.scope,
      editable: true,
      effective,
      path: managed.path,
      revision: managed.revision,
    };
  }
  return {
    id: profileKey(sourceId, profile.name),
    name: profile.name,
    description: profile.description ?? '',
    whenToUse: profile.whenToUse,
    override: profile.override === true,
    tools: profile.tools,
    disallowedTools: profile.disallowedTools,
    subagents: profile.subagents,
    modelPreference: profile.modelPreference ?? 'auto',
    sourceId,
    editable: false,
    effective,
  };
}

function descriptorFromDefinition(managed: ManagedDefinition): AgentProfileDescriptor {
  return {
    ...descriptorFields(managed.definition),
    id: profileKey(managed.sourceId, managed.definition.name),
    sourceId: managed.sourceId,
    scope: managed.scope,
    editable: true,
    effective: false,
    path: managed.path,
    revision: managed.revision,
  };
}

function descriptorFields(definition: AgentFileDefinition): Pick<
  AgentProfileDescriptor,
  | 'name'
  | 'description'
  | 'whenToUse'
  | 'prompt'
  | 'override'
  | 'tools'
  | 'disallowedTools'
  | 'subagents'
  | 'modelPreference'
> {
  return {
    name: definition.name,
    description: definition.description,
    whenToUse: definition.whenToUse,
    prompt: definition.prompt,
    override: definition.override,
    tools: definition.tools,
    disallowedTools: definition.disallowedTools,
    subagents: definition.subagents,
    modelPreference: definition.modelPreference ?? 'auto',
  };
}

function dedupeProfiles(profiles: readonly AgentProfile[]): readonly AgentProfile[] {
  const byName = new Map<string, AgentProfile>();
  for (const profile of profiles) byName.set(profile.name, profile);
  return [...byName.values()];
}

function serializeAgentProfile(input: AgentProfileDraft): string {
  const lines = [
    '---',
    `name: ${yamlString(input.name)}`,
    `description: ${yamlString(input.description)}`,
  ];
  if (input.whenToUse !== undefined && input.whenToUse.trim() !== '') {
    lines.push(`whenToUse: ${yamlString(input.whenToUse.trim())}`);
  }
  if (input.override === true) lines.push('override: true');
  appendList(lines, 'tools', input.tools);
  appendList(lines, 'disallowedTools', input.disallowedTools);
  appendList(lines, 'subagents', input.subagents);
  if (input.modelPreference !== undefined && input.modelPreference !== 'auto') {
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

function revisionOf(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function profileKey(sourceId: string, name: string): string {
  return `${sourceId}:${name}`;
}

function dedupeDiagnostics(
  diagnostics: readonly AgentProfileDiagnostic[],
): readonly AgentProfileDiagnostic[] {
  const byKey = new Map<string, AgentProfileDiagnostic>();
  for (const diagnostic of diagnostics) {
    byKey.set(`${diagnostic.sourceId}\0${diagnostic.path ?? ''}\0${diagnostic.message}`, diagnostic);
  }
  return [...byKey.values()].toSorted(
    (left, right) =>
      left.sourceId.localeCompare(right.sourceId) ||
      (left.path ?? '').localeCompare(right.path ?? ''),
  );
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof HostFsError &&
    (error.code === OsFsErrors.codes.OS_FS_NOT_FOUND ||
      error.code === OsFsErrors.codes.OS_FS_NOT_DIRECTORY)
  );
}

function isProfileManagementError(error: unknown): error is Error2 {
  return error instanceof Error2 && error.code.startsWith('profile.');
}
