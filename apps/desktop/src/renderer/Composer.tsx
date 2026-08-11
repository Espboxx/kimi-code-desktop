import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AtSign,
  Bot,
  ChevronDown,
  ImagePlus,
  Send,
  Sparkles,
  Square,
  Video,
} from 'lucide-react';

import type { SessionStatusSnapshot } from '../shared/desktop-api';
import {
  attachmentProblem,
  COMPOSER_HEIGHT_STORAGE_KEY,
  COMPOSER_IMAGE_ACCEPT,
  readImageAttachment,
  type ComposerAttachmentError,
} from './composer-utils';
import {
  ComposerAttachmentList,
  ComposerErrorBanner,
  ComposerFrame,
  type ComposerAttachmentView,
} from './ComposerPrimitives';
import {
  ComposerUsageIndicators,
  SessionControls,
  type SessionModelOption,
} from './SessionControls';
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
  readonly planModePending: boolean;
  readonly onSetPlanMode: (enabled: boolean) => Promise<void>;
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const suggestions = useMemo(() => collectSuggestions(props), [props]);
  const visibleSuggestions = value.startsWith('/') && invocation === undefined
    ? suggestions.filter((item) => item.label.toLowerCase().includes(value.slice(1).split(/\s/)[0]?.toLowerCase() ?? '')).slice(0, 8)
    : [];

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

  const attachmentViews: ComposerAttachmentView[] = [
    ...(invocation === undefined ? [] : [{
      id: `invocation:${invocation.id}`,
      label: `/${invocation.label}`,
      icon: <Sparkles size={12} />,
    }]),
    ...media.map((item) => ({
      id: item.id,
      label: item.label,
      icon: item.type === 'image_url' ? <ImagePlus size={12} /> : <Video size={12} />,
    })),
  ];

  return (
    <ComposerFrame
      value={value}
      disabled={props.sessionId === undefined}
      placeholder={props.sessionId === undefined ? '先选择或创建会话' : invocation === undefined ? '交给 Kimi 一个任务…' : `/${invocation.label} 参数`}
      heightStorageKey={COMPOSER_HEIGHT_STORAGE_KEY}
      textareaRef={textareaRef}
      onChange={setValue}
      onSubmit={() => { void submit(); }}
      onEscape={() => {
        setInvocation(undefined);
        setValue('');
      }}
      onPasteImages={(files) => { void addImageFiles(files); }}
      above={(
        <>
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
          <ComposerErrorBanner error={attachmentError} onDismiss={() => { setAttachmentError(undefined); }} />
          <ComposerAttachmentList
            items={attachmentViews}
            onRemove={(id) => {
              if (id.startsWith('invocation:')) setInvocation(undefined);
              else setMedia((current) => current.filter((item) => item.id !== id));
            }}
          />
        </>
      )}
      status={(
        <>
          <SessionControls
            sessionId={props.sessionId}
            status={props.status}
            models={props.models}
            placement="composer"
            planModePending={props.planModePending}
            onSetPlanMode={props.onSetPlanMode}
          />
          <ComposerUsageIndicators status={props.status} />
        </>
      )}
      toolbarStart={(
        <div className="segmented composer-modes" aria-label="发送模式">
          <button className={mode === 'prompt' ? 'active' : ''} onClick={() => { setMode('prompt'); }} title="普通 Prompt"><Bot size={13} /><span>Prompt</span></button>
          <button className={mode === 'steer' ? 'active' : ''} onClick={() => { setMode('steer'); }} title="Steer 当前轮次"><Sparkles size={13} /><span>Steer</span></button>
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
        </>
      )}
    />
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

function attachmentId(): string {
  return globalThis.crypto.randomUUID();
}
