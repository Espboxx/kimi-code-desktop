import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import {
  Bot,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Clock3,
  ImagePlus,
  Send,
  UserRound,
  Users,
  X,
} from 'lucide-react';

import type {
  TeamAssignment,
  TeamAssignmentStatus,
  TeamMember,
  TeamMessage,
  TeamStateSnapshot,
  SessionStatusSnapshot,
} from '../shared/desktop-api';
import { agentActivityLabel, type AgentActivityForest } from './agent-activity';
import {
  attachmentProblem,
  COMPOSER_IMAGE_ACCEPT,
  readImageAttachment,
  type ComposerAttachmentError,
  type ComposerImageAttachment,
} from './composer-utils';
import { collectTeamAgentActivities, type TeamAgentActivity } from './swarm-ui';
import { ModelSelect, type SessionModelOption } from './SessionControls';
import { classNames } from './ui-utils';
import { buildTeamMentionAliases, rehypeTeamMentions } from './team-message-markdown';

export function TeamPage({ sessionId, state, activity, status, models, onSeen, onSelectAgent }: {
  readonly sessionId: string;
  readonly state: TeamStateSnapshot;
  readonly activity?: AgentActivityForest;
  readonly status?: SessionStatusSnapshot;
  readonly models: readonly SessionModelOption[];
  readonly onSeen: (channelSeq: number) => void;
  readonly onSelectAgent: (agentId: string) => void;
}) {
  const [body, setBody] = useState('');
  const [images, setImages] = useState<ComposerImageAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<ComposerAttachmentError>();
  const [clientMessageId, setClientMessageId] = useState<string>();
  const [sending, setSending] = useState(false);
  const [modelPending, setModelPending] = useState(false);
  const [selectedModel, setSelectedModel] = useState(status?.model);
  const [error, setError] = useState<string>();
  const [assignmentsOpen, setAssignmentsOpen] = useState(true);
  const streamRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const nearBottomRef = useRef(true);
  const modelChangeRef = useRef<Promise<boolean>>(Promise.resolve(true));
  const snapshot = state.snapshot;
  const team = snapshot.team;
  const activeBatches = snapshot.batches.filter((batch) => batch.status === 'running').length;
  const statusCounts = countAssignments(snapshot.assignments);
  const assignmentForest = useMemo(
    () => buildAssignmentForest(snapshot.assignments),
    [snapshot.assignments],
  );
  const assignmentGroups = useMemo(() => groupAssignmentForest(assignmentForest), [assignmentForest]);
  const mentionAliases = useMemo(
    () => buildTeamMentionAliases(snapshot.members, snapshot.assignments),
    [snapshot.assignments, snapshot.members],
  );
  const activeAgents = useMemo(
    () => collectTeamAgentActivities(activity, snapshot.members),
    [activity, snapshot.members],
  );
  const activityKey = activeAgents
    .map((item) => `${item.agentId}:${item.status}:${item.action}`)
    .join('|');
  const leader = agentPresentation(team?.leaderAgentId ?? 'main', snapshot.members, snapshot.assignments);
  const selectedModelOption = models.find((model) => model.id === selectedModel);
  const imageInputSupport = selectedModelOption?.imageInput ?? 'unknown';
  const imageInputBlocked = images.length > 0 && imageInputSupport === 'unsupported';

  useEffect(() => {
    const element = streamRef.current;
    if (element === null || !nearBottomRef.current) return;
    element.scrollTop = element.scrollHeight;
    onSeen(snapshot.latestChannelSeq);
  }, [activityKey, onSeen, snapshot.latestChannelSeq, state.messages.length]);

  useEffect(() => {
    if (!modelPending) setSelectedModel(status?.model);
  }, [modelPending, status?.model]);

  const changeModel = (model: string) => {
    setSelectedModel(model);
    setModelPending(true);
    setError(undefined);
    const operation = window.kimiDesktop.turn.setModel(model, sessionId).then(
      () => true,
      (reason: unknown) => {
        setSelectedModel(status?.model);
        setError(reason instanceof Error ? reason.message : String(reason));
        modelChangeRef.current = Promise.resolve(true);
        return false;
      },
    ).finally(() => {
      setModelPending(false);
    });
    modelChangeRef.current = operation;
  };

  const addImageFiles = useCallback(async (files: readonly File[]) => {
    if (files.length === 0) return;
    setAttachmentError(undefined);
    const remaining = Math.max(0, 8 - images.length);
    const results = await Promise.allSettled(files.slice(0, remaining).map(readImageAttachment));
    const accepted: ComposerImageAttachment[] = [];
    const errors: ComposerAttachmentError[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') accepted.push(result.value);
      else errors.push(attachmentProblem(result.reason));
    }
    if (files.length > remaining) {
      errors.push({ code: 'media.too_many', message: '团队消息最多附加 8 张图片' });
    }
    if (accepted.length > 0) {
      setImages((current) => [...current, ...accepted].slice(0, 8));
      setClientMessageId(undefined);
    }
    if (errors.length > 0) {
      setAttachmentError({
        code: [...new Set(errors.map((item) => item.code))].join(', '),
        message: errors.map((item) => item.message).join('；'),
      });
    }
  }, [images.length]);

  const send = async () => {
    const message = body.trim();
    if ((message.length === 0 && images.length === 0) || sending) return;
    if (imageInputBlocked) {
      setAttachmentError({
        code: 'media.model_unsupported',
        message: '当前主代理模型不支持图片输入，请先切换到支持图片的模型',
      });
      return;
    }
    const id = clientMessageId ?? crypto.randomUUID();
    setClientMessageId(id);
    setSending(true);
    setError(undefined);
    try {
      if (!(await modelChangeRef.current)) return;
      const persistedBody = message.length > 0 ? message : `分享了 ${String(images.length)} 张图片`;
      await window.kimiDesktop.team.submit(
        sessionId,
        persistedBody,
        id,
        images.map((image) => ({ type: image.type, url: image.url, name: image.label })),
      );
      setBody('');
      setImages([]);
      setAttachmentError(undefined);
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
          <span title={`组长 ${team.leaderAgentId}`}><Bot size={13} />{leader.displayName}</span>
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
              <TeamMessageBubble
                assignments={snapshot.assignments}
                members={snapshot.members}
                mentionAliases={mentionAliases}
                message={message}
                onSelectAgent={onSelectAgent}
                key={message.id}
              />
            ))}
            {activeAgents.length > 0 && (
              <TeamActivityStrip
                activities={activeAgents}
                assignments={snapshot.assignments}
                members={snapshot.members}
                onSelectAgent={onSelectAgent}
              />
            )}
          </div>
          <div className="team-composer">
            <div className="team-composer-toolbar">
              <ModelSelect
                value={selectedModel}
                models={models}
                disabled={snapshot.state === 'degraded' || modelPending || models.length === 0}
                title="主代理模型"
                onChange={changeModel}
              />
              <span className={classNames('team-image-support', `support-${imageInputSupport}`)}>
                {modelPending
                  ? '正在切换模型…'
                  : imageInputSupport === 'supported'
                    ? '当前模型支持图片 · 主代理会为新子 Agent 单独选择执行模型'
                    : imageInputSupport === 'unsupported'
                      ? '当前模型不支持图片输入'
                      : '当前模型未声明图片能力，发送前请确认'}
              </span>
            </div>
            {images.length > 0 && (
              <div className="team-composer-images" aria-label={`已附加 ${String(images.length)} 张图片`}>
                {images.map((image) => (
                  <div className="team-composer-image" title={image.label} key={image.id}>
                    <img src={image.url} alt={image.label} />
                    <span>{image.label}</span>
                    <button
                      type="button"
                      title={`移除 ${image.label}`}
                      onClick={() => {
                        setImages((current) => current.filter((item) => item.id !== image.id));
                        setClientMessageId(undefined);
                        setAttachmentError(undefined);
                      }}
                    ><X size={11} /></button>
                  </div>
                ))}
              </div>
            )}
            {attachmentError !== undefined && (
              <div className="team-attachment-error" role="alert">
                <CircleAlert size={13} />
                <span><strong>{attachmentError.code}</strong>{attachmentError.message}</span>
                <button type="button" onClick={() => { setAttachmentError(undefined); }} title="关闭"><X size={11} /></button>
              </div>
            )}
            <textarea
              value={body}
              onChange={(event) => {
                setBody(event.target.value);
                setClientMessageId(undefined);
              }}
              onPaste={(event) => {
                const files = Array.from(event.clipboardData.items)
                  .filter((item) => item.kind === 'file' && item.type.toLowerCase().startsWith('image/'))
                  .map((item) => item.getAsFile())
                  .filter((file): file is File => file !== null);
                if (files.length === 0) return;
                if (event.clipboardData.getData('text/plain').length === 0) event.preventDefault();
                void addImageFiles(files);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void send();
                }
              }}
              placeholder="发送消息到 general…"
              disabled={snapshot.state === 'degraded'}
            />
            <input
              ref={fileInputRef}
              type="file"
              accept={COMPOSER_IMAGE_ACCEPT}
              multiple
              hidden
              onChange={(event) => {
                void addImageFiles(Array.from(event.target.files ?? []));
                event.currentTarget.value = '';
              }}
            />
            <div className="team-composer-actions">
              <button
                className="team-image-picker"
                type="button"
                onClick={() => { fileInputRef.current?.click(); }}
                disabled={snapshot.state === 'degraded' || images.length >= 8}
                title="粘贴或选择图片"
              ><ImagePlus size={16} /></button>
              <button
                className="team-message-send"
                type="button"
                onClick={() => void send()}
                disabled={sending || modelPending || imageInputBlocked || (body.trim().length === 0 && images.length === 0) || snapshot.state === 'degraded'}
                title={imageInputBlocked ? '当前模型不支持图片输入' : '发送团队消息'}
              >
                {sending ? <CircleDashed className="spin" size={16} /> : <Send size={16} />}
              </button>
            </div>
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
              <MemberList
                assignments={snapshot.assignments}
                members={snapshot.members}
                leaderAgentId={team.leaderAgentId}
                onSelectAgent={onSelectAgent}
              />
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

