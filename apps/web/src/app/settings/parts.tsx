import * as React from 'react';
import { Ban } from 'lucide-react';
import { NativeSelect } from '../../components/ui/input';
import { cn } from '../../lib/utils';

/*
 * Settings' building blocks (Paseo's settings section, card and row), shared by Settings.tsx and
 * the page files beside this one (HostPages.tsx, LibraryPages.tsx), so each page file can be
 * changed on its own without importing Settings.tsx back.
 */

export type Page =
  | 'general' | 'appearance' | 'sidebar' | 'chat' | 'terminal' | 'editor' | 'files' | 'shortcuts' | 'notifications' | 'diagnostics' | 'about'
  | 'host' | 'projects' | 'connections' | 'alp-templates' | 'alp-agents' | 'alp-skills' | 'alp-hooks' | 'alp-mcp'
  | 'workspaces' | 'providers' | 'usage' | 'terminals';

export const focusRing = 'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset';

export function Section({ title, action, children }: { title?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      {title || action ? (
        <div className="mb-3 ml-1 flex items-center justify-between gap-2">
          {title ? <h3 className="text-xs font-normal text-muted-foreground">{title}</h3> : <span />}
          {action}
        </div>
      ) : null}
      <div className="overflow-hidden rounded-lg border border-border bg-card">{children}</div>
    </section>
  );
}

export function Row({ title, hint, children, first }: { title: React.ReactNode; hint?: React.ReactNode; children?: React.ReactNode; first?: boolean }) {
  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-3 p-4', !first && 'border-t border-border')}>
      <div className="min-w-0 flex-1">
        <div className="text-sm text-foreground">{title}</div>
        {hint ? <div className="mt-1 text-xs text-muted-foreground">{hint}</div> : null}
      </div>
      {children !== undefined ? <div className="min-w-0 max-w-full text-sm text-muted-foreground">{children}</div> : null}
    </div>
  );
}

export function Unavailable({ what, why }: { what: string; why: string }) {
  return (
    <Section>
      <div className="flex items-start gap-3 p-4" role="note">
        <Ban aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div>
          <p className="text-sm">{what} is not available in this beta</p>
          <p className="mt-1 text-xs text-muted-foreground">{why}</p>
        </div>
      </div>
    </Section>
  );
}

/** Paseo's settings dropdown: a small pill with the value and a chevron, right of the row. */
export function Select<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<{ value: T; label: string }>; onChange?: (value: T) => void }) {
  return (
    <NativeSelect aria-label={label} value={value} onChange={event => onChange?.(event.target.value as T)} disabled={!onChange}
      className="h-8 w-auto rounded-lg border-border bg-transparent pl-3 text-sm text-foreground disabled:cursor-default disabled:opacity-100">
      {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </NativeSelect>
  );
}
