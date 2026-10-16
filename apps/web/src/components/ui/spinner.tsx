import { LoaderCircle } from 'lucide-react';
import { cn } from '../../lib/utils';

export function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <span role="status" className={cn('inline-flex items-center gap-2 text-muted-foreground', className)}>
      <LoaderCircle aria-hidden className="size-4 animate-spin" />
      {label ? <span>{label}</span> : <span className="sr-only">Loading</span>}
    </span>
  );
}
