import * as React from 'react';
import { Check } from 'lucide-react';
import { cn } from '../../lib/utils';

export type MenuItem = {
  /** Defaults to the label. */ id?: string;
  label: string;
  icon?: React.ReactNode;
  onSelect: () => void;
  destructive?: boolean;
  disabled?: boolean;
  /** A choice of one: shown with a check when chosen. */ checked?: boolean;
  /** Starts a new group: a divider above it. */ group?: boolean;
  /** Short text at the row's end (Paseo's hint: the first characters of an id). */ hint?: string;
  /** The row's tooltip. */ title?: string;
  testId?: string;
};

const listClass = 'fixed z-50 max-h-[min(60vh,28rem)] min-w-40 max-w-[min(92vw,26rem)] overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-xl shadow-[var(--shadow)]';

/** The menu's rows; a click runs the item after `close`. */
function MenuItems({ items, close }: { items: MenuItem[]; close: () => void }) {
  return (
    <>
      {items.map(item => (
        <React.Fragment key={item.id ?? item.label}>
        {item.group ? <div role="separator" className="-mx-1 my-1 h-px bg-border" /> : null}
        <button type="button" role={item.checked === undefined ? 'menuitem' : 'menuitemradio'} aria-checked={item.checked} disabled={item.disabled} title={item.title} data-testid={item.testId}
          onClick={event => { event.stopPropagation(); close(); item.onSelect(); }}
          className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent disabled:opacity-45 [&_svg]:size-3.5',
            item.destructive ? 'text-destructive' : 'text-foreground')}>
          {item.icon}<span className="min-w-0 flex-1 truncate">{item.label}</span>
          {item.hint ? <span className="ml-3 font-mono text-xs text-muted-foreground">{item.hint}</span> : null}
          {item.checked ? <Check aria-hidden className="ml-2 text-foreground" /> : null}
        </button>
        </React.Fragment>
      ))}
    </>
  );
}

/** Arrow keys, Home/End between the enabled rows; Escape and Tab call `close`. */
function menuKeys(list: React.RefObject<HTMLDivElement | null>, close: (focus?: boolean) => void) {
  return (event: React.KeyboardEvent) => {
    const all = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not([disabled])') ?? []);
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); all[(at + 1) % all.length]?.focus(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); all[(at - 1 + all.length) % all.length]?.focus(); }
    else if (event.key === 'Home') { event.preventDefault(); all[0]?.focus(); }
    else if (event.key === 'End') { event.preventDefault(); all.at(-1)?.focus(); }
    else if (event.key === 'Tab') close(false);
  };
}

/**
 * A context menu (right click, or Shift+F10 / the Menu key on the element): the same rows as
 * Menu, at the pointer, kept inside the viewport. Escape, a click elsewhere, a resize or a scroll
 * closes it; focus goes back to where it was.
 */
export function ContextMenu({ label, at, items, onClose, testId, fallbackFocus }: {
  label: string;
  /** Where focus goes when the element it came from is gone (the action removed it). */
  fallbackFocus?: () => HTMLElement | null | undefined;
  /** Where it opens (viewport coordinates); null: closed. */
  at: { x: number; y: number } | null;
  items: MenuItem[];
  onClose: () => void;
  testId?: string;
}) {
  const list = React.useRef<HTMLDivElement>(null);
  const [place, setPlace] = React.useState<React.CSSProperties>({ visibility: 'hidden' });
  const returnTo = React.useRef<HTMLElement | null>(null);
  const close = React.useCallback((focus = true) => {
    onClose();
    if (!focus) return;
    const target = returnTo.current;
    target?.focus();
    // After the chosen action ran: it may have removed that element (Close).
    setTimeout(() => { if (target && !target.isConnected) fallbackFocus?.()?.focus(); }, 0);
  }, [onClose, fallbackFocus]);
  React.useLayoutEffect(() => {
    if (!at) return;
    returnTo.current = document.activeElement as HTMLElement | null;
    const width = list.current?.offsetWidth ?? 0;
    const height = list.current?.offsetHeight ?? 0;
    setPlace({ left: Math.max(8, Math.min(at.x, window.innerWidth - width - 8)), top: Math.max(8, Math.min(at.y, window.innerHeight - height - 8)) });
    list.current?.querySelector<HTMLButtonElement>('[role^="menuitem"]:not([disabled])')?.focus();
  }, [at]);
  React.useEffect(() => {
    if (!at) return;
    const dismiss = () => close(false);
    const away = (event: PointerEvent) => { if (!list.current?.contains(event.target as Node)) close(false); };
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('blur', dismiss);
    document.addEventListener('pointerdown', away, true);
    return () => {
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('blur', dismiss);
      document.removeEventListener('pointerdown', away, true);
    };
  }, [at, close]);
  if (!at) return null;
  return (
    <div ref={list} role="menu" aria-label={label} data-testid={testId} onKeyDown={menuKeys(list, close)} onContextMenu={event => event.preventDefault()} style={place} className={listClass}>
      <MenuItems items={items} close={() => close()} />
    </div>
  );
}

