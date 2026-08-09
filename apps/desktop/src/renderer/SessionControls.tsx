import { Bot, ChevronDown, Pencil, Shield, Sparkles, Users } from 'lucide-react';

import type { SessionStatusSnapshot } from '../shared/desktop-api';
import { classNames } from './ui-utils';

export interface SessionModelOption {
  readonly id: string;
  readonly label: string;
}

interface SessionControlsProps {
  readonly sessionId?: string;
  readonly status?: SessionStatusSnapshot;
  readonly models: readonly SessionModelOption[];
  readonly placement: 'topbar' | 'composer';
  readonly swarmPermissionPending: boolean;
  readonly onEnterSwarm: (activate: () => Promise<void> | void) => Promise<boolean>;
}

export function SessionControls({
  sessionId,
  status,
  models,
  placement,
  swarmPermissionPending,
  onEnterSwarm,
}: SessionControlsProps) {
  const disabled = sessionId === undefined;
  const toggleSwarm = async () => {
    if (status?.swarmMode === true) {
      await window.kimiDesktop.turn.setSwarmMode(false, sessionId);
      return;
    }
    await onEnterSwarm(() => window.kimiDesktop.turn.setSwarmMode(true, sessionId));
  };
  return (
    <div className={classNames('session-controls', placement === 'composer' && 'composer-session-controls')} data-placement={placement}>
      <label className="select-control model-control" title="模型">
        <Bot size={13} />
        <select
          aria-label="模型"
          value={status?.model ?? ''}
          disabled={disabled}
          onChange={(event) => void window.kimiDesktop.turn.setModel(event.target.value, sessionId)}
        >
          {status?.model !== undefined && !models.some((model) => model.id === status.model) && <option value={status.model}>{status.model}</option>}
          {models.length === 0 && <option value="">未配置模型</option>}
          {models.map((model) => <option value={model.id} key={model.id}>{model.label}</option>)}
        </select>
        <ChevronDown size={12} />
      </label>
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
        disabled={disabled}
        aria-pressed={status?.planMode === true}
        title="Plan 模式"
        onClick={() => void window.kimiDesktop.turn.setPlanMode(status?.planMode !== true, sessionId)}
      ><Pencil size={13} /><span>Plan</span></button>
      <button
        className={classNames('mode-toggle', status?.swarmMode && 'active')}
        disabled={disabled || swarmPermissionPending}
        aria-pressed={status?.swarmMode === true}
        title="Session Swarm 模式"
        onClick={() => void toggleSwarm()}
      ><Users size={13} /><span>Swarm</span></button>
    </div>
  );
}
