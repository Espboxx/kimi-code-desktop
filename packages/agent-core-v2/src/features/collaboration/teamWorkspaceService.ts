/**
 * `collaboration` domain — Git worktree isolation implementation.
 *
 * Runs Git through `hostProcess`, creates detached worktrees under the Kimi
 * home, enforces a clean unchanged main worktree at preparation/apply
 * boundaries, and leaves the aggregate result unstaged in the user's main
 * worktree. Bound at Session scope.
 */

import { isAbsolute, join, relative, resolve } from 'node:path';

import { Error2, ErrorCodes } from '#/errors';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostProcessService } from '#/os/interface/hostProcess';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

import { ITeamWorkspaceService, type TeamCandidate, type TeamPreparedWorkspace } from './teamWorkspace';
import type { TeamIntegrationState, TeamWorkspaceMode } from './types';

interface GitResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export class TeamWorkspaceService implements ITeamWorkspaceService {
  declare readonly _serviceBrand: undefined;

  private readonly baseDir: string;
  private repoRoot: string | undefined;

  constructor(
    @IBootstrapService bootstrap: IBootstrapService,
    @ISessionContext private readonly session: ISessionContext,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IHostProcessService private readonly process: IHostProcessService,
  ) {
    this.baseDir = resolve(bootstrap.homeDir, 'team-worktrees', safeSegment(session.sessionId));
  }

  async prepareTask(input: {
    readonly taskId: string;
    readonly mode: TeamWorkspaceMode;
    readonly integration: TeamIntegrationState;
    readonly resumeHead?: string;
  }): Promise<{ readonly workspace: TeamPreparedWorkspace; readonly integration: TeamIntegrationState }> {
    if (input.mode === 'shared_readonly') {
      return {
        workspace: {
          execution: { workDir: this.session.cwd, access: 'read', confined: true },
          path: this.session.cwd,
        },
        integration: input.integration,
      };
    }
    const integration = await this.ensureIntegration(input.integration);
    const integrationHead = await this.head(this.integrationPath());
    const path = this.taskPath(input.taskId);
    const taskHead = input.resumeHead ?? integrationHead;
    await this.recreateWorktree(path, taskHead);
    return {
      workspace: {
        execution: { workDir: path, access: 'write', confined: true, additionalDirs: [] },
        path,
        head: taskHead,
      },
      integration,
    };
  }

  async finalizeTask(input: {
    readonly taskId: string;
    readonly workspacePath: string;
    readonly baseHead?: string;
  }): Promise<TeamCandidate> {
    this.assertOwnedPath(input.workspacePath);
    await this.git(['add', '-A'], input.workspacePath);
    const staged = await this.git(['diff', '--cached', '--quiet'], input.workspacePath, undefined, [0, 1]);
    if (staged.exitCode === 1) {
      await this.git([
        '-c', 'user.name=Kimi Team',
        '-c', 'user.email=kimi-team@example.invalid',
        'commit', '-m', `team task ${input.taskId}`,
      ], input.workspacePath);
    }
    const candidateHead = await this.head(input.workspacePath);
    const parent = input.baseHead === undefined
      ? await this.git(['rev-parse', `${candidateHead}^`], input.workspacePath, undefined, [0, 128])
      : undefined;
    const base = input.baseHead ?? (parent?.exitCode === 0 ? parent.stdout.trim() : candidateHead);
    const diff = await this.git(['diff', '--binary', base, candidateHead], input.workspacePath);
    return {
      workspacePath: input.workspacePath,
      candidateHead,
      patch: new TextEncoder().encode(diff.stdout),
    };
  }

  async prepareValidation(input: { readonly taskId: string; readonly candidateHead: string }): Promise<TeamPreparedWorkspace> {
    const path = this.validationPath(input.taskId);
    await this.recreateWorktree(path, input.candidateHead);
    return {
      execution: { workDir: path, access: 'write', confined: true, additionalDirs: [] },
      path,
      head: input.candidateHead,
    };
  }

  async integrate(input: { readonly candidateHead: string; readonly integration: TeamIntegrationState }): Promise<TeamIntegrationState> {
    const current = await this.ensureIntegration(input.integration);
    const path = this.integrationPath();
    const head = await this.head(path);
    if (head !== input.candidateHead) {
      const contained = await this.git(
        ['merge-base', '--is-ancestor', input.candidateHead, head],
        path,
        undefined,
        [0, 1],
      );
      if (contained.exitCode !== 0) {
        const base = await this.git(['merge-base', head, input.candidateHead], path);
        const range = `${base.stdout.trim()}..${input.candidateHead}`;
        const cherryPick = await this.git(['cherry-pick', range], path, undefined, [0, 1]);
        if (cherryPick.exitCode !== 0) {
          await this.git(['cherry-pick', '--abort'], path, undefined, [0, 128]);
          throw new Error2(
            ErrorCodes.COLLABORATION_INTEGRATION_CONFLICT,
            'Team candidate conflicts with the aggregate integration worktree',
            { details: { candidateHead: input.candidateHead, detail: cherryPick.stderr.trim() } },
          );
        }
      }
    }
    return {
      ...current,
      status: 'integrating',
      integrationHead: await this.head(path),
      error: undefined,
      updatedAt: Date.now(),
    };
  }

