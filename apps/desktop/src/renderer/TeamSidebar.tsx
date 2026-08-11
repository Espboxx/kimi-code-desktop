import { useState } from 'react';
import { CircleDashed, Plus, Trash2, Users } from 'lucide-react';

import type { SessionListItem, SessionStatusSnapshot, WorkspaceSnapshot } from '../shared/desktop-api';
import {
  NavigationRow,
  NavigationSection,
  NavigationSidebar,
  NavigationSidebarHeader,
} from './SidePrimitives';
import type { TeamBadge } from './swarm-ui';
import { basename, formatTime } from './ui-utils';

export function TeamSidebar({
  workspace,
  sessions,
  activeSessionId,
  activeWorkbenchSessionId,
  statuses,
  badges,
  onCreate,
  onSelect,
  onDelete,
}: {
  readonly workspace: WorkspaceSnapshot;
  readonly sessions: readonly SessionListItem[];
  readonly activeSessionId?: string;
  readonly activeWorkbenchSessionId?: string;
  readonly statuses: Readonly<Record<string, SessionStatusSnapshot>>;
  readonly badges: Readonly<Record<string, TeamBadge>>;
  readonly onCreate: () => void;
  readonly onSelect: (sessionId: string) => void;
  readonly onDelete: (session: SessionListItem) => void;
}) {
  const [tasksOpen, setTasksOpen] = useState(true);
  return (
    <NavigationSidebar className="team-task-sidebar" ariaLabel="团队任务">
      <NavigationSidebarHeader
        icon={<Users size={17} />}
        title="Team 工作台"
        subtitle={workspace.name || '工作区'}
        action={<button className="icon-button" onClick={onCreate} title="新建团队任务"><Plus size={16} /></button>}
      />
      <button className="team-create-button" onClick={onCreate}><Plus size={14} />新建团队任务</button>
      <NavigationSection
        className="team-task-section"
        title="团队任务"
        count={sessions.length}
        open={tasksOpen}
        onToggle={() => { setTasksOpen((value) => !value); }}
      >
        <div className="team-task-list">
          {sessions.length === 0 && (
            <div className="team-task-empty"><Users size={22} /><strong>还没有团队任务</strong><span>创建任务后，组长会主动拆分工作并协调子 Agent。</span></div>
          )}
          {sessions.map((session) => {
            const badge = badges[session.id];
            const status = statuses[session.id];
            const busy = status?.busy === true;
            const title = session.title || session.lastPrompt || '未命名团队任务';
            return (
              <NavigationRow
                className="team-task-row-shell"
                mainClassName="team-task-row"
                copyClassName="team-task-copy"
                actionsClassName="team-task-delete-actions"
                title={title}
                subtitle={`${formatTime(session.updatedAt)} · ${basename(session.id)}`}
                selected={session.id === activeWorkbenchSessionId}
                active={session.id === activeSessionId}
                busy={busy}
                revealActions
                onSelect={() => { onSelect(session.id); }}
                trailing={(
                  <span className="team-task-badges">
                    {busy && <CircleDashed className="spin" size={12} />}
                    {(badge?.running ?? 0) > 0 && <em className="running">{badge?.running} 运行</em>}
                    {(badge?.waiting ?? 0) > 0 && <em className="waiting">{badge?.waiting} 等待</em>}
                    {(badge?.failed ?? 0) > 0 && <em className="failed">{badge?.failed} 失败</em>}
                    {(badge?.unread ?? 0) > 0 && <em className="unread">{badge?.unread}</em>}
                  </span>
                )}
                actions={(
                  <button
                    className="team-task-delete"
                    type="button"
                    title={busy ? '终止并删除团队任务' : '删除团队任务'}
                    aria-label={`删除团队任务：${title}`}
                    onClick={() => { onDelete(session); }}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
                key={session.id}
              />
            );
          })}
        </div>
      </NavigationSection>
    </NavigationSidebar>
  );
}
