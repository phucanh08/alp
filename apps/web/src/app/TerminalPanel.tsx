import * as React from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type { TerminalPreferences } from '../lib/preferences.js';
import { openTerminalLink } from '../lib/terminal-links.js';
import '@xterm/xterm/css/xterm.css';
import { RotateCcw, ShieldAlert, SquareTerminal } from 'lucide-react';
import { Button } from '../components/ui/button';
import { TERMINAL_HEADER, TERMINAL_NOTICE, exitText, type TerminalSession } from '../lib/terminal.js';
import { useAppState, useController } from './store';

/*
 * The Terminal tab (#121 H, docs/protocol/alp-json-rpc-v1.md §12.10): a real shell on the daemon
 * host through the gateway, drawn by xterm.js. The logic (create, attach, replay, input batching,
 * resize, reconnect) is lib/terminal.js; this view only draws it.
 *
 * Honesty first (the user's product decision): the panel says where the shell runs and that the
 * workspace is not a sandbox, in full the first time a terminal opens in this page session and in a
 * header line always. A host that has not allowed terminals, or a token without terminal.exec, gets
 * the refusal and no terminal.
 */

const NOTICE_KEY = 'alp-web.terminal-notice-seen';

const seenNotice = () => { try { return globalThis.sessionStorage?.getItem(NOTICE_KEY) === '1'; } catch { return false; } };

/** Terminal colors that read on both app themes. */
const DARK_THEME = { background: '#101211', foreground: '#e4e7e5', cursor: '#e4e7e5', selectionBackground: '#3a4a44' };

const LIGHT_THEME = { background: '#f6f8f7', foreground: '#18251e', cursor: '#18251e', selectionBackground: '#b8d4c4' };
const FONTS = { mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', menlo: 'Menlo, monospace', consolas: 'Consolas, monospace' };

export function TerminalPanel() {
  const controller = useController();
  const state = useAppState();
  const gate = controller.terminalGate();
  if (!gate.ok) {
    return (
      <div className="flex min-h-full flex-col items-center justify-center gap-2 p-6 text-center" role="note" data-testid="terminal-refused">
        <SquareTerminal aria-hidden strokeWidth={1.5} className="size-6 text-extra-muted" />
        <p className="text-sm text-foreground">No terminal here</p>
        {gate.messages.map(message => <p key={message} className="max-w-[360px] text-xs leading-5 text-muted-foreground">{message}</p>)}
      </div>
    );
  }
  const group = controller.terminalTabs(gate.workspaceId);
  const prefs = state.preferences.terminal;
  const pending = group.tabs.some(tab => ['starting', 'attaching', 'reconnecting'].includes(tab.session.getState().status));
  const available = pending ? [] : state.terminalDirectory.items.filter(item => item.workspaceId === gate.workspaceId && item.state === 'running' && !group.tabs.some(tab => tab.session.getState().terminalId === item.terminalId));
  return <div className="flex h-full min-h-0 flex-col" key={`${state.connection.gateway}|${gate.workspaceId}`}>
    <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-2 py-1">
      <div className="flex w-full min-w-0 items-center gap-1 sm:w-auto sm:flex-1">
      <div role="tablist" aria-label="Terminal sessions" className="flex min-w-0 flex-1 flex-wrap gap-1">
        {group.tabs.map((tab, index) => <div key={tab.key} className="flex shrink-0 items-center">
          <button role="tab" id={`terminal-tab-${tab.key}`} aria-controls={`terminal-view-${tab.key}`} aria-selected={group.active === tab.key} tabIndex={group.active === tab.key ? 0 : -1}
            className={`whitespace-nowrap rounded px-2 py-1 text-xs ${group.active === tab.key ? 'bg-secondary text-foreground' : 'text-muted-foreground'}`}
            onClick={() => controller.selectTerminal(gate.workspaceId, tab.key)}
            onKeyDown={event => {
              if (event.key === 'Delete') { event.preventDefault(); void controller.closeTerminalTab(gate.workspaceId, tab.key); }
              if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                event.preventDefault();
                const at = event.key === 'Home' ? 0 : event.key === 'End' ? group.tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + group.tabs.length) % group.tabs.length;
                const next = group.tabs[at]; controller.selectTerminal(gate.workspaceId, next.key);
                document.getElementById(`terminal-tab-${next.key}`)?.focus();
              }
            }}>Shell {index + 1}</button>
          <button aria-label={`Close shell ${index + 1}`} className="px-1 text-muted-foreground" onClick={() => { void controller.closeTerminalTab(gate.workspaceId, tab.key); }}>×</button>
        </div>)}
      </div>
      <Button size="sm" variant="ghost" disabled={group.tabs.length >= 32} onClick={() => controller.addTerminal(gate.workspaceId)} aria-label="Add terminal">+</Button>
      </div>
      <div className="flex max-w-full flex-wrap items-center gap-2">
      <label className="text-xs">Font <select aria-label="Terminal font" value={prefs.fontFamily} onChange={event => controller.setTerminalPreferences({ fontFamily: event.target.value as TerminalPreferences['fontFamily'] })}>
        <option value="mono">Monospace</option><option value="menlo">Menlo</option><option value="consolas">Consolas</option>
      </select></label>
      <label className="text-xs">Size <select aria-label="Terminal font size" value={prefs.fontSize} onChange={event => controller.setTerminalPreferences({ fontSize: Number(event.target.value) })}>
        {Array.from({ length: 15 }, (_, index) => index + 10).map(size => <option key={size} value={size}>{size}</option>)}
      </select></label>
      <label className="text-xs">Theme <select aria-label="Terminal theme" value={prefs.theme} onChange={event => controller.setTerminalPreferences({ theme: event.target.value as TerminalPreferences['theme'] })}>
        <option value="dark">Dark</option><option value="light">Light</option>
      </select></label>
      </div>
    </div>
    {state.terminalDirectory.mode === 'polling' ? <p role="status" className="px-2 text-xs text-muted-foreground">This host refreshes the terminal list every five seconds.</p> : null}
    {state.terminalDirectory.error ? <p role="status" className="px-2 text-xs text-destructive">Terminal list: {state.terminalDirectory.error}</p> : null}
    {available.length ? <div className="flex shrink-0 flex-wrap gap-1 px-2 py-1" aria-label="Available host terminals">{available.map(item => <Button key={item.terminalId} size="sm" variant="secondary" onClick={() => controller.openListedTerminal(gate.workspaceId, item.terminalId)}>Open {item.title}</Button>)}</div> : null}
    {group.tabs.length ? group.tabs.map(tab => <TerminalView key={tab.key} tabKey={tab.key} active={group.active === tab.key} preferences={prefs} session={tab.session} />) : <div className="p-4 text-sm text-muted-foreground">No terminals open. Use + to start a shell.</div>}
  </div>;
}

