import { Bot, ChevronDown, Database, Gauge, Pencil, Shield, Sparkles } from 'lucide-react';

import type { SessionStatusSnapshot } from '../shared/desktop-api';
import {
  cacheMetrics,
  contextPercentage,
  contextProgress,
  formatTokenCount,
  type ImageInputSupport,
} from './composer-utils';
import { classNames } from './ui-utils';

export interface SessionModelOption {
  readonly id: string;
  readonly label: string;
  readonly imageInput?: ImageInputSupport;
}

export function ModelSelect({ value, models, disabled, onChange, title = '模型' }: {
  readonly value?: string;
  readonly models: readonly SessionModelOption[];
  readonly disabled?: boolean;
  readonly onChange: (model: string) => void;
  readonly title?: string;
}) {
  return (
    <label className="select-control model-control" title={title}>
      <Bot size={13} />
      <select
        aria-label={title}
        value={value ?? ''}
        disabled={disabled}
        onChange={(event) => { onChange(event.target.value); }}
      >
        {value !== undefined && !models.some((model) => model.id === value) && (
          <option value={value}>{value}</option>
        )}
        {models.length === 0 && <option value="">未配置模型</option>}
        {models.map((model) => <option value={model.id} key={model.id}>{model.label}</option>)}
      </select>
      <ChevronDown size={12} />
    </label>
  );
}

interface SessionControlsProps {
  readonly sessionId?: string;
  readonly status?: SessionStatusSnapshot;
  readonly models: readonly SessionModelOption[];
  readonly placement: 'topbar' | 'composer';
  readonly disabled?: boolean;
  readonly modelDisabled?: boolean;
  readonly modelTitle?: string;
  readonly modelValue?: string;
  readonly planModePending: boolean;
  readonly onSetModel?: (model: string) => void | Promise<void>;
  readonly onSetThinking?: (effort: string) => void | Promise<void>;
  readonly onSetPermission?: (permission: 'manual' | 'auto' | 'yolo') => void | Promise<void>;
  readonly onSetPlanMode: (enabled: boolean) => Promise<void>;
}

export function SessionControls({
  sessionId,
  status,
  models,
  placement,
  disabled: disabledProp,
  modelDisabled,
  modelTitle,
  modelValue,
  planModePending,
  onSetModel,
  onSetThinking,
  onSetPermission,
  onSetPlanMode,
}: SessionControlsProps) {
  const disabled = disabledProp === true || sessionId === undefined;
  return (
    <div className={classNames('session-controls', placement === 'composer' && 'composer-session-controls')} data-placement={placement}>
      <ModelSelect
        value={modelValue ?? status?.model}
        models={models}
        disabled={disabled || modelDisabled === true}
        title={modelTitle}
        onChange={(model) => {
          if (onSetModel === undefined) void window.kimiDesktop.turn.setModel(model, sessionId);
          else void onSetModel(model);
        }}
      />
      <label className="select-control" title="Thinking">
        <Sparkles size={13} />
        <select
          aria-label="Thinking"
          value={status?.thinkingEffort ?? 'off'}
          disabled={disabled}
          onChange={(event) => {
            const effort = event.target.value;
            if (onSetThinking === undefined) void window.kimiDesktop.turn.setThinking(effort, sessionId);
            else void onSetThinking(effort);
          }}
        >
          {['off', 'low', 'medium', 'high', 'max'].map((effort) => <option value={effort} key={effort}>{effort}</option>)}
        </select>
        <ChevronDown size={12} />
      </label>
      <label className="select-control" title="权限">
        <Shield size={13} />
        <select
          aria-label="权限"
          value={status?.permission ?? 'manual'}
          disabled={disabled}
          onChange={(event) => {
            const permission = event.target.value as 'manual' | 'auto' | 'yolo';
            if (onSetPermission === undefined) void window.kimiDesktop.turn.setPermission(permission, sessionId);
            else void onSetPermission(permission);
          }}
        >
          <option value="manual">Manual</option>
          <option value="auto">Auto</option>
          <option value="yolo">YOLO</option>
        </select>
        <ChevronDown size={12} />
      </label>
      <button
        className={classNames('mode-toggle', status?.planMode && 'active')}
        disabled={disabled || planModePending}
        aria-pressed={status?.planMode === true}
        title="Plan 模式"
        onClick={() => void onSetPlanMode(status?.planMode !== true)}
      ><Pencil size={13} /><span>Plan</span></button>
    </div>
  );
}

export function ComposerUsageIndicators({ status }: { readonly status?: SessionStatusSnapshot }) {
  const contextPercent = status === undefined ? undefined : contextPercentage(status.contextUsage);
  const contextBar = status === undefined ? 0 : contextProgress(status.contextUsage);
  const cache = cacheMetrics(status?.usage);
  const contextTitle = status === undefined
    ? '尚未选择会话'
    : `上下文 ${formatTokenCount(status.contextTokens)} / ${formatTokenCount(status.maxContextTokens)} tokens (${String(contextPercent)}%)`;
  const cacheTitle = cache === undefined
    ? '会话尚无用量数据'
    : `会话累计 · 普通输入 ${formatTokenCount(cache.inputOther)} · 缓存读取 ${formatTokenCount(cache.cacheRead)} · 缓存写入 ${formatTokenCount(cache.cacheCreation)} · 输入总量 ${formatTokenCount(cache.inputTotal)}`;

  return (
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
  );
}
