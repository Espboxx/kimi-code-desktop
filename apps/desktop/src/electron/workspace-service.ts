import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { promisify } from 'node:util';

import type {
  GitDiffArea,
  GitFile,
  GitFileStats,
  GitStatus,
  WorkspaceDiffSnapshot,
  WorkspaceFileSnapshot,
  WorkspaceNode,
} from '../shared/desktop-api';

const IGNORED_DIRS = new Set([
  '.git',
  '.idea',
  '.next',
  '.turbo',
  '.vscode',
  'coverage',
  'dist',
  'dist-electron',
  'dist-renderer',
  'node_modules',
  'out',
  'target',
]);

const execFileAsync = promisify(execFile);

const DEFAULT_GIT_MAX_BUFFER = 2_000_000;
const DEFAULT_DIFF_MAX_CHARS = 120_000;
export const MAX_EDITABLE_FILE_BYTES = 2 * 1024 * 1024;
const GIT_CONTENT_MAX_BUFFER = 8 * 1024 * 1024;
const ZERO_STATS: GitFileStats = { additions: 0, deletions: 0 };

export class WorkspaceServiceError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly retryable?: boolean;

  constructor(code: string, message: string, details?: Record<string, unknown>, retryable?: boolean) {
    super(message);
    this.name = 'WorkspaceServiceError';
    this.code = code;
    this.details = details;
    this.retryable = retryable;
  }
}

export function assertRoot(rootInput: string): string {
  const root = resolve(rootInput);
  if (root.length === 0) {
    throw new WorkspaceServiceError('workspace.root_invalid', 'workspace root must not be empty');
  }
  return root;
}

export function resolveSafePath(rootInput: string, candidateInput: string): string {
  const root = assertRoot(rootInput);
  const candidate = isAbsolute(candidateInput)
    ? resolve(candidateInput)
    : resolve(root, candidateInput);
  const rel = relative(root, candidate);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new WorkspaceServiceError(
      'workspace.path_escape',
      `escapes workspace: ${candidateInput}`,
      { path: candidateInput },
    );
  }
  return candidate;
}

export function isIgnoredWorkspacePath(path: string): boolean {
  const segments = normalizePath(path).split('/').filter(Boolean);
  return segments.some((segment, index) => IGNORED_DIRS.has(segment) || (index > 0 && segment.startsWith('.')));
}

async function runGit(
  cwd: string,
  args: readonly string[],
  maxBuffer = DEFAULT_GIT_MAX_BUFFER,
): Promise<string> {
  try {
    const result = await execFileAsync('git', [...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer,
      windowsHide: true,
    });
    return result.stdout;
  } catch (error) {
    const err = error as Error & { stdout?: string; stderr?: string; code?: string | number };
    if (typeof err.stdout === 'string' && err.stdout.length > 0) return err.stdout;
    throw new WorkspaceServiceError(
      'workspace.git_failed',
      `git ${args.join(' ')} failed: ${err.stderr || err.message}`,
      { args },
      true,
    );
  }
}

async function runGitBuffer(
  cwd: string,
  args: readonly string[],
  maxBuffer = DEFAULT_GIT_MAX_BUFFER,
): Promise<Buffer> {
  try {
    const result = await execFileAsync('git', [...args], {
      cwd,
      encoding: 'buffer',
      maxBuffer,
      windowsHide: true,
    });
    return result.stdout as Buffer;
  } catch (error) {
    const err = error as Error & { stdout?: Buffer; stderr?: Buffer | string };
    if (Buffer.isBuffer(err.stdout) && err.stdout.length > 0) return err.stdout;
    const stderr = Buffer.isBuffer(err.stderr) ? err.stderr.toString('utf8') : err.stderr;
    throw new WorkspaceServiceError(
      'workspace.git_failed',
      `git ${args.join(' ')} failed: ${stderr || err.message}`,
      { args },
      true,
    );
  }
}

async function tryGitBuffer(cwd: string, args: readonly string[]): Promise<Buffer> {
  try {
    return await runGitBuffer(cwd, args, GIT_CONTENT_MAX_BUFFER);
  } catch {
    return Buffer.alloc(0);
  }
}

