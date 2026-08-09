import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Clock3,
  Send,
  UserRound,
  Users,
} from 'lucide-react';

import type {
  TeamAssignment,
  TeamAssignmentStatus,
  TeamMember,
  TeamStateSnapshot,
} from '../shared/desktop-api';
import { classNames } from './ui-utils';

export function TeamPage({ sessionId, state, onSeen, onSelectAgent }: {
  readonly sessionId: string;
  readonly state: TeamStateSnapshot;
  readonly onSeen: (channelSeq: number) => void;
  readonly onSelectAgent: (agentId: string) => void;
}) {
  const [body, setBody] = useState('');
  const [clientMessageId, setClientMessageId] = useState<string>();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const [assignmentsOpen, setAssignmentsOpen] = useState(true);
  const streamRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const snapshot = state.snapshot;
  const team = snapshot.team;
  const activeBatches = snapshot.batches.filter((batch) => batch.status === 'running').length;
  const statusCounts = countAssignments(snapshot.assignments);
  const assignmentForest = useMemo(
    () => buildAssignmentForest(snapshot.assignments),
    [snapshot.assignments],
  );
  const assignmentGroups = useMemo(() => groupAssignmentForest(assignmentForest), [assignmentForest]);

  useEffect(() => {
    const element = streamRef.current;
    if (element === null || !nearBottomRef.current) return;
    element.scrollTop = element.scrollHeight;
    onSeen(snapshot.latestChannelSeq);
  }, [onSeen, snapshot.latestChannelSeq, state.messages.length]);

  const send = async () => {
    const message = body.trim();
    if (message.length === 0 || sending) return;
    const id = clientMessageId ?? crypto.randomUUID();
    setClientMessageId(id);
    setSending(true);
    setError(undefined);
    try {
      await window.kimiDesktop.team.submit(sessionId, message, id);
      setBody('');
      setClientMessageId(undefined);
      nearBottomRef.current = true;
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  };

  if (team === undefined) {
    return <div className="team-empty"><Users size={24} /><strong>正在初始化团队</strong><span>团队频道准备完成后会自动显示。</span></div>;
  }

  return (
    <section className="team-page" aria-label="团队频道">
      <header className="team-header">
        <div className="team-title"><Users size={17} /><div><strong>团队频道</strong><span>#{team.channelId}</span></div></div>
        <div className="team-summary">
          <span title={`组长 ${team.leaderAgentId}`}><Bot size={13} />{team.leaderAgentId}</span>
          <span><Users size={13} />{snapshot.members.length} 成员</span>
          <span className={classNames(activeBatches > 0 && 'running')}><CircleDashed size={13} />{activeBatches} 活动批次</span>
          <span className={classNames(snapshot.state === 'degraded' && 'failed')} title={snapshot.degradedReason}>
            {snapshot.state === 'degraded' ? <CircleAlert size={13} /> : <CircleCheck size={13} />}
            {snapshot.state === 'degraded' ? '只读降级' : '已连接'}
          </span>
        </div>
      </header>

      <div className="team-layout">
        <div className="team-messages-column">
          <div
            className="team-message-stream"
            ref={streamRef}
            onScroll={(event) => {
              const element = event.currentTarget;
              nearBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
              if (nearBottomRef.current) onSeen(snapshot.latestChannelSeq);
            }}
          >
            {state.messages.length === 0 && <div className="team-message-empty">general 频道还没有消息</div>}
            {state.messages.map((message) => (
              <article className="team-message" key={message.id}>
                <button
                  className="team-message-avatar"
                  disabled={message.sender.actorKind !== 'agent'}
                  onClick={() => { if (message.sender.actorKind === 'agent') onSelectAgent(message.sender.actorId); }}
                  title={message.sender.actorId}
                >
                  {message.sender.actorKind === 'agent' ? <Bot size={14} /> : <UserRound size={14} />}
                </button>
                <div>
                  <header>
                    <strong>{senderLabel(message.sender.actorKind, message.sender.actorId, message.sender.role)}</strong>
                    <span>{message.sender.role}</span>
                    {message.assignmentId !== undefined && <code>{shortId(message.assignmentId)}</code>}
                    <time>{formatTime(message.createdAt)}</time>
                  </header>
                  <p>{message.body}</p>
                </div>
              </article>
            ))}
          </div>
          <div className="team-composer">
            <textarea
              value={body}
              onChange={(event) => {
                setBody(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
              placeholder="发送消息到 general…"
              disabled={snapshot.state === 'degraded'}
            />
            <button onClick={() => void send()} disabled={sending || body.trim().length === 0 || snapshot.state === 'degraded'} title="发送团队消息">
              {sending ? <CircleDashed className="spin" size={16} /> : <Send size={16} />}
            </button>
            {error !== undefined && <div className="team-send-error"><CircleAlert size={13} /><span>{error}</span><button onClick={() => void send()}>重试原请求</button></div>}
          </div>
        </div>

        <aside className={classNames('team-assignments', assignmentsOpen && 'open')}>
          <button
            className="team-assignment-toggle"
            onClick={() => {
              setAssignmentsOpen((value) => !value);
            }}
          >
            {assignmentsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <strong>任务分配</strong>
            <span>{statusCounts.running} 进行中 · {statusCounts.queued} 等待 · {statusCounts.terminal} 已结束</span>
          </button>
          {assignmentsOpen && (
            <div className="team-assignment-scroll">
              <MemberList members={snapshot.members} leaderAgentId={team.leaderAgentId} onSelectAgent={onSelectAgent} />
              {assignmentForest.length === 0
                ? <div className="team-assignment-empty">暂无任务分配</div>
                : assignmentGroups.map((group) => (
                    <section className="team-assignment-group" key={group.id}>
                      <h3>{group.label}<span>{group.nodes.length}</span></h3>
                      {group.nodes.map((node) => <AssignmentNode node={node} depth={0} onSelectAgent={onSelectAgent} key={node.assignment.id} />)}
                    </section>
                  ))}
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}

function MemberList({ members, leaderAgentId, onSelectAgent }: {
  readonly members: readonly TeamMember[];
  readonly leaderAgentId: string;
  readonly onSelectAgent: (agentId: string) => void;
}) {
  return (
    <div className="team-member-list">
      <h3>成员</h3>
      {members.map((member) => (
        <button
          onClick={() => {
            onSelectAgent(member.agentId);
          }}
          key={member.agentId}
        >
          <Bot size={13} /><span>{member.agentId}</span><em>{member.agentId === leaderAgentId ? '组长' : '成员'}</em>
        </button>
      ))}
    </div>
  );
}

interface AssignmentNodeModel {
  readonly assignment: TeamAssignment;
  readonly children: readonly AssignmentNodeModel[];
}

function AssignmentNode({ node, depth, onSelectAgent }: {
  readonly node: AssignmentNodeModel;
  readonly depth: number;
  readonly onSelectAgent: (agentId: string) => void;
}) {
  const assignment = node.assignment;
  return (
    <div className="team-assignment-node">
      <button
        style={{ paddingInlineStart: `${10 + depth * 16}px` }}
        disabled={assignment.agentId === undefined}
        onClick={() => { if (assignment.agentId !== undefined) onSelectAgent(assignment.agentId); }}
        title={assignment.description}
      >
        <AssignmentStatusIcon status={assignment.status} />
        <span><strong>{assignment.description}</strong><small>{assignment.profileName} · {assignment.agentId ?? '等待 Agent'}</small></span>
        <em className={`assignment-${assignment.status}`}>{assignmentStatusLabel(assignment.status)}</em>
      </button>
      {node.children.map((child) => <AssignmentNode node={child} depth={depth + 1} onSelectAgent={onSelectAgent} key={child.assignment.id} />)}
    </div>
  );
}

function AssignmentStatusIcon({ status }: { readonly status: TeamAssignmentStatus }) {
  if (status === 'completed') return <CircleCheck size={13} />;
  if (status === 'failed' || status === 'cancelled' || status === 'interrupted') return <CircleAlert size={13} />;
  if (status === 'queued') return <Clock3 size={13} />;
  return <CircleDashed className="spin" size={13} />;
}

function buildAssignmentForest(assignments: readonly TeamAssignment[]): readonly AssignmentNodeModel[] {
  const nodes = new Map(assignments.map((assignment) => [assignment.id, { assignment, children: [] as AssignmentNodeModel[] }]));
  const roots: AssignmentNodeModel[] = [];
  for (const assignment of assignments) {
    const node = nodes.get(assignment.id)!;
    const parent = assignment.parentAssignmentId === undefined ? undefined : nodes.get(assignment.parentAssignmentId);
    if (parent === undefined || parent === node || createsCycle(node, parent, nodes)) roots.push(node);
    else parent.children.push(node);
  }
  return roots;
}

function groupAssignmentForest(nodes: readonly AssignmentNodeModel[]) {
  const groups = [
    { id: 'running', label: '正在进行', nodes: [] as AssignmentNodeModel[] },
    { id: 'queued', label: '等待开始', nodes: [] as AssignmentNodeModel[] },
    { id: 'terminal', label: '已结束', nodes: [] as AssignmentNodeModel[] },
  ];
  for (const node of nodes) {
    const statuses = flattenAssignmentStatuses(node);
    const id = statuses.has('running') ? 'running' : statuses.has('queued') ? 'queued' : 'terminal';
    groups.find((group) => group.id === id)!.nodes.push(node);
  }
  return groups.filter((group) => group.nodes.length > 0);
}

function flattenAssignmentStatuses(node: AssignmentNodeModel): ReadonlySet<TeamAssignmentStatus> {
  const statuses = new Set<TeamAssignmentStatus>([node.assignment.status]);
  for (const child of node.children) {
    for (const status of flattenAssignmentStatuses(child)) statuses.add(status);
  }
  return statuses;
}

function createsCycle(
  node: AssignmentNodeModel,
  parent: AssignmentNodeModel,
  nodes: ReadonlyMap<string, AssignmentNodeModel>,
): boolean {
  let current: AssignmentNodeModel | undefined = parent;
  const visited = new Set<string>();
  while (current !== undefined) {
    if (current.assignment.id === node.assignment.id) return true;
    if (visited.has(current.assignment.id)) return true;
    visited.add(current.assignment.id);
    current = current.assignment.parentAssignmentId === undefined
      ? undefined
      : nodes.get(current.assignment.parentAssignmentId);
  }
  return false;
}

function countAssignments(assignments: readonly TeamAssignment[]) {
  return assignments.reduce((counts, assignment) => {
    if (assignment.status === 'running') counts.running += 1;
    else if (assignment.status === 'queued') counts.queued += 1;
    else counts.terminal += 1;
    return counts;
  }, { running: 0, queued: 0, terminal: 0 });
}

function assignmentStatusLabel(status: TeamAssignmentStatus): string {
  const labels: Record<TeamAssignmentStatus, string> = {
    queued: '等待', running: '运行中', completed: '完成', failed: '失败', cancelled: '已取消', interrupted: '已中断',
  };
  return labels[status];
}

function senderLabel(actorKind: 'agent' | 'user', actorId: string, role: string): string {
  if (actorKind === 'user') return '你';
  if (role === 'leader') return `${actorId}（组长）`;
  return actorId;
}

function shortId(id: string): string {
  return id.length <= 14 ? id : `${id.slice(0, 8)}…`;
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(timestamp);
}
