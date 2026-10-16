import * as React from 'react';
import { Check, X } from 'lucide-react';
import { relativeTime } from '../lib/format';
import { cn } from '../lib/utils';

/**
 * A question an agent asked the user, as Paseo's question card: surface 1 with a border, the
 * question, its options as rows (one click answers), a free answer, then Decline and Submit.
 */
export function QuestionCard({ question, onAnswer, onDecline, busy, blocked }: {
  question: { id: string; agent: string; body: string; options?: string[]; askedAt: string };
  onAnswer: (text: string) => void;
  onDecline: () => void;
  busy: boolean;
  blocked?: string;
}) {
  const [text, setText] = React.useState('');
  const disabled = busy || !!blocked;
  const inputId = React.useId();
  const submit = () => { if (text.trim() && !disabled) onAnswer(text.trim()); };
  return (
    <section aria-label={`Question from ${question.agent}`} className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3" data-testid="question">
      <div className="flex flex-col gap-1 px-3 pb-1">
        <p className="text-[13px] text-muted-foreground">
          <span className="text-foreground/90">{question.agent}</span> asks you <span>· {relativeTime(question.askedAt)}</span>
        </p>
        <p className="whitespace-pre-wrap text-sm leading-[22px] text-foreground [overflow-wrap:anywhere]">{question.body}</p>
      </div>
      {question.options?.length ? (
        <div className="flex flex-col gap-1" role="group" aria-label="Answers">
          {question.options.map(option => (
            <button key={option} type="button" disabled={disabled} onClick={() => onAnswer(option)}
              className="flex w-full items-start gap-2 rounded-md px-3 py-2 text-left text-sm leading-[22px] text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring active:opacity-90 disabled:pointer-events-none disabled:opacity-50">
              <span aria-hidden className="mt-0.5 size-[18px] shrink-0 rounded-full border border-input" />
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{option}</span>
            </button>
          ))}
        </div>
      ) : null}
      <form className="contents" onSubmit={event => { event.preventDefault(); submit(); }}>
        <label htmlFor={inputId} className="sr-only">Your answer</label>
        <input id={inputId} value={text} onChange={event => setText(event.target.value)} disabled={disabled}
          placeholder={question.options?.length ? 'Other answer…' : 'Type your answer…'} autoComplete="off"
          className="w-full rounded-lg border border-input bg-transparent p-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-muted-foreground/50 disabled:cursor-not-allowed disabled:opacity-50" />
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <button type="button" disabled={disabled} onClick={onDecline}
            className="flex items-center justify-center gap-2 rounded-md border border-input bg-card px-3 py-2 text-sm text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50">
            <X aria-hidden className="size-3.5" />Decline
          </button>
          <button type="submit" disabled={disabled || !text.trim()}
            className={cn('flex items-center justify-center gap-2 rounded-md border border-primary bg-primary px-3 py-2 text-sm text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring active:opacity-90',
              (disabled || !text.trim()) && 'pointer-events-none opacity-50')}>
            <Check aria-hidden className="size-3.5" />Submit
          </button>
        </div>
      </form>
      {blocked ? <p className="px-1 text-xs text-muted-foreground">{blocked}</p> : null}
    </section>
  );
}
