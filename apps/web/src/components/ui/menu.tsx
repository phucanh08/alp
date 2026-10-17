import * as React from 'react';
import { Check } from 'lucide-react';
import { cn } from '../../lib/utils';

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
  items: Array<{ /** Defaults to the label. */ id?: string; label: string; icon?: React.ReactNode; onSelect: () => void; destructive?: boolean; disabled?: boolean; /** A choice of one: shown with a check when chosen. */ checked?: boolean; /** Starts a new group: a divider above it. */ group?: boolean }>;
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
  const onKey = (event: React.KeyboardEvent) => {
    const all = entries();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); all[(at + 1) % all.length]?.focus(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); all[(at - 1 + all.length) % all.length]?.focus(); }
    else if (event.key === 'Home') { event.preventDefault(); all[0]?.focus(); }
    else if (event.key === 'End') { event.preventDefault(); all.at(-1)?.focus(); }
    else if (event.key === 'Tab') close(false);
  };

  return (
    <>
      <button ref={button} type="button" aria-label={label} title={title ?? label} disabled={disabled} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} data-testid={testId}
        onClick={event => { event.stopPropagation(); setOpen(!open); }}
        onKeyDown={event => { if (event.key === 'ArrowDown' && !open) { event.preventDefault(); setOpen(true); } }}
        className={triggerClassName}>
        {trigger}
      </button>
      {open ? (
        <div ref={list} id={id} role="menu" aria-label={label} onKeyDown={onKey} style={place}
          className="fixed z-50 max-h-[min(60vh,28rem)] min-w-40 max-w-[min(92vw,26rem)] overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-xl shadow-[var(--shadow)]">
          {items.map(item => (
            <React.Fragment key={item.id ?? item.label}>
            {item.group ? <div role="separator" className="-mx-1 my-1 h-px bg-border" /> : null}
            <button type="button" role={item.checked === undefined ? 'menuitem' : 'menuitemradio'} aria-checked={item.checked} disabled={item.disabled}
              onClick={event => { event.stopPropagation(); close(); item.onSelect(); }}
              className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent disabled:opacity-45 [&_svg]:size-3.5',
                item.destructive ? 'text-destructive' : 'text-foreground')}>
              {item.icon}<span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.checked ? <Check aria-hidden className="ml-2 text-foreground" /> : null}
            </button>
            </React.Fragment>
          ))}
        </div>
      ) : null}
    </>
  );
}
