import { useState } from 'react';
import { CircleAlert } from 'lucide-react';

import { classNames } from './ui-utils';

export interface QuestionFormItem {
  readonly question: string;
  readonly header?: string;
  readonly body?: string;
  readonly options: readonly {
    readonly label: string;
    readonly description?: string;
  }[];
  readonly multiSelect?: boolean;
}

export function QuestionForm({
  questions,
  heading,
  disabled = false,
  className,
  onSubmit,
  onSkip,
}: {
  readonly questions: readonly QuestionFormItem[];
  readonly heading: string;
  readonly disabled?: boolean;
  readonly className?: string;
  readonly onSubmit: (answers: Readonly<Record<string, string | true>>) => Promise<void>;
  readonly onSkip: () => Promise<void>;
}) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
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
  const run = async (operation: () => Promise<void>) => {
    if (busy || disabled) return;
    setBusy(true);
    setError(undefined);
    try {
      await operation();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const complete = questions.every((question) => (answers[question.question]?.length ?? 0) > 0);
  const submit = () => run(async () => {
    const flattened = Object.fromEntries(
      Object.entries(answers).map(([question, values]) => [question, values.join(', ')]),
    );
    await onSubmit(flattened);
  });
  return (
    <div className={classNames('interaction-panel', 'question-panel', className)}>
      <div className="interaction-heading"><strong>{heading}</strong></div>
      {questions.map((question, index) => {
        const label = question.question || `问题 ${String(index + 1)}`;
        const header = question.header?.trim();
        const multi = question.multiSelect === true;
        return (
          <fieldset key={`${label}-${String(index)}`} disabled={busy || disabled}>
            <legend>{header === undefined || header.length === 0 ? label : header}</legend>
            {header !== undefined && header.length > 0 && <p>{label}</p>}
            {question.body?.trim() && <p>{question.body}</p>}
            <div className="question-options">
              {question.options.map((option, optionIndex) => {
                const optionLabel = option.label || `选项 ${String(optionIndex + 1)}`;
                const selected = answers[label]?.includes(optionLabel) === true;
                return (
                  <button
                    type="button"
                    className={classNames('question-option', selected && 'selected')}
                    onClick={() => { toggle(label, optionLabel, multi); }}
                    disabled={busy || disabled}
                    key={`${optionLabel}-${String(optionIndex)}`}
                  >
                    <span>{optionLabel}</span>
                    {option.description?.trim() && <small>{option.description}</small>}
                  </button>
                );
              })}
            </div>
          </fieldset>
        );
      })}
      {error !== undefined && <div className="question-form-error"><CircleAlert size={13} /><span>{error}</span></div>}
      <div className="interaction-actions">
        <button className="button-primary" onClick={() => void submit()} disabled={busy || disabled || !complete}>提交</button>
        <button onClick={() => void run(onSkip)} disabled={busy || disabled}>跳过</button>
      </div>
    </div>
  );
}
