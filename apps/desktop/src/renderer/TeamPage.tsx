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
  Eye,
  GitMerge,
  ImagePlus,
  ListChecks,
  Pause,
  Play,
  RotateCcw,
  Send,
  Settings2,
  Square,
  UserRound,
  Users,
  X,
} from 'lucide-react';

import type {
  TeamAssignment,
  TeamAssignmentStatus,
  TeamArtifactContent,
  TeamMember,
  TeamMessage,
  TeamPolicy,
  TeamPolicyInput,
  TeamSchedulerState,
  TeamStateSnapshot,
  SessionStatusSnapshot,
  TodoItem,
} from '../shared/desktop-api';
import { isTeamSnapshotV2, teamTaskParentId } from '../shared/team-types';
import { agentActivityLabel, type AgentActivityForest } from './agent-activity';
import {
  attachmentProblem,
  COMPOSER_IMAGE_ACCEPT,
  readImageAttachment,
  TEAM_COMPOSER_HEIGHT_STORAGE_KEY,
  type ComposerAttachmentError,
  type ComposerImageAttachment,
} from './composer-utils';
import {
  ComposerAttachmentList,
  ComposerErrorBanner,
  ComposerFrame,
  type ComposerAttachmentView,
} from './ComposerPrimitives';
import {
  collectTeamAgentActivities,
  collectPendingLeaderQuestions,
  mergePendingLeaderQuestionActivity,
  resolveTeamLeaderStatus,
  type PendingLeaderQuestion,
  type TeamAgentActivity,
  type TeamLeaderStatus,
} from './swarm-ui';
import {
  ComposerUsageIndicators,
  SessionControls,
  type SessionModelOption,
} from './SessionControls';
import { QuestionForm } from './QuestionForm';
import { SidePanelFrame } from './SidePrimitives';
import {
  buildTeamTodoEntries,
  countTeamTodos,
  partitionTeamTodos,
  type TeamTodoEntry,
} from './todo-list';
import { classNames } from './ui-utils';
import { buildTeamMentionAliases, rehypeTeamMentions } from './team-message-markdown';