/**
 * A small dropdown menu (WAI-ARIA menu button): the trigger opens a list of actions below it,
 * arrow keys move between them, Escape or a click elsewhere closes it and focus goes back.
 */
export function Menu({ label, title, trigger, triggerClassName, items, align = 'end', onOpenChange, disabled, openRequest, onOpenRequestHandled, testId }: {
  label: string;
  /** The trigger's tooltip; the label by default. */
  title?: string;
  disabled?: boolean;
  trigger: React.ReactNode;
  triggerClassName?: string;
  items: MenuItem[];
  align?: 'start' | 'end';
  onOpenChange?: (open: boolean) => void;
  /**
   * A keyboard shortcut's request to open the menu: a non-zero number. The menu opens and calls
   * onOpenRequestHandled, and the owner clears the request so a remount does not open it again.
   */
  openRequest?: number;
  onOpenRequestHandled?: () => void;
  testId?: string;
}) {
  const [open, setOpenState] = React.useState(false);
  const [place, setPlace] = React.useState<React.CSSProperties>({});
  const button = React.useRef<HTMLButtonElement>(null);
  const list = React.useRef<HTMLDivElement>(null);
  const id = React.useId();
  const setOpen = React.useCallback((value: boolean) => { setOpenState(value); onOpenChange?.(value); }, [onOpenChange]);
  React.useEffect(() => {
    if (!openRequest) return;
    if (!disabled) setOpen(true);
    onOpenRequestHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRequest]);
  const entries = () => Array.from(list.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not([disabled])') ?? []);

  // Fixed to the viewport so a scrolling list cannot clip it; opens upward near the bottom edge.
  React.useLayoutEffect(() => {
    if (!open || !button.current) return;
    const rect = button.current.getBoundingClientRect();
    const height = list.current?.offsetHeight ?? 0;
    const below = rect.bottom + 4 + height <= window.innerHeight - 8;
    setPlace({
      top: below ? rect.bottom + 4 : Math.max(8, rect.top - 4 - height),
      ...(align === 'end' ? { right: Math.max(8, window.innerWidth - rect.right) } : { left: Math.max(8, rect.left) }),
    });
  }, [open, align]);

  React.useEffect(() => {
    if (!open) return;
    entries()[0]?.focus();
    const dismiss = () => setOpen(false);
    // Only a scroll that moves the trigger closes it; the conversation streaming beside it does not.
    const scrolled = (event: Event) => { if (event.target instanceof Node && event.target.contains(button.current)) setOpen(false); };
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', scrolled, true);
    const away = (event: PointerEvent) => {
      if (!list.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => {
      document.removeEventListener('pointerdown', away);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', scrolled, true);
    };
  }, [open, setOpen]);

  const close = (focus = true) => { setOpen(false); if (focus) button.current?.focus(); };
  const onKey = menuKeys(list, close);

  return (
    <>
      <button ref={button} type="button" aria-label={label} title={title ?? label} disabled={disabled} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} data-testid={testId}
        onClick={event => { event.stopPropagation(); setOpen(!open); }}
        onKeyDown={event => { if (event.key === 'ArrowDown' && !open) { event.preventDefault(); setOpen(true); } }}
        className={triggerClassName}>
        {trigger}
      </button>
      {open ? (
        <div ref={list} id={id} role="menu" aria-label={label} onKeyDown={onKey} style={place} className={listClass}>
          <MenuItems items={items} close={() => close()} />
        </div>
      ) : null}
    </>
  );
}
