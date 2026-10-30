import * as React from 'react';
import { ArrowUp, FileText, Pencil, Plus, Square, X } from 'lucide-react';
import { IMAGE_TYPES, NO_FILES, fileSize, filesOf, fitFiles, fitImages, imageType, previewUrl, readFiles, readImages, type FileAttachment, type FileLimits, type ImageAttachment } from '../lib/attachments.js';
import type { QueuedPrompt } from '../lib/controller.js';
import { insertCommand, matchCommands, slashQuery } from '../lib/slash-commands.js';
import type { SessionCommand } from '@anhlp/alp-protocol';
import { cn } from '../lib/utils';
import { usePaneFocused } from './pane';

/**
 * The message box, with Paseo's composer logic and layout: one rounded surface with the text on
 * top and a row of controls below (agent controls on the left, the primary action on the right).
 *
 * - Enter sends. While the agent works it does the Default send setting: steer (the message joins
 *   the running turn), interrupt (the turn stops, then the message starts the next one) or queue.
 * - Cmd/Ctrl+Enter while the agent works does the alternate (queue; for queue, send and steer).
 *   With the Send shortcut set to Cmd/Ctrl+Enter, Enter is a new line and only Cmd/Ctrl+Enter
 *   sends, always the default (Paseo's resolveMessageInputEnterAction). Queued messages wait above
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
 *
 * - Images (t-7679.11): Paseo's + button (here it opens the image picker), a paste or a drop adds
 *   them; each shows a preview with Remove above the text. They go inline with the message, never
 *   as a path. Without `images` (the session's runtime takes none) there is no button, and a
 *   pasted or dropped image is refused with `imagesUnavailable`. A message with images is sent
 *   (or steered), never queued: a queued message is text.
 * - Files (#121 J): with `files` (the host stores them, the token may upload, the session's runtime
 *   reads them) the + button attaches any file, and a drop or paste of a file that is not an image
 *   the session takes adds it as a file: a chip each (name, size, Remove). The bytes stay here until
 *   the message is sent; the controller uploads them under the session first and shows their
 *   progress on the message. Without `files`, a file is refused with `filesUnavailable` before
 *   anything is sent. Like images, a message with files is sent, never queued.
 * - The context meter (t-7679.12): Paseo's ring before the primary action, when given `meter`.
 * - Slash commands (t-f628): with `commands`, a "/" at the start of the box lists every command and
 *   skill of the session, filtered as the name is typed; Up/Down move, Enter or Tab inserts `/<name> `,
 *   Escape closes the list. A click inserts too.
 */
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export function Composer({ meter, imageLimits, images: takesImages = false, imagesUnavailable, files: takesFiles = false, fileLimits, filesUnavailable, onSend, onQueue, onInterruptSend, onStop, queued, onEditQueued, onSendQueued, running, stopping, blocked, disabledReason, placeholder, controls, tracks, onCycleMode, sendBehavior = 'steer', sendShortcut = 'enter', startLabel, startHold, initialText, addText, autoFocus, inputId, commands: loadCommands }: {
  /** Paseo's context window meter, before the primary action (t-7679.12). */
  meter?: React.ReactNode;
  /** The session takes images: the + button, paste and drop add them. */
  images?: boolean;
  imageLimits?: { maxCount: number; maxBytes: number; maxTotalBytes: number };
  /** Why a pasted or dropped image cannot go (the runtime takes none). */
  imagesUnavailable?: string;
  /** Files other than the images the session takes may go (#121 J). */
  files?: boolean;
  fileLimits?: FileLimits;
  /** Why a picked, pasted or dropped file cannot go. */
  filesUnavailable?: string;
  onSend: (text: string, images: ImageAttachment[], files: FileAttachment[]) => Promise<unknown>;
  onQueue: (text: string) => void;
  /** Default send Interrupt: stop the running turn, then send this as the next one. */
  onInterruptSend?: (text: string) => void;
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
  /** What sending does while the agent works; Cmd/Ctrl+Enter does the alternate. */
  sendBehavior?: 'interrupt' | 'steer' | 'queue';
  /** Which key sends: Enter (Shift+Enter is a new line) or Cmd/Ctrl+Enter (Enter is a new line). */
  sendShortcut?: 'enter' | 'mod-enter';
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
  /** The box's id (one of its own by default: split panes can show two composers). */
  inputId?: string;
  /** The session's slash commands and skills, offered after "/" (t-f628). */
  commands?: () => Promise<SessionCommand[]>;
}) {
  const [text, setText] = React.useState(initialText ?? '');
  React.useEffect(() => {
    if (addText) setText(current => current.trim() ? `${current.replace(/\s+$/, '')}\n\n${addText.text}` : addText.text);
  }, [addText]);
  const [error, setError] = React.useState<string | null>(null);
  const [attached, setAttached] = React.useState<ImageAttachment[]>([]);
  const [attachedFiles, setAttachedFiles] = React.useState<FileAttachment[]>([]);
  const picker = React.useRef<HTMLInputElement>(null);
  const area = React.useRef<HTMLTextAreaElement>(null);
  const reason = blocked ?? disabledReason;
  const hasText = !!text.trim() || attached.length > 0 || attachedFiles.length > 0;
  // A message with images or files is sent and steered: only text queues or waits for a stop.
  const textOnly = !attached.length && !attachedFiles.length;
  const queues = running && sendBehavior === 'queue' && textOnly;
  const interrupts = running && sendBehavior === 'interrupt' && textOnly && !!onInterruptSend;
  // The attached images as of now, set together with the state: a read that ends after a send, a
  // Remove or another paste joins what is attached then, never an earlier copy.
  const attachedRef = React.useRef(attached);
  const limitsRef = React.useRef(imageLimits);
  limitsRef.current = imageLimits;
  const setImages = (next: ImageAttachment[]) => { attachedRef.current = next; setAttached(next); };
  const filesRef = React.useRef(attachedFiles);
  const fileLimitsRef = React.useRef(fileLimits ?? NO_FILES);
  fileLimitsRef.current = fileLimits ?? NO_FILES;
  const setFiles = (next: FileAttachment[]) => { filesRef.current = next; setAttachedFiles(next); };
  /**
   * Adds what was picked, pasted or dropped within the limits: an image the session takes inline,
   * any other file as a file when files may go; a file left out says why (the first reason).
   */
  const attach = async (picked: File[]) => {
    if (!picked.length || reason) return;
    const images: File[] = [];
    const others: File[] = [];
    let refused: string | null = null;
    for (const file of picked) {
      if (takesImages && (imageType(file) || (!takesFiles && file.type.startsWith('image/')))) images.push(file);
      else if (takesFiles) others.push(file);
      else refused ??= !takesImages && file.type.startsWith('image/') ? (imagesUnavailable ?? 'This session takes no images.') : (filesUnavailable ?? imagesUnavailable ?? 'This session takes no files.');
    }
    let failed: string | null = null;
    if (images.length) {
      const { added, error: unread } = await readImages(attachedRef.current, images, limitsRef.current);
      const { attachments, error: unfit } = fitImages(attachedRef.current, added, limitsRef.current);
      setImages(attachments);
      failed ??= unread ?? unfit;
    }
    if (others.length) {
      const { added, error: unread } = await readFiles(filesRef.current, others, fileLimitsRef.current);
      const { attachments, error: unfit } = fitFiles(filesRef.current, added, fileLimitsRef.current);
      setFiles(attachments);
      failed ??= unread ?? unfit;
    }
    setError(refused ?? failed);
  };
  const [focused, setFocused] = React.useState(false);

  // The "/" list: loaded each time the box starts a command, filtered as the name is typed.
  const [commandList, setCommandList] = React.useState<SessionCommand[]>([]);
  const [activeCommand, setActiveCommand] = React.useState(0);
  // Escape closes the list for the text it was pressed on; typing on opens it again.
  const [closedOn, setClosedOn] = React.useState<string | null>(null);
  const typingCommand = !!loadCommands && slashQuery(text) !== null;
  const loaderRef = React.useRef(loadCommands);
  loaderRef.current = loadCommands;
  React.useEffect(() => {
    if (!typingCommand || !loaderRef.current) return;
    let current = true;
    void loaderRef.current().then(list => { if (current) setCommandList(list); }, () => {});
    return () => { current = false; };
  }, [typingCommand]);
  const suggestions = typingCommand && closedOn !== text && !reason ? (matchCommands(commandList, text) ?? []) : [];
  const selected = suggestions.length ? Math.min(activeCommand, suggestions.length - 1) : 0;
  React.useEffect(() => { setActiveCommand(0); }, [text]);
  const choose = (command: SessionCommand) => {
    setText(insertCommand(command));
    area.current?.focus();
  };
  const listId = `${React.useId()}-commands`;

  // Paseo's composer keys outside the box: Cmd/Ctrl+L focuses it; Escape interrupts the agent
  // from the box or from nowhere in particular (not from another field, a menu or a dialog).
  // With split panes, only the focused pane's composer answers these keys.
  const paneFocused = usePaneFocused();
  const ownId = React.useId();
  const boxId = inputId ?? `composer-${ownId}`;
  const latest = React.useRef({ running, stopping, blocked, onStop, paneFocused });
  latest.current = { running, stopping, blocked, onStop, paneFocused };
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || !latest.current.paneFocused) return;
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
    const images = attachedRef.current;
    const files = filesRef.current;
    if ((!body && !images.length && !files.length && !startLabel) || reason || (startLabel && startHold)) return;
    const fitted = fitImages([], images, limitsRef.current);
    if (fitted.error) { setError(fitted.error); return; }
    if (files.length) {
      if (!takesFiles) { setError(filesUnavailable ?? 'This session takes no files.'); return; }
      const fit = fitFiles([], files, fileLimitsRef.current);
      if (fit.error) { setError(fit.error); return; }
    }
    setText('');
    setImages([]);
    setFiles([]);
    setError(null);
    try { await onSend(body, images, files); } catch (failure) {
      setText(body);
      setImages(fitImages(images, attachedRef.current, limitsRef.current).attachments);
      setFiles(fitFiles(files, filesRef.current, fileLimitsRef.current).attachments);
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  const queue = () => {
    const body = text.trim();
    if (attachedRef.current.length || filesRef.current.length) return void send();
    if (!body || reason) return;
    try { onQueue(body); setText(''); setError(null); } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  };
  const interruptSend = () => {
    const body = text.trim();
    if (attachedRef.current.length || filesRef.current.length || !onInterruptSend) return void send();
    if (!body || reason) return;
    try { onInterruptSend(body); setText(''); setError(null); } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  };
  /** The Default send setting, while the agent works; plain send when it is idle. */
  const defaultSend = () => !running ? void send() : sendBehavior === 'queue' ? queue() : sendBehavior === 'interrupt' ? interruptSend() : void send();
  /** Cmd/Ctrl+Enter while the agent works: queue, or for queue send and steer. */
  const alternateSend = () => sendBehavior === 'queue' ? void send() : queue();
  const modKey = isMac ? '⌘' : 'Ctrl';
  const sendLabel = !running ? 'Send' : queues ? 'Queue message' : interrupts ? 'Interrupt and send' : 'Send and steer';
  const sendTitle = !running || sendShortcut === 'mod-enter' ? sendLabel
    : `${sendLabel} (${modKey}+Enter ${sendBehavior === 'queue' ? 'sends and steers' : 'queues'})`;
  const edit = (id: string) => {
    const body = onEditQueued(id);
    if (body == null) return;
    setText(current => current.trim() ? `${current}\n${body}` : body);
    area.current?.focus();
  };

  const round = 'inline-flex size-7 shrink-0 items-center justify-center rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4';
  return (
    <div className="px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-4 md:pb-4">
      <div className="mx-auto flex w-full max-w-(--content-width) flex-col gap-3">
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
        <div className={cn('relative flex flex-col gap-3 rounded-2xl border border-input bg-card px-3 py-2 transition-colors duration-200 focus-within:border-[var(--input-focus)] md:px-4 md:pb-3 md:pt-4', reason && 'border-dotted')}
          data-testid="composer-box"
          onDragOver={event => { if (Array.from(event.dataTransfer?.types ?? []).includes('Files')) event.preventDefault(); }}
          onDrop={event => { const files = filesOf(event.dataTransfer); if (!files.length) return; event.preventDefault(); void attach(files); }}>
          {attached.length ? (
            <ul aria-label="Attached images" className="flex flex-wrap gap-2">
              {attached.map(image => (
                <li key={image.id} data-testid="composer-attachment" className="relative size-16 overflow-hidden rounded-lg border border-border bg-muted">
                  <img src={previewUrl(image)} alt={image.name} title={image.name} className="size-full object-cover" />
                  <button type="button" aria-label={`Remove ${image.name}`} title="Remove" onClick={() => setImages(attachedRef.current.filter(entry => entry.id !== image.id))}
                    className="absolute right-0.5 top-0.5 flex size-5 items-center justify-center rounded-full bg-background/90 text-foreground outline-none hover:bg-background focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3">
                    <X aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {attachedFiles.length ? (
            <ul aria-label="Attached files" className="flex flex-wrap gap-2">
              {attachedFiles.map(file => (
                <li key={file.id} data-testid="composer-file" className="flex h-9 max-w-[16rem] items-center gap-2 rounded-lg border border-border bg-muted pl-2 pr-1 text-[length:calc(13px*var(--ui-scale))] text-foreground">
                  <FileText aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 truncate" title={file.name}>{file.name}</span>
                  <span className="shrink-0 text-muted-foreground">{fileSize(file.size)}</span>
                  <button type="button" aria-label={`Remove ${file.name}`} title="Remove" onClick={() => setFiles(filesRef.current.filter(entry => entry.id !== file.id))}
                    className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3">
                    <X aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {!focused && !text && !reason ? (
            <span aria-hidden className="pointer-events-none absolute right-4 top-3 hidden text-xs text-muted-foreground/80 [@media(pointer:fine)]:md:block" data-testid="composer-focus-hint">{isMac ? '⌘L' : 'Ctrl+L'} to focus</span>
          ) : null}
          {suggestions.length ? (
            <ul id={listId} role="listbox" aria-label="Commands and skills" data-testid="composer-commands"
              className="absolute inset-x-0 bottom-full z-20 mb-2 max-h-72 overflow-y-auto rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-lg">
              {suggestions.map((command, index) => (
                <li key={command.name} id={`${listId}-${index}`} role="option" aria-selected={index === selected} data-testid="composer-command"
                  onMouseDown={event => { event.preventDefault(); choose(command); }}
                  onMouseEnter={() => setActiveCommand(index)}
                  className={cn('flex cursor-pointer items-baseline gap-2 rounded-lg px-2 py-1.5 text-sm', index === selected && 'bg-muted')}>
                  <span className="shrink-0 font-medium text-foreground">/{command.name}</span>
                  {command.argumentHint ? <span className="shrink-0 text-xs text-muted-foreground">{command.argumentHint}</span> : null}
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={command.description}>{command.description}</span>
                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground/80">{command.kind === 'skill' ? 'skill' : 'command'}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <label htmlFor={boxId} className="sr-only">Message</label>
          <textarea
            id={boxId}
            ref={area}
            rows={1}
            value={text}
            disabled={!!reason}
            placeholder={reason && !blocked ? reason : placeholder}
            onChange={event => setText(event.target.value)}
            onPaste={event => {
              const files = filesOf(event.clipboardData).filter(file => takesFiles || file.type.startsWith('image/'));
              if (!files.length) return;
              event.preventDefault();
              void attach(files);
            }}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            autoFocus={autoFocus}
            aria-keyshortcuts={isMac ? 'Meta+L' : 'Control+L'}
            role={loadCommands ? 'combobox' : undefined}
            aria-expanded={loadCommands ? suggestions.length > 0 : undefined}
            aria-controls={suggestions.length ? listId : undefined}
            aria-autocomplete={loadCommands ? 'list' : undefined}
            aria-activedescendant={suggestions.length ? `${listId}-${selected}` : undefined}
            onKeyDown={event => {
              if (suggestions.length && !event.nativeEvent.isComposing) {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  setActiveCommand((selected + (event.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length);
                  return;
                }
                if ((event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey) || (event.key === 'Tab' && !event.shiftKey)) {
                  event.preventDefault();
                  choose(suggestions[selected]);
                  return;
                }
                if (event.key === 'Escape') {
                  // Closes the list only; the window's Escape (interrupt) does not see it.
                  event.preventDefault();
                  event.stopPropagation();
                  event.nativeEvent.stopImmediatePropagation();
                  setClosedOn(text);
                  return;
                }
              }
              if (event.key === 'Tab' && event.shiftKey && onCycleMode && !event.nativeEvent.isComposing) {
                event.preventDefault();
                if (!event.repeat) onCycleMode();
                return;
              }
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
              const modifier = event.metaKey || event.ctrlKey;
              if (sendShortcut === 'mod-enter' && !modifier) return;
              event.preventDefault();
              if (sendShortcut === 'enter' && modifier && running) alternateSend();
              else defaultSend();
            }}
            className="max-h-[280px] min-h-[21px] w-full resize-none bg-transparent text-(length:--content-font-size) leading-[1.4] text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
          />
          <div className="-mx-1.5 flex min-h-7 shrink-0 items-end justify-between">
            <div className="flex min-w-0 flex-1 items-end">
              {takesFiles || (takesImages && !startLabel) ? (
                <>
                  <button type="button" aria-label={takesFiles ? 'Attach files' : 'Attach images'} title={takesFiles ? 'Attach files' : 'Attach images'} disabled={!!reason} onClick={() => picker.current?.click()}
                    className={cn(round, 'mr-1 text-muted-foreground hover:bg-muted hover:text-foreground')} data-testid="composer-attach">
                    <Plus aria-hidden />
                  </button>
                  <input ref={picker} type="file" accept={takesFiles ? undefined : IMAGE_TYPES.join(',')} multiple hidden data-testid="composer-attach-input"
                    onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void attach(files); }} />
                </>
              ) : null}
              {controls}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {meter}
              {startLabel ? (
                <button type="button" aria-label={startLabel} title={startHold ?? startLabel} onClick={() => void send()} disabled={!!reason || !!startHold}
                  className={cn(round, 'ml-1 bg-primary text-primary-foreground hover:bg-primary/85')} data-testid="composer-start">
                  <ArrowUp aria-hidden />
                </button>
              ) : hasText ? (
                <button type="button" aria-label={sendLabel} title={sendTitle}
                  onClick={defaultSend} disabled={!!reason}
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
