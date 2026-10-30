import * as React from 'react';
import { useController } from './store';
import { Dialog } from '../components/ui/dialog';

/**
 * Create or remove a managed worktree (workspace.worktree.*), opened from the project's actions
 * menu in the sidebar: the dialog asks for a destination mapping (create) or confirms the removal.
 */
export function WorktreeDialog({
  workspaceId,
  managed,
  online,
  open,
  onClose
}: {
  workspaceId: string;
  managed: boolean;
  online: boolean;
  open: boolean;
  onClose: () => void;
}) {
  const controller = useController();
  const [busy, setBusy] = React.useState(false);
  const setOpen = (value: boolean) => { if (!value) onClose(); };
  const [mappings, setMappings] = React.useState<string[]>([]),
    [mapping, setMapping] = React.useState(''),
    [error, setError] = React.useState('');
  const prepare = async () => {
    setError('');
    if (managed) return;
    setBusy(true);
    try {
      const ids = await controller.worktreeOptions(workspaceId);
      setMappings(ids);
      setMapping(ids[0] ?? '');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    setBusy(true);
    try {
      if (await controller.mutateWorktree(managed ? 'remove' : 'create', workspaceId, managed ? undefined : mapping)) {
        setOpen(false);
        setError('');
      } else setError('The operation is not confirmed. Retry to reconcile.');
    } finally {
      setBusy(false);
    }
  };
  // Each opening reads the destinations afresh.
  React.useEffect(() => { if (open) void prepare(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
      <Dialog
        open={open}
        onClose={() => {
          if (!busy) setOpen(false);
        }}
        title={managed ? 'Remove managed worktree' : 'Create managed worktree'}
      >
        <p>
          {managed
            ? 'Delete this checkout’s files. Its Git branch remains. Saved sessions, active work, claims, leases, results and dirty files prevent removal.'
            : 'Create a clean checkout from the current committed HEAD in a host-approved destination.'}
        </p>
        {!managed ? (
          mappings.length ? (
            <label className="mt-2 block">
              Destination
              <select
                aria-label="Worktree destination"
                className="mt-1 w-full rounded border border-border bg-background p-1"
                value={mapping}
                onChange={(e) => setMapping(e.target.value)}
              >
                {mappings.map((id) => (
                  <option key={id}>{id}</option>
                ))}
              </select>
            </label>
          ) : (
            <p className="mt-2">
              {busy
                ? 'Loading destinations…'
                : 'Ask the host owner to configure a destination mapping and grant its ID to this credential.'}
            </p>
          )
        ) : null}
        {error ? (
          <p role="alert" className="mt-2">
            {error}
          </p>
        ) : null}
        <div className="mt-3 flex gap-3">
          <button type="button" disabled={busy || !online || (!managed && !mapping)} onClick={() => void apply()}>
            {busy ? 'Working…' : managed ? 'Delete checkout files' : 'Create checkout'}
          </button>
          <button type="button" disabled={busy} onClick={() => setOpen(false)}>
            Cancel
          </button>
        </div>
      </Dialog>
  );
}