export function parseGitStatusPorcelainV2(stdout: string): {
  readonly branch: string;
  readonly files: GitFile[];
} {
  const records = stdout.split('\0');
  const files: GitFile[] = [];
  let branch = 'HEAD';

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record.length === 0) continue;
    if (record.startsWith('# branch.head ')) {
      const head = record.slice('# branch.head '.length).trim();
      branch = head === '(detached)' ? 'HEAD' : head || 'HEAD';
      continue;
    }
    if (record.startsWith('? ')) {
      files.push(gitFile(record.slice(2), undefined, undefined, 'untracked'));
      continue;
    }
    if (record.startsWith('! ')) continue;
    if (record.startsWith('u ')) {
      const fields = record.split(' ');
      const path = fields.slice(10).join(' ');
      if (path.length > 0) files.push(gitFile(path, undefined, 'conflicted', 'conflicted'));
      continue;
    }
    if (record.startsWith('1 ')) {
      const fields = record.split(' ');
      const xy = fields[1] ?? '..';
      const path = fields.slice(8).join(' ');
      if (path.length > 0) files.push(gitFile(path, undefined, gitStatus(xy[0]), gitStatus(xy[1])));
      continue;
    }
    if (record.startsWith('2 ')) {
      const fields = record.split(' ');
      const xy = fields[1] ?? '..';
      const path = fields.slice(9).join(' ');
      const originalPath = records[index + 1] || undefined;
      index += 1;
      if (path.length > 0) files.push(gitFile(path, originalPath, gitStatus(xy[0]), gitStatus(xy[1])));
    }
  }

  files.sort((left, right) => left.path.localeCompare(right.path));
  return { branch, files };
}

function gitFile(
  path: string,
  originalPath: string | undefined,
  indexStatus: GitStatus | undefined,
  worktreeStatus: GitStatus | undefined,
): GitFile {
  return {
    path: normalizePath(path),
    originalPath: originalPath === undefined ? undefined : normalizePath(originalPath),
    indexStatus,
    worktreeStatus,
    indexStats: ZERO_STATS,
    worktreeStats: ZERO_STATS,
  };
}

function gitStatus(code: string | undefined): GitStatus | undefined {
  switch (code) {
    case 'A': return 'added';
    case 'M':
    case 'T': return 'modified';
    case 'D': return 'deleted';
    case 'R': return 'renamed';
    case 'C': return 'copied';
    case 'U': return 'conflicted';
    case '?': return 'untracked';
    default: return undefined;
  }
}

export function parseGitNumstatZ(input: Buffer | string): Map<string, GitFileStats> {
  const records = (typeof input === 'string' ? input : input.toString('utf8')).split('\0');
  const counts = new Map<string, GitFileStats>();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record.length === 0) continue;
    const fields = record.split('\t');
    if (fields.length < 3) continue;
    const additions = fields[0] === '-' ? 0 : Number(fields[0]);
    const deletions = fields[1] === '-' ? 0 : Number(fields[1]);
    if (Number.isNaN(additions) || Number.isNaN(deletions)) continue;
    let path = fields.slice(2).join('\t');
    if (path.length === 0) {
      index += 2;
      path = records[index] ?? '';
    }
    if (path.length > 0) counts.set(normalizePath(path), { additions, deletions });
  }
  return counts;
}

