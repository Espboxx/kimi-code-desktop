import { useEffect, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  AlertCircle,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Clock3,
  FileCode2,
  GitCompare,
  Image as ImageIcon,
  TerminalSquare,
  Video,
  Wrench,
  X,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type {
  AgentTranscript,
  TranscriptStore,
  TranscriptAttachment,
  TranscriptFrame,
  TranscriptInteraction,
  TranscriptItem,
  TranscriptTask,
  TranscriptTurn,
} from '@moonshot-ai/transcript';

import { InlineAgentActivity } from './AgentActivity';
import type { AgentActivityForest } from './agent-activity';
import { InteractionPanel } from './InteractionPanel';
import { decideTimelineAutoFollow } from './timeline-scroll';
import {
  fileOperationDisplay,
  payloadPreview,
  toolDisplayState,
  workspaceFilePath,
  type FileOperationDisplay,
  type FileOperationTarget,
  type ToolDisplayState,
} from './tool-display';
import { classNames, formatJson, formatTime, record, text } from './ui-utils';

interface TimelineProps {
  readonly transcript?: AgentTranscript;
  readonly store?: TranscriptStore;
  readonly activity: AgentActivityForest;
  readonly selectedAgentId: string;
  readonly onSelectAgent: (agentId: string) => void;
  readonly sessionId?: string;
  readonly version: number;
  readonly followRequest: number;
  readonly workspaceRoot: string;
  readonly onOpenFileOperation: (target: FileOperationTarget) => void;
  readonly onOpenGitDiff: (path: string) => void;
}

export function Timeline({
  transcript,
  store,
  activity,
  selectedAgentId,
  onSelectAgent,
  sessionId,
  version,
  followRequest,
  workspaceRoot,
  onOpenFileOperation,
  onOpenGitDiff,
}: TimelineProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const shouldStick = useRef(true);
  const previousStreamKey = useRef<string | undefined>(undefined);
  const previousFollowRequest = useRef(followRequest);
  const pendingFollow = useRef(false);
  const items = transcript?.getItems() ?? [];
  const tasks = transcript?.getTasks() ?? new Map<string, TranscriptTask>();
  const interactions = transcript?.getInteractions() ?? new Map<string, TranscriptInteraction>();
  const attachments = transcript?.getAttachments() ?? new Map<string, TranscriptAttachment>();
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => items[index]?.kind === 'turn' ? 260 : 56,
    overscan: 5,
  });
  const streamKey = sessionId === undefined ? undefined : `${sessionId}:${selectedAgentId}`;

  useEffect(() => {
    const streamChanged = previousStreamKey.current !== streamKey;
    const followRequested = previousFollowRequest.current !== followRequest;
    previousStreamKey.current = streamKey;
    previousFollowRequest.current = followRequest;
    const decision = decideTimelineAutoFollow({
      hasContent: virtualizer.options.count > 0,
      nearBottom: shouldStick.current,
      streamChanged,
      followRequested,
      pendingFollow: pendingFollow.current,
    });
    pendingFollow.current = decision.pendingFollow;
    if (decision.shouldFollow) {
      shouldStick.current = true;
      virtualizer.scrollToIndex(virtualizer.options.count - 1, { align: 'end' });
    }
  }, [followRequest, streamKey, version, virtualizer]);

  if (transcript === undefined || sessionId === undefined) {
    return (
      <div className="timeline-empty">
        <div className="empty-glyph"><TerminalSquare size={22} /></div>
        <strong>选择或创建 Kimi 会话</strong>
        <span>会话历史、工具调用和 Agent 活动会在这里显示。</span>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="timeline-empty">
        <div className="empty-glyph"><Brain size={22} /></div>
        <strong>会话已就绪</strong>
        <span>输入任务，或切换到 Plan / Swarm 模式开始工作。</span>
      </div>
    );
  }

  return (
    <div
      className="timeline-scroll"
      ref={parentRef}
      onScroll={(event) => {
        const element = event.currentTarget;
        shouldStick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
      }}
    >
      <div className="timeline-virtual" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const item = items[virtualItem.index];
          if (item === undefined) return null;
          return (
            <div
              className="timeline-virtual-row"
              data-index={virtualItem.index}
              key={itemId(item)}
              ref={virtualizer.measureElement}
              style={{ transform: `translateY(${virtualItem.start}px)` }}
            >
              <TimelineItem
                item={item}
                tasks={tasks}
                interactions={interactions}
                attachments={attachments}
                sessionId={sessionId}
                store={store}
                activity={activity}
                selectedAgentId={selectedAgentId}
                onSelectAgent={onSelectAgent}
                workspaceRoot={workspaceRoot}
                onOpenFileOperation={onOpenFileOperation}
                onOpenGitDiff={onOpenGitDiff}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TimelineItem({
  item,
  tasks,
  interactions,
  attachments,
  sessionId,
  store,
  activity,
  selectedAgentId,
  onSelectAgent,
  workspaceRoot,
  onOpenFileOperation,
  onOpenGitDiff,
}: {
  readonly item: TranscriptItem;
  readonly tasks: ReadonlyMap<string, TranscriptTask>;
  readonly interactions: ReadonlyMap<string, TranscriptInteraction>;
  readonly attachments: ReadonlyMap<string, TranscriptAttachment>;
  readonly sessionId: string;
  readonly store?: TranscriptStore;
  readonly activity: AgentActivityForest;
  readonly selectedAgentId: string;
  readonly onSelectAgent: (agentId: string) => void;
  readonly workspaceRoot: string;
  readonly onOpenFileOperation: (target: FileOperationTarget) => void;
  readonly onOpenGitDiff: (path: string) => void;
}) {
  if (item.kind === 'marker') {
    const payload = record(item.payload);
    const isNotice = item.marker === 'notice';
    const timestamp = formatTime(item.at);
    return (
      <article className={classNames('timeline-system-message', isNotice && `marker-${text(payload['level'], 'info')}`)}>
        <div className="message-role system-role">系统</div>
        <div className="system-message-content">
          <div className="system-message-bubble">
            <span className="system-message-icon">
              {isNotice && text(payload['level']) === 'error' ? <AlertCircle size={14} /> : <Clock3 size={13} />}
            </span>
            <span className="system-message-title">{markerTitle(item.marker, item.payload)}</span>
            {timestamp.length > 0 && <time>{timestamp}</time>}
            {Object.keys(payload).length > 1 && (
              <details><summary>详情</summary><pre>{formatJson(item.payload)}</pre></details>
            )}
          </div>
        </div>
      </article>
    );
  }
  if (item.kind === 'taskref') {
    const task = tasks.get(item.taskId);
    return task === undefined || activity.linkedTaskIds.has(item.taskId) ? null : <TaskStrip task={task} />;
  }
  return (
    <TurnView
      turn={item}
      interactions={interactions}
      attachments={attachments}
      sessionId={sessionId}
      store={store}
      activity={activity}
      selectedAgentId={selectedAgentId}
      onSelectAgent={onSelectAgent}
      workspaceRoot={workspaceRoot}
      onOpenFileOperation={onOpenFileOperation}
      onOpenGitDiff={onOpenGitDiff}
    />
  );
}

function TurnView({
  turn,
  interactions,
  attachments,
  sessionId,
  store,
  activity,
  selectedAgentId,
  onSelectAgent,
  workspaceRoot,
  onOpenFileOperation,
  onOpenGitDiff,
}: {
  readonly turn: TranscriptTurn;
  readonly interactions: ReadonlyMap<string, TranscriptInteraction>;
  readonly attachments: ReadonlyMap<string, TranscriptAttachment>;
  readonly sessionId: string;
  readonly store?: TranscriptStore;
  readonly activity: AgentActivityForest;
  readonly selectedAgentId: string;
  readonly onSelectAgent: (agentId: string) => void;
  readonly workspaceRoot: string;
  readonly onOpenFileOperation: (target: FileOperationTarget) => void;
  readonly onOpenGitDiff: (path: string) => void;
}) {
  return (
    <article className="conversation-turn">
      {(turn.prompt !== undefined && turn.prompt.length > 0) || (turn.attachmentIds?.length ?? 0) > 0 ? (
        <div className="user-message">
          <div className="message-role">你</div>
          <div className="message-content">
            {turn.prompt !== undefined && turn.prompt.length > 0 && (
              <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{turn.prompt}</ReactMarkdown></div>
            )}
            <AttachmentStrip ids={turn.attachmentIds} attachments={attachments} />
          </div>
        </div>
      ) : null}
      <div className="assistant-message">
        <div className="message-role kimi-role">Kimi</div>
        <div className="assistant-content">
          {turn.steps.flatMap((step) => step.frames.map((frame) => (
            <FrameView
              frame={frame}
              interaction={frame.kind === 'tool' && frame.approvalId !== undefined
                ? interactions.get(frame.approvalId)
                : frame.kind === 'tool'
                  ? [...interactions.values()].find((candidate) => candidate.toolCallId === frame.toolCallId)
                  : undefined}
              sessionId={sessionId}
              attachments={attachments}
              store={store}
              activity={activity}
              selectedAgentId={selectedAgentId}
              onSelectAgent={onSelectAgent}
              workspaceRoot={workspaceRoot}
              onOpenFileOperation={onOpenFileOperation}
              onOpenGitDiff={onOpenGitDiff}
              key={frame.frameId}
            />
          )))}
          {turn.steps.length === 0 && turn.state === 'running' && (
            <div className="stream-wait"><CircleDashed className="spin" size={15} /> Kimi 正在处理</div>
          )}
        </div>
      </div>
      <div className="turn-footer">
        <span className={`status-dot status-${turn.state}`} />
        <span>{turnStateLabel(turn.state)}</span>
        {turn.durationMs !== undefined && <span>{formatDuration(turn.durationMs)}</span>}
        {turn.error !== undefined && <span className="error-text">{turn.error}</span>}
      </div>
    </article>
  );
}

function FrameView({
  frame,
  interaction,
  sessionId,
  attachments,
  store,
  activity,
  selectedAgentId,
  onSelectAgent,
  workspaceRoot,
  onOpenFileOperation,
  onOpenGitDiff,
}: {
  readonly frame: TranscriptFrame;
  readonly interaction?: TranscriptInteraction;
  readonly sessionId: string;
  readonly attachments: ReadonlyMap<string, TranscriptAttachment>;
  readonly store?: TranscriptStore;
  readonly activity: AgentActivityForest;
  readonly selectedAgentId: string;
  readonly onSelectAgent: (agentId: string) => void;
  readonly workspaceRoot: string;
  readonly onOpenFileOperation: (target: FileOperationTarget) => void;
  readonly onOpenGitDiff: (path: string) => void;
}) {
  switch (frame.kind) {
    case 'text':
      return frame.text.length === 0 && (frame.attachmentIds?.length ?? 0) === 0 ? null : (
        <div className={classNames('message-content', frame.role === 'user' ? 'steer-message' : 'assistant-markdown')}>
          {frame.text.length > 0 && (
            <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{frame.text}</ReactMarkdown></div>
          )}
          <AttachmentStrip ids={frame.attachmentIds} attachments={attachments} />
        </div>
      );
    case 'thinking':
      return (
        <details className="thinking-block">
          <summary><Brain size={14} /> Thinking <ChevronDown size={14} /></summary>
          <div className="thinking-content markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{frame.text}</ReactMarkdown></div>
        </details>
      );
    case 'notice':
      return (
        <div className={`inline-notice inline-notice-${frame.level}`}>
          <AlertCircle size={14} />
          <span>{frame.message}</span>
        </div>
      );
    case 'tool': {
      const operation = fileOperationDisplay(frame.display);
      const operationPath = operation === undefined ? undefined : workspaceFilePath(workspaceRoot, operation.path);
      const operationTarget: FileOperationTarget | undefined = frame.state === 'done' && operation !== undefined && operationPath !== undefined
        ? {
            toolCallId: frame.toolCallId,
            operation: operation.operation,
            path: operationPath,
            before: operation.before,
            after: operation.after,
          }
        : undefined;
      return (
        <div className={classNames('tool-frame', `tool-${frame.state}`)}>
          <details open={frame.state === 'running'}>
            <summary>
              <span className="tool-icon"><Wrench size={14} /></span>
              <strong>{frame.name || 'Tool'}</strong>
              <span className="tool-summary">{operationPath ?? toolSummary(frame.input, frame.display, interaction)}</span>
              <span className="tool-summary-status">
                {operationTarget !== undefined && (
                  <button
                    className="tool-open-action"
                    type="button"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      onOpenFileOperation(operationTarget);
                    }}
                    title={operationTarget.operation === 'edit' ? '查看本次修改' : '打开文件'}
                  >
                    {operationTarget.operation === 'edit' ? <GitCompare size={12} /> : <FileCode2 size={12} />}
                    {operationTarget.operation === 'edit' ? '查看修改' : '打开文件'}
                  </button>
                )}
                <ToolState state={toolDisplayState(frame, interaction)} />
              </span>
              <ChevronRight className="tool-chevron" size={14} />
            </summary>
            <div className="tool-details">
              {frame.progress !== undefined && (
                <div className="tool-progress">
                  {frame.progress.percent !== undefined && <progress value={frame.progress.percent} max={100} />}
                  {frame.progress.text !== undefined && <pre>{frame.progress.text}</pre>}
                </div>
              )}
              {operation !== undefined ? (
                <FileOperationDetails
                  operation={operation}
                  path={operationPath}
                  target={operationTarget}
                  onOpen={onOpenFileOperation}
                  onOpenGitDiff={onOpenGitDiff}
                />
              ) : frame.input !== undefined && <PayloadBlock title="输入" value={frame.input} />}
              {frame.output !== undefined && <PayloadBlock title={frame.state === 'error' ? '错误' : '结果'} value={frame.output} />}
            </div>
          </details>
          {store !== undefined && frame.agentRefs !== undefined && frame.agentRefs.length > 0 && (
            <InlineAgentActivity
              refs={frame.agentRefs}
              forest={activity}
              selectedAgentId={selectedAgentId}
              onSelectAgent={onSelectAgent}
            />
          )}
          {interaction !== undefined && interaction.state !== 'pending' && (
            <InteractionPanel interaction={interaction} sessionId={sessionId} />
          )}
        </div>
      );
    }
  }
}

