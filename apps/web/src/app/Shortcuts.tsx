import * as React from 'react';
import { Search } from 'lucide-react';
import { Dialog } from '../components/ui/dialog';
import { bindingId, effectiveBindings, helpSections, isEditable, isMacPlatform, matchShortcut, NOT_SET, setShortcutOverrides, type Binding } from '../lib/shortcuts.js';
import { isDesktopApp } from '../lib/browser-url.js';
import { useAppState } from './store';

/*
 * Paseo's keyboard shortcuts for the workspace: one window listener that maps a key press to an
 * action of the shell (lib/shortcuts.ts holds the bindings), and the "Shortcuts" dialog that
 * Shift+? opens (packages/app/src/components/keyboard-shortcuts-dialog.tsx).
 */

/**
 * Applies the user's keys (Settings › Shortcuts, preferences.shortcutOverrides) to every shortcut:
 * the window listener, the dialog and the hints read them from lib/shortcuts.ts. Called by the app
 * root while it renders, so the components under it render with the current keys.
 */
export function useShortcutOverrides() {
  const { preferences } = useAppState();
  setShortcutOverrides(preferences.shortcutOverrides);
}

export type ShortcutAction = (binding: Binding, index?: number) => boolean | void;

/**
 * Listens for the workspace's shortcuts. `run` returns false when the action does not apply now,
 * so the browser keeps the key. While a modal dialog is open only `allowInModal` actions fire.
 */
export function useShortcuts(run: ShortcutAction, { enabled = true, allowInModal = [] as string[] } = {}) {
  const latest = React.useRef(run);
  latest.current = run;
  const mac = React.useMemo(() => isMacPlatform(), []);
  const desktop = React.useMemo(() => isDesktopApp(), []);
  React.useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat) return;
      const match = matchShortcut(event, { mac, desktop, editable: isEditable(event.target) });
      if (!match) return;
      const modal = !!document.querySelector('dialog[open]') || !!document.querySelector('[data-modal-overlay]');
      if (modal && !allowInModal.includes(match.binding.action)) return;
      if (latest.current(match.binding, match.index) === false) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, mac, desktop, allowInModal.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * ALP.app only: ⌘W (Ctrl+W off a Mac) that nothing took (no tab to close, History) closes the window,
 * as it did before the page took the key (t-0166); ALP.app's menu no longer has it. Not while a dialog,
 * a menu or Settings (an overlay) is open.
 */
export function useDesktopCloseFallback() {
  const mac = React.useMemo(() => isMacPlatform(), []);
  const desktop = React.useMemo(() => isDesktopApp(), []);
  React.useEffect(() => {
    if (!desktop) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.repeat || event.code !== 'KeyW' || event.altKey || event.shiftKey) return;
      if (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return;
      // Only while ⌘W is still Close tab: once the user rebinds or clears it (Settings › Shortcuts),
      // ⌘W is no longer a close key and must not close the window either.
      if (!effectiveBindings().some(binding => bindingId(binding) === 'tab.close@desktop' && binding.combo === 'Mod+W')) return;
      // After every other listener of this key press has had its turn.
      setTimeout(() => {
        const open = !!document.querySelector('dialog[open], [data-modal-overlay], [role="menu"]');
        if (!event.defaultPrevented && !open) window.close();
      }, 0);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [desktop, mac]);
}

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = React.useState('');
  const mac = React.useMemo(() => isMacPlatform(), []);
  const desktop = React.useMemo(() => isDesktopApp(), []);
  React.useEffect(() => { if (!open) setQuery(''); }, [open]);
  // The user's keys: the dialog renders on its own state, the overrides come from the app root.
  useAppState();
  const sections = helpSections(mac, query, desktop);
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
                  {row.keys === NOT_SET ? <span className="shrink-0 text-xs text-muted-foreground">{row.keys}</span>
                    : <kbd className="shrink-0 rounded-md bg-secondary/60 px-1.5 py-0.5 font-sans text-xs text-muted-foreground">{row.keys}</kbd>}
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