  async preview(integration: TeamIntegrationState): Promise<Uint8Array | undefined> {
    if (integration.baselineHead === undefined || integration.integrationHead === undefined) return undefined;
    const result = await this.git(['diff', '--binary', integration.baselineHead, integration.integrationHead], this.integrationPath());
    return new TextEncoder().encode(result.stdout);
  }

  async apply(integration: TeamIntegrationState): Promise<void> {
    if (integration.baselineHead === undefined || integration.integrationHead === undefined) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'Team integration has no baseline or aggregate head');
    }
    const root = await this.root();
    await this.requireCleanHead(root, integration.baselineHead);
    const patch = await this.preview(integration);
    if (patch === undefined || patch.byteLength === 0) return;
    await this.git(['apply', '--whitespace=nowarn', '-'], root, patch);
  }

  async discard(_integration: TeamIntegrationState, taskIds: readonly string[]): Promise<void> {
    const root = await this.root();
    for (const taskId of taskIds) {
      await this.removeWorktree(root, this.taskPath(taskId));
      await this.removeWorktree(root, this.validationPath(taskId));
    }
    await this.removeWorktree(root, this.integrationPath());
  }

  private async ensureIntegration(integration: TeamIntegrationState): Promise<TeamIntegrationState> {
    const root = await this.root();
    if (integration.baselineHead === undefined) {
      const baselineHead = await this.requireCleanHead(root);
      await this.fs.mkdir(this.baseDir, { recursive: true });
      await this.recreateWorktree(this.integrationPath(), baselineHead);
      return { status: 'preparing', baselineHead, integrationHead: baselineHead, updatedAt: Date.now() };
    }
    const path = this.integrationPath();
    if (!await this.exists(path)) await this.recreateWorktree(path, integration.integrationHead ?? integration.baselineHead);
    return integration;
  }

  private async root(): Promise<string> {
    if (this.repoRoot !== undefined) return this.repoRoot;
    const result = await this.git(['rev-parse', '--show-toplevel'], this.session.cwd);
    const value = result.stdout.trim();
    if (value.length === 0) throw new Error2(ErrorCodes.COLLABORATION_WORKSPACE_UNAVAILABLE, 'Team write tasks require a Git worktree');
    const root = resolve(value);
    this.repoRoot = root;
    return root;
  }

  private async requireCleanHead(root: string, expectedHead?: string): Promise<string> {
    const status = await this.git(['status', '--porcelain=v1'], root);
    if (status.stdout.trim().length > 0) {
      throw new Error2(ErrorCodes.COLLABORATION_WORKSPACE_UNAVAILABLE, 'Clean the main Git worktree before starting or applying Team write tasks');
    }
    const head = await this.head(root);
    if (expectedHead !== undefined && head !== expectedHead) {
      throw new Error2(ErrorCodes.COLLABORATION_STALE_STATE, 'The main Git HEAD changed since this Team started', {
        details: { expectedHead, actualHead: head },
      });
    }
    return head;
  }

  private head(cwd: string): Promise<string> {
    return this.git(['rev-parse', 'HEAD'], cwd).then((result) => result.stdout.trim());
  }

  private async recreateWorktree(path: string, head: string): Promise<void> {
    const root = await this.root();
    this.assertOwnedPath(path);
    await this.removeWorktree(root, path);
    await this.fs.mkdir(resolve(path, '..'), { recursive: true });
    await this.git(['worktree', 'add', '--detach', path, head], root);
  }

  private async removeWorktree(root: string, path: string): Promise<void> {
    this.assertOwnedPath(path);
    await this.git(['worktree', 'remove', '--force', path], root, undefined, [0, 128]);
    if (await this.exists(path)) await this.fs.remove(path);
  }

  private integrationPath(): string { return join(this.baseDir, 'integration'); }
  private taskPath(taskId: string): string { return join(this.baseDir, `task-${safeSegment(taskId)}`); }
  private validationPath(taskId: string): string { return join(this.baseDir, `validate-${safeSegment(taskId)}`); }

  private assertOwnedPath(path: string): void {
    const rel = relative(this.baseDir, resolve(path));
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error2(ErrorCodes.COLLABORATION_WORKSPACE_UNAVAILABLE, 'Refusing a Team worktree path outside its session directory');
    }
  }

  private async exists(path: string): Promise<boolean> {
    return this.fs.lstat(path).then(() => true, () => false);
  }

  private async git(args: readonly string[], cwd: string, stdin?: Uint8Array, allowed: readonly number[] = [0]): Promise<GitResult> {
    const proc = await this.process.spawn('git', args, { cwd, windowsHide: true });
    const work = Promise.all([collect(proc.stdout), collect(proc.stderr), proc.wait()] as const);
    proc.stdin.end(stdin);
    try {
      const [stdout, stderr, exitCode] = await work;
      if (!allowed.includes(exitCode)) {
        throw new Error2(ErrorCodes.COLLABORATION_WORKSPACE_UNAVAILABLE, 'Git command failed for Team workspace', {
          details: { command: ['git', ...args].join(' '), exitCode, detail: stderr.trim() },
        });
      }
      return { stdout, stderr, exitCode };
    } finally {
      proc.dispose();
    }
  }
}

async function collect(stream: AsyncIterable<Uint8Array | string>): Promise<string> {
  const decoder = new TextDecoder();
  let output = '';
  for await (const chunk of stream) output += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
  return output + decoder.decode();
}

function safeSegment(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9_-]/g, '_').slice(0, 96);
}
