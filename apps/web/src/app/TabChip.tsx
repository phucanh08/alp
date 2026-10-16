import * as React from 'react';
import { X } from 'lucide-react';
import { cn } from '../lib/utils';

const focusRing = 'outline-none focus-visible:ring-2 focus-visible:ring-ring';

/**
 * One tab of Paseo's tab rows (the center column's and the explorer dock's): icon and label,
 * a close button that shows on hover or when active, Delete/Backspace closes it.
 */
export function TabChip({ label, icon, title, badge, active, onSelect, onClose, testId, tabRef, ...rest }: {
  label: string;
  icon: React.ReactNode;
  title?: string;
  badge?: number;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
  testId?: string;
  tabRef?: (element: HTMLButtonElement | null) => void;
} & Pick<React.ComponentProps<'button'>, 'id' | 'aria-controls' | 'tabIndex'> & { [data: `data-${string}`]: string }) {
  return (
    <div role="presentation" className={cn('group relative mx-0.5 flex h-7 max-w-[220px] shrink-0 items-center rounded-md', active ? 'bg-secondary' : 'hover:bg-card')}>
      <button ref={tabRef} type="button" role="tab" aria-selected={active} onClick={onSelect} title={title} data-testid={testId} {...rest}
        onKeyDown={event => { if ((event.key === 'Delete' || event.key === 'Backspace') && !event.repeat) { event.preventDefault(); onClose(); } }}
        className={cn('flex h-7 min-w-0 items-center gap-1 rounded-md pl-2 pr-7 text-sm', focusRing, active ? 'text-foreground' : 'text-muted-foreground')}>
        <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">{icon}</span>
        <span className="truncate">{label}</span>
        {badge ? <span className="ml-0.5 rounded-full bg-background/60 px-1.5 text-[11px] leading-4 text-muted-foreground">{badge}</span> : null}
      </button>
      <button type="button" aria-label={`Close ${label}`} title="Close tab" onClick={onClose}
        className={cn('absolute right-1 flex size-[18px] items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:opacity-100', focusRing, active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')}>
        <X aria-hidden className="size-3" />
      </button>
    </div>
  );
}
