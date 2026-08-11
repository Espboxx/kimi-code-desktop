import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MAX_EDITABLE_FILE_BYTES,
  parseGitNumstatZ,
  parseGitStatusPorcelainV2,
  readGitFileDiff,
  readGitStatus,
  readWorkspaceDirectory,
  readWorkspaceFile,
  resolveSafePath,
  writeWorkspaceFile,
} from './workspace-service';

describe('workspace-service helpers', () => {
  it('rejects paths that escape the workspace root', () => {
    expect(() => resolveSafePath(join(tmpdir(), 'project'), join('..', 'outside'))).toThrow(/escapes workspace/);
  });

  it('parses porcelain v2 index, worktree, rename, untracked, and conflict records', () => {
    const parsed = parseGitStatusPorcelainV2([
      '# branch.head feature/editor',
      '1 .M N... 100644 100644 100644 a b src/a file.ts',
      '1 M. N... 100644 100644 100644 a b staged.ts',
      '2 R. N... 100644 100644 100644 a b R100 src/new name.ts',
      'src/old name.ts',
      '? untracked file.md',
      'u UU N... 100644 100644 100644 100644 a b c conflict.ts',
      '',
    ].join('\0'));

    expect(parsed.branch).toBe('feature/editor');
    expect(parsed.files).toEqual([
      expect.objectContaining({ path: 'conflict.ts', indexStatus: 'conflicted', worktreeStatus: 'conflicted' }),
      expect.objectContaining({ path: 'src/a file.ts', indexStatus: undefined, worktreeStatus: 'modified' }),
      expect.objectContaining({ path: 'src/new name.ts', originalPath: 'src/old name.ts', indexStatus: 'renamed' }),
      expect.objectContaining({ path: 'staged.ts', indexStatus: 'modified', worktreeStatus: undefined }),
      expect.objectContaining({ path: 'untracked file.md', worktreeStatus: 'untracked' }),
    ]);
  });

  it('parses nul-delimited numstat entries including renames', () => {
    const counts = parseGitNumstatZ('3\t1\tsrc/a file.ts\0' + '4\t2\t\0old.ts\0new.ts\0');
    expect(counts.get('src/a file.ts')).toEqual({ additions: 3, deletions: 1 });
    expect(counts.get('new.ts')).toEqual({ additions: 4, deletions: 2 });
  });

  it('reads lazy directories and safely saves versioned UTF-8 files atomically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kimi-workspace-files-'));
    try {
      await Promise.all([
        mkdir(join(root, 'src')),
        mkdir(join(root, 'node_modules')),
        writeFile(join(root, 'src', 'main.ts'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('const a = 1;\r\n')])),
        writeFile(join(root, 'binary.bin'), Buffer.from([0, 1, 2])),
        writeFile(join(root, 'large.txt'), Buffer.alloc(MAX_EDITABLE_FILE_BYTES + 1, 65)),
      ]);

      const rootNodes = await readWorkspaceDirectory(root);
      expect(rootNodes.map((node) => node.name)).toEqual(['src', 'binary.bin', 'large.txt']);
      expect((await readWorkspaceDirectory(root, 'src')).map((node) => node.path)).toEqual(['src/main.ts']);

      const initial = await readWorkspaceFile(root, 'src/main.ts');
      expect(initial).toMatchObject({ kind: 'text', content: 'const a = 1;\r\n', bom: true, languageId: 'typescript' });
      const saved = await writeWorkspaceFile(root, {
        path: 'src/main.ts', content: 'const a = 2;\r\n', expectedVersion: initial.version, bom: true,
      });
      expect(saved.version).not.toBe(initial.version);
      expect(await readFile(join(root, 'src', 'main.ts'))).toEqual(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('const a = 2;\r\n')]));
      expect((await readdir(join(root, 'src'))).some((name) => name.includes('.kimi-'))).toBe(false);

      await writeFile(join(root, 'src', 'main.ts'), 'external');
      await expect(writeWorkspaceFile(root, {
        path: 'src/main.ts', content: 'editor', expectedVersion: saved.version,
      })).rejects.toMatchObject({ code: 'workspace.file_conflict' });
      expect(await readWorkspaceFile(root, 'binary.bin')).toMatchObject({ kind: 'binary' });
      expect(await readWorkspaceFile(root, 'large.txt')).toMatchObject({ kind: 'too-large' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects symbolic-link files when the platform allows creating them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kimi-workspace-link-'));
    const outside = join(root, '..', `outside-${Date.now()}.txt`);
    try {
      await writeFile(outside, 'outside');
      try {
        await symlink(outside, join(root, 'link.txt'), 'file');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
        throw error;
      }
      await expect(readWorkspaceFile(root, 'link.txt')).rejects.toMatchObject({ code: 'workspace.file_symlink' });
    } finally {
      await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { force: true })]);
    }
  });

  it('builds authoritative staged and working diff contents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kimi-workspace-git-'));
    const run = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    try {
      run('init');
      run('config', 'user.name', 'Desktop Test');
      run('config', 'user.email', 'desktop@example.test');
      await writeFile(join(root, 'sample.ts'), 'const value = "base";\n');
      run('add', 'sample.ts');
      run('commit', '-m', 'base');
      await writeFile(join(root, 'sample.ts'), 'const value = "staged";\n');
      run('add', 'sample.ts');
      await writeFile(join(root, 'sample.ts'), 'const value = "working";\n');

      const status = await readGitStatus(root);
      const file = status.files.find((candidate) => candidate.path === 'sample.ts');
      expect(file).toMatchObject({ indexStatus: 'modified', worktreeStatus: 'modified' });
      if (file === undefined) throw new Error('missing sample.ts status');

      const staged = await readGitFileDiff(root, file, 'staged');
      expect(staged.original).toContain('base');
      expect(staged.modified).toContain('staged');
      const working = await readGitFileDiff(root, file, 'working');
      expect(working.original).toContain('staged');
      expect(working.modified).toContain('working');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
