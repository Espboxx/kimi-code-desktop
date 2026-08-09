import { useMemo, useState } from 'react';
import {
  Check,
  ListChecks,
  Plus,
  Square,
  SquareCheckBig,
  SquareMinus,
  Trash2,
  X,
} from 'lucide-react';

import type { TodoItem, TodoStatus } from '../shared/desktop-api';
import {
  nextTodoStatus,
  partitionTodos,
  removeTodo,
  replaceTodo,
  todoStatusLabel,
} from './todo-list';

interface TodoListPanelProps {
  readonly sessionId?: string;
  readonly todos: readonly TodoItem[];
  readonly readOnly: boolean;
}

export function TodoListPanel({ sessionId, todos, readOnly }: TodoListPanelProps) {
  const [newTitle, setNewTitle] = useState('');
  const [editing, setEditing] = useState<{ readonly index: number; readonly title: string }>();
  const [confirmDelete, setConfirmDelete] = useState<number>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const sections = useMemo(() => partitionTodos(todos), [todos]);
  const disabled = sessionId === undefined || readOnly || saving;

  const commit = async (next: readonly TodoItem[]): Promise<boolean> => {
    if (sessionId === undefined) return false;
    setSaving(true);
    setError(undefined);
    try {
      await window.kimiDesktop.task.replaceTodos(todos, next, sessionId);
      return true;
    } catch (error) {
      setError(errorMessage(error));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const addTodo = async () => {
    const title = newTitle.trim();
    if (title.length === 0) return;
    if (await commit([...todos, { title, status: 'pending' }])) setNewTitle('');
  };

  const saveTitle = async (index: number, title: string) => {
    const normalized = title.trim();
    if (normalized.length === 0) return;
    if (await commit(replaceTodo(todos, index, { title: normalized }))) setEditing(undefined);
  };

  const renderTodo = ({ item, index }: { readonly item: TodoItem; readonly index: number }) => {
    const nextStatus = nextTodoStatus(item.status);
    const isEditing = editing?.index === index;
    return (
      <div className={`todo-item todo-item-${item.status}`} key={`${index}:${item.title}`}>
        <button
          className={`todo-status-toggle todo-status-${item.status}`}
          disabled={disabled}
          aria-label={`${item.title}：${todoStatusLabel(item.status)}，点击切换为${todoStatusLabel(nextStatus)}`}
          title={`${todoStatusLabel(item.status)} · 点击切换为${todoStatusLabel(nextStatus)}`}
          onClick={() => void commit(replaceTodo(todos, index, { status: nextStatus }))}
        >
          <TodoStatusIcon status={item.status} />
        </button>
        {isEditing ? (
          <input
            autoFocus
            className="todo-title-input"
            value={editing.title}
            maxLength={10_000}
            disabled={saving}
            aria-label="任务名称"
            onChange={(event) => {
              setEditing({ index, title: event.target.value });
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setEditing(undefined);
              if (event.key === 'Enter') void saveTitle(index, editing.title);
            }}
          />
        ) : (
          <button
            className="todo-title-button"
            disabled={disabled}
            title={`${item.title} · 点击修改名称`}
            onClick={() => {
              setConfirmDelete(undefined);
              setEditing({ index, title: item.title });
            }}
          >{item.title}</button>
        )}
        <div className="todo-item-actions">
          {isEditing && (
            <>
              <button
                className="icon-button"
                disabled={saving || editing.title.trim().length === 0}
                title="保存名称"
                onClick={() => void saveTitle(index, editing.title)}
              ><Check size={12} /></button>
              <button
                className="icon-button"
                onClick={() => {
                  setEditing(undefined);
                }}
                title="取消编辑"
              ><X size={12} /></button>
            </>
          )}
          <button
            className={`icon-button ${confirmDelete === index ? 'danger' : ''}`}
            disabled={disabled}
            onClick={() => {
              if (confirmDelete !== index) {
                setConfirmDelete(index);
                return;
              }
              void commit(removeTodo(todos, index)).then((saved) => {
                if (saved) setConfirmDelete(undefined);
              });
            }}
            title={confirmDelete === index ? '再次点击确认删除' : '删除任务'}
          ><Trash2 size={13} /></button>
        </div>
      </div>
    );
  };

  return (
    <section className="todo-fixed-panel" aria-label="TodoList">
      <div className="todo-panel-heading">
        <span><ListChecks size={14} /><strong>TodoList</strong></span>
        <small>{todos.length} 项</small>
      </div>
      {sessionId === undefined ? (
        <div className="todo-empty">选择会话后查看 TodoList</div>
      ) : (
        <>
          <div className="todo-add-row">
            <input
              value={newTitle}
              disabled={disabled}
              maxLength={10_000}
              placeholder={readOnly ? 'Agent 运行期间只读' : '新增任务'}
              onChange={(event) => {
                setNewTitle(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void addTodo();
              }}
            />
            <button
              className="icon-button"
              disabled={disabled || newTitle.trim().length === 0}
              onClick={() => void addTodo()}
              title="新增任务"
            ><Plus size={14} /></button>
          </div>
          {readOnly && <div className="todo-readonly-note">Agent 正在工作，完成或终止后可编辑</div>}
          <div className="todo-lists">
            <section className="todo-card todo-card-active" aria-label="待办任务">
              <header><strong>待办</strong><small>{sections.active.length}</small></header>
              <div className="todo-card-items">
                {sections.active.length === 0
                  ? <div className="todo-card-empty">暂无待办</div>
                  : sections.active.map(renderTodo)}
              </div>
            </section>
            <section className="todo-card todo-card-completed" aria-label="已完成任务">
              <header><strong>已完成</strong><small>{sections.completed.length}</small></header>
              <div className="todo-card-items">
                {sections.completed.length === 0
                  ? <div className="todo-card-empty">暂无已完成任务</div>
                  : sections.completed.map(renderTodo)}
              </div>
            </section>
          </div>
          {error !== undefined && <div className="todo-error" role="alert">{error}</div>}
        </>
      )}
    </section>
  );
}

function TodoStatusIcon({ status }: { readonly status: TodoStatus }) {
  if (status === 'in_progress') return <SquareMinus size={17} />;
  if (status === 'done') return <SquareCheckBig size={17} />;
  return <Square size={17} />;
}

function errorMessage(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const message = (error as { readonly message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return String(error);
}
