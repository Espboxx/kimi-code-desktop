import { CircleDashed, Plus, Users } from 'lucide-react';

import type { SessionListItem, SessionStatusSnapshot, WorkspaceSnapshot } from '../shared/desktop-api';
import { basename, classNames, formatTime } from './ui-utils';

interface TeamBadge {
  readonly unread: number;
  readonly running: number;
  readonly failed: number;
}

export function TeamSidebar({
  workspace,
  sessions,
  activeSessionId,
  activeWorkbenchSessionId,
  statuses,
  badges,
  onCreate,
  onSelect,
}: {
  readonly workspace: WorkspaceSnapshot;
  readonly sessions: readonly SessionListItem[];
  readonly activeSessionId?: string;
  readonly activeWorkbenchSessionId?: string;
  readonly statuses: Readonly<Record<string, SessionStatusSnapshot>>;
  readonly badges: Readonly<Record<string, TeamBadge>>;
  readonly onCreate: () => void;
  readonly onSelect: (sessionId: string) => void;
}) {
  return (
    <aside className="team-task-sidebar" aria-label="团队任务">
      <header className="team-task-sidebar-header">
        <div><Users size={17} /><span><strong>Team 工作台</strong><small>{workspace.name || '工作区'}</small></span></div>
        <button className="icon-button" onClick={onCreate} title="新建团队任务"><Plus size={16} /></button>
      </header>
      <button className="team-create-button" onClick={onCreate}><Plus size={14} />新建团队任务</button>
      <div className="team-task-heading"><span>团队任务</span><em>{sessions.length}</em></div>
      <div className="team-task-list">
        {sessions.length === 0 && (
          <div className="team-task-empty"><Users size={22} /><strong>还没有团队任务</strong><span>创建任务后，组长会主动拆分工作并协调子 Agent。</span></div>
        )}
        {sessions.map((session) => {
          const badge = badges[session.id];
          const status = statuses[session.id];
          const busy = status?.busy === true;
          return (
            <button
              className={classNames('team-task-row', session.id === activeWorkbenchSessionId && 'selected')}
              onClick={() => onSelect(session.id)}
              key={session.id}
            >
              <span className={classNames('session-presence', (session.id === activeSessionId || busy) && 'active', busy && 'busy')} />
              <span className="team-task-copy">
                <strong>{session.title || session.lastPrompt || '未命名团队任务'}</strong>
                <small>{formatTime(session.updatedAt)} · {basename(session.id)}</small>
              </span>
              <span className="team-task-badges">
                {busy && <CircleDashed className="spin" size={12} />}
                {(badge?.running ?? 0) > 0 && <em className="running">{badge?.running} 运行</em>}
                {(badge?.failed ?? 0) > 0 && <em className="failed">{badge?.failed} 失败</em>}
                {(badge?.unread ?? 0) > 0 && <em className="unread">{badge?.unread}</em>}
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