function FileOperationDetails({ operation, path, target, onOpen, onOpenGitDiff }: {
  readonly operation: FileOperationDisplay;
  readonly path?: string;
  readonly target?: FileOperationTarget;
  readonly onOpen: (target: FileOperationTarget) => void;
  readonly onOpenGitDiff: (path: string) => void;
}) {
  const detail = operation.operation === 'write'
    ? `写入 ${operation.content?.length.toLocaleString('zh-CN') ?? '未知'} 个字符`
    : operation.operation === 'edit'
      ? `替换 ${operation.before?.length.toLocaleString('zh-CN') ?? '未知'} → ${operation.after?.length.toLocaleString('zh-CN') ?? '未知'} 个字符`
      : '读取文件';
  return (
    <div className="file-operation-details">
      <div><span>{operationLabel(operation.operation)}</span><code>{path ?? operation.path}</code><small>{detail}</small></div>
      {target !== undefined ? (
        <div className="file-operation-actions">
          <button type="button" onClick={() => onOpen(target)}>
            {target.operation === 'edit' ? <GitCompare size={12} /> : <FileCode2 size={12} />}
            {target.operation === 'edit' ? '查看本次修改' : '打开文件'}
          </button>
          <button type="button" onClick={() => onOpenGitDiff(target.path)}><GitCompare size={12} />当前 Git 差异</button>
        </div>
      ) : (
        <small className="file-operation-unavailable">操作完成后可打开；工作区外路径不支持在编辑器中查看。</small>
      )}
    </div>
  );
}

