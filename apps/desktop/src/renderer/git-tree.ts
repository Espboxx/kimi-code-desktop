import type { GitFile, GitStatus } from '../shared/desktop-api';

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

function higherPriority(current: GitStatus | undefined, candidate: GitStatus | undefined): GitStatus | undefined {
  if (candidate === undefined) return current;
  if (current === undefined) return candidate;
  const priority: Record<GitStatus, number> = {
    conflicted: 7, deleted: 6, renamed: 5, copied: 4, added: 3, modified: 2, untracked: 1,
  };
  return priority[candidate] > priority[current] ? candidate : current;
}
