import * as React from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
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
const THEME = { background: '#101211', foreground: '#e4e7e5', cursor: '#e4e7e5', selectionBackground: '#3a4a44' };

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
  return <TerminalView key={`${state.connection.gateway}|${gate.workspaceId}`} session={controller.terminal(gate.workspaceId)} />;
}

function useSession(session: TerminalSession) {
  return React.useSyncExternalStore(React.useCallback(listener => session.subscribe(listener), [session]), () => session.getState());
}

function TerminalView({ session }: { session: TerminalSession }) {
  const view = useSession(session);
  const host = React.useRef<HTMLDivElement | null>(null);
  const terminal = React.useRef<Terminal | null>(null);
  const [notice, setNotice] = React.useState(() => !seenNotice());

  React.useEffect(() => {
    const element = host.current;
    if (!element) return;
    const term = new Terminal({ cursorBlink: true, convertEol: false, fontSize: 13, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', scrollback: 5000, theme: THEME, disableStdin: !session.accepting });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    terminal.current = term;
    const fitNow = () => { try { if (element.clientWidth > 0 && element.clientHeight > 0) fit.fit(); } catch {} };
    fitNow();
    term.write(session.history());
    const offOutput = session.onOutput(text => term.write(text));
    const offData = term.onData(data => { session.input(data); });
    const offResize = term.onResize(({ cols, rows }) => session.resize(cols, rows));
    const observer = new ResizeObserver(() => fitNow());
    observer.observe(element);
    session.start(term.cols, term.rows);
    session.resize(term.cols, term.rows);
    term.focus();
    return () => {
      observer.disconnect();
      offOutput();
      offData.dispose();
      offResize.dispose();
      terminal.current = null;
      term.dispose();
    };
  }, [session]);

  React.useEffect(() => {
    const term = terminal.current;
    if (!term) return;
    term.options.disableStdin = view.status !== 'running';
    term.options.cursorBlink = view.status === 'running';
    if (view.status === 'running') term.focus();
  }, [view.status]);

  const dismiss = () => {
    try { globalThis.sessionStorage?.setItem(NOTICE_KEY, '1'); } catch {}
    setNotice(false);
    terminal.current?.focus();
  };

  return (
    <div className="flex h-full min-h-[240px] flex-col" data-testid="terminal-panel" data-status={view.status}>
      <p className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-1 text-[11px] leading-4 text-muted-foreground" data-testid="terminal-header">
        <ShieldAlert aria-hidden className="size-3 shrink-0 text-amber-500" />
        <span className="truncate" title={TERMINAL_NOTICE}>{TERMINAL_HEADER}</span>
      </p>
      {notice ? (
        <div role="alert" className="m-2 flex shrink-0 items-start gap-3 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm text-foreground" data-testid="terminal-notice">
          <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-amber-500" />
          <p className="min-w-0 flex-1 leading-5">{TERMINAL_NOTICE}</p>
          <Button size="sm" variant="secondary" onClick={dismiss}>Got it</Button>
        </div>
      ) : null}
      <Status session={session} />
      <div className="relative min-h-0 flex-1 bg-[#101211] p-1.5">
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