function operationLabel(operation: FileOperationDisplay['operation']): string {
  return operation === 'read' ? '读取' : operation === 'write' ? '写入' : '编辑';
}

function AttachmentStrip({
  ids,
  attachments,
}: {
  readonly ids?: readonly string[];
  readonly attachments: ReadonlyMap<string, TranscriptAttachment>;
}) {
  if (ids === undefined || ids.length === 0) return null;
  return (
    <div className="message-attachments">
      {ids.map((id) => {
        const attachment = attachments.get(id);
        if (attachment === undefined) return null;
        const source = attachment.source?.kind === 'url' ? attachment.source.url : undefined;
        if (source !== undefined && attachment.mediaType.startsWith('image/')) {
          return <img src={source} alt={attachment.name ?? 'Attached image'} loading="lazy" key={id} />;
        }
        if (source !== undefined && attachment.mediaType.startsWith('video/')) {
          return <video src={source} controls preload="metadata" aria-label={attachment.name ?? 'Attached video'} key={id} />;
        }
        if (source !== undefined && attachment.mediaType.startsWith('audio/')) {
          return <audio src={source} controls preload="metadata" aria-label={attachment.name ?? 'Attached audio'} key={id} />;
        }
        return (
          <div className="attachment-fallback" key={id}>
            {attachment.mediaType.startsWith('video/') ? <Video size={15} /> : <ImageIcon size={15} />}
            <span>{attachment.name ?? attachment.placeholder ?? attachment.mediaType}</span>
          </div>
        );
      })}
    </div>
  );
}

