import * as React from 'react';
import { MoreHorizontal, Pencil, Undo2, X } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Menu, type MenuItem } from '../../components/ui/menu';
import { checkCapture, checkReset, comboFromEvent, heldModifiers, isMacPlatform, NOT_SET, shortcutSections, type ShortcutOverrides } from '../../lib/shortcuts.js';
import { isDesktopApp } from '../../lib/browser-url.js';
import { cn } from '../../lib/utils';
import { useAppState, useController } from '../store';
import { Section } from './parts';

/*
 * Paseo's Settings › Shortcuts (screens/settings/keyboard-shortcuts-section.tsx): every row of the
 * shortcuts dialog with its keys, and per row a menu to Bind/Rebind (press the new keys), Clear
 * (the row stays, "Not set", nothing fires) and Reset to default; Reset all over the first section.
 * The keys are the app preferences' shortcutOverrides; lib/shortcuts.ts applies them to the window
 * listener, the dialog and the hints at once.
 *
 * Capture as Paseo's: the next key press with its modifiers, a held modifier shown while it waits.
 * ALP's differences: Escape cancels (Paseo records it as a key), the keys are saved on the press
 * (ALP has no multi-key chords, so no Done), and keys another shortcut uses, or a key that would
 * type, are refused with the reason (lib/shortcuts.ts checkCapture). Reset to default is refused,
 * with the reason, when another shortcut has taken the default keys since (checkReset).
 */

type Capture = { id: string; held: string; error: string };

const UNCHANGEABLE = 'This key is handled where it is used and cannot be changed here.';

export function ShortcutsPage() {
  const controller = useController();
  const { preferences } = useAppState();
  const overrides = preferences.shortcutOverrides;
  const mac = React.useMemo(() => isMacPlatform(), []);
  const desktop = React.useMemo(() => isDesktopApp(), []);
  const [capture, setCapture] = React.useState<Capture | null>(null);
  // A refused Reset to default: the row and why.
  const [refused, setRefused] = React.useState<{ id: string; error: string } | null>(null);
  const sections = shortcutSections(mac, desktop, overrides);
  const save = React.useCallback((next: ShortcutOverrides) => controller.updatePreferences({ shortcutOverrides: next }), [controller]);
  const captureId = capture?.id;

  React.useEffect(() => {
    if (!captureId) return;
    // Before every other listener (window, capture phase), so no shortcut of the app, Settings'
    // Escape or a menu sees the keys being recorded.
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.isComposing) return;
      if (event.key === 'Escape') { setCapture(null); return; }
      const combo = comboFromEvent(event, mac);
      if (combo === '') { setCapture(current => current && { ...current, held: heldModifiers(event, mac) }); return; }
      if (combo === null) { setCapture(current => current && { ...current, held: '', error: 'That key cannot be used for a shortcut.' }); return; }
      const result = checkCapture(captureId, combo, { mac, desktop, overrides });
      if ('error' in result) { setCapture(current => current && { ...current, held: '', error: result.error }); return; }
      const next = { ...overrides };
      const row = sections.flatMap(section => section.rows).find(entry => entry.id === captureId);
      // The default's keys again: no override, as Reset to default.
      if (row && result.combo === row.defaultCombo) delete next[captureId];
      else next[captureId] = result.combo;
      save(next);
      setCapture(null);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      setCapture(current => current && { ...current, held: heldModifiers(event, mac) });
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
    };
  }, [captureId, overrides, mac, desktop, save, sections]);

  const clear = (id: string) => { setRefused(null); save({ ...overrides, [id]: null }); };
  const reset = (id: string) => {
    const check = checkReset(id, { mac, desktop, overrides });
    if ('error' in check) { setRefused({ id, error: check.error }); return; }
    setRefused(null);
    const next = { ...overrides };
    delete next[id];
    save(next);
  };
  const hasOverrides = Object.keys(overrides).length > 0;

  return (
    <div data-testid="shortcuts-page">
      {sections.map((section, sectionIndex) => (
        <Section key={section.id} title={section.title}
          action={sectionIndex === 0 && hasOverrides ? <Button size="sm" variant="ghost" className="h-7 text-xs" data-testid="shortcuts-reset-all" onClick={() => { setCapture(null); setRefused(null); save({}); }}>Reset all</Button> : undefined}>
          {section.rows.map((row, index) => {
            const capturing = capture?.id === row.id;
            const items: MenuItem[] = [
              { id: 'bind', label: row.keys ? 'Rebind' : 'Bind', icon: <Pencil aria-hidden />, testId: `shortcut-bind-${row.id}`, onSelect: () => { setRefused(null); setCapture({ id: row.id, held: '', error: '' }); } },
              ...(row.keys ? [{ id: 'clear', label: 'Clear', icon: <X aria-hidden />, testId: `shortcut-clear-${row.id}`, onSelect: () => clear(row.id) }] : []),
              ...(row.overridden ? [{ id: 'reset', label: 'Reset to default', icon: <Undo2 aria-hidden />, testId: `shortcut-reset-${row.id}`, onSelect: () => reset(row.id) }] : []),
            ];
            return (
              <div key={row.id} data-testid={`shortcut-setting-${row.id}`} data-capturing={capturing || undefined}
                className={cn('flex flex-wrap items-center justify-between gap-3 px-4 py-3', index > 0 && 'border-t border-border', capturing && 'bg-accent/60')}>
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-foreground">{row.label}</div>
                  {capturing && capture.error ? <div role="alert" className="mt-1 text-xs text-warning" data-testid="shortcut-capture-error">{capture.error}</div>
                    : refused?.id === row.id ? <div role="alert" className="mt-1 text-xs text-warning" data-testid="shortcut-reset-error">{refused.error}</div>
                    : !row.rebindable ? <div className="mt-1 text-xs text-muted-foreground">{UNCHANGEABLE}</div>
                    : row.note ? <div className="mt-1 text-xs text-muted-foreground">{row.note}</div> : null}
                </div>
                <div className="flex items-center gap-2">
                  {capturing
                    ? <span aria-live="polite" className="text-sm text-muted-foreground" data-testid="shortcut-capture">{capture.held || 'Press shortcut…'}</span>
                    : row.keys
                      ? <kbd className="rounded-md bg-secondary/60 px-1.5 py-0.5 font-sans text-xs text-muted-foreground" data-testid="shortcut-keys">{row.keys}</kbd>
                      : <span className="text-sm text-muted-foreground" data-testid="shortcut-keys">{NOT_SET}</span>}
                  {capturing
                    ? <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setCapture(null)} data-testid="shortcut-capture-cancel">Cancel</Button>
                    : <span className="flex size-7 items-center justify-center">
                        {row.rebindable
                          ? <Menu label={`Actions for ${row.label}`} testId={`shortcut-actions-${row.id}`} items={items}
                              trigger={<MoreHorizontal aria-hidden className="size-3.5" />}
                              triggerClassName="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground" />
                          : null}
                      </span>}
                </div>
              </div>
            );
          })}
        </Section>
      ))}
    </div>
  );
}
