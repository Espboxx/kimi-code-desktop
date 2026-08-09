import type { TodoItem, TodoStatus } from '../shared/desktop-api';

export interface IndexedTodo {
  readonly index: number;
  readonly item: TodoItem;
}

export interface TodoListSections {
  readonly active: readonly IndexedTodo[];
  readonly completed: readonly IndexedTodo[];
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
