import * as React from 'react';
import { Search } from 'lucide-react';
import { Dialog } from '../components/ui/dialog';
import { helpSections, isEditable, isMacPlatform, matchShortcut, type Binding } from '../lib/shortcuts.js';

/*
 * Paseo's keyboard shortcuts for the workspace: one window listener that maps a key press to an
 * action of the shell (lib/shortcuts.js holds the bindings), and the "Shortcuts" dialog that
 * Shift+? opens (packages/app/src/components/keyboard-shortcuts-dialog.tsx).
 */

export type ShortcutAction = (binding: Binding, index?: number) => boolean | void;

/**
 * Listens for the workspace's shortcuts. `run` returns false when the action does not apply now,
 * so the browser keeps the key. While a modal dialog is open only `allowInModal` actions fire.
 */
export function useShortcuts(run: ShortcutAction, { enabled = true, allowInModal = [] as string[] } = {}) {
  const latest = React.useRef(run);
  latest.current = run;
  const mac = React.useMemo(() => isMacPlatform(), []);
  React.useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat) return;
      const match = matchShortcut(event, { mac, editable: isEditable(event.target) });
      if (!match) return;
      const modal = !!document.querySelector('dialog[open]') || !!document.querySelector('[data-modal-overlay]');
      if (modal && !allowInModal.includes(match.binding.action)) return;
      if (latest.current(match.binding, match.index) === false) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, mac, allowInModal.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = React.useState('');
  const mac = React.useMemo(() => isMacPlatform(), []);
  React.useEffect(() => { if (!open) setQuery(''); }, [open]);
  const sections = helpSections(mac, query);
  return (
    <Dialog open={open} onClose={onClose} title="Shortcuts" className="w-[min(92vw,36rem)]">
      <div className="space-y-4" data-testid="keyboard-shortcuts-dialog">
        <div className="flex h-9 items-center gap-2 rounded-lg border border-border bg-card px-2.5 focus-within:ring-1 focus-within:ring-ring">
          <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <input type="search" autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="Search shortcuts"
            onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); onClose(); } }} aria-label="Search shortcuts"
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden" />
        </div>
        {sections.map(section => (
          <section key={section.id} aria-label={section.title} className="space-y-2">
            <h3 className="text-xs font-medium text-muted-foreground">{section.title}</h3>
            <div className="overflow-hidden rounded-lg border border-secondary">
              {section.rows.map(row => (
                <div key={row.id} className="flex items-center justify-between gap-3 border-b border-secondary px-4 py-2.5 last:border-b-0" data-testid="shortcut-row">
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-foreground">{row.label}</span>
                    {'note' in row && row.note ? <span className="mt-0.5 block text-xs text-muted-foreground">{row.note}</span> : null}
                  </span>
                  <kbd className="shrink-0 rounded-md bg-secondary/60 px-1.5 py-0.5 font-sans text-xs text-muted-foreground">{row.keys}</kbd>
                </div>
              ))}
            </div>
          </section>
        ))}
        {!sections.length ? <p className="py-6 text-center text-sm text-muted-foreground">No results</p> : null}
      </div>
    </Dialog>
  );
}
