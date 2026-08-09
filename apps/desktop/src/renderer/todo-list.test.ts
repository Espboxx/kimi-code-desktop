import { describe, expect, it } from 'vitest';

import { groupTodos, removeTodo, replaceTodo } from './todo-list';

const todos = [
  { title: 'Running', status: 'in_progress' as const },
  { title: 'Pending', status: 'pending' as const },
  { title: 'Done', status: 'done' as const },
  { title: 'Pending two', status: 'pending' as const },
];

describe('TodoList view model', () => {
  it('groups statuses without changing authoritative order', () => {
    const groups = groupTodos(todos);
    expect(groups.get('in_progress')).toEqual([{ index: 0, item: todos[0] }]);
    expect(groups.get('pending')).toEqual([
      { index: 1, item: todos[1] },
      { index: 3, item: todos[3] },
    ]);
    expect(groups.get('done')).toEqual([{ index: 2, item: todos[2] }]);
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
