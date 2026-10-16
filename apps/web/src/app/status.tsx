import { CircleAlert } from 'lucide-react';
import { cn } from '../lib/utils';

/* Paseo's status marks: every status sits in one slot, so a row never shifts when it changes. */

export type Bucket = 'running' | 'needs_input' | 'failed' | 'done';

/** The running mark: a dot inside a turning quarter ring, in the running blue. */
export function StatusRing() {
  return (
    <span aria-hidden className="relative flex size-[14px] items-center justify-center">
      <span className="absolute inset-[1px] rounded-full border-[1.5px] border-dot-running opacity-30" />
      <span className="absolute inset-[1px] animate-spin rounded-full border-[1.5px] border-transparent border-t-dot-running opacity-90 [animation-duration:900ms]" />
      <span className="size-1.5 rounded-full bg-dot-running" />
    </span>
  );
}

/** The leading slot of a session row: every status sits in the same 16×20 box. */
export function StatusIndicator({ bucket }: { bucket: Bucket }) {
  const label = bucket === 'running' ? 'Running' : bucket === 'needs_input' ? 'Waiting for your answer' : bucket === 'failed' ? 'Failed' : 'Idle';
  return (
    <span className="flex h-5 w-4 shrink-0 items-center justify-center" title={label} data-status={bucket}>
      {bucket === 'running' ? <StatusRing /> : bucket === 'needs_input' ? <CircleAlert aria-hidden className="size-3 fill-dot-warning text-sidebar" /> : (
        <span aria-hidden className={cn('size-1.5 rounded-full', bucket === 'failed' ? 'bg-dot-danger' : 'bg-extra-muted opacity-30')} />
      )}
      <span className="sr-only">{label}</span>
    </span>
  );
}