export function TeamPage({
  sessionId,
  state,
  activity,
  status,
  models,
  leaderTodos,
  planModePending,
  onSetPlanMode,
  onSeen,
  onSelectAgent,
}: {
  readonly sessionId: string;
  readonly state: TeamStateSnapshot;
  readonly activity?: AgentActivityForest;
  readonly status?: SessionStatusSnapshot;
  readonly models: readonly SessionModelOption[];
  readonly leaderTodos: readonly TodoItem[];
  readonly planModePending: boolean;
  readonly onSetPlanMode: (enabled: boolean) => Promise<void>;
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
  const [recipientAgentId, setRecipientAgentId] = useState('');
  const [controlPending, setControlPending] = useState(false);
  const [artifactDialog, setArtifactDialog] = useState<{
    readonly title: string;
    readonly content: TeamArtifactContent;
    readonly integration: boolean;
  }>();
  const [reassigning, setReassigning] = useState<TeamAssignment>();
  const [reassignProfile, setReassignProfile] = useState('');
  const [reassignModel, setReassignModel] = useState('');
  const [policyDraft, setPolicyDraft] = useState<TeamPolicyDraft>();
  const streamRef = useRef<HTMLDivElement>(null);
  const questionRefs = useRef(new Map<string, HTMLElement>());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const nearBottomRef = useRef(true);
  const modelChangeRef = useRef<Promise<boolean>>(Promise.resolve(true));
  const snapshot = state.snapshot;
  const team = snapshot.team;
  const snapshotV2 = isTeamSnapshotV2(snapshot) ? snapshot : undefined;
  const writable = snapshotV2 !== undefined && snapshotV2.state === 'ready';
  const schedulerControllable = snapshotV2 !== undefined
    && ['running', 'paused'].includes(snapshotV2.scheduler.status);
  const activeBatches = snapshot.batches.filter((batch) => batch.status === 'running').length;
  const assignmentForest = useMemo(
    () => buildAssignmentForest(snapshot.assignments),
    [snapshot.assignments],
  );
  const assignmentGroups = useMemo(() => groupAssignmentForest(assignmentForest), [assignmentForest]);
  const mentionAliases = useMemo(
    () => buildTeamMentionAliases(snapshot.members, snapshot.assignments),
    [snapshot.assignments, snapshot.members],
  );
  const leaderAgentId = team?.leaderAgentId ?? 'main';
  const teamTodos = useMemo(
    () => buildTeamTodoEntries(leaderTodos, snapshot.assignments, snapshot.members, leaderAgentId),
    [leaderAgentId, leaderTodos, snapshot.assignments, snapshot.members],
  );
  const teamTodoCounts = useMemo(() => countTeamTodos(teamTodos), [teamTodos]);
  const pendingLeaderQuestions = useMemo(
    () => collectPendingLeaderQuestions(state.messages, leaderAgentId),
    [leaderAgentId, state.messages],
  );
  const pendingLeaderQuestion = pendingLeaderQuestions[0];
  const pendingQuestionByMessageId = useMemo(
    () => new Map(pendingLeaderQuestions.map((question) => [question.message.id, question])),
    [pendingLeaderQuestions],
  );
  const activeAgents = useMemo(
    () => mergePendingLeaderQuestionActivity(
      collectTeamAgentActivities(activity, snapshot.members),
      leaderAgentId,
      pendingLeaderQuestion,
    ),
    [activity, leaderAgentId, pendingLeaderQuestion, snapshot.members],
  );
  const leaderStatus = useMemo(() => resolveTeamLeaderStatus({
    leaderAgentId,
    activity,
    busy: status?.busy,
    pendingQuestion: pendingLeaderQuestion,
    assignments: snapshot.assignments,
    scheduler: snapshotV2?.scheduler,
    snapshotState: snapshot.state,
    degradedReason: snapshot.degradedReason,
    activeBatchCount: activeBatches,
    hasInProgressPlan: leaderTodos.some((item) => item.status === 'in_progress'),
  }), [
    activeBatches,
    activity,
    leaderAgentId,
    leaderTodos,
    pendingLeaderQuestion,
    snapshot.assignments,
    snapshot.degradedReason,
    snapshot.state,
    snapshotV2?.scheduler,
    status?.busy,
  ]);
  const activityKey = activeAgents
    .map((item) => `${item.agentId}:${item.status}:${item.action}`)
    .join('|');
  const leader = agentPresentation(leaderAgentId, snapshot.members, snapshot.assignments);
  const selectedModelOption = models.find((model) => model.id === selectedModel);
  const imageInputSupport = selectedModelOption?.imageInput ?? 'unknown';
  const imageInputBlocked = images.length > 0 && imageInputSupport === 'unsupported';
  const attachmentViews: ComposerAttachmentView[] = images.map((image) => ({
    id: image.id,
    label: image.label,
    previewUrl: image.url,
  }));
  const focusPendingLeaderQuestion = useCallback(() => {
    if (pendingLeaderQuestion === undefined) {
      onSelectAgent(leaderAgentId);
      return;
    }
    const element = questionRefs.current.get(pendingLeaderQuestion.message.id);
    element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    element?.querySelector<HTMLButtonElement>('.question-option')?.focus();
  }, [leaderAgentId, onSelectAgent, pendingLeaderQuestion]);

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
      (error: unknown) => {
        setSelectedModel(status?.model);
        setError(error instanceof Error ? error.message : String(error));
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
        recipientAgentId === '' ? undefined : [recipientAgentId],
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

  const runControl = async (operation: () => Promise<unknown>) => {
    if (controlPending) return;
    setControlPending(true);
    setError(undefined);
    try {
      await operation();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setControlPending(false);
    }
  };

  const inspectArtifact = async (artifactId: string, title = '任务产物') => {
    await runControl(async () => {
      const content = await window.kimiDesktop.team.artifact(sessionId, artifactId);
      setArtifactDialog({ title, content, integration: false });
    });
  };

  const previewIntegration = async () => {
    await runControl(async () => {
      const content = await window.kimiDesktop.team.previewIntegration(sessionId);
      if (content === undefined) throw new Error('当前没有可应用的集成变更');
      const awaitingApply = snapshotV2?.integration.status === 'awaiting_apply';
      setArtifactDialog({
        title: awaitingApply ? '集成差异预览' : '集成差异',
        content,
        integration: awaitingApply,
      });
    });
  };

  const beginReassign = (assignment: TeamAssignment) => {
    setReassigning(assignment);
    setReassignProfile(assignment.profileName);
    setReassignModel(assignment.model ?? '');
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
          {snapshotV2 !== undefined && (
            <span className={classNames(snapshotV2.scheduler.status === 'running' && 'running')}>
              {snapshotV2.scheduler.status === 'paused' ? <Pause size={13} /> : <CircleDashed size={13} />}
              {schedulerStatusLabel(snapshotV2.scheduler.status)} · {snapshotV2.scheduler.activeCount}/{snapshotV2.policy.maxConcurrency}
            </span>
          )}
          {snapshotV2 !== undefined && (
            <span title="Team 模型调用累计 token">
              {snapshotV2.budget.totalTokens.toLocaleString()} tokens
            </span>
          )}
          <span className={classNames(!writable && 'failed')} title={snapshot.degradedReason}>
            {writable ? <CircleCheck size={13} /> : <CircleAlert size={13} />}
            {snapshot.protocolVersion === 1
              ? 'v1 只读'
              : snapshot.state === 'degraded' ? '只读降级' : '已连接'}
          </span>
          {snapshotV2 !== undefined && (
            <div className="team-header-controls">
              <button
                type="button"
                disabled={!writable || controlPending || !schedulerControllable}
                onClick={() => void runControl(() => snapshotV2.scheduler.status === 'paused'
                  ? window.kimiDesktop.team.resume(sessionId, snapshot.latestSeq)
                  : window.kimiDesktop.team.pause(sessionId, snapshot.latestSeq, 'Paused from Desktop'))}
                title={snapshotV2.scheduler.status === 'paused' ? '继续调度' : '暂停调度'}
              >
                {snapshotV2.scheduler.status === 'paused' ? <Play size={13} /> : <Pause size={13} />}
                {snapshotV2.scheduler.status === 'paused' ? '继续' : '暂停'}
              </button>
              <button
                type="button"
                disabled={!writable || controlPending}
                onClick={() => { setPolicyDraft(policyToDraft(snapshotV2.policy)); }}
                title="调整 Team 并发、成员、重试和预算"
              ><Settings2 size={13} />策略</button>
              <button
                type="button"
                disabled={!writable || controlPending || snapshotV2.integration.diffArtifactId === undefined}
                onClick={() => void previewIntegration()}
                title={snapshotV2.integration.status === 'awaiting_apply'
                  ? '预览汇总差异并确认应用'
                  : '查看集成差异'}
              ><GitMerge size={13} />集成预览</button>
            </div>
          )}
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
            {state.messages.map((message) => {
              const pendingQuestion = pendingQuestionByMessageId.get(message.id);
              return pendingQuestion === undefined
                ? (
                    <TeamMessageBubble
                      assignments={snapshot.assignments}
                      members={snapshot.members}
                      mentionAliases={mentionAliases}
                      message={message}
                      onSelectAgent={onSelectAgent}
                      key={message.id}
                    />
                  )
                : (
                    <TeamUserQuestionCard
                      pending={pendingQuestion}
                      disabled={!writable}
                      onSelectAgent={onSelectAgent}
                      onRef={(element) => {
                        if (element === null) questionRefs.current.delete(message.id);
                        else questionRefs.current.set(message.id, element);
                      }}
                      sessionId={sessionId}
                      key={message.id}
                    />
                  );
            })}
            {activeAgents.length > 0 && (
              <TeamActivityStrip
                activities={activeAgents}
                assignments={snapshot.assignments}
                members={snapshot.members}
                onSelectActivity={(agentId) => {
                  if (agentId === leaderAgentId && pendingLeaderQuestion !== undefined) {
                    focusPendingLeaderQuestion();
                  } else {
                    onSelectAgent(agentId);
                  }
                }}
              />
            )}
          </div>
          <ComposerFrame
            className="team-composer"
            frameClassName="team-composer-frame"
            value={body}
            disabled={!writable}
            placeholder="发送消息到 general…"
            ariaLabel="发送团队消息"
            heightStorageKey={TEAM_COMPOSER_HEIGHT_STORAGE_KEY}
            onChange={(value) => {
              setBody(value);
              setClientMessageId(undefined);
            }}
            onSubmit={() => { void send(); }}
            onPasteImages={(files) => { void addImageFiles(files); }}
            above={(
              <>
                <ComposerAttachmentList
                  items={attachmentViews}
                  ariaLabel={`已附加 ${String(images.length)} 张图片`}
                  className="team-composer-images"
                  itemClassName="team-composer-image"
                  onRemove={(id) => {
                    setImages((current) => current.filter((item) => item.id !== id));
                    setClientMessageId(undefined);
                    setAttachmentError(undefined);
                  }}
                />
                <ComposerErrorBanner
                  error={attachmentError}
                  className="team-attachment-error"
                  onDismiss={() => { setAttachmentError(undefined); }}
                />
                {error !== undefined && <div className="team-send-error"><CircleAlert size={13} /><span>{error}</span>{clientMessageId !== undefined && <button onClick={() => void send()}>重试原请求</button>}</div>}
              </>
            )}
            status={(
              <>
                <div className="team-composer-target-row">
                  <label className="team-recipient-control">
                    <span>收件人</span>
                    <select
                      aria-label="团队消息收件人"
                      value={recipientAgentId}
                      disabled={!writable || sending}
                      onChange={(event) => {
                        setRecipientAgentId(event.currentTarget.value);
                        setClientMessageId(undefined);
                      }}
                    >
                      <option value="">全员广播</option>
                      {snapshot.members.map((member) => (
                        <option value={member.agentId} key={member.agentId}>
                          {agentPresentation(member.agentId, snapshot.members, snapshot.assignments).displayName}
                        </option>
                      ))}
                    </select>
                  </label>
                  <SessionControls
                    sessionId={sessionId}
                    status={status}
                    models={models}
                    placement="composer"
                    disabled={!writable || controlPending}
                    modelDisabled={modelPending || models.length === 0}
                    modelTitle="主代理模型"
                    modelValue={selectedModel}
                    planModePending={planModePending}
                    onSetModel={changeModel}
                    onSetThinking={(effort) => runControl(() => window.kimiDesktop.turn.setThinking(effort, sessionId))}
                    onSetPermission={(permission) => runControl(() => window.kimiDesktop.turn.setPermission(permission, sessionId))}
                    onSetPlanMode={onSetPlanMode}
                  />
                </div>
                <ComposerUsageIndicators status={status} />
                {images.length > 0 && (
                  <span className={classNames('team-image-support', `support-${imageInputSupport}`)}>
                    {modelPending
                      ? '正在切换模型…'
                      : imageInputSupport === 'supported'
                        ? '当前模型支持图片 · 主代理会为新子 Agent 单独选择执行模型'
                        : imageInputSupport === 'unsupported'
                          ? '当前模型不支持图片输入'
                          : '当前模型未声明图片能力，发送前请确认'}
                  </span>
                )}
              </>
            )}
            toolbarStart={(
              <div className="segmented composer-modes" aria-label="团队消息发送模式">
                <button className="active" type="button" title="持久化 Team Prompt"><Bot size={13} /><span>Prompt</span></button>
              </div>
            )}
            toolbarEnd={(
              <>
                <input
                  ref={fileInputRef}
                  className="composer-file-input"
                  type="file"
                  accept={COMPOSER_IMAGE_ACCEPT}
                  multiple
                  tabIndex={-1}
                  onChange={(event) => {
                    void addImageFiles(Array.from(event.currentTarget.files ?? []));
                    event.currentTarget.value = '';
                  }}
                />
                <button
                  className="icon-button team-image-picker"
                  type="button"
                  onClick={() => { fileInputRef.current?.click(); }}
                  disabled={!writable || images.length >= 8}
                  title="粘贴或选择图片"
                ><ImagePlus size={16} /></button>
                {status?.busy === true && (
                  <button
                    className="icon-button cancel-button"
                    type="button"
                    disabled={controlPending}
                    onClick={() => void runControl(() => window.kimiDesktop.turn.cancel(sessionId))}
                    title="取消组长当前轮次"
                  ><Square size={14} /></button>
                )}
                <button
                  className="send-button team-message-send"
                  type="button"
                  onClick={() => void send()}
                  disabled={sending || modelPending || imageInputBlocked || (body.trim().length === 0 && images.length === 0) || !writable}
                  title={imageInputBlocked ? '当前模型不支持图片输入' : '发送团队消息'}
                >
                  {sending ? <CircleDashed className="spin" size={16} /> : <Send size={16} />}
                </button>
              </>
            )}
          />
        </div>

        <SidePanelFrame
          className="team-assignments"
          ariaLabel="团队任务"
          open={assignmentsOpen}
          bodyClassName="team-assignment-scroll"
          header={(
            <button
              className="team-assignment-toggle"
              onClick={() => {
                setAssignmentsOpen((value) => !value);
              }}
              aria-expanded={assignmentsOpen}
            >
              {assignmentsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <strong>团队任务</strong>
              <span>计划进度：{teamTodoCounts.running} 进行中 · {teamTodoCounts.waiting} 等待 · {teamTodoCounts.terminal} 已结束</span>
            </button>
          )}
        >
              <MemberList
                assignments={snapshot.assignments}
                members={snapshot.members}
                leaderAgentId={team.leaderAgentId}
                onSelectAgent={onSelectAgent}
              />
              <LeaderStatusCard
                status={leaderStatus}
                displayName={leader.displayName}
                onActivate={pendingLeaderQuestion === undefined
                  ? () => { onSelectAgent(leaderAgentId); }
                  : focusPendingLeaderQuestion}
              />
              <TeamTodoList entries={teamTodos} onSelectAgent={onSelectAgent} />
              <div className="team-assignment-subheading">
                <strong>任务分配</strong>
                <span>{snapshot.assignments.length} 项</span>
              </div>
              {assignmentForest.length === 0
                ? <div className="team-assignment-empty">暂无任务分配</div>
                : assignmentGroups.map((group) => (
                    <section className="team-assignment-group" key={group.id}>
                      <h3>{group.label}<span>{group.nodes.length}</span></h3>
                      {group.nodes.map((node) => (
                        <AssignmentNode
                          node={node}
                          depth={0}
                          writable={writable && !controlPending}
                          onSelectAgent={onSelectAgent}
                          onCancel={(taskId) => void runControl(() => window.kimiDesktop.team.cancelTask(
                            sessionId,
                            taskId,
                            snapshot.latestSeq,
                          ))}
                          onRetry={(taskId) => void runControl(() => window.kimiDesktop.team.retryTask(
                            sessionId,
                            taskId,
                            snapshot.latestSeq,
                          ))}
                          onReassign={beginReassign}
                          onInspectArtifact={(artifactId) => void inspectArtifact(artifactId)}
                          key={node.assignment.id}
                        />
                      ))}
                    </section>
                  ))}
        </SidePanelFrame>
      </div>
      {artifactDialog !== undefined && (
        <TeamArtifactDialog
          value={artifactDialog}
          pending={controlPending}
          onClose={() => { setArtifactDialog(undefined); }}
          onApply={() => void runControl(async () => {
            await window.kimiDesktop.team.applyIntegration(sessionId, snapshot.latestSeq);
            setArtifactDialog(undefined);
          })}
          onDiscard={() => void runControl(async () => {
            await window.kimiDesktop.team.discardIntegration(sessionId, snapshot.latestSeq);
            setArtifactDialog(undefined);
          })}
        />
      )}
      {reassigning !== undefined && (
        <TeamReassignDialog
          task={reassigning}
          profileName={reassignProfile}
          model={reassignModel}
          pending={controlPending}
          onProfileName={setReassignProfile}
          onModel={setReassignModel}
          onClose={() => { setReassigning(undefined); }}
          onSubmit={() => void runControl(async () => {
            await window.kimiDesktop.team.reassignTask(
              sessionId,
              reassigning.id,
              snapshot.latestSeq,
              reassignProfile.trim() || undefined,
              reassignModel.trim() || undefined,
            );
            setReassigning(undefined);
          })}
        />
      )}
      {policyDraft !== undefined && snapshotV2 !== undefined && (
        <TeamPolicyDialog
          value={policyDraft}
          pending={controlPending}
          onChange={setPolicyDraft}
          onClose={() => { setPolicyDraft(undefined); }}
          onSubmit={() => void runControl(async () => {
            await window.kimiDesktop.team.updatePolicy(
              sessionId,
              policyFromDraft(policyDraft),
              snapshot.latestSeq,
            );
            setPolicyDraft(undefined);
          })}
        />
      )}
    </section>
  );
}

function TeamActivityStrip({ activities, members, assignments, onSelectActivity }: {
  readonly activities: readonly TeamAgentActivity[];
  readonly members: readonly TeamMember[];
  readonly assignments: readonly TeamAssignment[];
  readonly onSelectActivity: (agentId: string) => void;
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
            onClick={() => { onSelectActivity(activity.agentId); }}
            title={`${presentation.displayName} · ${profession} · ${status} · ${activity.action}`}
            aria-label={`${presentation.displayName}，${profession}，${status}：${activity.action}`}
            key={activity.agentId}
          >
            <span className="team-activity-icon">
              <TeamActivityStatusIcon status={activity.status} size={12} />
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

function LeaderStatusCard({ status, displayName, onActivate }: {
  readonly status: TeamLeaderStatus;
  readonly displayName: string;
  readonly onActivate: () => void;
}) {
  return (
    <section
      className={classNames('team-leader-activity', `state-${status.state}`, `tone-${status.tone}`)}
      data-state={status.state}
      aria-label="组长状态"
      aria-live="polite"
    >
      <h3>组长状态</h3>
      <button
        type="button"
        onClick={onActivate}
        title={`${displayName} · ${status.label} · ${status.action}`}
        aria-label={`${displayName}，${status.label}：${status.action}`}
      >
        <span className="team-leader-activity-icon">
          <LeaderStatusIcon status={status} />
        </span>
        <span className="team-leader-activity-copy">
          <strong>{displayName}</strong>
          <small className="team-leader-activity-action">{status.action}</small>
        </span>
        <em>{status.label}</em>
      </button>
    </section>
  );
}

function LeaderStatusIcon({ status }: { readonly status: TeamLeaderStatus }) {
  if (status.state === 'completed') return <CircleCheck size={13} />;
  if (status.state === 'failed' || status.state === 'degraded') return <CircleAlert size={13} />;
  if (status.state === 'cancelled') return <Square size={12} />;
  if (
    status.state === 'waiting_user'
    || status.state === 'waiting_interaction'
    || status.state === 'waiting_children'
    || status.state === 'awaiting_apply'
  ) return <Clock3 size={13} />;
  if (status.state === 'paused' || status.state === 'idle') return <Pause size={13} />;
  return <CircleDashed className="spin" size={13} />;
}

function TeamActivityStatusIcon({ status, size }: {
  readonly status: TeamAgentActivity['status'];
  readonly size: number;
}) {
  return status === 'waiting'
    ? <Clock3 size={size} />
    : <CircleDashed className="spin" size={size} />;
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

function TeamTodoList({ entries, onSelectAgent }: {
  readonly entries: readonly TeamTodoEntry[];
  readonly onSelectAgent: (agentId: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const sections = partitionTeamTodos(entries);
  const groups = [
    { id: 'running', label: '计划进行中', entries: sections.running },
    { id: 'waiting', label: '等待', entries: sections.waiting },
    { id: 'terminal', label: '已结束', entries: sections.terminal },
  ].filter((group) => group.entries.length > 0);

  return (
    <section className={classNames('team-todo-panel', !open && 'collapsed')} aria-label="团队总 TodoList">
      <button
        className="team-todo-toggle"
        type="button"
        aria-expanded={open}
        title="TodoList 表示计划进度，不代表 Agent 当前正在运行"
        onClick={() => { setOpen((value) => !value); }}
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <ListChecks size={13} />
        <strong>团队总 TodoList</strong>
        <span>{entries.length} 项 · 只读</span>
      </button>
      {open && (
        <div className="team-todo-groups">
          {groups.length === 0
            ? <div className="team-todo-empty">组长计划或子任务出现后会显示在这里</div>
            : groups.map((group) => (
                <section className={`team-todo-group team-todo-group-${group.id}`} key={group.id}>
                  <h3>{group.label}<span>{group.entries.length}</span></h3>
                  {group.entries.map((entry) => (
                    <div className={classNames('team-todo-item', `team-todo-state-${entry.status}`)} key={entry.id}>
                      <span className="team-todo-status"><TeamTodoStatusIcon entry={entry} /></span>
                      <span className="team-todo-copy">
                        <strong title={entry.title}>{entry.title}</strong>
                        <small>
                          <span className="team-todo-source">{entry.sourceLabel}</span>
                          {entry.ownerAgentId === undefined
                            ? <span className="team-todo-owner waiting"><Clock3 size={10} />{entry.ownerLabel}</span>
                            : (
                                <button
                                  className="team-todo-owner"
                                  type="button"
                                  onClick={() => {
                                    if (entry.ownerAgentId !== undefined) onSelectAgent(entry.ownerAgentId);
                                  }}
                                  title={`查看 ${entry.ownerLabel}`}
                                ><Bot size={10} />{entry.ownerLabel}</button>
                              )}
                        </small>
                      </span>
                      <em>{entry.statusLabel}</em>
                    </div>
                  ))}
                </section>
              ))}
        </div>
      )}
    </section>
  );
}

function TeamTodoStatusIcon({ entry }: { readonly entry: TeamTodoEntry }) {
  if (entry.bucket === 'running') return <CircleDashed className="spin" size={13} />;
  if (entry.bucket === 'waiting') return <Clock3 size={13} />;
  if (entry.status === 'failed' || entry.status === 'cancelled' || entry.status === 'interrupted') {
    return <CircleAlert size={13} />;
  }
  return <CircleCheck size={13} />;
}

interface AssignmentNodeModel {
  readonly assignment: TeamAssignment;
  readonly children: readonly AssignmentNodeModel[];
}

function AssignmentNode({
  node,
  depth,
  writable,
  onSelectAgent,
  onCancel,
  onRetry,
  onReassign,
  onInspectArtifact,
}: {
  readonly node: AssignmentNodeModel;
  readonly depth: number;
  readonly writable: boolean;
  readonly onSelectAgent: (agentId: string) => void;
  readonly onCancel: (taskId: string) => void;
  readonly onRetry: (taskId: string) => void;
  readonly onReassign: (assignment: TeamAssignment) => void;
  readonly onInspectArtifact: (artifactId: string) => void;
}) {
  const assignment = node.assignment;
  const task = 'taskKey' in assignment ? assignment : undefined;
  const active = ['blocked', 'ready', 'running', 'awaiting_validation', 'integrating'].includes(
    assignment.status,
  );
  const retryable = ['failed', 'cancelled', 'interrupted'].includes(assignment.status);
  return (
    <div className="team-assignment-node">
      <button
        className="team-assignment-main"
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
            {task === undefined ? '' : ` · ${task.workspaceMode === 'isolated_write' ? '隔离写入' : '共享只读'} · ${task.validationMode === 'required' ? '独立验证' : '无需验证'}`}
          </small>
        </span>
        <em className={`assignment-${assignment.status}`}>{assignmentStatusLabel(assignment.status)}</em>
      </button>
      {task !== undefined && (
        <div className="team-task-actions" style={{ paddingInlineStart: `${10 + depth * 16}px` }}>
          {task.blocker !== undefined && <span title={task.blocker}>{task.blocker}</span>}
          {task.error !== undefined && <span className="failed" title={task.error}>{task.error}</span>}
          {task.artifactIds.map((artifactId) => (
            <button
              type="button"
              onClick={() => { onInspectArtifact(artifactId); }}
              title={`查看产物 ${artifactId}`}
              key={artifactId}
            ><Eye size={11} />产物</button>
          ))}
          <button
            type="button"
            disabled={!writable || !active}
            onClick={() => { onCancel(task.id); }}
            title="取消任务"
          ><Square size={11} />取消</button>
          <button
            type="button"
            disabled={!writable || !retryable}
            onClick={() => { onRetry(task.id); }}
            title="重试任务"
          ><RotateCcw size={11} />重试</button>
          <button
            type="button"
            disabled={!writable || ['running', 'awaiting_validation', 'integrating', 'completed'].includes(task.status)}
            onClick={() => { onReassign(task); }}
            title="重分配 profile 或模型"
          ><Settings2 size={11} />重分配</button>
        </div>
      )}
      {node.children.map((child) => (
        <AssignmentNode
          node={child}
          depth={depth + 1}
          writable={writable}
          onSelectAgent={onSelectAgent}
          onCancel={onCancel}
          onRetry={onRetry}
          onReassign={onReassign}
          onInspectArtifact={onInspectArtifact}
          key={child.assignment.id}
        />
      ))}
    </div>
  );
}

function AssignmentStatusIcon({ status }: { readonly status: TeamAssignmentStatus }) {
  if (status === 'completed') return <CircleCheck size={13} />;
  if (status === 'failed' || status === 'cancelled' || status === 'interrupted') return <CircleAlert size={13} />;
  if (status === 'queued' || status === 'blocked' || status === 'ready') return <Clock3 size={13} />;
  return <CircleDashed className="spin" size={13} />;
}

function buildAssignmentForest(assignments: readonly TeamAssignment[]): readonly AssignmentNodeModel[] {
  const nodes = new Map(assignments.map((assignment) => [assignment.id, { assignment, children: [] as AssignmentNodeModel[] }]));
  const roots: AssignmentNodeModel[] = [];
  for (const assignment of assignments) {
    const node = nodes.get(assignment.id)!;
    const parentId = teamTaskParentId(assignment);
    const parent = parentId === undefined ? undefined : nodes.get(parentId);
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
    const id = [...statuses].some((status) => isActiveAssignmentStatus(status))
      ? 'running'
      : [...statuses].some((status) => isWaitingAssignmentStatus(status)) ? 'queued' : 'terminal';
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
    const parentId = teamTaskParentId(current.assignment);
    current = parentId === undefined ? undefined : nodes.get(parentId);
  }
  return false;
}

function assignmentStatusLabel(status: TeamAssignmentStatus): string {
  const labels: Record<TeamAssignmentStatus, string> = {
    queued: '等待',
    blocked: '依赖阻塞',
    ready: '就绪',
    running: '运行中',
    awaiting_validation: '等待验证',
    integrating: '集成中',
    completed: '完成',
    failed: '失败',
    cancelled: '已取消',
    interrupted: '已中断',
  };
  return labels[status];
}

function isActiveAssignmentStatus(status: TeamAssignmentStatus): boolean {
  return status === 'running' || status === 'awaiting_validation' || status === 'integrating';
}

function isWaitingAssignmentStatus(status: TeamAssignmentStatus): boolean {
  return status === 'queued' || status === 'blocked' || status === 'ready';
}

function schedulerStatusLabel(status: TeamSchedulerState['status']): string {
  const labels: Record<TeamSchedulerState['status'], string> = {
    running: '调度中',
    paused: '已暂停',
    awaiting_apply: '等待应用',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
  };
  return labels[status];
}

function TeamArtifactDialog({ value, pending, onClose, onApply, onDiscard }: {
  readonly value: {
    readonly title: string;
    readonly content: TeamArtifactContent;
    readonly integration: boolean;
  };
  readonly pending: boolean;
  readonly onClose: () => void;
  readonly onApply: () => void;
  readonly onDiscard: () => void;
}) {
  return (
    <div className="team-control-dialog-backdrop" role="presentation">
      <section
        className="team-control-dialog team-artifact-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={value.title}
      >
        <header>
          <div><GitMerge size={15} /><strong>{value.title}</strong></div>
          <button className="icon-button" type="button" onClick={onClose} title="关闭"><X size={15} /></button>
        </header>
        <div className="team-artifact-meta">
          <code>{value.content.artifact.kind}</code>
          <span>{value.content.artifact.mediaType}</span>
          <span>{value.content.artifact.byteLength.toLocaleString()} bytes</span>
        </div>
        <pre>{decodeArtifactText(value.content)}</pre>
        <footer>
          <button type="button" onClick={onClose} disabled={pending}>关闭</button>
          {value.integration && (
            <>
              <button type="button" onClick={onDiscard} disabled={pending}>放弃汇总</button>
              <button className="primary" type="button" onClick={onApply} disabled={pending}>
                {pending ? <CircleDashed className="spin" size={13} /> : <GitMerge size={13} />}
                确认应用到工作区
              </button>
            </>
          )}
        </footer>
      </section>
    </div>
  );
}

function TeamReassignDialog({
  task,
  profileName,
  model,
  pending,
  onProfileName,
  onModel,
  onClose,
  onSubmit,
}: {
  readonly task: TeamAssignment;
  readonly profileName: string;
  readonly model: string;
  readonly pending: boolean;
  readonly onProfileName: (value: string) => void;
  readonly onModel: (value: string) => void;
  readonly onClose: () => void;
  readonly onSubmit: () => void;
}) {
  return (
    <div className="team-control-dialog-backdrop" role="presentation">
      <section
        className="team-control-dialog team-reassign-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="重分配团队任务"
      >
        <header>
          <div><Settings2 size={15} /><strong>重分配任务</strong></div>
          <button className="icon-button" type="button" onClick={onClose} title="关闭"><X size={15} /></button>
        </header>
        <p>{task.description}</p>
        <label>
          <span>Agent profile</span>
          <input value={profileName} onChange={(event) => { onProfileName(event.currentTarget.value); }} />
        </label>
        <label>
          <span>模型（留空保留当前值）</span>
          <input value={model} onChange={(event) => { onModel(event.currentTarget.value); }} />
        </label>
        <footer>
          <button type="button" onClick={onClose} disabled={pending}>取消</button>
          <button
            className="primary"
            type="button"
            onClick={onSubmit}
            disabled={pending || profileName.trim().length === 0}
          >
            {pending ? <CircleDashed className="spin" size={13} /> : <Settings2 size={13} />}
            保存分配
          </button>
        </footer>
      </section>
    </div>
  );
}

interface TeamPolicyDraft {
  readonly maxConcurrency: string;
  readonly maxMembers: string;
  readonly maxDelegationDepth: string;
  readonly executionRetries: string;
  readonly validationRetries: string;
  readonly maxTokens: string;
  readonly maxDurationMs: string;
}

function TeamPolicyDialog({ value, pending, onChange, onClose, onSubmit }: {
  readonly value: TeamPolicyDraft;
  readonly pending: boolean;
  readonly onChange: (value: TeamPolicyDraft) => void;
  readonly onClose: () => void;
  readonly onSubmit: () => void;
}) {
  const field = (key: keyof TeamPolicyDraft, label: string, min: number, max?: number) => (
    <label>
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        value={value[key]}
        onChange={(event) => { onChange({ ...value, [key]: event.currentTarget.value }); }}
      />
    </label>
  );
  return (
    <div className="team-control-dialog-backdrop" role="presentation">
      <section
        className="team-control-dialog team-policy-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Team 调度策略"
      >
        <header>
          <div><Settings2 size={15} /><strong>Team 调度策略</strong></div>
          <button className="icon-button" type="button" onClick={onClose} title="关闭"><X size={15} /></button>
        </header>
        <div className="team-policy-grid">
          {field('maxConcurrency', '最大并发（1–16）', 1, 16)}
          {field('maxMembers', '最大成员（2–64）', 2, 64)}
          {field('maxDelegationDepth', '最大委派深度（1–8）', 1, 8)}
          {field('executionRetries', '执行自动重试（0–5）', 0, 5)}
          {field('validationRetries', '验证自动重试（0–5）', 0, 5)}
          {field('maxTokens', 'Token 上限（留空取消）', 1)}
          {field('maxDurationMs', '时长上限 ms（留空取消）', 1)}
        </div>
        <footer>
          <button type="button" onClick={onClose} disabled={pending}>取消</button>
          <button className="primary" type="button" onClick={onSubmit} disabled={pending}>
            {pending ? <CircleDashed className="spin" size={13} /> : <Settings2 size={13} />}
            保存策略
          </button>
        </footer>
      </section>
    </div>
  );
}

function policyToDraft(policy: TeamPolicy): TeamPolicyDraft {
  return {
    maxConcurrency: String(policy.maxConcurrency),
    maxMembers: String(policy.maxMembers),
    maxDelegationDepth: String(policy.maxDelegationDepth),
    executionRetries: String(policy.executionRetries),
    validationRetries: String(policy.validationRetries),
    maxTokens: policy.maxTokens === undefined ? '' : String(policy.maxTokens),
    maxDurationMs: policy.maxDurationMs === undefined ? '' : String(policy.maxDurationMs),
  };
}

function policyFromDraft(value: TeamPolicyDraft): TeamPolicyInput {
  return {
    maxConcurrency: parsePolicyInteger(value.maxConcurrency, '最大并发', 1, 16),
    maxMembers: parsePolicyInteger(value.maxMembers, '最大成员', 2, 64),
    maxDelegationDepth: parsePolicyInteger(value.maxDelegationDepth, '最大委派深度', 1, 8),
    executionRetries: parsePolicyInteger(value.executionRetries, '执行自动重试', 0, 5),
    validationRetries: parsePolicyInteger(value.validationRetries, '验证自动重试', 0, 5),
    maxTokens: parseOptionalPolicyInteger(value.maxTokens, 'Token 上限'),
    maxDurationMs: parseOptionalPolicyInteger(value.maxDurationMs, '时长上限'),
  };
}

function parseOptionalPolicyInteger(value: string, label: string): number | undefined {
  return value.trim().length === 0 ? undefined : parsePolicyInteger(value, label, 1);
}

function parsePolicyInteger(value: string, label: string, min: number, max?: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || (max !== undefined && parsed > max)) {
    throw new Error(`${label}必须是 ${String(min)}${max === undefined ? ' 以上' : `–${String(max)}`} 的整数`);
  }
  return parsed;
}

function decodeArtifactText(content: TeamArtifactContent): string {
  try {
    const binary = atob(content.dataBase64);
    const bytes = Uint8Array.from(binary, (character) => character.codePointAt(0) ?? 0);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return `无法以内联文本显示该产物（${content.artifact.mediaType}，${String(content.artifact.byteLength)} bytes）`;
  }
}

function shortId(id: string): string {
  return id.length <= 14 ? id : `${id.slice(0, 8)}…`;
}

function TeamUserQuestionCard({ pending, sessionId, disabled, onSelectAgent, onRef }: {
  readonly pending: PendingLeaderQuestion;
  readonly sessionId: string;
  readonly disabled: boolean;
  readonly onSelectAgent: (agentId: string) => void;
  readonly onRef: (element: HTMLElement | null) => void;
}) {
  const message = pending.message;
  return (
    <article
      className="team-message agent leader team-user-question"
      data-question-id={pending.questionId}
      ref={onRef}
    >
      <button
        className="team-message-avatar"
        type="button"
        onClick={() => { onSelectAgent(message.sender.actorId); }}
        title={`组长 · ${message.sender.actorId}`}
      >
        <Bot size={14} />
      </button>
      <div className="team-message-frame">
        <header className="team-message-meta">
          <strong>组长</strong>
          <span>等待你的回答</span>
          <time>{formatTime(message.createdAt)}</time>
        </header>
        <QuestionForm
          questions={pending.questions}
          heading="组长需要你的决定"
          disabled={disabled}
          className="team-user-question-form"
          onSubmit={(answers) => window.kimiDesktop.team.answerQuestion(
            sessionId,
            pending.questionId,
            answers,
          ).then(() => undefined)}
          onSkip={() => window.kimiDesktop.team.answerQuestion(
            sessionId,
            pending.questionId,
            null,
          ).then(() => undefined)}
        />
      </div>
    </article>
  );
}

function TeamMessageBubble({ message, members, assignments, mentionAliases, onSelectAgent }: {
  readonly message: TeamMessage;
  readonly members: readonly TeamMember[];
  readonly assignments: readonly TeamAssignment[];
  readonly mentionAliases: ReturnType<typeof buildTeamMentionAliases>;
  readonly onSelectAgent: (agentId: string) => void;
}) {
  const isUser = message.sender.actorKind === 'user';
  const isAgent = message.sender.actorKind === 'agent';
  const presentation = isUser
    ? { displayName: '你', profileName: undefined, agentId: message.sender.actorId }
    : isAgent
      ? agentPresentation(message.sender.actorId, members, assignments)
      : { displayName: '团队协调器', profileName: '系统', agentId: message.sender.actorId };
  return (
    <article className={classNames('team-message', isUser ? 'user' : isAgent ? 'agent' : 'system', message.sender.role === 'leader' && 'leader')}>
      <button
        className="team-message-avatar"
        disabled={!isAgent}
        onClick={() => { if (isAgent) onSelectAgent(message.sender.actorId); }}
        title={isUser ? '你' : `${presentation.displayName} · ${message.sender.actorId}`}
      >
        {isUser ? <UserRound size={14} /> : <Bot size={14} />}
      </button>
      <div className="team-message-frame">
        <header className="team-message-meta">
          <strong>{presentation.displayName}</strong>
          <span>{message.sender.role === 'leader' ? '组长' : presentation.profileName ?? '用户'}</span>
          {message.taskId !== undefined && <code>{shortId(message.taskId)}</code>}
          {message.recipientAgentIds !== undefined && (
            <code>私信 {message.recipientAgentIds.map((agentId) => agentPresentation(
              agentId,
              members,
              assignments,
            ).displayName).join('、')}</code>
          )}
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
