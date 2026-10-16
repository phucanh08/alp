import * as React from 'react';
import type { SessionSummary } from '../lib/controller.js';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { Input, Label, NativeSelect } from '../components/ui/input';
import { Spinner } from '../components/ui/spinner';
import { baseName, modeLabel, sessionName } from '../lib/format';
import { useAction, useAppState, useController } from './store';

export function NewSessionDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const controller = useController();
  const { catalog, workspace } = useAppState();
  const [team, setTeam] = React.useState('');
  const [mode, setMode] = React.useState('');
  const [model, setModel] = React.useState('');
  const [title, setTitle] = React.useState('');
  const create = useAction(React.useCallback((input: Parameters<typeof controller.createSession>[0]) => controller.createSession(input), [controller]));
  React.useEffect(() => {
    if (!open) return;
    setTeam(catalog.teams[0]?.id ?? '');
    setMode(catalog.defaultMode ?? catalog.modes[0]?.id ?? '');
    setModel('');
    setTitle('');
    create.clearError();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, catalog.status]);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const done = await create.run({ ...(team ? { team } : {}), ...(mode ? { mode } : {}), ...(model ? { model } : {}), ...(title.trim() ? { title: title.trim() } : {}) });
    if (done) onClose();
  };
  const selectedTeam = catalog.teams.find(entry => entry.id === team);
  return (
    <Dialog open={open} onClose={onClose} title="New session" description={workspace ? <>Runs on the host in <span className="font-mono text-foreground/90">{baseName(workspace)}</span>.</> : undefined}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button type="submit" form="new-session" disabled={create.pending || catalog.status === 'loading'}>{create.pending ? <Spinner className="text-primary-foreground" label="Starting…" /> : 'Start session'}</Button>
      </>}>
      <form id="new-session" onSubmit={submit} className="space-y-4">
        {catalog.status === 'loading' ? <Spinner label="Loading teams and modes…" className="text-xs" /> : null}
        {catalog.status === 'error' ? <p role="alert" className="text-xs text-destructive">{catalog.error?.message}</p> : null}
        <div className="space-y-1.5">
          <Label htmlFor="new-title">Title (optional)</Label>
          <Input id="new-title" value={title} onChange={event => setTitle(event.target.value)} maxLength={200} placeholder="What is this session about?" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="new-team">Team</Label>
            <NativeSelect id="new-team" value={team} onChange={event => setTeam(event.target.value)}>
              {catalog.teams.length ? catalog.teams.map(entry => <option key={entry.id} value={entry.id}>{entry.label}</option>) : <option value="">Host default</option>}
            </NativeSelect>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-mode">Permissions</Label>
            <NativeSelect id="new-mode" value={mode} onChange={event => setMode(event.target.value)}>
              {catalog.modes.map(entry => <option key={entry.id} value={entry.id}>{entry.label ?? modeLabel(entry.id)}</option>)}
            </NativeSelect>
          </div>
        </div>
        {selectedTeam?.description ? <p className="-mt-2 text-xs text-muted-foreground">{selectedTeam.description}</p> : null}
        <div className="space-y-1.5">
          <Label htmlFor="new-model">Main agent model</Label>
          <NativeSelect id="new-model" value={model} onChange={event => setModel(event.target.value)}>
            <option value="">Team default</option>
            {catalog.models.map(entry => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
          </NativeSelect>
        </div>
        {create.error ? <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{create.error}</p> : null}
      </form>
    </Dialog>
  );
}

export function RenameDialog({ session, onClose }: { session: SessionSummary | null; onClose: () => void }) {
  const controller = useController();
  const [title, setTitle] = React.useState('');
  const rename = useAction(React.useCallback((id: string, value: string) => controller.renameSession(id, value), [controller]));
  React.useEffect(() => { if (session) { setTitle(session.title ?? ''); rename.clearError(); } /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [session]);
  return (
    <Dialog open={!!session} onClose={onClose} title="Rename session"
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button type="submit" form="rename-session" disabled={rename.pending || !title.trim()}>Save</Button>
      </>}>
      <form id="rename-session" className="space-y-1.5" onSubmit={async event => { event.preventDefault(); if (session && await rename.run(session.id, title.trim())) onClose(); }}>
        <Label htmlFor="rename-title">Title</Label>
        <Input id="rename-title" value={title} onChange={event => setTitle(event.target.value)} maxLength={200} autoFocus />
        {rename.error ? <p role="alert" className="text-xs text-destructive">{rename.error}</p> : null}
      </form>
    </Dialog>
  );
}

export function ArchiveDialog({ session, onClose }: { session: SessionSummary | null; onClose: () => void }) {
  const controller = useController();
  const archive = useAction(React.useCallback((id: string) => controller.archiveSession(id), [controller]));
  React.useEffect(() => { if (session) archive.clearError(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [session]);
  return (
    <Dialog open={!!session} onClose={onClose} title="Archive session?"
      description={<>“{sessionName(session ?? undefined)}” stops and leaves the list. Its history stays on the host.</>}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="destructive" disabled={archive.pending} onClick={async () => { if (session && await archive.run(session.id)) onClose(); }}>Archive</Button>
      </>}>
      {archive.error ? <p role="alert" className="text-xs text-destructive">{archive.error}</p> : <p className="text-sm text-muted-foreground">Running work in this session is stopped.</p>}
    </Dialog>
  );
}
