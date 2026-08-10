import { Bot, ChevronDown, Pencil, Shield, Sparkles } from 'lucide-react';

import type { SessionStatusSnapshot } from '../shared/desktop-api';
import { classNames } from './ui-utils';

export interface SessionModelOption {
  readonly id: string;
  readonly label: string;
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
  readonly planModePending: boolean;
  readonly onSetPlanMode: (enabled: boolean) => Promise<void>;
}

export function SessionControls({
  sessionId,
  status,
  models,
  placement,
  planModePending,
  onSetPlanMode,
}: SessionControlsProps) {
  const disabled = sessionId === undefined;
  return (
    <div className={classNames('session-controls', placement === 'composer' && 'composer-session-controls')} data-placement={placement}>
      <ModelSelect
        value={status?.model}
        models={models}
        disabled={disabled}
        onChange={(model) => { void window.kimiDesktop.turn.setModel(model, sessionId); }}
      />
      <label className="select-control" title="Thinking">
        <Sparkles size={13} />
        <select
          aria-label="Thinking"
          value={status?.thinkingEffort ?? 'off'}
          disabled={disabled}
          onChange={(event) => void window.kimiDesktop.turn.setThinking(event.target.value, sessionId)}
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
          onChange={(event) => void window.kimiDesktop.turn.setPermission(event.target.value as 'manual' | 'auto' | 'yolo', sessionId)}
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