function useSession(session: TerminalSession) {
  return React.useSyncExternalStore(React.useCallback(listener => session.subscribe(listener), [session]), () => session.getState());
}

function TerminalView({ session, active, preferences, tabKey }: { session: TerminalSession, active: boolean, preferences: TerminalPreferences, tabKey: string }) {
  const view = useSession(session);
  const host = React.useRef<HTMLDivElement | null>(null);
  const terminal = React.useRef<Terminal | null>(null);
  const fitTerminal = React.useRef<() => void>(() => {});
  const search = React.useRef<SearchAddon | null>(null);
  const [query, setQuery] = React.useState('');
  const [searchResult, setSearchResult] = React.useState<string>('');
  const activeRef = React.useRef(active);
  activeRef.current = active;
  const [notice, setNotice] = React.useState(() => !seenNotice());

  React.useEffect(() => {
    const element = host.current;
    if (!element) return;
    const term = new Terminal({ cursorBlink: true, convertEol: false, fontSize: preferences.fontSize, fontFamily: FONTS[preferences.fontFamily], scrollback: 5000, theme: preferences.theme === 'light' ? LIGHT_THEME : DARK_THEME, disableStdin: !session.accepting });
    const fit = new FitAddon();
    const finder = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(finder);
    term.loadAddon(new WebLinksAddon((_event, uri) => { openTerminalLink(uri); }));
    search.current = finder;
    term.open(element);
    terminal.current = term;
    const fitNow = () => { try { if (activeRef.current && element.clientWidth > 0 && element.clientHeight > 0) fit.fit(); } catch {} };
    fitTerminal.current = fitNow;
    fitNow();
    term.write(session.history());
    const offOutput = session.onOutput(text => term.write(text));
    const offData = term.onData(data => { session.input(data); });
    const offResize = term.onResize(({ cols, rows }) => session.resize(cols, rows));
    const observer = new ResizeObserver(() => fitNow());
    observer.observe(element);
    session.start(term.cols, term.rows);
    session.resize(term.cols, term.rows);
    if (activeRef.current) term.focus();
    return () => {
      observer.disconnect();
      offOutput();
      offData.dispose();
      offResize.dispose();
      terminal.current = null;
      search.current = null;
      fitTerminal.current = () => {};
      term.dispose();
    };
  }, [session]);

  React.useEffect(() => {
    const term = terminal.current;
    if (!term) return;
    term.options.disableStdin = view.status !== 'running';
    term.options.cursorBlink = view.status === 'running';
    if (view.status === 'running' && activeRef.current) term.focus();
  }, [view.status]);

  React.useEffect(() => {
    const term = terminal.current;
    if (!term) return;
    term.options.fontSize = preferences.fontSize;
    term.options.fontFamily = FONTS[preferences.fontFamily];
    term.options.theme = preferences.theme === 'light' ? LIGHT_THEME : DARK_THEME;
    if (active) { fitTerminal.current(); term.focus(); }
  }, [active, preferences]);

  const find = (backward = false) => {
    if (!query) { terminal.current?.clearSelection(); search.current?.clearDecorations(); setSearchResult(''); return; }
    const found = backward ? search.current?.findPrevious(query) : search.current?.findNext(query);
    setSearchResult(found ? 'Match selected' : 'No matches');
  };

  const dismiss = () => {
    try { globalThis.sessionStorage?.setItem(NOTICE_KEY, '1'); } catch {}
    setNotice(false);
    terminal.current?.focus();
  };

  return (
    <div id={`terminal-view-${tabKey}`} role="tabpanel" aria-labelledby={`terminal-tab-${tabKey}`} hidden={!active} className={active ? "flex min-h-0 flex-1 flex-col" : "hidden"} data-testid="terminal-panel" data-status={view.status} data-terminal-key={tabKey}>
      <p className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-1 text-[11px] leading-4 text-muted-foreground" data-testid="terminal-header">
        <ShieldAlert aria-hidden className="size-3 shrink-0 text-amber-500" />
        <span className="truncate" title={TERMINAL_NOTICE}>{TERMINAL_HEADER}</span>
      </p>
      {notice ? (
        <div role="alert" className="m-2 grid shrink-0 grid-cols-[auto_1fr] items-start gap-x-3 gap-y-2 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm text-foreground sm:flex sm:gap-3" data-testid="terminal-notice">
          <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-amber-500" />
          <p className="min-w-0 flex-1 leading-5">{TERMINAL_NOTICE}</p>
          <Button size="sm" variant="secondary" className="col-start-2 justify-self-end" onClick={dismiss}>Got it</Button>
        </div>
      ) : null}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1 text-xs">
        <input aria-label="Search terminal" placeholder="Search terminal" value={query} className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1" onChange={event => { setQuery(event.target.value); setSearchResult(''); if (!event.target.value) { search.current?.clearDecorations(); terminal.current?.clearSelection(); } }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); find(event.shiftKey); } if (event.key === 'Escape') { setQuery(''); search.current?.clearDecorations(); terminal.current?.clearSelection(); terminal.current?.focus(); } }} />
        <button onClick={() => find(true)} aria-label="Previous terminal match">↑</button>
        <button onClick={() => find()} aria-label="Next terminal match">↓</button>
        <span role="status" aria-label="Terminal search result">{searchResult}</span>
      </div>
      <Status session={session} />
      <div className="relative min-h-0 flex-1 p-1.5" style={{ backgroundColor: preferences.theme === 'light' ? LIGHT_THEME.background : DARK_THEME.background }}>
        <div ref={host} className="h-full w-full" data-testid="terminal-screen" aria-label="Terminal" />
      </div>
    </div>
  );
}

