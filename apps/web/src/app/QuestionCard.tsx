import * as React from 'react';
import { Check, X } from 'lucide-react';
import { Spinner } from '../components/ui/spinner';
import { cn } from '../lib/utils';

/**
 * A question an agent asked the user, as Paseo's question card (components/question-form-card.tsx)
 * shows ALP's questions: surface 1 with a border, the question, its options as radio rows, a
 * field for any other answer, then Dismiss and Submit. Picking an option and typing another
 * answer replace each other; Submit sends whichever is there, Enter in the field too.
 */
export function QuestionCard({ question, onAnswer, onDecline, busy, blocked }: {
  question: { id: string; agent: string; body: string; options?: string[]; askedAt: string };
  onAnswer: (text: string) => void;
  onDecline: () => void;
  busy: boolean;
  blocked?: string;
}) {
  const [selected, setSelected] = React.useState<number | null>(null);
  const [text, setText] = React.useState('');
  const [action, setAction] = React.useState<'submit' | 'dismiss' | null>(null);
  React.useEffect(() => { if (!busy) setAction(null); }, [busy]);
  const disabled = busy || !!blocked;
  const inputId = React.useId();
  const options = question.options ?? [];
  const answer = text.trim() || (selected != null ? options[selected] : '');
  const submit = () => { if (answer && !disabled) { setAction('submit'); onAnswer(answer); } };
  const dismiss = () => { if (!disabled) { setAction('dismiss'); onDecline(); } };
  // ALP's main asks most questions; the card names any other agent that asks.
  const asker = question.agent && question.agent !== 'main' ? question.agent : null;
  return (
    <section aria-label={`Question from ${question.agent}`} className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3" data-testid="question">
      <div className="flex flex-col gap-1 px-3 pt-1">
        {asker ? <p className="text-[13px] text-muted-foreground">{asker} asks</p> : null}
        <p className="whitespace-pre-wrap text-[15px] leading-[22px] text-foreground [overflow-wrap:anywhere]" data-testid="question-text">{question.body}</p>
      </div>
      <div className="flex flex-col gap-1">
        {options.length ? (
          <div className="flex flex-col gap-1" role="radiogroup" aria-label={question.body}
            onKeyDown={event => {
              // The radio group pattern: arrows move the choice, one stop in the tab order.
              if (!['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft'].includes(event.key)) return;
              event.preventDefault();
              const step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1;
              const next = ((selected ?? (step > 0 ? -1 : 0)) + step + options.length) % options.length;
              setSelected(next);
              setText('');
              (event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next])?.focus();
            }}>
            {options.map((option, index) => {
              const checked = selected === index;
              return (
                <button key={`${index}:${option}`} type="button" role="radio" aria-checked={checked} disabled={disabled}
                  tabIndex={checked || (selected == null && index === 0) ? 0 : -1}
                  onClick={() => { setSelected(checked ? null : index); setText(''); }}
                  className={cn('flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-[15px] leading-[22px] outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring active:opacity-90 disabled:pointer-events-none disabled:opacity-50',
                    checked ? 'bg-muted text-foreground' : 'text-muted-foreground')}>
                  <span aria-hidden className={cn('flex size-[18px] shrink-0 items-center justify-center rounded-full border', checked ? 'border-primary' : 'border-input')}>
                    {checked ? <span className="size-2.5 rounded-full bg-primary" /> : null}
                  </span>
                  <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{option}</span>
                </button>
              );
            })}
          </div>
        ) : null}
        <label htmlFor={inputId} className="sr-only">{options.length ? 'Other answer' : 'Your answer'}</label>
        <input id={inputId} value={text} disabled={disabled} autoComplete="off"
          onChange={event => { setText(event.target.value); if (event.target.value) setSelected(null); }}
          onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }}
          placeholder={options.length ? 'Other...' : 'Type your answer...'}
          className="w-full rounded-lg border border-transparent bg-muted p-3 text-[15px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-input disabled:cursor-not-allowed disabled:opacity-50" />
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <button type="button" disabled={disabled} onClick={dismiss}
          className="flex min-h-9 items-center justify-center gap-2 rounded-md border border-input bg-card px-3 py-2 text-sm text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50">
          {action === 'dismiss' && busy ? <Spinner label="" /> : <><X aria-hidden className="size-3.5" />Dismiss</>}
        </button>
        <button type="button" disabled={disabled || !answer} onClick={submit}
          className={cn('flex min-h-9 items-center justify-center gap-2 rounded-md border border-primary bg-primary px-3 py-2 text-sm text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring active:opacity-90',
            (disabled || !answer) && 'pointer-events-none opacity-50')}>
          {action === 'submit' && busy ? <Spinner label="" className="text-primary-foreground" /> : <><Check aria-hidden className="size-3.5" />Submit</>}
        </button>
      </div>
      {blocked ? <p className="px-1 text-xs text-muted-foreground">{blocked}</p> : null}
    </section>
  );
}
