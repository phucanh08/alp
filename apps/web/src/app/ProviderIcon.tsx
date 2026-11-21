import { CircleGauge } from 'lucide-react';
import { cn } from '../lib/utils';

/**
 * A provider's mark in the sidebar's usage line, as Paseo's footer shows it: Claude's starburst,
 * Codex's rosette; any other runtime the usage gauge. Drawn here as plain glyphs (currentColor),
 * not the vendors' artwork.
 */
export function ProviderIcon({ runtime, className }: { runtime: string; className?: string }) {
  if (runtime === 'claude') {
    return (
      <svg aria-hidden viewBox="0 0 24 24" className={cn('size-3.5 shrink-0', className)} fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" data-provider="claude">
        {[0, 30, 60, 90, 120, 150].map(angle => <line key={angle} x1="12" y1="3" x2="12" y2="21" transform={`rotate(${angle} 12 12)`} />)}
      </svg>
    );
  }
  if (runtime === 'codex') {
    return (
      <svg aria-hidden viewBox="0 0 24 24" className={cn('size-3.5 shrink-0', className)} fill="none" stroke="currentColor" strokeWidth={1.6} data-provider="codex">
        {[0, 60, 120].map(angle => <ellipse key={angle} cx="12" cy="12" rx="9" ry="4.2" transform={`rotate(${angle} 12 12)`} />)}
      </svg>
    );
  }
  return <CircleGauge aria-hidden className={cn('size-3.5 shrink-0', className)} data-provider={runtime} />;
}
