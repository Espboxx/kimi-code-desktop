import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  AlertCircle,
  AtSign,
  Bot,
  ChevronDown,
  Database,
  Gauge,
  ImagePlus,
  Send,
  Sparkles,
  Square,
  Video,
  X,
} from 'lucide-react';

import type { SessionStatusSnapshot } from '../shared/desktop-api';
import {
  cacheMetrics,
  clampComposerHeight,
  COMPOSER_HEIGHT_STORAGE_KEY,
  COMPOSER_IMAGE_ACCEPT,
  composerMaxHeight,
  contextPercentage,
  contextProgress,
  formatTokenCount,
  imageFileError,
  MIN_COMPOSER_HEIGHT,
  parseComposerHeight,
} from './composer-utils';
import { SessionControls, type SessionModelOption } from './SessionControls';
import { classNames, record, text } from './ui-utils';

export type ComposerMode = 'prompt' | 'steer';

interface ComposerMedia {
  readonly type: 'image_url' | 'video_url';
  readonly url: string;
}

interface ComposerAttachment extends ComposerMedia {
  readonly id: string;
  readonly label: string;
}

interface ComposerAttachmentError {
  readonly code: string;
  readonly message: string;
}

interface CommandSuggestion {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly kind: 'skill' | 'plugin' | 'command';
  readonly pluginId?: string;
  readonly commandName?: string;
}

interface ComposerProps {
  readonly sessionId?: string;
  readonly busy: boolean;
  readonly status?: SessionStatusSnapshot;
  readonly models: readonly SessionModelOption[];
  readonly skills: readonly unknown[];
  readonly pluginCommands: readonly unknown[];
  readonly commands: readonly unknown[];
  readonly onSubmit: (input: { mode: ComposerMode; text: string; media: readonly ComposerMedia[] }) => Promise<void>;
  readonly onCancel: () => Promise<void>;
  readonly swarmPermissionPending: boolean;
  readonly onEnterSwarm: (activate: () => Promise<void> | void) => Promise<boolean>;
}

