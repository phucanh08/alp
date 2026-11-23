import * as React from 'react';
import { PanelLeft, PanelRight } from 'lucide-react';
import { cn } from '../lib/utils';
import { windowControlsVisible } from '../lib/window-controls.js';

/*
 * The top row of ALP.app on macOS, as Paseo's desktop titlebar: the traffic lights, then the sidebar
 * toggle right after them; the explorer toggle at the window's right edge, in the explorer's tab row
 * when the explorer is open and at the end of the workspace header when it is closed. The window owns
 * both toggles (fixed, styles.css .window-toggle), so they stay where they are while the panels open
 * and close; a header keeps an empty slot where one sits over it. In a browser nothing here changes
 * the page: the headers draw their own toggles as before.
 */

const focusRing = 'outline-none focus-visible:ring-2 focus-visible:ring-ring';
const headerButton = cn('flex size-8 shrink-0 items-center justify-center rounded-lg text-extra-muted hover:bg-secondary hover:text-foreground [&_svg]:size-[18px]', focusRing);

export type WindowToggles = { sidebarToggle: boolean; explorerToggle: boolean };
export const WindowTogglesContext = React.createContext<WindowToggles>({ sidebarToggle: false, explorerToggle: false });

/** Whether the traffic lights are in the page (windowControlsVisible), following full screen and back. */
export function useWindowControlsVisible(): boolean {
  const [visible, setVisible] = React.useState(() => windowControlsVisible());
  React.useEffect(() => {
    const overlay = (navigator as any).windowControlsOverlay as EventTarget | undefined;
    const update = () => setVisible(windowControlsVisible());
    update();
    // geometrychange follows the overlay; resize backs it up for full screen.
    overlay?.addEventListener?.('geometrychange', update);
    window.addEventListener('resize', update);
    return () => {
      overlay?.removeEventListener?.('geometrychange', update);
      window.removeEventListener('resize', update);
    };
  }, []);
  return visible;
}

function SidebarToggleButton({ navOpen, onToggleNav, className, testId }: { navOpen: boolean; onToggleNav: () => void; className?: string; testId?: string }) {
  return (
    <button type="button" aria-label={navOpen ? 'Close sessions' : 'Open sessions'} aria-expanded={navOpen} title="Toggle sidebar" onClick={onToggleNav}
      className={cn(headerButton, className)} data-testid={testId}>
      <PanelLeft aria-hidden strokeWidth={1.5} />
    </button>
  );
}

function ExplorerToggleButton({ explorerOpen, onToggleExplorer, className }: { explorerOpen: boolean; onToggleExplorer: () => void; className?: string }) {
  return (
    <button type="button" aria-label="Agents and tasks" aria-expanded={explorerOpen} title="Toggle explorer" onClick={onToggleExplorer}
      className={cn(headerButton, className)} data-testid="workspace-explorer-toggle">
      <PanelRight aria-hidden strokeWidth={1.5} />
    </button>
  );
}

/**
 * A header's start: when the sidebar is closed this header starts the window's top row, so it leaves
 * the traffic lights their room (.window-controls-inset, zero in a browser). Then the sidebar toggle,
 * or, where the window owns it, an empty slot it sits over (none while the sidebar is open: the toggle
 * is over the sidebar's top row then).
 */
export function HeaderSidebarToggle({ navOpen, onToggleNav }: { navOpen: boolean; onToggleNav: () => void }) {
  const { sidebarToggle } = React.useContext(WindowTogglesContext);
  const inset = navOpen ? null : <span aria-hidden className="window-controls-inset" />;
  if (sidebarToggle) return navOpen ? null : <>{inset}<span aria-hidden className="size-8 shrink-0 md:-ml-1.5" data-testid="window-sidebar-toggle-slot" /></>;
  return <>{inset}<SidebarToggleButton navOpen={navOpen} onToggleNav={onToggleNav} className="md:-ml-1.5" /></>;
}

/** The workspace header's end: the explorer toggle, or the slot the window's sits over while the explorer is closed. */
export function HeaderExplorerToggle({ explorerOpen, onToggleExplorer }: { explorerOpen: boolean; onToggleExplorer: () => void }) {
  const { explorerToggle } = React.useContext(WindowTogglesContext);
  if (explorerToggle) return explorerOpen ? null : <span aria-hidden className="size-8 shrink-0 md:-mr-1.5" data-testid="window-explorer-toggle-slot" />;
  return <ExplorerToggleButton explorerOpen={explorerOpen} onToggleExplorer={onToggleExplorer} className="md:-mr-1.5" />;
}

/** The explorer's tab row end: the slot the window's explorer toggle sits over. */
export function ExplorerTabsToggleSlot() {
  const { explorerToggle } = React.useContext(WindowTogglesContext);
  return explorerToggle ? <span aria-hidden className="mr-1.5 size-8 shrink-0" data-testid="window-explorer-toggle-slot" /> : null;
}

/** The window's sidebar toggle, right after the traffic lights. */
export function WindowSidebarToggle({ navOpen, onToggleNav }: { navOpen: boolean; onToggleNav: () => void }) {
  return (
    <div className="window-toggle window-toggle-start">
      <SidebarToggleButton navOpen={navOpen} onToggleNav={onToggleNav} className="-ml-1.5" testId="window-sidebar-toggle" />
    </div>
  );
}

/** The window's explorer toggle, at its right edge. */
export function WindowExplorerToggle({ explorerOpen, onToggleExplorer }: { explorerOpen: boolean; onToggleExplorer: () => void }) {
  return (
    <div className="window-toggle window-toggle-end">
      <ExplorerToggleButton explorerOpen={explorerOpen} onToggleExplorer={onToggleExplorer} className="-mr-1.5" />
    </div>
  );
}
