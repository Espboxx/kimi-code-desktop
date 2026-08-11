import { useState } from 'react';
import { AlertCircle, Check, X } from 'lucide-react';
import type { TranscriptInteraction } from '@moonshot-ai/transcript';

import { array, record, text } from './ui-utils';
import { QuestionForm, type QuestionFormItem } from './QuestionForm';

interface InteractionPanelProps {
  readonly interaction: TranscriptInteraction;
  readonly sessionId: string;
}

export function InteractionPanel({ interaction, sessionId }: InteractionPanelProps) {
  if (interaction.state !== 'pending') {
    return (
      <div className={`interaction-resolved interaction-${interaction.state}`}>
        {interaction.state === 'approved' || interaction.state === 'answered' ? <Check size={14} /> : <X size={14} />}
        {interactionLabel(interaction.state)}
      </div>
    );
  }
  return interaction.interactionKind === 'approval'
    ? <ApprovalPanel interaction={interaction} sessionId={sessionId} />
    : <QuestionPanel interaction={interaction} sessionId={sessionId} />;
}

function ApprovalPanel({ interaction, sessionId }: InteractionPanelProps) {
  const request = record(interaction.request);
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const resolve = async (decision: 'approved' | 'rejected' | 'cancelled', scope?: 'session') => {
    setBusy(true);
    try {
      await window.kimiDesktop.interaction.resolve(sessionId, interaction.interactionId, {
        decision,
        scope,
        feedback: feedback.trim() || undefined,
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="interaction-panel approval-panel">
      <div className="interaction-heading"><AlertCircle size={15} /><strong>需要批准</strong></div>
      <p>{text(request['action'], text(request['toolName'], '工具操作'))}</p>
      <input value={feedback} onChange={(event) => { setFeedback(event.target.value); }} placeholder="可选反馈" disabled={busy} />
      <div className="interaction-actions">
        <button className="button-primary" onClick={() => void resolve('approved')} disabled={busy}>允许</button>
        <button onClick={() => void resolve('approved', 'session')} disabled={busy}>本会话允许</button>
        <button onClick={() => void resolve('rejected')} disabled={busy}>拒绝</button>
      </div>
    </div>
  );
}

function QuestionPanel({ interaction, sessionId }: InteractionPanelProps) {
  const request = record(interaction.request);
  const questions = array(request['questions']).map((raw, index): QuestionFormItem => {
    const question = record(raw);
    return {
      question: text(question['question'], `问题 ${String(index + 1)}`),
      header: text(question['header']) || undefined,
      body: text(question['body']) || undefined,
      options: array(question['options']).map((rawOption, optionIndex) => {
        const option = record(rawOption);
        return {
          label: text(option['label'], `选项 ${String(optionIndex + 1)}`),
          description: text(option['description']) || undefined,
        };
      }),
      multiSelect: question['multiSelect'] === true,
    };
  });
  return (
    <QuestionForm
      questions={questions}
      heading="Kimi 有问题"
      onSubmit={(answers) => window.kimiDesktop.interaction.resolve(
        sessionId,
        interaction.interactionId,
        { answers, method: 'enter' },
      )}
      onSkip={() => window.kimiDesktop.interaction.resolve(sessionId, interaction.interactionId, null)}
    />
  );
}

function interactionLabel(state: TranscriptInteraction['state']): string {
  switch (state) {
    case 'approved': return '已批准';
    case 'rejected': return '已拒绝';
    case 'cancelled': return '已取消';
    case 'answered': return '已回答';
    case 'dismissed': return '已跳过';
    case 'pending': return '等待处理';
  }
}
