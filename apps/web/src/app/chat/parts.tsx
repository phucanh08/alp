import * as React from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '../../lib/utils';

/** Paseo's turn duration: 12s, 3m 4s, 1h 5m. */
export function formatDuration(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}

const LOADER_MS = 950;
const LOADER_STATES = [
  [1, 0, 0.78, 0, 0.56, 0.34],
  [0.78, 1, 0.56, 0, 0.34, 0],
  [0.56, 0.78, 0.34, 1, 0, 0],
  [0.34, 0.56, 0, 0.78, 0, 1],
  [0, 0.34, 0, 0.56, 1, 0.78],
  [0, 0, 1, 0.34, 0.78, 0.56],
];
const loaderStep = () => Math.floor(((Date.now() % LOADER_MS) * 6) / LOADER_MS);

/** Paseo's working loader: a 2x3 grid of dots whose light walks around, on a shared clock. */
export function Loader({ size = 14, className }: { size?: number; className?: string }) {
  const [step, setStep] = React.useState(loaderStep);
  React.useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const timer = window.setInterval(() => setStep(loaderStep()), LOADER_MS / 6);
    return () => window.clearInterval(timer);
  }, []);
  const gap = Math.max(1, Math.round(size * 0.12));
  const dot = Math.max(2, (size - gap * 2) / 3);
  return (
    <span aria-hidden className={cn('relative inline-flex shrink-0 items-center justify-center', className)} style={{ width: size, height: size }}>
      <span className="relative" style={{ width: dot * 2 + gap, height: dot * 3 + gap * 2 }}>
        {LOADER_STATES[step].map((opacity, index) => (
          <span key={index} className="absolute rounded-full bg-current transition-opacity duration-100"
            style={{ width: dot, height: dot, left: (index % 2) * (dot + gap), top: Math.floor(index / 2) * (dot + gap), opacity }} />
        ))}
      </span>
    </span>
  );
}

/** Ticks once a second: the time since `since`. */
export function Elapsed({ since, className }: { since: number; className?: string }) {
  const [now, setNow] = React.useState(Date.now);
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <span className={cn('tabular-nums', className)}>{formatDuration(now - since)}</span>;
}

/** A quiet icon button that copies text and shows a check for a moment. */
export function CopyButton({ text, label, className }: { text: () => string; label: string; className?: string }) {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<number | undefined>(undefined);
  React.useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <button type="button" aria-label={copied ? 'Copied' : label} title={copied ? 'Copied' : label}
      onClick={() => {
        const value = text();
        if (!value) return;
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setCopied(false), 1500);
        }).catch(() => undefined);
      }}
      className={cn('flex shrink-0 items-center justify-center rounded p-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5', className)}>
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
    </button>
  );
}
