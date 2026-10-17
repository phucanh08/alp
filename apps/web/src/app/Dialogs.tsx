import * as React from 'react';
import type { SessionSummary } from '../lib/controller.js';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { Input, Label } from '../components/ui/input';
import { sessionName } from '../lib/format';
import { useAction, useController } from './store';

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
