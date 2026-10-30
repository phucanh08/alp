import * as React from 'react';
import { cn } from '../../lib/utils';

/** Paseo's settings switch: a pill track with a sliding thumb, as a button with role="switch". */
export function Switch({ checked, onCheckedChange, className, ...props }: Omit<React.ComponentProps<'button'>, 'onChange'> & { checked: boolean; onCheckedChange: (checked: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onCheckedChange(!checked)} data-slot="switch"
      className={cn('relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-primary' : 'bg-input', className)} {...props}>
      <span aria-hidden className={cn('pointer-events-none block size-4 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-4' : 'translate-x-0.5')} />
    </button>
  );
}
