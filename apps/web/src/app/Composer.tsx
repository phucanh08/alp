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
 * - Paseo's keys: Cmd/Ctrl+L focuses the box (a hint says so while it is empty and unfocused),
 *   Escape interrupts a working agent, Shift+Tab in the box cycles the permissions mode.
 * - "Working" includes a message of ours still on its way to its turn (controller.rootBusy).
 * - The track bar above the box holds pills for the pane's context (ALP's Tasks pill).
 *
 * A box that cannot take a message keeps its shape with a dotted border.
 */
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export function Composer({ onSend, onQueue, onStop, queued, onEditQueued, onSendQueued, running, stopping, blocked, disabledReason, placeholder, controls, tracks, onCycleMode, sendBehavior = 'steer', startLabel, startHold, initialText, addText, autoFocus }: {
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
  /** Paseo's track bar above the box: pills for the pane's context (ALP's tasks). */
  tracks?: React.ReactNode;
  /** Shift+Tab in the box: the next permissions mode, as Paseo's mode control. */
  onCycleMode?: () => void;
  /** What Enter does while the agent works; Cmd/Ctrl+Enter does the other. */
  sendBehavior?: 'steer' | 'queue';
  /**
   * The New session screen's composer: the primary action is always this (e.g. Start session)
   * and may go with an empty box (a session without a first message).
   */
  startLabel?: string;
  /** Why the start action waits for now (the box stays editable), e.g. while the preview checks. */
  startHold?: string;
  /** Text the box starts with (a first message a failed start left). */
  initialText?: string;
  /** Text put in the box while it is open, after what is there (a new `id` each time). */
  addText?: { id: number; text: string };
  autoFocus?: boolean;
}) {
  const [text, setText] = React.useState(initialText ?? '');
  React.useEffect(() => {
    if (addText) setText(current => current.trim() ? `${current.replace(/\s+$/, '')}\n\n${addText.text}` : addText.text);
  }, [addText]);
  const [error, setError] = React.useState<string | null>(null);
  const area = React.useRef<HTMLTextAreaElement>(null);
  const reason = blocked ?? disabledReason;
  const hasText = !!text.trim();
  const queues = running && sendBehavior === 'queue';
  const [focused, setFocused] = React.useState(false);

  // Paseo's composer keys outside the box: Cmd/Ctrl+L focuses it; Escape interrupts the agent
  // from the box or from nowhere in particular (not from another field, a menu or a dialog).
  const latest = React.useRef({ running, stopping, blocked, onStop });
  latest.current = { running, stopping, blocked, onStop };
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.key.toLowerCase() === 'l' && (isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) && !event.altKey && !event.shiftKey) {
        if (!area.current || area.current.disabled) return;
        event.preventDefault();
        area.current.focus();
        return;
      }
      if (event.key !== 'Escape') return;
      const { running: working, stopping: halting, blocked: refused, onStop: stop } = latest.current;
      const target = event.target;
      const fromBox = target === area.current;
      const fromNowhere = target === document.body || target === document.documentElement || target === null;
      if (!working || halting || refused || !(fromBox || fromNowhere)) return;
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      stop();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  React.useLayoutEffect(() => {
    const element = area.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 280)}px`;
  }, [text]);

  const send = async () => {
    const body = text.trim();
    if ((!body && !startLabel) || reason || (startLabel && startHold)) return;
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
    <div className="px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-4 md:pb-4">
      <div className="mx-auto flex w-full max-w-[820px] flex-col gap-3">
        {tracks ? <div className="-mb-1 flex min-w-0 flex-wrap items-center gap-2" data-testid="composer-tracks">{tracks}</div> : null}
        {queued.length ? (
          <ul aria-label="Queued messages" className="flex flex-col gap-2">
            {queued.map(item => (
              <li key={item.id} data-testid="queued-message" className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2">
                <span className="line-clamp-2 min-w-0 flex-1 whitespace-pre-wrap text-sm text-foreground [overflow-wrap:anywhere]">{item.text}</span>
                <span className="flex shrink-0 items-center gap-2">
                  <button type="button" aria-label="Edit queued message" title="Edit" onClick={() => edit(item.id)}
                    className="flex size-8 items-center justify-center rounded-full bg-muted text-foreground outline-none hover:bg-bubble focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5">
                    <Pencil aria-hidden />
                  </button>
                  <button type="button" aria-label="Send queued message now" title="Send now" disabled={!!reason} onClick={() => onSendQueued(item.id)}
                    className="flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground outline-none hover:bg-primary/85 focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-3.5">
                    <ArrowUp aria-hidden />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {blocked ? <p className="px-1 text-sm text-warning" role="note">{blocked}</p> : null}
        {error ? <p className="px-1 text-sm text-destructive" role="alert">{error}</p> : null}
        <div className={cn('relative flex flex-col gap-3 rounded-2xl border border-input bg-card px-3 py-2 transition-colors duration-200 focus-within:border-[var(--input-focus)] md:px-4 md:pb-3 md:pt-4', reason && 'border-dotted')}>
          {!focused && !text && !reason ? (
            <span aria-hidden className="pointer-events-none absolute right-4 top-3 hidden text-xs text-muted-foreground/80 [@media(pointer:fine)]:md:block" data-testid="composer-focus-hint">{isMac ? '⌘L' : 'Ctrl+L'} to focus</span>
          ) : null}
          <label htmlFor="composer" className="sr-only">Message</label>
          <textarea
            id="composer"
            ref={area}
            rows={1}
            value={text}
            disabled={!!reason}
            placeholder={reason && !blocked ? reason : placeholder}
            onChange={event => setText(event.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            autoFocus={autoFocus}
            aria-keyshortcuts={isMac ? 'Meta+L' : 'Control+L'}
            onKeyDown={event => {
              if (event.key === 'Tab' && event.shiftKey && onCycleMode && !event.nativeEvent.isComposing) {
                event.preventDefault();
                if (!event.repeat) onCycleMode();
                return;
              }
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              const alternate = event.metaKey || event.ctrlKey;
              if (running && (sendBehavior === 'queue') !== alternate) queue();
              else void send();
            }}
            className="max-h-[280px] min-h-[21px] w-full resize-none bg-transparent text-[15px] leading-[21px] text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
          />
          <div className="-mx-1.5 flex min-h-7 shrink-0 items-end justify-between">
            <div className="flex min-w-0 flex-1 items-end">{controls}</div>
            <div className="flex shrink-0 items-center gap-1">
              {startLabel ? (
                <button type="button" aria-label={startLabel} title={startHold ?? startLabel} onClick={() => void send()} disabled={!!reason || !!startHold}
                  className={cn(round, 'ml-1 bg-primary text-primary-foreground hover:bg-primary/85')} data-testid="composer-start">
                  <ArrowUp aria-hidden />
                </button>
              ) : hasText ? (
                <button type="button" aria-label={!running ? 'Send' : queues ? 'Queue message' : 'Send and steer'}
                  title={!running ? 'Send' : queues ? 'Queue (⌘/Ctrl+Enter sends and steers)' : 'Send and steer (⌘/Ctrl+Enter queues)'}
                  onClick={() => queues ? queue() : void send()} disabled={!!reason}
                  className={cn(round, 'ml-1 bg-primary text-primary-foreground hover:bg-primary/85')}>
                  <ArrowUp aria-hidden />
                </button>
              ) : running ? (
                <button type="button" aria-label="Interrupt agent" title="Interrupt agent" onClick={onStop} disabled={stopping || !!blocked}
                  className={cn(round, 'ml-1 bg-[#dc2626] text-white hover:bg-[#dc2626]/85')}>
                  <Square aria-hidden className="fill-current" />
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