export function Composer(props: ComposerProps) {
  const [value, setValue] = useState('');
  const [mode, setMode] = useState<ComposerMode>('prompt');
  const [media, setMedia] = useState<ComposerAttachment[]>([]);
  const [mediaDraft, setMediaDraft] = useState('');
  const [mediaType, setMediaType] = useState<ComposerMedia['type']>('image_url');
  const [showMedia, setShowMedia] = useState(false);
  const [attachmentError, setAttachmentError] = useState<ComposerAttachmentError>();
  const [submitting, setSubmitting] = useState(false);
  const [invocation, setInvocation] = useState<CommandSuggestion>();
  const [editorHeight, setEditorHeight] = useState(() => initialEditorHeight());
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editorHeightRef = useRef(editorHeight);
  const resizeDragRef = useRef<{ readonly pointerId: number; readonly startY: number; readonly startHeight: number } | undefined>(undefined);
  const suggestions = useMemo(() => collectSuggestions(props), [props]);
  const visibleSuggestions = value.startsWith('/') && invocation === undefined
    ? suggestions.filter((item) => item.label.toLowerCase().includes(value.slice(1).split(/\s/)[0]?.toLowerCase() ?? '')).slice(0, 8)
    : [];
  const contextPercent = props.status === undefined ? undefined : contextPercentage(props.status.contextUsage);
  const contextBar = props.status === undefined ? 0 : contextProgress(props.status.contextUsage);
  const cache = cacheMetrics(props.status?.usage);

  const updateEditorHeight = useCallback((height: number, persist: boolean) => {
    const next = clampComposerHeight(height, window.innerHeight);
    editorHeightRef.current = next;
    setEditorHeight(next);
    if (!persist) return;
    try {
      window.localStorage.setItem(COMPOSER_HEIGHT_STORAGE_KEY, String(next));
    } catch {
      // A blocked storage backend should not disable resizing.
    }
  }, []);

  useEffect(() => {
    const onResize = () => {
      updateEditorHeight(editorHeightRef.current, false);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [updateEditorHeight]);

  useEffect(() => {
    setMode('prompt');
  }, [props.sessionId]);

  const submit = async () => {
    const prompt = value.trim();
    if (props.sessionId === undefined || submitting || (prompt.length === 0 && media.length === 0 && invocation === undefined)) return;
    setSubmitting(true);
    try {
      if (invocation !== undefined) {
        const args = prompt.length === 0 ? undefined : prompt;
        if (invocation.kind === 'skill') {
          await window.kimiDesktop.extension.activateSkill(invocation.commandName ?? invocation.label, args, props.sessionId);
        } else if (invocation.kind === 'plugin') {
          await window.kimiDesktop.extension.activatePlugin(invocation.pluginId ?? '', invocation.commandName ?? invocation.label, args, props.sessionId);
        } else {
          await window.kimiDesktop.extension.runCommand(invocation.commandName ?? invocation.label, args, props.sessionId);
        }
      } else {
        await props.onSubmit({
          mode,
          text: prompt,
          media: media.map((item) => ({ type: item.type, url: item.url })),
        });
      }
      setValue('');
      setMedia([]);
      setAttachmentError(undefined);
      setInvocation(undefined);
      textareaRef.current?.focus();
    } finally {
      setSubmitting(false);
    }
  };

  const addMedia = () => {
    const url = mediaDraft.trim();
    if (url.length === 0) return;
    setMedia((current) => [...current, {
      id: attachmentId(),
      type: mediaType,
      url,
      label: url,
    }]);
    setAttachmentError(undefined);
    setMediaDraft('');
    setShowMedia(false);
  };

  const addImageFiles = useCallback(async (files: readonly File[]) => {
    if (files.length === 0) return;
    setAttachmentError(undefined);
    const results = await Promise.allSettled(files.map(readImageAttachment));
    const accepted: ComposerAttachment[] = [];
    const errors: ComposerAttachmentError[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') accepted.push(result.value);
      else errors.push(attachmentProblem(result.reason));
    }
    if (accepted.length > 0) setMedia((current) => [...current, ...accepted]);
    if (errors.length > 0) {
      setAttachmentError({
        code: [...new Set(errors.map((error) => error.code))].join(', '),
        message: errors.map((error) => error.message).join('；'),
      });
    }
  }, []);

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    resizeDragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: editorHeightRef.current,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const moveResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = resizeDragRef.current;
    if (drag === undefined || drag.pointerId !== event.pointerId) return;
    updateEditorHeight(drag.startHeight + drag.startY - event.clientY, false);
  };

  const finishResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = resizeDragRef.current;
    if (drag === undefined || drag.pointerId !== event.pointerId) return;
    resizeDragRef.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    updateEditorHeight(editorHeightRef.current, true);
  };

  const contextTitle = props.status === undefined
    ? '尚未选择会话'
    : `上下文 ${formatTokenCount(props.status.contextTokens)} / ${formatTokenCount(props.status.maxContextTokens)} tokens (${String(contextPercent)}%)`;
  const cacheTitle = cache === undefined
    ? '会话尚无用量数据'
    : `会话累计 · 普通输入 ${formatTokenCount(cache.inputOther)} · 缓存读取 ${formatTokenCount(cache.cacheRead)} · 缓存写入 ${formatTokenCount(cache.cacheCreation)} · 输入总量 ${formatTokenCount(cache.inputTotal)}`;
  const maxHeight = composerMaxHeight(window.innerHeight);

  return (
    <div className="composer-wrap">
      {visibleSuggestions.length > 0 && (
        <div className="command-menu" role="listbox">
          {visibleSuggestions.map((suggestion) => (
            <button
              role="option"
              aria-selected="false"
              key={suggestion.id}
              onClick={() => {
                setInvocation(suggestion);
                setValue('');
                textareaRef.current?.focus();
              }}
            >
              {suggestion.kind === 'skill' ? <Sparkles size={14} /> : suggestion.kind === 'plugin' ? <Bot size={14} /> : <AtSign size={14} />}
              <span><strong>/{suggestion.label}</strong><small>{suggestion.description}</small></span>
            </button>
          ))}
        </div>
      )}
      {showMedia && (
        <div className="media-input-row" aria-label="通过 URL 或路径添加媒体">
          <div className="segmented compact">
            <button className={mediaType === 'image_url' ? 'active' : ''} onClick={() => { setMediaType('image_url'); }} title="图片"><ImagePlus size={14} /></button>
            <button className={mediaType === 'video_url' ? 'active' : ''} onClick={() => { setMediaType('video_url'); }} title="视频"><Video size={14} /></button>
          </div>
          <input value={mediaDraft} onChange={(event) => { setMediaDraft(event.target.value); }} placeholder="URL 或绝对文件路径" onKeyDown={(event) => { if (event.key === 'Enter') addMedia(); }} />
          <button className="icon-button" onClick={addMedia} title="添加"><Send size={14} /></button>
        </div>
      )}
      {attachmentError !== undefined && (
        <div className="composer-attachment-error" role="alert">
          <AlertCircle size={13} />
          <span><strong>{attachmentError.code}</strong>{attachmentError.message}</span>
          <button onClick={() => { setAttachmentError(undefined); }} title="关闭"><X size={11} /></button>
        </div>
      )}
      {(media.length > 0 || invocation !== undefined) && (
        <div className="composer-chips">
          {invocation !== undefined && (
            <span><Sparkles size={12} /><span className="attachment-label">/{invocation.label}</span><button onClick={() => { setInvocation(undefined); }} title="移除"><X size={11} /></button></span>
          )}
          {media.map((item, index) => (
            <span key={item.id} title={item.label}>
              {item.type === 'image_url' ? <ImagePlus size={12} /> : <Video size={12} />}
              <span className="attachment-label">{item.label}</span>
              <button onClick={() => { setMedia((current) => current.filter((_, itemIndex) => itemIndex !== index)); }} title="移除"><X size={11} /></button>
            </span>
          ))}
        </div>
      )}
      <div
        className={classNames('composer', props.sessionId === undefined && 'disabled')}
        style={{ '--composer-editor-height': `${String(editorHeight)}px` } as CSSProperties}
      >
        <div
          className="composer-resize-handle"
          role="separator"
          aria-label="调整输入框高度"
          aria-orientation="horizontal"
          aria-valuemin={MIN_COMPOSER_HEIGHT}
          aria-valuemax={maxHeight}
          aria-valuenow={editorHeight}
          tabIndex={0}
          onPointerDown={startResize}
          onPointerMove={moveResize}
          onPointerUp={finishResize}
          onPointerCancel={finishResize}
          onKeyDown={(event) => {
            let next: number | undefined;
            if (event.key === 'ArrowUp') next = editorHeightRef.current + (event.shiftKey ? 24 : 8);
            if (event.key === 'ArrowDown') next = editorHeightRef.current - (event.shiftKey ? 24 : 8);
            if (event.key === 'Home') next = MIN_COMPOSER_HEIGHT;
            if (event.key === 'End') next = maxHeight;
            if (next === undefined) return;
            event.preventDefault();
            updateEditorHeight(next, true);
          }}
        ><span /></div>
        <textarea
          ref={textareaRef}
          value={value}
          disabled={props.sessionId === undefined}
          placeholder={props.sessionId === undefined ? '先选择或创建会话' : invocation === undefined ? '交给 Kimi 一个任务…' : `/${invocation.label} 参数`}
          rows={2}
          onChange={(event) => { setValue(event.target.value); }}
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
              void submit();
            }
            if (event.key === 'Escape') {
              setInvocation(undefined);
              setValue('');
            }
          }}
        />
        <div className="composer-status-toolbar">
          <SessionControls
            sessionId={props.sessionId}
            status={props.status}
            models={props.models}
            placement="composer"
            swarmPermissionPending={props.swarmPermissionPending}
            onEnterSwarm={props.onEnterSwarm}
          />
          <div className="composer-usage-indicators">
            <span className="composer-metric context-usage-indicator" title={contextTitle}>
              <Gauge size={12} />
              <span>上下文 <strong>{contextPercent === undefined ? '--' : `${String(contextPercent)}%`}</strong></span>
              <span className="context-mini-progress" aria-hidden="true"><i style={{ width: `${String(contextBar)}%` }} /></span>
            </span>
            <span className="composer-metric cache-usage-indicator" title={cacheTitle}>
              <Database size={12} />
              <span>缓存 <strong>{cache === undefined ? '--' : formatTokenCount(cache.cacheRead)}</strong> · 命中 <strong>{cache === undefined ? '--' : `${String(cache.hitRate)}%`}</strong></span>
            </span>
          </div>
        </div>
        <div className="composer-toolbar">
          <div className="segmented composer-modes" aria-label="发送模式">
            <button className={mode === 'prompt' ? 'active' : ''} onClick={() => { setMode('prompt'); }} title="普通 Prompt"><Bot size={13} /><span>Prompt</span></button>
            <button className={mode === 'steer' ? 'active' : ''} onClick={() => { setMode('steer'); }} title="Steer 当前轮次"><Sparkles size={13} /><span>Steer</span></button>
          </div>
          <div className="composer-actions">
            <input
              ref={fileInputRef}
              className="composer-file-input"
              type="file"
              accept={COMPOSER_IMAGE_ACCEPT}
              multiple
              tabIndex={-1}
              onChange={(event) => {
                const files = Array.from(event.currentTarget.files ?? []);
                event.currentTarget.value = '';
                void addImageFiles(files);
              }}
            />
            <button
              className="icon-button image-picker-button"
              disabled={props.sessionId === undefined}
              onClick={() => fileInputRef.current?.click()}
              title="选择图片"
            ><ImagePlus size={15} /></button>
            <button
              className={classNames('icon-button', 'attachment-menu-button', showMedia && 'active')}
              disabled={props.sessionId === undefined}
              aria-expanded={showMedia}
              onClick={() => { setShowMedia((current) => !current); }}
              title="通过 URL 或路径添加媒体"
            ><ChevronDown size={14} /></button>
            {props.busy ? (
              <button className="icon-button cancel-button" onClick={() => void props.onCancel()} title="取消当前轮次"><Square size={14} /></button>
            ) : (
              <button className="send-button" onClick={() => void submit()} disabled={submitting || props.sessionId === undefined} title="发送"><Send size={16} /></button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function collectSuggestions(props: Pick<ComposerProps, 'skills' | 'pluginCommands' | 'commands'>): CommandSuggestion[] {
  const output: CommandSuggestion[] = [];
  for (const raw of props.commands) {
    const item = record(raw);
    const name = text(item['name']);
    if (name.length === 0) continue;
    output.push({ id: `command:${name}`, label: name, commandName: name, description: text(item['description'], 'Kimi 命令'), kind: 'command' });
  }
  for (const raw of props.skills) {
    const item = record(raw);
    const name = text(item['name']);
    if (name.length === 0) continue;
    output.push({ id: `skill:${name}`, label: name, commandName: name, description: text(item['description'], 'Skill'), kind: 'skill' });
  }
  for (const raw of props.pluginCommands) {
    const item = record(raw);
    const pluginId = text(item['pluginId'], text(item['plugin_id']));
    const commandName = text(item['name'], text(item['commandName']));
    if (pluginId.length === 0 || commandName.length === 0) continue;
    output.push({
      id: `plugin:${pluginId}:${commandName}`,
      label: `${pluginId}:${commandName}`,
      pluginId,
      commandName,
      description: text(item['description'], '插件命令'),
      kind: 'plugin',
    });
  }
  return output;
}

function initialEditorHeight(): number {
  try {
    return parseComposerHeight(window.localStorage.getItem(COMPOSER_HEIGHT_STORAGE_KEY), window.innerHeight);
  } catch {
    return parseComposerHeight(null, window.innerHeight);
  }
}

async function readImageAttachment(file: File): Promise<ComposerAttachment> {
  const validationError = imageFileError(file);
  if (validationError !== undefined) throw new MediaAttachmentError(validationError.code, validationError.message);
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error(`无法读取图片：${file.name}`));
    }, { once: true });
    reader.addEventListener('error', () => {
      reject(new Error(`无法读取图片：${file.name}`));
    }, { once: true });
    reader.readAsDataURL(file);
  });
  return { id: attachmentId(), type: 'image_url', url, label: file.name };
}

function attachmentProblem(reason: unknown): ComposerAttachmentError {
  if (reason instanceof MediaAttachmentError) return { code: reason.code, message: reason.message };
  if (reason instanceof Error) return { code: 'media.read_failed', message: reason.message };
  return { code: 'media.read_failed', message: String(reason) };
}

class MediaAttachmentError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'MediaAttachmentError';
  }
}

function attachmentId(): string {
  return globalThis.crypto.randomUUID();
}
