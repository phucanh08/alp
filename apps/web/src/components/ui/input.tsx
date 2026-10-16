import * as React from 'react';
import { cn } from '../../lib/utils';

const field = 'w-full min-w-0 rounded-md border border-input bg-background/60 px-3 text-sm text-foreground placeholder:text-muted-foreground/80 outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive';

export function Input({ className, type = 'text', ...props }: React.ComponentProps<'input'>) {
  return <input data-slot="input" type={type} className={cn(field, 'h-9', className)} {...props} />;
}

export function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return <textarea data-slot="textarea" className={cn(field, 'min-h-16 py-2 leading-relaxed', className)} {...props} />;
}

export function NativeSelect({ className, children, ...props }: React.ComponentProps<'select'>) {
  return (
    <select data-slot="select" className={cn(field, 'h-9 appearance-none pr-8', className)}
      // The chevron is styled inline: a bg-* class from the caller (a background color) would make cn() drop arbitrary bg-[…] classes.
      style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2395a39a' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")", backgroundPosition: 'right 0.6rem center', backgroundSize: '16px', backgroundRepeat: 'no-repeat' }} {...props}>
      {children}
    </select>
  );
}

export function Label({ className, ...props }: React.ComponentProps<'label'>) {
  return <label data-slot="label" className={cn('text-xs font-medium text-muted-foreground', className)} {...props} />;
}
