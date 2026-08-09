import { useState } from 'react';
import {
  Brain,
  Clock3,
  FileText,
  FolderPlus,
  Gauge,
  ListChecks,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Square,
  Trash2,
  Users,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import type { SessionDetailsSnapshot } from '../shared/desktop-api';
import type { TodoItem } from '../shared/desktop-api';
import { AgentActivityTree } from './AgentActivity';
import type { AgentActivityForest } from './agent-activity';
import { contextPercentage, contextProgress } from './composer-utils';
import { classNames, formatJson, number, record, text } from './ui-utils';
import { TodoListPanel } from './TodoListPanel';

type InspectorTab = 'plan' | 'agents' | 'tasks' | 'goal' | 'context';

interface InspectorProps {
  readonly sessionId?: string;
  readonly details: SessionDetailsSnapshot;
  readonly activity: AgentActivityForest;
  readonly selectedAgentId: string;
  readonly onSelectAgent: (agentId: string) => void;
  readonly onTaskOutput: (taskId: string) => void;
  readonly planModePending: boolean;
  readonly onSetPlanMode: (enabled: boolean) => Promise<void>;
  readonly todos: readonly TodoItem[];
  readonly todoReadOnly: boolean;
}

export function Inspector(props: InspectorProps) {
  const [tab, setTab] = useState<InspectorTab>('plan');
  const tabs: Array<{ id: InspectorTab; label: string; icon: React.ReactNode }> = [
    { id: 'plan', label: 'Plan', icon: <FileText size={13} /> },
    { id: 'agents', label: 'Agents', icon: <Users size={13} /> },
    { id: 'tasks', label: '后台任务', icon: <ListChecks size={13} /> },
    { id: 'goal', label: 'Goal', icon: <Gauge size={13} /> },
    { id: 'context', label: '上下文', icon: <Brain size={13} /> },
  ];
  return (
    <aside className="inspector">
      <div className="inspector-tabs" role="tablist">
        {tabs.map((item) => (
          <button
            role="tab"
            aria-selected={tab === item.id}
            className={tab === item.id ? 'active' : ''}
            onClick={() => setTab(item.id)}
            key={item.id}
          >{item.icon}<span>{item.label}</span></button>
        ))}
      </div>
      <TodoListPanel
        key={props.sessionId ?? 'no-session'}
        sessionId={props.sessionId}
        todos={props.todos}
        readOnly={props.todoReadOnly}
      />
      <div className="inspector-content">
        {props.sessionId === undefined ? <div className="inspector-empty">选择会话后可查看运行状态</div> : (
          <>
            {tab === 'plan' && (
              <PlanPanel
                sessionId={props.sessionId}
                plan={props.details.plan}
                planMode={props.details.status?.planMode === true}
                pending={props.planModePending}
                onSetPlanMode={props.onSetPlanMode}
              />
            )}
            {tab === 'agents' && <AgentsPanel {...props} />}
            {tab === 'tasks' && <TasksPanel sessionId={props.sessionId} tasks={props.details.backgroundTasks} onOutput={props.onTaskOutput} />}
            {tab === 'goal' && <GoalPanel sessionId={props.sessionId} goal={props.details.goal} cron={props.details.cron} />}
            {tab === 'context' && <ContextPanel sessionId={props.sessionId} details={props.details} />}
          </>
        )}
      </div>
    </aside>
  );
}

function PlanPanel({
  sessionId,
  plan,
  planMode,
  pending,
  onSetPlanMode,
}: {
  readonly sessionId: string;
  readonly plan: unknown;
  readonly planMode: boolean;
  readonly pending: boolean;
  readonly onSetPlanMode: (enabled: boolean) => Promise<void>;
}) {
  const data = record(plan);
  const content = text(data['content']);
  if (content.length === 0) {
    return (
      <div className="inspector-empty compact-empty">
        <FileText size={20} />
        <strong>{planMode ? 'Plan 模式已开启' : '暂无 Plan'}</strong>
        <span>{planMode ? '等待 Kimi 生成或更新计划' : '进入 Plan 模式后由 Kimi 创建计划'}</span>
        <button disabled={pending} onClick={() => void onSetPlanMode(!planMode)}>
          {pending ? '正在切换…' : planMode ? '退出 Plan 模式' : '进入 Plan 模式'}
        </button>
      </div>
    );
  }
  return (
    <div className="panel-stack">
      <div className="panel-heading-row">
        <div><strong>{text(data['id'], 'Plan')}</strong><small>{text(data['path'])}</small></div>
        <button className="icon-button" onClick={() => void window.kimiDesktop.host.openPath(text(data['path']))} title="打开 Plan 文件" disabled={text(data['path']).length === 0}><FileText size={14} /></button>
      </div>
      <div className="plan-content markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown></div>
      <div className="panel-actions">
        <button disabled={pending} onClick={() => void onSetPlanMode(false)}>{pending ? '正在切换…' : '退出 Plan'}</button>
        <button onClick={() => void window.kimiDesktop.context.clearPlan(sessionId)}><Trash2 size={13} />清空</button>
      </div>
    </div>
  );
}

function AgentsPanel(props: InspectorProps) {
  const agents = props.activity.counts.total;
  return (
    <div className="panel-stack">
      <div className="panel-heading-row">
        <div><strong>Agent 活动</strong><small>{agents} 个 transcript</small></div>
        <button className="icon-button" onClick={() => void window.kimiDesktop.task.startBtw(props.sessionId)} title="启动 BTW Agent"><Plus size={14} /></button>
      </div>
      {agents === 0 ? (
        <div className="inspector-empty compact-empty">暂无 Agent transcript</div>
      ) : (
        <AgentActivityTree
          nodes={props.activity.roots}
          selectedAgentId={props.selectedAgentId}
          onSelectAgent={props.onSelectAgent}
        />
      )}
      {props.activity.unattached.length > 0 && (
        <section className="unattached-agents">
          <h4>未挂载 <span>{props.activity.unattached.length}</span></h4>
          <AgentActivityTree
            nodes={props.activity.unattached}
            selectedAgentId={props.selectedAgentId}
            onSelectAgent={props.onSelectAgent}
          />
        </section>
      )}
    </div>
  );
}

function TasksPanel({ sessionId, tasks, onOutput }: { readonly sessionId: string; readonly tasks: readonly unknown[]; readonly onOutput: (taskId: string) => void }) {
  if (tasks.length === 0) return <div className="inspector-empty compact-empty"><ListChecks size={20} /><strong>没有后台任务</strong></div>;
  return (
    <div className="task-list-panel">
      {tasks.map((raw, index) => {
        const task = record(raw);
        const taskId = text(task['taskId'], text(task['id'], `task-${index}`));
        const status = text(task['status'], 'unknown');
        return (
          <div className="task-row-panel" key={taskId}>
            <div className="task-row-main">
              <span className={classNames('status-dot', status === 'running' && 'status-running')} />
              <span><strong>{text(task['description'], text(task['command'], taskId))}</strong><small>{taskId} · {status}</small></span>
            </div>
            <div className="row-actions">
              <button onClick={() => onOutput(taskId)} title="查看输出"><FileText size={13} /></button>
              {status === 'running' && <button onClick={() => void window.kimiDesktop.task.detach(taskId, sessionId)} title="转到后台"><Pause size={13} /></button>}
              {status === 'running' && <button onClick={() => void window.kimiDesktop.task.stop(taskId, 'Stopped from desktop', sessionId)} title="停止"><Square size={12} /></button>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function GoalPanel({ sessionId, goal, cron }: { readonly sessionId: string; readonly goal: unknown; readonly cron: unknown }) {
  const [objective, setObjective] = useState('');
  const goalResult = record(goal);
  const current = record(goalResult['goal'] ?? goal);
  const status = text(current['status']);
  return (
    <div className="panel-stack">
      {text(current['objective']).length > 0 ? (
        <div className="goal-current">
          <div className="goal-status"><span className={`status-dot status-${status}`} /><strong>{status}</strong></div>
          <p>{text(current['objective'])}</p>
          <div className="goal-stats">
            <span>{number(current['turnsUsed'])} turns</span>
            <span>{number(current['tokensUsed'])} tokens</span>
          </div>
          <div className="panel-actions">
            {status === 'active' && <button onClick={() => void window.kimiDesktop.goal.pause(sessionId)}><Pause size={13} />暂停</button>}
            {status === 'paused' && <button onClick={() => void window.kimiDesktop.goal.resume(sessionId)}><Play size={13} />继续</button>}
            {!['complete', 'cancelled'].includes(status) && <button onClick={() => void window.kimiDesktop.goal.cancel(sessionId)}><Square size={12} />取消</button>}
          </div>
        </div>
      ) : (
        <div className="goal-create">
          <label>目标</label>
          <textarea value={objective} onChange={(event) => setObjective(event.target.value)} rows={4} placeholder="定义一个持续执行的目标" />
          <button className="button-primary" disabled={objective.trim().length === 0} onClick={() => {
            void window.kimiDesktop.goal.create(objective.trim(), false, sessionId);
            setObjective('');
          }}><Plus size={13} />创建 Goal</button>
        </div>
      )}
      <section className="subsection">
        <h4><Clock3 size={13} />Cron</h4>
        <pre className="compact-json">{formatJson(cron)}</pre>
      </section>
    </div>
  );
}

function ContextPanel({ sessionId, details }: { readonly sessionId: string; readonly details: SessionDetailsSnapshot }) {
  const [instruction, setInstruction] = useState('');
  const [importText, setImportText] = useState('');
  const [directory, setDirectory] = useState('');
  const status = details.status;
  const percent = contextPercentage(status?.contextUsage ?? 0);
  const progress = contextProgress(status?.contextUsage ?? 0);
  return (
    <div className="panel-stack context-panel">
      <div className="context-meter">
        <div><strong>Context</strong><span>{status?.contextTokens ?? 0} / {status?.maxContextTokens ?? 0}</span></div>
        <progress value={progress} max={100} />
        <small>{percent}% · {details.context?.messageCount ?? 0} messages</small>
      </div>
      <section className="subsection">
        <h4>压缩与历史</h4>
        <input value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="压缩指令（可选）" />
        <div className="panel-actions wrap">
          <button onClick={() => void window.kimiDesktop.turn.compact(instruction || undefined, sessionId)}><RotateCcw size={13} />Compact</button>
          <button onClick={() => void window.kimiDesktop.turn.cancelCompact(sessionId)}>取消 Compact</button>
          <button onClick={() => void window.kimiDesktop.turn.undo(1, sessionId)}>Undo</button>
          <button onClick={() => void window.kimiDesktop.context.clear(sessionId)}><Trash2 size={13} />Clear</button>
        </div>
      </section>
      <section className="subsection">
        <h4>导入上下文</h4>
        <textarea rows={4} value={importText} onChange={(event) => setImportText(event.target.value)} placeholder="粘贴要追加的上下文" />
        <button disabled={importText.trim().length === 0} onClick={() => {
          void window.kimiDesktop.context.import(importText, 'desktop-import', sessionId);
          setImportText('');
        }}>导入</button>
      </section>
      <section className="subsection">
        <h4>Additional directories</h4>
        {details.context?.additionalDirs.map((path) => <div className="path-row" key={path}>{path}</div>)}
        <div className="inline-form"><input value={directory} onChange={(event) => setDirectory(event.target.value)} placeholder="绝对目录" /><button className="icon-button" onClick={() => {
          if (directory.trim().length === 0) return;
          void window.kimiDesktop.context.addDirectory(directory.trim(), true, sessionId);
          setDirectory('');
        }} title="添加目录"><FolderPlus size={14} /></button></div>
      </section>
      <div className="panel-actions wrap">
        <button onClick={() => void window.kimiDesktop.context.initAgents(sessionId)}>初始化 AGENTS.md</button>
        <button onClick={() => void window.kimiDesktop.context.applySecondaryModel(sessionId)}>应用 Secondary Model</button>
      </div>
    </div>
  );
}
