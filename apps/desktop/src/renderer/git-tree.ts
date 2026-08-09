import type { GitDiffArea, GitFile, GitFileStats, GitStatus } from '../shared/desktop-api';

export interface GitChangeEntry {
  readonly key: string;
  readonly file: GitFile;
  readonly area: GitDiffArea;
  readonly status: GitStatus;
  readonly stats: GitFileStats;
}

export interface GitChangeGroup {
  readonly id: 'merge' | 'staged' | 'working';
  readonly label: string;
  readonly entries: readonly GitChangeEntry[];
}

export interface GitTreeDirectory {
  readonly kind: 'directory';
  readonly name: string;
  readonly path: string;
  readonly children: readonly GitTreeNode[];
}

export interface GitTreeFile {
  readonly kind: 'file';
  readonly name: string;
  readonly path: string;
  readonly entry: GitChangeEntry;
}

export type GitTreeNode = GitTreeDirectory | GitTreeFile;

export function groupGitChanges(files: readonly GitFile[]): readonly GitChangeGroup[] {
  const merge: GitChangeEntry[] = [];
  const staged: GitChangeEntry[] = [];
  const working: GitChangeEntry[] = [];
  for (const file of files) {
    if (file.indexStatus === 'conflicted' || file.worktreeStatus === 'conflicted') {
      merge.push(entry(file, 'conflict', 'conflicted', file.worktreeStats));
      continue;
    }
    if (file.indexStatus !== undefined) staged.push(entry(file, 'staged', file.indexStatus, file.indexStats));
    if (file.worktreeStatus !== undefined) working.push(entry(file, 'working', file.worktreeStatus, file.worktreeStats));
  }
  return [
    { id: 'merge', label: 'MERGE CHANGES', entries: merge },
    { id: 'staged', label: 'STAGED CHANGES', entries: staged },
    { id: 'working', label: 'CHANGES', entries: working },
  ].filter((group) => group.entries.length > 0) as readonly GitChangeGroup[];
}

export function buildGitTree(entries: readonly GitChangeEntry[]): readonly GitTreeNode[] {
  interface MutableDirectory {
    readonly directories: Map<string, MutableDirectory>;
    readonly files: GitTreeFile[];
  }
  const root: MutableDirectory = { directories: new Map(), files: [] };
  for (const change of entries) {
    const parts = change.file.path.split('/').filter(Boolean);
    const name = parts.pop();
    if (name === undefined) continue;
    let parent = root;
    const pathParts: string[] = [];
    for (const part of parts) {
      pathParts.push(part);
      let directory = parent.directories.get(part);
      if (directory === undefined) {
        directory = { directories: new Map(), files: [] };
        parent.directories.set(part, directory);
      }
      parent = directory;
    }
    parent.files.push({ kind: 'file', name, path: change.file.path, entry: change });
  }

  const materialize = (directory: MutableDirectory, prefix: string): readonly GitTreeNode[] => [
    ...[...directory.directories.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, child]) => {
        const path = prefix.length === 0 ? name : `${prefix}/${name}`;
        return { kind: 'directory' as const, name, path, children: materialize(child, path) };
      }),
    ...directory.files.sort((left, right) => left.name.localeCompare(right.name)),
  ];
  return materialize(root, '');
}

export function gitDecoration(path: string, files: readonly GitFile[], directory = false): GitStatus | undefined {
  const candidates = directory
    ? files.filter((file) => file.path.startsWith(`${path}/`))
    : files.filter((file) => file.path === path);
  let selected: GitStatus | undefined;
  for (const file of candidates) {
    selected = higherPriority(selected, file.worktreeStatus);
    selected = higherPriority(selected, file.indexStatus);
  }
  return selected;
}

export function gitStatusLetter(status: GitStatus): string {
  switch (status) {
    case 'untracked': return 'U';
    case 'added': return 'A';
    case 'deleted': return 'D';
    case 'renamed': return 'R';
    case 'copied': return 'C';
    case 'conflicted': return '!';
    case 'modified': return 'M';
  }
}

export function gitStatusLabel(status: GitStatus): string {
  return ({
    untracked: '未跟踪', added: '已添加', modified: '已修改', deleted: '已删除',
    renamed: '已重命名', copied: '已复制', conflicted: '存在冲突',
  } as const)[status];
}

function entry(file: GitFile, area: GitDiffArea, status: GitStatus, stats: GitFileStats): GitChangeEntry {
  return { key: `${area}:${file.path}`, file, area, status, stats };
}

function higherPriority(current: GitStatus | undefined, candidate: GitStatus | undefined): GitStatus | undefined {
  if (candidate === undefined) return current;
  if (current === undefined) return candidate;
  const priority: Record<GitStatus, number> = {
    conflicted: 7, deleted: 6, renamed: 5, copied: 4, added: 3, modified: 2, untracked: 1,
  };
  return priority[candidate] > priority[current] ? candidate : current;
}