export async function readWorkspaceDirectory(rootInput: string, relativePath = ''): Promise<WorkspaceNode[]> {
  const root = assertRoot(rootInput);
  const directory = resolveSafePath(root, relativePath);
  const info = await lstat(directory).catch(() => undefined);
  if (info === undefined || !info.isDirectory() || info.isSymbolicLink()) {
    throw new WorkspaceServiceError(
      'workspace.directory_invalid',
      `Not a workspace directory: ${relativePath || '.'}`,
      { path: relativePath },
    );
  }
  await assertRealPathInside(root, directory);

  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => {
    if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1;
    return left.name.localeCompare(right.name);
  });

  const nodes: WorkspaceNode[] = [];
  for (const entry of entries) {
    if (entry.name === '.' || entry.name === '..' || entry.isSymbolicLink()) continue;
    if (entry.isDirectory() && (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.'))) continue;
    const absolute = join(directory, entry.name);
    const path = normalizePath(relative(root, absolute));
    if (entry.isDirectory()) {
      nodes.push({ name: entry.name, path, kind: 'directory', hasChildren: true });
      continue;
    }
    if (!entry.isFile()) continue;
    const extension = extname(entry.name).replace(/^\./, '') || undefined;
    nodes.push({ name: entry.name, path, kind: 'file', extension });
  }
  return nodes;
}

export async function readWorkspaceFile(rootInput: string, path: string): Promise<WorkspaceFileSnapshot> {
  const root = assertRoot(rootInput);
  const absolute = await assertRegularWorkspaceFile(root, path);
  const [bytes, info] = await Promise.all([readFile(absolute), stat(absolute)]);
  return fileSnapshot(path, bytes, info.mtimeMs);
}

export async function writeWorkspaceFile(
  rootInput: string,
  input: {
    readonly path: string;
    readonly content: string;
    readonly expectedVersion: string;
    readonly force?: boolean;
    readonly bom?: boolean;
  },
): Promise<WorkspaceFileSnapshot> {
  const root = assertRoot(rootInput);
  const absolute = await assertRegularWorkspaceFile(root, input.path);
  const currentBytes = await readFile(absolute);
  const currentVersion = hashBytes(currentBytes);
  if (input.force !== true && currentVersion !== input.expectedVersion) {
    throw new WorkspaceServiceError(
      'workspace.file_conflict',
      `File changed on disk: ${input.path}`,
      { path: input.path, expectedVersion: input.expectedVersion, actualVersion: currentVersion },
    );
  }

  const body = Buffer.from(input.content, 'utf8');
  const bytes = input.bom === true ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
  if (bytes.length > MAX_EDITABLE_FILE_BYTES) {
    throw new WorkspaceServiceError(
      'workspace.file_too_large',
      `File exceeds the ${MAX_EDITABLE_FILE_BYTES} byte edit limit: ${input.path}`,
      { path: input.path, size: bytes.length, limit: MAX_EDITABLE_FILE_BYTES },
    );
  }

  const info = await stat(absolute);
  const temporary = join(dirname(absolute), `.${basename(absolute)}.kimi-${process.pid}-${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', info.mode);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, absolute);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return readWorkspaceFile(root, input.path);
}

export async function readGitStatus(rootInput: string): Promise<{
  readonly branch: string;
  readonly changedFiles: number;
  readonly files: GitFile[];
  readonly isRepo: boolean;
}> {
  const root = assertRoot(rootInput);
  try {
    await runGit(root, ['rev-parse', '--is-inside-work-tree']);
  } catch {
    return { branch: '非 Git 仓库', changedFiles: 0, files: [], isRepo: false };
  }

  const status = await runGitBuffer(root, ['status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z']);
  const parsed = parseGitStatusPorcelainV2(status.toString('utf8'));
  let indexStats = new Map<string, GitFileStats>();
  let worktreeStats = new Map<string, GitFileStats>();
  try {
    const [index, worktree] = await Promise.all([
      runGitBuffer(root, ['diff', '--cached', '--numstat', '-z']),
      runGitBuffer(root, ['diff', '--numstat', '-z']),
    ]);
    indexStats = parseGitNumstatZ(index);
    worktreeStats = parseGitNumstatZ(worktree);
  } catch {
    // Status remains authoritative even if numstat cannot be calculated.
  }

  const files = parsed.files.map((file) => ({
    ...file,
    indexStats: indexStats.get(file.path) ?? ZERO_STATS,
    worktreeStats: worktreeStats.get(file.path) ?? ZERO_STATS,
  }));
  return { branch: parsed.branch, changedFiles: files.length, files, isRepo: true };
}

export async function readGitFileDiff(
  rootInput: string,
  file: GitFile,
  area: GitDiffArea,
): Promise<WorkspaceDiffSnapshot> {
  const root = assertRoot(rootInput);
  const path = normalizeRelativePath(root, file.path);
  const originalPath = file.originalPath === undefined ? undefined : normalizeRelativePath(root, file.originalPath);
  let originalBytes: Buffer;
  let modifiedBytes: Buffer;
  let originalLabel: string;
  let modifiedLabel: string;

  if (area === 'staged') {
    originalBytes = await tryGitBuffer(root, ['show', `HEAD:${originalPath ?? path}`]);
    modifiedBytes = await tryGitBuffer(root, ['show', `:${path}`]);
    originalLabel = `HEAD · ${originalPath ?? path}`;
    modifiedLabel = `Index · ${path}`;
  } else if (area === 'conflict') {
    originalBytes = await tryGitBuffer(root, ['show', `:2:${path}`]);
    modifiedBytes = await readWorkingBytes(root, path);
    originalLabel = `Base · ${path}`;
    modifiedLabel = `Workspace · ${path}`;
  } else {
    originalBytes = await tryGitBuffer(root, ['show', `:${path}`]);
    modifiedBytes = await readWorkingBytes(root, path);
    originalLabel = `Index · ${path}`;
    modifiedLabel = `Workspace · ${path}`;
  }

  const original = decodeEditableBytes(originalBytes);
  const modified = decodeEditableBytes(modifiedBytes);
  const unsupported = original.kind !== 'text' || modified.kind !== 'text';
  return {
    path,
    originalPath,
    area,
    original: unsupported ? undefined : original.content,
    modified: unsupported ? undefined : modified.content,
    originalLabel,
    modifiedLabel,
    languageId: languageIdForPath(path),
    binary: original.kind === 'binary' || modified.kind === 'binary',
    truncated: original.kind === 'too-large' || modified.kind === 'too-large',
    version: hashBytes(Buffer.concat([originalBytes, Buffer.from([0]), modifiedBytes])),
  };
}

export async function readGitDiff(
  rootInput: string,
  relativePath?: string,
): Promise<{ readonly path: string; readonly patch: string; readonly truncated: boolean }> {
  const root = assertRoot(rootInput);
  const args = ['diff', '--no-ext-diff', '--unified=3'];
  let pathLabel = '.';
  if (relativePath !== undefined && relativePath.trim().length > 0) {
    pathLabel = normalizeRelativePath(root, relativePath);
    args.push('--', pathLabel);
  }

  const unstaged = await runGit(root, args, DEFAULT_GIT_MAX_BUFFER);
  const stagedArgs = ['diff', '--cached', '--no-ext-diff', '--unified=3'];
  if (pathLabel !== '.') stagedArgs.push('--', pathLabel);
  const staged = await runGit(root, stagedArgs, DEFAULT_GIT_MAX_BUFFER);
  let patch = [staged, unstaged].filter((part) => part.trim().length > 0).join('\n');
  if (patch.trim().length === 0 && pathLabel !== '.') {
    const status = await runGit(root, ['status', '--porcelain=v1', '--', pathLabel]);
    if (status.trim().startsWith('??')) {
      patch = `diff --git a/${pathLabel} b/${pathLabel}\n--- /dev/null\n+++ b/${pathLabel}\n@@ 未跟踪文件 @@\n`;
    }
  }

  const truncated = patch.length > DEFAULT_DIFF_MAX_CHARS;
  return {
    path: pathLabel,
    patch: truncated ? `${patch.slice(0, DEFAULT_DIFF_MAX_CHARS)}\n...[truncated]` : patch,
    truncated,
  };
}

export function workspaceDisplayName(root: string): string {
  return basename(assertRoot(root)) || '工作区';
}

export async function refreshWorkspace(rootInput: string): Promise<{
  readonly workspace: {
    readonly name: string;
    readonly root: string;
    readonly branch: string;
    readonly changedFiles: number;
    readonly language: string;
  };
  readonly tree: WorkspaceNode[];
  readonly files: GitFile[];
  readonly isRepo: boolean;
}> {
  const root = assertRoot(rootInput);
  const [tree, git] = await Promise.all([readWorkspaceDirectory(root), readGitStatus(root)]);
  return {
    workspace: {
      name: workspaceDisplayName(root),
      root,
      branch: git.branch,
      changedFiles: git.changedFiles,
      language: '项目',
    },
    tree,
    files: git.files,
    isRepo: git.isRepo,
  };
}

function fileSnapshot(path: string, bytes: Buffer, mtimeMs: number): WorkspaceFileSnapshot {
  const decoded = decodeEditableBytes(bytes);
  const normalized = normalizePath(path);
  return {
    path: normalized,
    kind: decoded.kind,
    content: decoded.content,
    languageId: languageIdForPath(normalized),
    size: bytes.length,
    mtimeMs,
    version: hashBytes(bytes),
    bom: decoded.bom,
    readOnlyReason: decoded.kind === 'binary'
      ? '该文件不是有效的 UTF-8 文本，已以只读方式打开。'
      : decoded.kind === 'too-large'
        ? `文件超过 ${MAX_EDITABLE_FILE_BYTES} 字节编辑上限，已以只读方式打开。`
        : undefined,
  };
}

function decodeEditableBytes(bytes: Buffer): {
  readonly kind: WorkspaceFileSnapshot['kind'];
  readonly content?: string;
  readonly bom: boolean;
} {
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  if (bytes.length > MAX_EDITABLE_FILE_BYTES) return { kind: 'too-large', bom };
  const body = bom ? bytes.subarray(3) : bytes;
  if (body.includes(0)) return { kind: 'binary', bom };
  try {
    return { kind: 'text', content: new TextDecoder('utf-8', { fatal: true }).decode(body), bom };
  } catch {
    return { kind: 'binary', bom };
  }
}

async function assertRegularWorkspaceFile(root: string, path: string): Promise<string> {
  const absolute = resolveSafePath(root, path);
  const info = await lstat(absolute).catch(() => undefined);
  if (info === undefined) {
    throw new WorkspaceServiceError('workspace.file_not_found', `File does not exist: ${path}`, { path });
  }
  if (info.isSymbolicLink()) {
    throw new WorkspaceServiceError('workspace.file_symlink', `Symbolic links cannot be edited: ${path}`, { path });
  }
  if (!info.isFile()) {
    throw new WorkspaceServiceError('workspace.file_not_regular', `Not a regular file: ${path}`, { path });
  }
  await assertRealPathInside(root, absolute);
  return absolute;
}

async function assertRealPathInside(root: string, target: string): Promise<void> {
  const [rootReal, targetReal] = await Promise.all([realpath(root), realpath(target)]);
  const rel = relative(rootReal, targetReal);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new WorkspaceServiceError('workspace.path_escape', `escapes workspace: ${target}`, { path: target });
  }
}

async function readWorkingBytes(root: string, path: string): Promise<Buffer> {
  const absolute = resolveSafePath(root, path);
  const info = await lstat(absolute).catch(() => undefined);
  if (info === undefined) return Buffer.alloc(0);
  if (info.isSymbolicLink() || !info.isFile()) return Buffer.alloc(0);
  await assertRealPathInside(root, absolute);
  return readFile(absolute);
}

function normalizeRelativePath(root: string, path: string): string {
  const safe = resolveSafePath(root, path);
  return normalizePath(relative(root, safe));
}

function normalizePath(path: string): string {
  return path.split(sep).join('/').replace(/^\.\//, '');
}

function hashBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function languageIdForPath(path: string): string {
  const extension = extname(path).slice(1).toLowerCase();
  return ({
    c: 'c', cc: 'cpp', cpp: 'cpp', cs: 'csharp', css: 'css', go: 'go', h: 'c', hpp: 'cpp',
    html: 'html', java: 'java', js: 'javascript', jsx: 'javascript', json: 'json', jsonc: 'json',
    md: 'markdown', mjs: 'javascript', mts: 'typescript', py: 'python', rs: 'rust', scss: 'scss',
    sh: 'shell', sql: 'sql', toml: 'ini', ts: 'typescript', tsx: 'typescript', txt: 'plaintext',
    xml: 'xml', yaml: 'yaml', yml: 'yaml',
  } as Record<string, string>)[extension] ?? 'plaintext';
}
