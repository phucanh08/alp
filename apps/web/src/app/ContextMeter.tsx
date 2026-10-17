import * as React from 'react';
import type { SessionUsage } from '@anhlp/alp-protocol/events';
import { contextOf, formatSessionCost, formatTokenCount, meterLabel, meterLevel, responseTokens, ringShare } from '../lib/usage.js';
import { cn } from '../lib/utils';

const SIZE = 14;
const STROKE = 2;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const LEVEL_CLASS = { normal: 'text-muted-foreground', warning: 'text-warning', danger: 'text-destructive' } as const;

/**
 * Paseo's context window meter (t-7679.12; packages/app/src/components/context-window-meter.tsx
 * at b63a325): a ring in the composer that fills clockwise from twelve with the share of the
 * context window the session holds, muted below 70%, amber from 70%, red above 90%; an empty
 * track while the runtime has not said both numbers. Hovering, focusing or tapping it shows
 * the details: the share used, the tokens against the window, the tokens last reported and
 * the session's cost when the runtime reports them. Paseo's account usage cards are not shown:
 * account-wide usage (daemon.usage) stays on the host (docs/alp/remote-gateway.md §5.9).
 */
export function ContextMeter({ usage, className }: { usage?: SessionUsage; className?: string }) {
  const [open, setOpen] = React.useState(false);
  const detailsId = React.useId();
  const context = contextOf(usage);
  const cost = formatSessionCost(usage?.totalCostUsd);
  const tokens = responseTokens(usage);
  const share = context ? ringShare(context.share) : 0;
  const center = SIZE / 2;
  return (
    <div className={cn('relative flex', className)} onPointerEnter={event => { if (event.pointerType === 'mouse') setOpen(true); }} onPointerLeave={event => { if (event.pointerType === 'mouse') setOpen(false); }}>
      <button type="button" aria-label={meterLabel(usage)} aria-describedby={open ? detailsId : undefined} data-testid="context-window-meter"
        data-level={context ? meterLevel(context.share) : 'none'}
        onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onClick={() => setOpen(true)}
        onKeyDown={event => { if (event.key === 'Escape' && open) { event.preventDefault(); setOpen(false); } }}
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-full outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden>
          <circle cx={center} cy={center} r={RADIUS} fill="none" stroke="currentColor" strokeWidth={STROKE} className="text-muted" />
          {context ? (
            <circle cx={center} cy={center} r={RADIUS} fill="none" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round"
              strokeDasharray={CIRCUMFERENCE} strokeDashoffset={CIRCUMFERENCE - (share / 100) * CIRCUMFERENCE}
              transform={`rotate(-90 ${center} ${center})`} className={LEVEL_CLASS[meterLevel(context.share)]} data-testid="context-window-ring" />
          ) : null}
        </svg>
      </button>
      {open ? (
        <div role="tooltip" id={detailsId} data-testid="context-window-details"
          className="absolute bottom-full right-0 z-50 mb-2 flex w-max min-w-[200px] max-w-[300px] flex-col gap-1.5 rounded-lg border border-border bg-popover px-2 py-1 text-popover-foreground shadow-md">
          <span className="text-sm text-foreground">Context window</span>
          {context ? (
            <>
              <span className="text-sm text-foreground">{context.percentage}% used</span>
              <span className="text-xs text-muted-foreground">{formatTokenCount(context.usedTokens)} / {formatTokenCount(context.maxTokens)} tokens</span>
            </>
          ) : <span className="text-xs text-muted-foreground">No context data</span>}
          {tokens ? <span className="text-xs text-muted-foreground">Last reported {tokens}</span> : null}
          {cost ? <span className="text-xs text-muted-foreground">Session cost {cost}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
