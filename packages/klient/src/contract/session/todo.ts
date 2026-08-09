/**
 * `sessionTodoService` — the session-shared TodoList contract.
 */

import { z } from 'zod';

import { noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';

export const todoItemSchema = z.object({
  title: z.string().min(1),
  status: z.enum(['pending', 'in_progress', 'done']),
});

export const todoItemsSchema = z.array(todoItemSchema);

export const sessionTodoContract = {
  getTodos: { input: z.tuple([]), output: todoItemsSchema },
  setTodos: { input: z.tuple([todoItemsSchema]), output: noResult },
} satisfies ServiceContract;