/** The line under the header: what the terminal is doing when it is not simply running. */
function Status({ session }: { session: TerminalSession }) {
  const view = useSession(session);
  const line = (text: string, action?: React.ReactNode, tone: 'info' | 'error' = 'info') => (
    <div role="status" className={`flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-xs ${tone === 'error' ? 'text-destructive' : 'text-muted-foreground'}`} data-testid="terminal-status">
      <span className="min-w-0 flex-1">{text}</span>
      {action}
    </div>
  );
  const restart = <Button size="sm" variant="secondary" onClick={() => session.restart()}><RotateCcw aria-hidden />New terminal</Button>;
  switch (view.status) {
    case 'idle': case 'starting': return line('Starting a shell on the host…');
    case 'attaching': return line('Connecting to the terminal…');
    case 'reconnecting': return line('Reconnecting to the host… input is paused.');
    case 'replaced': return line('Opened in another client', <Button size="sm" variant="secondary" onClick={() => session.reattach()}>Reattach</Button>);
    case 'exited': return line(view.exit ? exitText(view.exit) : 'Process exited', restart);
    case 'gone': return line(view.error ?? 'This terminal has ended.', restart);
    case 'failed': return line(view.error ?? 'The terminal could not open.', restart, 'error');
    case 'closed': return line('Terminal closed.');
    default:
      return view.lost ? line(view.lost, <Button size="sm" variant="ghost" onClick={() => session.dismissLost()}>Dismiss</Button>) : null;
  }
}
