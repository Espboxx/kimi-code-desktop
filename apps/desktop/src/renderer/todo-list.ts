import type { TodoItem, TodoStatus } from '../shared/desktop-api';

export interface IndexedTodo {
  readonly index: number;
  readonly item: TodoItem;
}

export const TODO_GROUPS: readonly {
  readonly status: TodoStatus;
  readonly label: string;
}[] = [
  { status: 'in_progress', label: '正在进行' },
  { status: 'pending', label: '未完成' },
  { status: 'done', label: '已完成' },
];

export function groupTodos(todos: readonly TodoItem[]): ReadonlyMap<TodoStatus, readonly IndexedTodo[]> {
  const groups = new Map<TodoStatus, IndexedTodo[]>([
    ['in_progress', []],
    ['pending', []],
    ['done', []],
  ]);
  todos.forEach((item, index) => groups.get(item.status)?.push({ index, item }));
  return groups;
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
