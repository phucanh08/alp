import * as React from 'react';
import { describe } from '../../lib/errors.js';
import { HIDDEN, libraryContentParts } from '../../lib/library.js';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Spinner } from '../../components/ui/spinner';
import { baseName } from '../../lib/format';
import { cn } from '../../lib/utils';
import { useAppState, useController } from '../store';
import { Row, Section, Unavailable, focusRing } from './parts';

/*
 * Settings' library pages (t-a95b): the library (templates, agents, skills, hooks, MCP servers, and
 * the provider list Host › Providers shows) and Editor. Moved out of Settings.tsx
 * unchanged; the host owner's library actions are added here by later changes (group C).
 */

export function EditorPage() {
  return <Unavailable what="Editor" why="This app opens a workspace's files read only (the Files panel); changing them is the agents' work, or yours on the host." />;
}

export type LibraryKind = 'teams' | 'agents' | 'skills' | 'hooks' | 'mcp' | 'providers';

type LibraryEntry = Awaited<ReturnType<ReturnType<typeof useController>['getLibraryEntry']>>;

/** One entry's content, read only: Markdown files as text, configuration as JSON with secrets hidden. */
function LibraryEntryView({ kind, name, onClose }: { kind: LibraryKind; name: string; onClose: () => void }) {
  const controller = useController();
  const [state, setState] = React.useState<{ status: 'loading' | 'ready' | 'error'; entry?: LibraryEntry; error?: string }>({ status: 'loading' });
  React.useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    controller.getLibraryEntry(kind, name).then(
      entry => { if (live) setState({ status: 'ready', entry }); },
      error => { if (live) setState({ status: 'error', error: describe(error).message }); },
    );
    return () => { live = false; };
  }, [controller, kind, name]);
  const entry = state.entry;
  return (
    <Section title={name} action={<Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onClose}>Close</Button>}>
      <div data-testid="library-entry" aria-label={`${name} content`} role="group">
        {state.status === 'loading' ? <div className="p-4"><Spinner label="Loading…" className="text-xs" /></div> : null}
        {state.status === 'error' ? <p role="alert" className="p-4 text-xs text-destructive">{state.error}</p> : null}
        {entry ? (
          <>
            <Row first title="Source" hint={entry.usedBy.length ? `Used by ${entry.usedBy.join(', ')}` : undefined}>
              <span className="text-xs">{entry.source}{entry.overrides ? ` · overrides ${entry.overrides}` : ''}</span>
            </Row>
            {entry.librarySkills?.length ? <Row title="Skills the library gives it">{entry.librarySkills.join(', ')}</Row> : null}
            {libraryContentParts(entry.content).map(part => (
              <div key={part.key} className="border-t border-border p-4">
                <div className="mb-2 font-mono text-xs text-muted-foreground">{part.label}</div>
                <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-secondary p-3 font-mono text-xs text-foreground">{part.text}</pre>
              </div>
            ))}
            {entry.secrets.length ? <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">{entry.secrets.length === 1 ? 'One value that can hold a secret is' : `${entry.secrets.length} values that can hold secrets are`} shown as {HIDDEN}: the gateway keeps them on the host.</p> : null}
          </>
        ) : null}
      </div>
    </Section>
  );
}

/** Writes pure project instructions; executable and inherited entries stay on the host. */
function LibraryEditor({ kind, selected, onChanged }: { kind: LibraryKind; selected: string | null; onChanged: () => void }) {
  const controller = useController();
  const [name, setName] = React.useState('');
  const [target, setTarget] = React.useState('');
  const [content, setContent] = React.useState('');
  const [revision, setRevision] = React.useState<string | null>(null);
  const [ready, setReady] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  React.useEffect(() => {
    let live = true;
    setReady(false); setError(null); setNote(null); setTarget('');
    if (!selected) {
      setName(''); setRevision(null);
      setContent(JSON.stringify(kind === 'skills' ? { body: '' } : { instructions: '', config: { description: '' } }, null, 2));
      setReady(true);
    } else controller.getLibraryEntry(kind, selected).then(entry => {
      if (!live) return;
      if (entry.source !== 'project' || entry.overrides || entry.secrets.length || entry.revision === undefined) {
        setNote('This entry holds configuration the host runs or values kept on the host, so it is read only here.'); return;
      }
      setName(selected); setRevision(entry.revision); setContent(JSON.stringify(entry.content, null, 2)); setReady(true);
    }, failure => { if (live) setError(describe(failure).message); });
    return () => { live = false; };
  }, [controller, kind, selected]);
  const mutate = async (action: 'save' | 'delete' | 'duplicate' | 'rename') => {
    setBusy(true); setError(null);
    try {
      const params = action === 'save' ? { name, content: JSON.parse(content), revision } : action === 'delete' ? { name, revision } : { from: name, to: target };
      const result = await controller.writeLibrary(action, kind, params);
      if (action === 'save') setRevision(result.revision);
      if (action === 'delete' || action === 'rename') setReady(false);
      onChanged();
    } catch (failure) { setError(describe(failure).message); }
    finally { setBusy(false); }
  };
  return <Section title={selected ? 'Edit project instructions' : 'New project instructions'}>
    <div className="flex flex-col gap-3 p-4">
      <p className="text-xs text-muted-foreground">Agents and skills only. Host entries, executable configuration, references and extra files cannot be changed here.</p>
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      {note ? <p role="note" className="text-xs text-muted-foreground">{note}</p> : null}
      {ready ? <>
        <Input aria-label="Entry name" value={name} onChange={e => setName(e.target.value)} disabled={busy || !!selected} placeholder="Entry name" />
        <textarea aria-label="Instruction entry JSON" className="min-h-48 rounded border border-border bg-background p-2 font-mono text-xs" value={content} onChange={e => setContent(e.target.value)} disabled={busy} />
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy || !name.trim()} onClick={() => void mutate('save')}>Save project entry</Button>
          {selected ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => void mutate('delete')}>Delete project entry</Button> : null}
        </div>
        {selected ? <div className="flex flex-wrap gap-2">
          <Input aria-label="New entry name" value={target} onChange={e => setTarget(e.target.value)} placeholder="New name" disabled={busy} />
          <Button size="sm" variant="secondary" disabled={busy || !target.trim()} onClick={() => void mutate('duplicate')}>Duplicate</Button>
          <Button size="sm" variant="secondary" disabled={busy || !target.trim()} onClick={() => void mutate('rename')}>Rename</Button>
        </div> : null}
      </> : null}
    </div>
  </Section>;
}

