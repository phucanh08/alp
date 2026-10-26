import * as React from 'react';
import { KeyRound, PlugZap, ShieldCheck } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Input, Label } from '../components/ui/input';
import { Spinner } from '../components/ui/spinner';
import { useAppState, useController } from './store';
import { Logo } from './Logo';
import { defaultGatewayAddress, servedByAlpWeb } from '../lib/link-token.js';

/** The gateway address is the only thing remembered between visits; it is not a secret. */
const GATEWAY_KEY = 'alp-web:gateway';
/**
 * Vite's dev server runs beside a standalone gateway; a built app on loopback is most likely alp
 * web's. That is a guess from the page's address, so the form's default stays editable.
 */
const DEV = import.meta.env.DEV;

function rememberedGateway() {
  let remembered: string | null = null;
  try { remembered = window.localStorage.getItem(GATEWAY_KEY); } catch { /* storage may be off */ }
  return defaultGatewayAddress({ location: window.location, remembered, dev: DEV });
}

/** The page `alp web` opened, connecting with the token from its address (it retries until alp web is up). */
function LinkConnecting() {
  const controller = useController();
  const { connection } = useAppState();
  return (
    <main className="flex min-h-full items-center justify-center bg-[radial-gradient(ellipse_at_top,_var(--glow)_0%,_var(--background)_55%)] px-4 py-10">
      <div className="w-full max-w-md space-y-4" data-testid="link-connecting">
        <div className="flex items-center gap-3">
          <Logo className="size-10" />
          <div>
            <h1 className="text-xl font-semibold tracking-tight">ALP</h1>
            <p className="text-sm text-muted-foreground">Opening ALP on this machine</p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner label="Connecting…" />
          {connection.attempt > 1 ? <span>Waiting for alp web (attempt {connection.attempt})</span> : null}
        </div>
        {connection.error ? <p className="text-sm text-muted-foreground">{connection.error.message}</p> : null}
        <Button size="sm" variant="ghost" onClick={() => controller.disconnect()}>Use another access token</Button>
      </div>
    </main>
  );
}

export function ConnectScreen() {
  const controller = useController();
  const { connection } = useAppState();
  // After a connection that failed (a link's refused token, too), the address it used.
  const [gateway, setGateway] = React.useState(() => connection.gateway || rememberedGateway());
  const [token, setToken] = React.useState('');
  const connecting = connection.phase === 'connecting';
  const error = connection.phase === 'failed' ? connection.error : undefined;
  // The address `alp web` opened is connecting with its token: nothing to type.
  if (connecting && connection.link) return <LinkConnecting />;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    try { window.localStorage.setItem(GATEWAY_KEY, gateway.trim()); } catch { /* storage may be off */ }
    controller.connect({ url: gateway, token });
  };

  return (
    <main className="flex min-h-full items-center justify-center bg-[radial-gradient(ellipse_at_top,_var(--glow)_0%,_var(--background)_55%)] px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-8 flex items-center gap-3">
          <Logo className="size-10" />
          <div>
            <h1 className="text-xl font-semibold tracking-tight">ALP</h1>
            <p className="text-sm text-muted-foreground">Connect to your agents on an ALP host</p>
          </div>
        </div>
        <form onSubmit={submit} className="space-y-5 rounded-xl border border-border bg-card/80 p-6 shadow-xl shadow-[var(--shadow)] backdrop-blur" aria-describedby={error ? 'connect-error' : undefined}>
          <div className="space-y-1.5">
            <Label htmlFor="gateway">Gateway address</Label>
            <Input id="gateway" name="gateway" inputMode="url" autoComplete="url" spellCheck={false} value={gateway} onChange={event => setGateway(event.target.value)} placeholder="https://alp.example.com" required disabled={connecting} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="token">Access token</Label>
            <Input id="token" name="token" type="password" autoComplete="off" spellCheck={false} value={token} onChange={event => setToken(event.target.value)} placeholder="alpgw1.…" required disabled={connecting} />
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <ShieldCheck aria-hidden className="mt-0.5 size-3.5 shrink-0 text-highlight" />
              Kept in this tab's memory only. Reloading or disconnecting forgets it.
            </p>
          </div>
          {error ? (
            <div id="connect-error" role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error.message}
            </div>
          ) : null}
          <Button type="submit" className="w-full" disabled={connecting || !gateway.trim() || !token.trim()}>
            {connecting ? <Spinner className="text-primary-foreground" label="Connecting…" /> : <><PlugZap aria-hidden /> Connect</>}
          </Button>
        </form>
        <details className="mt-5 rounded-lg border border-border/70 bg-card/40 px-4 py-3 text-sm text-muted-foreground">
          <summary className="flex cursor-pointer items-center gap-2 font-medium text-foreground/90"><KeyRound aria-hidden className="size-4" /> Getting a token</summary>
          <div className="mt-3 space-y-2">
            {servedByAlpWeb({ location: window.location, dev: DEV }) ? (
              <>
                <p>On this machine, run <code className="font-mono">alp web</code>: it opens this page with a link that signs you in. <code className="font-mono">alp web --print</code> prints the link instead, and <code className="font-mono">alp web rotate</code> replaces its token, signing out every open page.</p>
                <p>To use a standalone gateway instead, create a token for the workspaces you want to open, then start the gateway with this page's address as an allowed origin:</p>
              </>
            ) : (
              <p>On the ALP host, create a token for the workspaces you want to open here, then start the gateway with this page's address as an allowed origin:</p>
            )}
            <pre className="overflow-x-auto rounded-md bg-background px-3 py-2 font-mono text-xs text-foreground/90">{`alp-gateway credential create --label web \\
  --workspace /path/to/project
alp-gateway serve --origin ${typeof window === 'undefined' ? 'http://127.0.0.1:7435' : window.location.origin}`}</pre>
            <p>From another machine, use the host's HTTPS address, or an SSH tunnel to the gateway's port (127.0.0.1:7434 by default).</p>
          </div>
        </details>
      </div>
    </main>
  );
}
