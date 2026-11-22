import * as React from 'react';
import { CircleAlert, Copy, RotateCcw, X } from 'lucide-react';
import { Button } from '../components/ui/button';

/** What a caught render error says: its message, or the value thrown. */
export function caughtMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  try { return typeof error === 'string' ? error : JSON.stringify(error) ?? String(error); } catch { return String(error); }
}

type Props = {
  /** What shows instead of the children once one of them throws while rendering. */
  fallback: (error: unknown, reset: () => void) => React.ReactNode;
  /** A new value clears a caught error (another tab in the pane). */
  resetKey?: string;
  /** Where the error happened, for the console. */
  where: string;
  children: React.ReactNode;
};

/**
 * Paseo's RootErrorBoundary, and one per pane: an error while rendering shows a fallback in that
 * part of the window instead of leaving the whole page blank. Errors in event handlers and promises
 * are not render errors; they keep going to the notices.
 */
export class ErrorBoundary extends React.Component<Props, { error: unknown; key?: string; caught: boolean }> {
  state = { error: null as unknown, key: this.props.resetKey, caught: false };

  static getDerivedStateFromError(error: unknown) { return { error, caught: true }; }

  static getDerivedStateFromProps(props: Props, state: { key?: string; caught: boolean }) {
    // Another tab in front: what it shows starts afresh.
    return props.resetKey !== state.key ? { key: props.resetKey, error: null, caught: false } : null;
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    console.error(`[ErrorBoundary:${this.props.where}] Unhandled render error`, error, info.componentStack);
  }

  reset = () => this.setState({ error: null, caught: false });

  render() {
    return this.state.caught ? this.props.fallback(this.state.error, this.reset) : this.props.children;
  }
}

function copyDetails(error: unknown) {
  const text = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : caughtMessage(error);
  void navigator.clipboard?.writeText(text).catch(() => undefined);
}

/** The whole window's fallback, as Paseo's RootErrorFallback: what broke, and Reload. */
export function RootErrorFallback({ error }: { error: unknown }) {
  return (
    <div role="alert" data-testid="root-error-boundary" className="flex h-dvh items-center justify-center bg-background px-6 text-foreground">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <CircleAlert aria-hidden className="size-8 text-destructive" />
        <h1 className="text-base font-medium">Something went wrong</h1>
        <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]" data-testid="root-error-boundary-message">{caughtMessage(error)}</p>
        <p className="text-xs text-muted-foreground">Work on the host keeps running. Reload the page to continue.</p>
        <div className="mt-2 flex gap-2">
          <Button onClick={() => window.location.reload()} data-testid="root-error-boundary-reload"><RotateCcw aria-hidden /> Reload</Button>
          <Button variant="secondary" onClick={() => copyDetails(error)}><Copy aria-hidden /> Copy details</Button>
        </div>
      </div>
    </div>
  );
}

/** A pane's fallback: the tab that broke, Try again (renders it again) and Close tab. */
export function PaneErrorFallback({ error, onRetry, onClose }: { error: unknown; onRetry: () => void; onClose?: () => void }) {
  return (
    <div role="alert" data-testid="pane-error-boundary" className="flex flex-1 items-center justify-center px-6 py-10">
      <div className="flex max-w-sm flex-col items-center gap-2 text-center">
        <CircleAlert aria-hidden className="size-7 text-destructive" />
        <h2 className="text-sm font-medium">This tab ran into an error</h2>
        <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]" data-testid="pane-error-boundary-message">{caughtMessage(error)}</p>
        <div className="mt-2 flex flex-wrap justify-center gap-2">
          <Button size="sm" onClick={onRetry} data-testid="pane-error-boundary-retry"><RotateCcw aria-hidden /> Try again</Button>
          {onClose ? <Button size="sm" variant="secondary" onClick={onClose} data-testid="pane-error-boundary-close"><X aria-hidden /> Close tab</Button> : null}
          <Button size="sm" variant="ghost" onClick={() => copyDetails(error)}><Copy aria-hidden /> Copy details</Button>
        </div>
      </div>
    </div>
  );
}