function TeamActivityStrip({ activities, members, assignments, onSelectAgent }: {
  readonly activities: readonly TeamAgentActivity[];
  readonly members: readonly TeamMember[];
  readonly assignments: readonly TeamAssignment[];
  readonly onSelectAgent: (agentId: string) => void;
}) {
  return (
    <div className="team-activity-strip" aria-label="团队实时动态" aria-live="polite">
      {activities.map((activity) => {
        const member = members.find((candidate) => candidate.agentId === activity.agentId);
        const presentation = agentPresentation(activity.agentId, members, assignments);
        const profession = member?.role === 'leader' ? '组长' : presentation.profileName ?? '成员';
        const status = agentActivityLabel(activity.status);
        return (
          <button
            className={classNames('team-activity-bubble', `status-${activity.status}`)}
            type="button"
            onClick={() => { onSelectAgent(activity.agentId); }}
            title={`${presentation.displayName} · ${profession} · ${status} · ${activity.action}`}
            aria-label={`${presentation.displayName}，${profession}，${status}：${activity.action}`}
            key={activity.agentId}
          >
            <span className="team-activity-icon">
              {activity.status === 'waiting'
                ? <Clock3 size={12} />
                : <CircleDashed className="spin" size={12} />}
            </span>
            <strong>{presentation.displayName}</strong>
            <em>{profession}</em>
            <span className="team-activity-action">{activity.action}</span>
          </button>
        );
      })}
    </div>
  );
}

