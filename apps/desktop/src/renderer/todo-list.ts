import type {
  TeamAssignment,
  TeamAssignmentStatus,
  TeamMember,
  TodoItem,
  TodoStatus,
} from '../shared/desktop-api';

export interface IndexedTodo {
  readonly index: number;
  readonly item: TodoItem;
}

export interface TodoListSections {
  readonly active: readonly IndexedTodo[];
  readonly completed: readonly IndexedTodo[];
}

export type TeamTodoBucket = 'running' | 'waiting' | 'terminal';
export type TeamTodoSource = 'leader' | 'assignment';

export interface TeamTodoEntry {
  readonly id: string;
  readonly title: string;
  readonly source: TeamTodoSource;
  readonly sourceLabel: '组长计划' | '子任务';
  readonly status: TodoStatus | TeamAssignmentStatus;
  readonly statusLabel: string;
  readonly bucket: TeamTodoBucket;
  readonly ownerAgentId?: string;
  readonly ownerLabel: string;
}

export interface TeamTodoSections {
  readonly running: readonly TeamTodoEntry[];
  readonly waiting: readonly TeamTodoEntry[];
  readonly terminal: readonly TeamTodoEntry[];
}

export interface TeamTodoCounts {
  readonly running: number;
  readonly waiting: number;
  readonly terminal: number;
}

export function partitionTodos(todos: readonly TodoItem[]): TodoListSections {
  const active: IndexedTodo[] = [];
  const completed: IndexedTodo[] = [];
  todos.forEach((item, index) => {
    (item.status === 'done' ? completed : active).push({ index, item });
  });
  return { active, completed };
}

export function nextTodoStatus(status: TodoStatus): TodoStatus {
  if (status === 'pending') return 'in_progress';
  if (status === 'in_progress') return 'done';
  return 'pending';
}

export function todoStatusLabel(status: TodoStatus): string {
  if (status === 'pending') return '未完成';
  if (status === 'in_progress') return '正在进行';
  return '已完成';
}

export function replaceTodo(
  todos: readonly TodoItem[],
  index: number,
  patch: Partial<TodoItem>,
): readonly TodoItem[] {
  return todos.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item);
}

export function removeTodo(todos: readonly TodoItem[], index: number): readonly TodoItem[] {
  return todos.filter((_item, itemIndex) => itemIndex !== index);
}

export function buildTeamTodoEntries(
  leaderTodos: readonly TodoItem[],
  assignments: readonly TeamAssignment[],
  members: readonly TeamMember[],
  leaderAgentId: string,
): readonly TeamTodoEntry[] {
  const leader = members.find((member) => member.agentId === leaderAgentId);
  const leaderLabel = leader?.displayName ?? (leaderAgentId === 'main' ? '组长' : leaderAgentId);
  return [
    ...leaderTodos.map((item, index): TeamTodoEntry => ({
      id: `leader:${String(index)}`,
      title: item.title,
      source: 'leader',
      sourceLabel: '组长计划',
      status: item.status,
      statusLabel: todoStatusLabel(item.status),
      bucket: todoBucket(item.status),
      ownerAgentId: leaderAgentId,
      ownerLabel: leaderLabel,
    })),
    ...assignments.map((assignment): TeamTodoEntry => {
      const owner = assignment.agentId === undefined
        ? undefined
        : members.find((member) => member.agentId === assignment.agentId);
      return {
        id: `assignment:${assignment.id}`,
        title: assignment.description,
        source: 'assignment',
        sourceLabel: '子任务',
        status: assignment.status,
        statusLabel: assignmentStatusLabel(assignment.status),
        bucket: assignmentBucket(assignment.status),
        ownerAgentId: assignment.agentId,
        ownerLabel: assignment.agentId === undefined
          ? '等待分配'
          : owner?.displayName ?? assignment.displayName ?? assignment.agentId,
      };
    }),
  ];
}

export function partitionTeamTodos(entries: readonly TeamTodoEntry[]): TeamTodoSections {
  const sections: Record<TeamTodoBucket, TeamTodoEntry[]> = {
    running: [],
    waiting: [],
    terminal: [],
  };
  for (const entry of entries) sections[entry.bucket].push(entry);
  return sections;
}

export function countTeamTodos(entries: readonly TeamTodoEntry[]): TeamTodoCounts {
  const sections = partitionTeamTodos(entries);
  return {
    running: sections.running.length,
    waiting: sections.waiting.length,
    terminal: sections.terminal.length,
  };
}

function todoBucket(status: TodoStatus): TeamTodoBucket {
  if (status === 'in_progress') return 'running';
  if (status === 'pending') return 'waiting';
  return 'terminal';
}

function assignmentBucket(status: TeamAssignmentStatus): TeamTodoBucket {
  if (status === 'running' || status === 'awaiting_validation' || status === 'integrating') return 'running';
  if (status === 'queued' || status === 'blocked' || status === 'ready') return 'waiting';
  return 'terminal';
}

function assignmentStatusLabel(status: TeamAssignmentStatus): string {
  const labels: Record<TeamAssignmentStatus, string> = {
    queued: '等待',
    blocked: '依赖阻塞',
    ready: '就绪',
    running: '运行中',
    awaiting_validation: '等待验证',
    integrating: '集成中',
    completed: '完成',
    failed: '失败',
    cancelled: '已取消',
    interrupted: '已中断',
  };
  return labels[status];
}
