import * as React from 'react';
import { MessageCircleQuestion } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { relativeTime } from '../lib/format';

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
  return (
    <section aria-label={`Question from ${question.agent}`} className="rounded-xl border border-warning/40 bg-warning/[0.06] p-3.5" data-testid="question">
      <p className="mb-1 flex items-center gap-2 text-xs font-medium text-warning">
        <MessageCircleQuestion aria-hidden className="size-4" />
        {question.agent} asks you <span className="font-normal text-muted-foreground">{relativeTime(question.askedAt)}</span>
      </p>
      <p className="mb-3 whitespace-pre-wrap text-[14px] text-foreground">{question.body}</p>
      {question.options?.length ? (
        <div className="mb-3 flex flex-wrap gap-2">
          {question.options.map(option => <Button key={option} size="sm" variant="secondary" disabled={disabled} onClick={() => onAnswer(option)}>{option}</Button>)}
        </div>
      ) : null}
      <form className="flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); if (text.trim()) onAnswer(text.trim()); }}>
        <label htmlFor={inputId} className="sr-only">Your answer</label>
        <Input id={inputId} value={text} onChange={event => setText(event.target.value)} placeholder="Type an answer…" disabled={disabled} className="h-8 min-w-40 flex-1" />
        <Button type="submit" size="sm" disabled={disabled || !text.trim()}>Answer</Button>
        <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={onDecline}>Decline</Button>
      </form>
      {blocked ? <p className="mt-2 text-xs text-muted-foreground">{blocked}</p> : null}
    </section>
  );
}