function MemberList({ members, assignments, leaderAgentId, onSelectAgent }: {
  readonly members: readonly TeamMember[];
  readonly assignments: readonly TeamAssignment[];
  readonly leaderAgentId: string;
  readonly onSelectAgent: (agentId: string) => void;
}) {
  return (
    <div className="team-member-list">
      <h3>成员</h3>
      {members.map((member) => {
        const presentation = agentPresentation(member.agentId, members, assignments);
        return (
          <button
            onClick={() => {
              onSelectAgent(member.agentId);
            }}
            key={member.agentId}
          >
            <Bot size={13} />
            <span title={member.agentId}>{presentation.displayName}</span>
            <em>{member.agentId === leaderAgentId ? '组长' : presentation.profileName ?? '成员'}</em>
          </button>
        );
      })}
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
        <span>
          <strong>{assignment.description}</strong>
          <small>
            {assignment.profileName} · {assignment.displayName ?? assignment.agentId ?? '等待 Agent'}
            {assignment.model === undefined ? '' : ` · ${assignment.model}`}
          </small>
        </span>
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

function shortId(id: string): string {
  return id.length <= 14 ? id : `${id.slice(0, 8)}…`;
}

function TeamMessageBubble({ message, members, assignments, mentionAliases, onSelectAgent }: {
  readonly message: TeamMessage;
  readonly members: readonly TeamMember[];
  readonly assignments: readonly TeamAssignment[];
  readonly mentionAliases: ReturnType<typeof buildTeamMentionAliases>;
  readonly onSelectAgent: (agentId: string) => void;
}) {
  const isUser = message.sender.actorKind === 'user';
  const presentation = isUser
    ? { displayName: '你', profileName: undefined, agentId: message.sender.actorId }
    : agentPresentation(message.sender.actorId, members, assignments);
  return (
    <article className={classNames('team-message', isUser ? 'user' : 'agent', message.sender.role === 'leader' && 'leader')}>
      <button
        className="team-message-avatar"
        disabled={isUser}
        onClick={() => { if (!isUser) onSelectAgent(message.sender.actorId); }}
        title={isUser ? '你' : `${presentation.displayName} · ${message.sender.actorId}`}
      >
        {isUser ? <UserRound size={14} /> : <Bot size={14} />}
      </button>
      <div className="team-message-frame">
        <header className="team-message-meta">
          <strong>{presentation.displayName}</strong>
          <span>{message.sender.role === 'leader' ? '组长' : presentation.profileName ?? '用户'}</span>
          {message.assignmentId !== undefined && <code>{shortId(message.assignmentId)}</code>}
          <time>{formatTime(message.createdAt)}</time>
        </header>
        <div className="team-message-bubble markdown-body">
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkBreaks]}
            rehypePlugins={[[rehypeTeamMentions, mentionAliases]]}
            components={{
              button: ({ node, children, ...props }) => {
                const agentId = String(node?.properties?.['dataAgentId'] ?? '');
                return (
                  <button
                    {...props}
                    type="button"
                    onClick={() => { if (agentId !== '') onSelectAgent(agentId); }}
                  >
                    {children}
                  </button>
                );
              },
            }}
          >
            {message.body}
          </ReactMarkdown>
          {(message.attachments ?? []).some((attachment) => safeTeamAttachmentUrl(attachment.url)) && (
            <div className="team-message-attachments">
              {(message.attachments ?? []).map((attachment, index) => safeTeamAttachmentUrl(attachment.url) && (
                <img
                  src={attachment.url}
                  alt={attachment.name ?? `团队图片 ${String(index + 1)}`}
                  title={attachment.name}
                  key={`${attachment.url}:${String(index)}`}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

function agentPresentation(
  agentId: string,
  members: readonly TeamMember[],
  assignments: readonly TeamAssignment[],
): { readonly agentId: string; readonly displayName: string; readonly profileName?: string } {
  const member = members.find((candidate) => candidate.agentId === agentId);
  const assignment = assignments.findLast((candidate) => candidate.agentId === agentId);
  return {
    agentId,
    displayName: member?.displayName ?? assignment?.displayName ?? (agentId === 'main' ? '组长' : agentId),
    profileName: assignment?.profileName,
  };
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(timestamp);
}

function safeTeamAttachmentUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'file:'
      && /\/cache\/desktop-media\/[a-f0-9]{64}\.(?:gif|jpe?g|png|webp)$/i.test(url.pathname);
  } catch {
    return false;
  }
}
