import { useMemo, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  ListChecks,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react';

import type { TodoItem, TodoStatus } from '../shared/desktop-api';
import { groupTodos, removeTodo, replaceTodo, TODO_GROUPS } from './todo-list';

interface TodoListPanelProps {
  readonly sessionId?: string;
  readonly todos: readonly TodoItem[];
  readonly readOnly: boolean;
}

export function TodoListPanel({ sessionId, todos, readOnly }: TodoListPanelProps) {
  const [expanded, setExpanded] = useState<Record<TodoStatus, boolean>>({
    in_progress: true,
    pending: true,
    done: false,
  });
  const [newTitle, setNewTitle] = useState('');
  const [editing, setEditing] = useState<{ readonly index: number; readonly title: string }>();
  const [confirmDelete, setConfirmDelete] = useState<number>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const groups = useMemo(() => groupTodos(todos), [todos]);
  const disabled = sessionId === undefined || readOnly || saving;

  const commit = async (next: readonly TodoItem[]): Promise<boolean> => {
    if (sessionId === undefined) return false;
    setSaving(true);
    setError(undefined);
    try {
      await window.kimiDesktop.task.replaceTodos(todos, next, sessionId);
      return true;
    } catch (caught) {
      setError(errorMessage(caught));
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
              placeholder={readOnly ? 'Agent 运行期间只读' : '新增未完成任务'}
              onChange={(event) => setNewTitle(event.target.value)}
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
          <div className="todo-groups">
            {TODO_GROUPS.map((group) => {
              const entries = groups.get(group.status) ?? [];
              const open = expanded[group.status];
              return (
                <section className={`todo-group todo-group-${group.status}`} key={group.status}>
                  <button
                    className="todo-group-heading"
                    aria-expanded={open}
                    onClick={() => setExpanded((current) => ({ ...current, [group.status]: !current[group.status] }))}
                  >
                    {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    <span>{group.label}</span><small>{entries.length}</small>
                  </button>
                  {open && (
                    <div className="todo-group-items">
                      {entries.length === 0 ? <div className="todo-group-empty">暂无</div> : entries.map(({ item, index }) => (
                        <div className="todo-item" key={`${index}:${item.title}`}>
                          <select
                            aria-label={`${item.title} 状态`}
                            disabled={disabled}
                            value={item.status}
                            onChange={(event) => void commit(replaceTodo(todos, index, {
                              status: event.target.value as TodoStatus,
                            }))}
                          >
                            <option value="in_progress">正在进行</option>
                            <option value="pending">未完成</option>
                            <option value="done">已完成</option>
                          </select>
                          {editing?.index === index ? (
                            <input
                              autoFocus
                              className="todo-title-input"
                              value={editing.title}
                              maxLength={10_000}
                              disabled={saving}
                              onChange={(event) => setEditing({ index, title: event.target.value })}
                              onKeyDown={(event) => {
                                if (event.key === 'Escape') setEditing(undefined);
                                if (event.key === 'Enter') {
                                  const title = editing.title.trim();
                                  if (title.length > 0) void commit(replaceTodo(todos, index, { title })).then((saved) => {
                                    if (saved) setEditing(undefined);
                                  });
                                }
                              }}
                            />
                          ) : <span className="todo-title" title={item.title}>{item.title}</span>}
                          <div className="todo-item-actions">
                            {editing?.index === index ? (
                              <>
                                <button
                                  className="icon-button"
                                  disabled={saving || editing.title.trim().length === 0}
                                  title="保存名称"
                                  onClick={() => {
                                    const title = editing.title.trim();
                                    if (title.length === 0) return;
                                    void commit(replaceTodo(todos, index, { title })).then((saved) => {
                                      if (saved) setEditing(undefined);
                                    });
                                  }}
                                ><Check size={12} /></button>
                                <button className="icon-button" onClick={() => setEditing(undefined)} title="取消编辑"><X size={12} /></button>
                              </>
                            ) : (
                              <button
                                className="icon-button"
                                disabled={disabled}
                                onClick={() => setEditing({ index, title: item.title })}
                                title="修改名称"
                              ><Pencil size={12} /></button>
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
                            ><Trash2 size={12} /></button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
          {error !== undefined && <div className="todo-error" role="alert">{error}</div>}
        </>
      )}
    </section>
  );
}

function errorMessage(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const message = (error as { readonly message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return String(error);
}