function ToolState({ state }: { readonly state: ToolDisplayState }) {
  if (state === 'preparing') return <span className="tool-state running"><CircleDashed className="spin" size={13} />生成参数</span>;
  if (state === 'waiting-approval') return <span className="tool-state waiting"><Clock3 size={13} />等待批准</span>;
  if (state === 'waiting-answer') return <span className="tool-state waiting"><Clock3 size={13} />等待回答</span>;
  if (state === 'running') return <span className="tool-state running"><CircleDashed className="spin" size={13} />执行中</span>;
  if (state === 'error') return <span className="tool-state error"><X size={13} />失败</span>;
  return <span className="tool-state done"><Check size={13} />完成</span>;
}

function PayloadBlock({ title, value }: { readonly title: string; readonly value: unknown }) {
  const preview = payloadPreview(value);
  return (
    <div className="payload-block">
      <span>{title}</span>
      <pre>
        {preview.text}
        {preview.omittedCharacters > 0 && <small>\n… 已省略 {preview.omittedCharacters.toLocaleString('zh-CN')} 个字符</small>}
      </pre>
    </div>
  );
}

function TaskStrip({ task }: { readonly task: TranscriptTask }) {
  return (
    <div className="task-strip">
      {task.kind === 'shell' ? <TerminalSquare size={14} /> : <Brain size={14} />}
      <span>{task.description ?? task.taskId}</span>
      <span className={`task-state task-${task.state}`}>{task.state}</span>
      {task.resultSummary !== undefined && <span className="task-result">{task.resultSummary}</span>}
    </div>
  );
}