export function LibraryPage({ kind, noun }: { kind: LibraryKind; noun: string }) {
  const controller = useController();
  const { workspace } = useAppState();
  const [state, setState] = React.useState<{ status: 'loading' | 'ready' | 'error'; entries: any[]; error?: string }>({ status: 'loading', entries: [] });
  const [open, setOpen] = React.useState<string | null>(null);
  const blocked = controller.libraryBlock();
  const load = React.useCallback(() => {
    let live = true;
    setState(current => ({ ...current, status: 'loading', error: undefined }));
    controller.listLibrary(kind).then(
      entries => { if (live) setState({ status: 'ready', entries }); },
      error => { if (live) setState({ status: 'error', entries: [], error: describe(error).message }); },
    );
    return () => { live = false; };
  }, [controller, kind]);
  React.useEffect(() => blocked ? undefined : load(), [load, blocked, workspace]);
  React.useEffect(() => { setOpen(null); }, [kind, workspace]);
  if (blocked) return <Unavailable what={`Listing ${noun}`} why={blocked} />;
  const opened = open ? state.entries.find(entry => entry.name === open) : undefined;
  const editable: string | null = opened && opened.source === 'project' && !opened.overrides ? opened.name : null;
  return (
    <>
      <Section title={workspace ? `As ${baseName(workspace)} sees them` : undefined}
        action={<Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => load()}>Refresh</Button>}>
        {state.status === 'loading' && !state.entries.length ? <div className="p-4"><Spinner label="Loading…" className="text-xs" /></div> : null}
        {state.status === 'error' ? <p role="alert" className="p-4 text-xs text-destructive">{state.error}</p> : null}
        {state.status === 'ready' && !state.entries.length ? <Row first title={`No ${noun}`} /> : null}
        {state.entries.map((entry, index) => (
          <button key={`${entry.source}:${entry.name}`} type="button" onClick={() => setOpen(current => current === entry.name ? null : entry.name)}
            aria-expanded={open === entry.name} data-testid={`library-row-${entry.name}`}
            className={cn('block w-full text-left hover:bg-sidebar-hover', focusRing, open === entry.name && 'bg-sidebar-hover')}>
            <Row first={index === 0} title={<span className="font-mono text-[length:calc(13px*var(--ui-scale))]">{entry.name}</span>}
              hint={[entry.description, entry.usedBy?.length ? `Used by ${entry.usedBy.join(', ')}` : ''].filter(Boolean).join(' · ') || undefined}>
              <span className="text-xs">{entry.source}{entry.overrides ? ` · overrides ${entry.overrides}` : ''}</span>
            </Row>
          </button>
        ))}
      </Section>
      {/* An entry from the host or the library (builtin, user, library) is read only: opening it
          to read keeps the New editor; this project's own entries open in the editor. */}
      {!controller.libraryWriteBlock(kind) ? <LibraryEditor key={`${kind}:${workspace}:${editable ?? 'new'}`} kind={kind} selected={editable} onChanged={() => load()} /> : null}
      {open ? <LibraryEntryView kind={kind} name={open} onClose={() => setOpen(null)} /> : null}
      {controller.libraryWriteBlock(kind) ? <Unavailable what={`Editing ${noun}`} why={`${controller.libraryWriteBlock(kind)} Open an entry to read it. Values that can hold secrets (environment, headers, MCP URLs and arguments, hook commands) show as ${HIDDEN}. Changes configure commands the host runs, so edit them on the host with alp.`} /> : null}
    </>
  );
}
