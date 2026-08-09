import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, Eye, MessageCircleQuestion, ShieldAlert, Users } from 'lucide-react';
import type { TranscriptStore } from '@moonshot-ai/transcript';

import { InteractionPanel } from './InteractionPanel';
import { collectPendingAgentInteractions } from './swarm-ui';
import { classNames } from './ui-utils';

interface PendingInteractionDockProps {
  readonly store?: TranscriptStore;
  readonly sessionId?: string;
  readonly selectedAgentId: string;
  readonly version: number;
  readonly onSelectAgent: (agentId: string) => void;
}

export function PendingInteractionDock(props: PendingInteractionDockProps) {
  const pending = useMemo(
    () => collectPendingAgentInteractions(props.store, props.selectedAgentId),
    [props.store, props.selectedAgentId, props.version],
  );
  const pendingSignature = pending.map((item) => item.key).join('\n');
  const [expandedKey, setExpandedKey] = useState<string>();

  useEffect(() => {
    setExpandedKey((current) => pending.some((item) => item.key === current) ? current : pending[0]?.key);
  }, [pendingSignature]);

  const sessionId = props.sessionId;
  if (sessionId === undefined || pending.length === 0) return null;

  return (
    <section className="pending-interaction-dock" aria-label="子 Agent 待处理交互">
      <header className="pending-interaction-header" aria-live="polite">
        <Users size={14} />
        <strong>子 Agent 等待处理</strong>
        <span>{pending.length}</span>
      </header>
      <div className="pending-interaction-list">
        {pending.map((item) => {
          const expanded = item.key === expandedKey;
          return (
            <article className={classNames('pending-interaction-item', expanded && 'expanded')} key={item.key}>
              <div className="pending-interaction-summary">
                <button
                  className="pending-interaction-toggle"
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={`pending-interaction-${item.key}`}
                  onClick={() => { setExpandedKey(expanded ? undefined : item.key); }}
                >
                  {item.interaction.interactionKind === 'approval' ? <ShieldAlert size={14} /> : <MessageCircleQuestion size={14} />}
                  <span className="pending-agent-label">{item.agent.label ?? item.agent.agentId}</span>
                  <span className="pending-interaction-kind">{item.interaction.interactionKind === 'approval' ? '权限审批' : '问题'}</span>
                  <span className="pending-interaction-text">{item.summary}</span>
                  <ChevronDown className="pending-interaction-chevron" size={14} />
                </button>
                <button className="icon-button" type="button" onClick={() => { props.onSelectAgent(item.agent.agentId); }} title={`查看 ${item.agent.label ?? item.agent.agentId}`}>
                  <Eye size={14} />
                </button>
              </div>
              <div id={`pending-interaction-${item.key}`} className="pending-interaction-body" hidden={!expanded}>
                <InteractionPanel interaction={item.interaction} sessionId={sessionId} />
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
