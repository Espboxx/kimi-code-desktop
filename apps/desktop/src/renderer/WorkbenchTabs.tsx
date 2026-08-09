import { Bot, CircleAlert, FileCode2, GitCompare, UserRoundCog, Users, X } from 'lucide-react';

import type { SessionListItem, SessionStatusSnapshot } from '../shared/desktop-api';
import { classNames } from './ui-utils';
import type { WorkbenchTab, WorkbenchTabState } from './workbench-tabs';

export function WorkbenchTabs({ state, sessions, statuses, pendingCounts, teamBadges, onActivate, onClose }: {
  readonly state: WorkbenchTabState;
  readonly sessions: readonly SessionListItem[];
  readonly statuses: Readonly<Record<string, SessionStatusSnapshot>>;
  readonly pendingCounts: Readonly<Record<string, number>>;
  readonly teamBadges?: Readonly<Record<string, { readonly unread: number; readonly running: number; readonly failed: number }>>;
  readonly onActivate: (tab: WorkbenchTab) => void;
  readonly onClose: (tab: WorkbenchTab) => void;
}) {
  return (
    <div className="workbench-tabbar" role="tablist" aria-label="编辑器标签">
      <div className="workbench-tab-scroll">
        {state.tabs.map((tab) => {
          const session = tab.kind === 'session' || tab.kind === 'team' || tab.kind === 'agent'
            ? sessions.find((item) => item.id === tab.sessionId)
            : undefined;
          const busy = tab.kind === 'session' && statuses[tab.sessionId]?.busy === true;
          const pending = tab.kind === 'session' ? pendingCounts[tab.sessionId] ?? 0 : 0;
          const teamBadge = tab.kind === 'team' ? teamBadges?.[tab.sessionId] : undefined;
          return (
            <div
              className={classNames('workbench-tab', state.activeId === tab.id && 'active', tab.kind === 'file' && tab.dirty && 'dirty')}
              role="tab"
              aria-selected={state.activeId === tab.id}
              onAuxClick={(event) => { if (event.button === 1) onClose(tab); }}
              key={tab.id}
            >
              <button className="workbench-tab-main" onClick={() => onActivate(tab)} title={tabTitle(tab, session)}>
                {tab.kind === 'session' ? <Bot size={13} /> : tab.kind === 'team' ? <Users size={13} /> : tab.kind === 'agent' ? <UserRoundCog size={13} /> : tab.kind === 'file' ? <FileCode2 size={13} /> : <GitCompare size={13} />}
                <span>{tabLabel(tab, session)}</span>
                {busy && <i className="tab-working" title="Working" />}
                {pending > 0 && <em title={`${pending} 个待处理交互`}>{pending}</em>}
                {(teamBadge?.running ?? 0) > 0 && <i className="tab-working" title={`${teamBadge?.running} 个任务运行中`} />}
                {(teamBadge?.failed ?? 0) > 0 && <CircleAlert className="tab-team-failed" size={12} aria-label={`${teamBadge?.failed} 个任务失败`} />}
                {(teamBadge?.unread ?? 0) > 0 && <em title={`${teamBadge?.unread} 条未读团队消息`}>{teamBadge?.unread}</em>}
                {tab.kind === 'file' && tab.dirty && <i className="tab-dirty" title="未保存" />}
              </button>
              <button className="workbench-tab-close" onClick={() => onClose(tab)} title="关闭标签"><X size={12} /></button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function tabLabel(tab: WorkbenchTab, session?: SessionListItem): string {
  if (tab.kind === 'session') return session?.title || session?.lastPrompt || 'Kimi 会话';
  if (tab.kind === 'team') return `${session?.title || session?.lastPrompt || 'Kimi 会话'} · 团队`;
  if (tab.kind === 'agent') return tab.agentId === 'main' ? '组长详情' : `${tab.agentId} · Agent`;
  const name = tab.path.split('/').at(-1) ?? tab.path;
  if (tab.kind === 'diff') return `${name} (${areaLabel(tab.area)})`;
  return tab.kind === 'operation-diff' ? `${name} (操作差异)` : name;
}

function tabTitle(tab: WorkbenchTab, session?: SessionListItem): string {
  if (tab.kind === 'session') return `${session?.title || session?.lastPrompt || 'Kimi 会话'} · ${tab.sessionId}`;
  if (tab.kind === 'team') return `团队频道 · ${session?.title || session?.lastPrompt || tab.sessionId}`;
  if (tab.kind === 'agent') return `${tab.agentId} · ${session?.title || session?.lastPrompt || tab.sessionId}`;
  if (tab.kind === 'diff') return `${tab.path} · ${areaLabel(tab.area)} Diff`;
  return tab.kind === 'operation-diff' ? `${tab.path} · 本次操作差异` : tab.path;
}

function areaLabel(area: Extract<WorkbenchTab, { kind: 'diff' }>['area']): string {
  return area === 'staged' ? 'Staged' : area === 'conflict' ? 'Conflict' : 'Working Tree';
}
