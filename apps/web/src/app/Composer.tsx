import * as React from 'react';
import { ArrowUp, Pencil, Square } from 'lucide-react';
import type { QueuedPrompt } from '../lib/controller.js';
import { cn } from '../lib/utils';

/**
 * The message box, with Paseo's composer logic and layout: one rounded surface with the text on
 * top and a row of controls below (agent controls on the left, the primary action on the right).
 *
 * - Enter sends. While the agent works it sends and steers: the message joins the running turn
 *   (or queues, when the Sending setting says so).
 * - Cmd/Ctrl+Enter while the agent works does the other one. Queued messages wait above
 *   the box, each with Edit (back into the box) and Send now; the queue sends itself, one at a
 *   time, once the agent is idle.
 * - The primary action is Send when there is text, Interrupt while the agent works with an empty
 *   box, and nothing otherwise. Shift+Enter is a new line.
 *
 * A box that cannot take a message keeps its shape with a dotted border.
 */
export function Composer({ onSend, onQueue, onStop, queued, onEditQueued, onSendQueued, running, stopping, blocked, disabledReason, placeholder, controls, sendBehavior = 'steer' }: {
  onSend: (text: string) => Promise<unknown>;
  onQueue: (text: string) => void;
  onStop: () => void;
  queued: QueuedPrompt[];
  onEditQueued: (id: string) => string | null;
  onSendQueued: (id: string) => void;
  running: boolean;
  stopping: boolean;
  blocked?: string;
  disabledReason?: string;
  placeholder: string;
  controls?: React.ReactNode;
  /** What Enter does while the agent works; Cmd/Ctrl+Enter does the other. */
  sendBehavior?: 'steer' | 'queue';
}) {
  const [text, setText] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const area = React.useRef<HTMLTextAreaElement>(null);
  const reason = blocked ?? disabledReason;
  const hasText = !!text.trim();
  const queues = running && sendBehavior === 'queue';
  React.useLayoutEffect(() => {
    const element = area.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 280)}px`;
  }, [text]);

  const send = async () => {
    const body = text.trim();
    if (!body || reason) return;
    setText('');
    setError(null);
    try { await onSend(body); } catch (failure) { setText(body); setError(failure instanceof Error ? failure.message : String(failure)); }
  };
  const queue = () => {
    const body = text.trim();
    if (!body || reason) return;
    try { onQueue(body); setText(''); setError(null); } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  };
  const edit = (id: string) => {
    const body = onEditQueued(id);
    if (body == null) return;
    setText(current => current.trim() ? `${current}\n${body}` : body);
    area.current?.focus();
  };

  const round = 'inline-flex size-7 shrink-0 items-center justify-center rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4';
  return (
    <div className="px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2 sm:px-4 sm:pb-4">
      <div className="mx-auto w-full max-w-[820px]">
        {queued.length ? (
          <ul aria-label="Queued messages" className="mb-2 space-y-1.5">
            {queued.map(item => (
              <li key={item.id} data-testid="queued-message" className="flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2">
                <span className="line-clamp-2 min-w-0 flex-1 whitespace-pre-wrap text-sm text-foreground/90 [overflow-wrap:anywhere]">{item.text}</span>
                <button type="button" aria-label="Edit queued message" title="Edit" onClick={() => edit(item.id)}
                  className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                  <Pencil aria-hidden className="size-3.5" />
                </button>
                <button type="button" aria-label="Send queued message now" title="Send now" disabled={!!reason} onClick={() => onSendQueued(item.id)}
                  className={cn(round, 'bg-primary text-primary-foreground hover:bg-primary/85 [&_svg]:size-3.5')}>
                  <ArrowUp aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {blocked ? <p className="mb-2 px-1 text-xs text-warning" role="note">{blocked}</p> : null}
        {error ? <p className="mb-2 px-1 text-xs text-destructive" role="alert">{error}</p> : null}
        <div className={cn('flex flex-col gap-3 rounded-2xl border border-input bg-card px-3 pb-2 pt-2 transition-colors focus-within:border-[#3d4544] md:px-4 md:pb-3 md:pt-4', reason && 'border-dotted')}>
          <label htmlFor="composer" className="sr-only">Message</label>
          <textarea
            id="composer"
            ref={area}
            rows={1}
            value={text}
            disabled={!!reason}
            placeholder={reason && !blocked ? reason : placeholder}
            onChange={event => setText(event.target.value)}
            onKeyDown={event => {
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              const alternate = event.metaKey || event.ctrlKey;
              if (running && (sendBehavior === 'queue') !== alternate) queue();
              else void send();
            }}
            className="max-h-[280px] min-h-6 w-full resize-none bg-transparent text-[15px] leading-[1.4] text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
          />
          <div className="-mx-1.5 flex min-h-7 items-end justify-between gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-1 text-xs text-muted-foreground">{controls}</div>
            <div className="flex shrink-0 items-center gap-1">
              {hasText ? (
                <button type="button" aria-label={!running ? 'Send' : queues ? 'Queue message' : 'Send and steer'}
                  title={!running ? 'Send' : queues ? 'Queue (⌘/Ctrl+Enter sends and steers)' : 'Send and steer (⌘/Ctrl+Enter queues)'}
                  onClick={() => queues ? queue() : void send()} disabled={!!reason}
                  className={cn(round, 'bg-primary text-primary-foreground hover:bg-primary/85')}>
                  <ArrowUp aria-hidden />
                </button>
              ) : running ? (
                <button type="button" aria-label="Interrupt agent" title="Interrupt agent" onClick={onStop} disabled={stopping || !!blocked}
                  className={cn(round, 'bg-stop text-white hover:bg-stop/85')}>
                  <Square aria-hidden className="!size-3 fill-current" />
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
