import { describe, expect, it } from 'vitest';

import { nextTodoStatus, partitionTodos, removeTodo, replaceTodo } from './todo-list';

const todos = [
  { title: 'Running', status: 'in_progress' as const },
  { title: 'Pending', status: 'pending' as const },
  { title: 'Done', status: 'done' as const },
  { title: 'Pending two', status: 'pending' as const },
];

describe('TodoList view model', () => {
  it('separates active and completed cards without changing authoritative order', () => {
    const sections = partitionTodos(todos);
    expect(sections.active).toEqual([
      { index: 0, item: todos[0] },
      { index: 1, item: todos[1] },
      { index: 3, item: todos[3] },
    ]);
    expect(sections.completed).toEqual([{ index: 2, item: todos[2] }]);
  });

  it('cycles a task through pending, in-progress, done, and back to pending', () => {
    expect(nextTodoStatus('pending')).toBe('in_progress');
    expect(nextTodoStatus('in_progress')).toBe('done');
    expect(nextTodoStatus('done')).toBe('pending');
  });

  it('updates and removes by authoritative index', () => {
    expect(replaceTodo(todos, 1, { status: 'done', title: 'Updated' })).toEqual([
      todos[0],
      { title: 'Updated', status: 'done' },
      todos[2],
      todos[3],
    ]);
    expect(removeTodo(todos, 1)).toEqual([todos[0], todos[2], todos[3]]);
  });
});
