import { useState } from 'react';
import { AlertCircle, Check, X } from 'lucide-react';
import type { TranscriptInteraction } from '@moonshot-ai/transcript';

import { array, classNames, record, text } from './ui-utils';

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
  const questions = array(request['questions']);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const toggle = (question: string, label: string, multi: boolean) => {
    setAnswers((current) => {
      const selected = current[question] ?? [];
      if (!multi) return { ...current, [question]: [label] };
      return {
        ...current,
        [question]: selected.includes(label)
          ? selected.filter((value) => value !== label)
          : [...selected, label],
      };
    });
  };
  const submit = async () => {
    setBusy(true);
    try {
      const flattened = Object.fromEntries(Object.entries(answers).map(([question, values]) => [question, values.join(', ')]));
      await window.kimiDesktop.interaction.resolve(sessionId, interaction.interactionId, { answers: flattened, method: 'enter' });
    } finally {
      setBusy(false);
    }
  };
  const skip = async () => {
    setBusy(true);
    try {
      await window.kimiDesktop.interaction.resolve(sessionId, interaction.interactionId, null);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="interaction-panel question-panel">
      <div className="interaction-heading"><strong>Kimi 有问题</strong></div>
      {questions.map((raw, index) => {
        const question = record(raw);
        const label = text(question['question'], `问题 ${index + 1}`);
        const multi = question['multiSelect'] === true;
        return (
          <fieldset key={`${label}-${index}`}>
            <legend>{label}</legend>
            {text(question['body']).length > 0 && <p>{text(question['body'])}</p>}
            <div className="question-options">
              {array(question['options']).map((rawOption, optionIndex) => {
                const option = record(rawOption);
                const optionLabel = text(option['label'], `选项 ${optionIndex + 1}`);
                const selected = answers[label]?.includes(optionLabel) === true;
                return (
                  <button
                    type="button"
                    className={classNames('question-option', selected && 'selected')}
                    onClick={() => { toggle(label, optionLabel, multi); }}
                    key={optionLabel}
                  >
                    <span>{optionLabel}</span>
                    {text(option['description']).length > 0 && <small>{text(option['description'])}</small>}
                  </button>
                );
              })}
            </div>
          </fieldset>
        );
      })}
      <div className="interaction-actions">
        <button className="button-primary" onClick={() => void submit()} disabled={busy || Object.keys(answers).length < questions.length}>提交</button>
        <button onClick={() => void skip()} disabled={busy}>跳过</button>
      </div>
    </div>
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