function itemId(item: TranscriptItem): string {
  return item.kind === 'turn' ? item.turnId : item.kind === 'marker' ? item.markerId : item.refId;
}

function markerTitle(marker: string, payload: unknown): string {
  const value = record(payload);
  if (marker === 'notice') return text(value['message'], '通知');
  if (marker === 'compaction') return `上下文压缩 · ${text(value['phase'], '完成')}`;
  if (marker === 'goal') return 'Goal 已更新';
  if (marker === 'plan.enter') return '已进入 Plan 模式';
  if (marker === 'plan.exit') return '已退出 Plan 模式';
  if (marker === 'skill') return `已激活 ${text(value['skillName'], text(value['commandName'], '扩展命令'))}`;
  if (marker === 'cron.fired') return '定时任务已触发';
  if (marker === 'hook') return `Hook · ${text(value['hookEvent'], 'result')}`;
  if (marker === 'context.import') return `已导入上下文 · ${text(value['source'], 'unknown')}`;
  return marker;
}

function toolSummary(input: unknown, display: unknown, interaction?: TranscriptInteraction): string {
  const source = record(display);
  const inputRecord = record(input);
  const request = record(interaction?.request);
  return text(source['summary'], text(
    source['description'],
    text(inputRecord['path'], text(inputRecord['command'], text(request['action']))),
  ));
}

function turnStateLabel(state: TranscriptTurn['state']): string {
  return state === 'running' ? '进行中' : state === 'completed' ? '完成' : state === 'cancelled' ? '已取消' : state === 'failed' ? '失败' : '排队中';
}

function formatDuration(ms: number): string {
  return ms < 1_000 ? `${ms} ms` : `${(ms / 1_000).toFixed(1)} s`;
}
