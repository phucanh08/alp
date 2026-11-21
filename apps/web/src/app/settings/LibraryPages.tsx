import * as React from 'react';
import { describe } from '../../lib/errors.js';
import { HIDDEN, libraryContentParts } from '../../lib/library.js';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Spinner } from '../../components/ui/spinner';
import { baseName } from '../../lib/format';
import { cn } from '../../lib/utils';
import { useAppState, useController, useOwner } from '../store';
import {
  BLOCKING_HOOK_EVENTS, HOOK_EVENTS, SCOPE_LABELS, deleteOwnerEntry, getOwnerEntry, hookContent, hookForm, mcpContent, mcpForm, ownScopeEntry, reviewRows, saveOwnerEntry, testOwnerEntry,
  type HookForm, type McpForm, type OwnerKind, type OwnerScope, type SecretRow,
} from '../../lib/owner-library.js';
import { Row, Section, Unavailable, focusRing } from './parts';

/*
 * Settings' library pages (t-a95b): the library (templates, agents, skills, hooks, MCP servers, and
 * the provider list Host › Providers shows) and Editor. The host owner's own dashboard (state.owner)
 * edits, tests and removes entries of this host's library and of the project (OwnerLibraryEditor below,
 * host.library.*); every other token keeps the project-instruction editor below, under library.write,
 * exactly as before (docs/alp/dashboard.md §4.8).
 */

/**
 * Settings › Editor: where files are edited. The host owner's own dashboard edits workspace text
 * files in the Files panel (host.files.write, docs/alp/dashboard.md §4.8); any other token reads them
 * only. The app has no editor preference of its own: the code font and size are Appearance's.
 */
export function EditorPage() {
  const owner = useOwner();
  if (!owner) return <Unavailable what="Editor" why="This app opens a workspace's files read only (the Files panel); changing them is the agents' work, or yours on the host. Opening ALP on the host itself (ALP.app or alp dashboard) lets you edit them here." />;
  return (
    <Section title="Editing files">
      <Row first title="Where" hint="Open a file from the Files panel of a workspace, then choose Edit. Save (or ⌘/Ctrl+S) writes it on this host.">
        <span className="text-xs" data-testid="editor-owner">On, for you on this host</span>
      </Row>
      <Row title="Never overwrites other edits" hint="A save is written only while the file still holds the text you opened. If an agent or another editor changed it, nothing is written and the app says so; your edit stays in the editor." />
      <Row title="What can be saved" hint="Existing UTF-8 text files of the workspace, up to 1 MB. .git, .alp, .env files, keys and credential files, and anything reached through a link are never written. The file is replaced in one step, keeping its permissions." />
      <Row title="Font and size" hint="The editor uses the code font and code size of Settings › Appearance." />
    </Section>
  );
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
  const owner = useOwner();
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
      {owner && kind !== 'providers' ? (
        <OwnerLibraryEditor key={`${kind}:${workspace}:${open ?? 'new'}`} kind={kind} noun={noun} selected={opened ? { name: opened.name, source: opened.source } : null} onChanged={() => load()} onClose={() => setOpen(null)} />
      ) : null}
      {/* An entry from the host or the library (builtin, user, library) is read only: opening it
          to read keeps the New editor; this project's own entries open in the editor. */}
      {!owner && !controller.libraryWriteBlock(kind) ? <LibraryEditor key={`${kind}:${workspace}:${editable ?? 'new'}`} kind={kind} selected={editable} onChanged={() => load()} /> : null}
      {open ? <LibraryEntryView kind={kind} name={open} onClose={() => setOpen(null)} /> : null}
      {!owner && controller.libraryWriteBlock(kind) ? <Unavailable what={`Editing ${noun}`} why={`${controller.libraryWriteBlock(kind)} Open an entry to read it. Values that can hold secrets (environment, headers, MCP URLs and arguments, hook commands) show as ${HIDDEN}. Changes configure commands the host runs, so edit them on the host with alp.`} /> : null}
    </>
  );
}

// ---- the host owner's editor (host.library.*) --------------------------------------------------

const field = 'rounded border border-border bg-background px-2 py-1 text-sm';
const label = 'flex flex-col gap-1 text-xs text-muted-foreground';

/** A new entry's content, as `alp <kind> new` starts one. */
function blankContent(kind: OwnerKind, name: string): Record<string, unknown> {
  const id = name || 'name';
  if (kind === 'agents') return { instructions: `# ${id}\n\nDescribe what this agent does, and how.\n`, config: { description: '' } };
  if (kind === 'skills') return { body: `---\nname: ${id}\ndescription: "What ${id} does. Use when the work it is for comes up."\n---\n\n# ${id}\n` };
  if (kind === 'teams') return { team: { label: id, main: 'main', members: { main: {} }, delegation: {} } };
  if (kind === 'hooks') return { hook: { event: 'turn.end', command: '' } };
  return { server: { command: '' } };
}

/** Name/value rows; a kept value shows the mask and a Replace button, never its text. */
function SecretRows({ title, rows, onChange, disabled }: { title: string; rows: SecretRow[]; onChange: (rows: SecretRow[]) => void; disabled: boolean }) {
  const set = (index: number, row: SecretRow) => onChange(rows.map((other, at) => at === index ? row : other));
  return (
    <fieldset className="flex flex-col gap-2" aria-label={title}>
      <legend className="mb-1 text-xs text-muted-foreground">{title}</legend>
      {rows.map((row, index) => (
        <div key={index} className="flex flex-wrap items-center gap-2" data-testid={`secret-row-${row.key || index}`}>
          <Input aria-label={`${title} name ${index + 1}`} value={row.key} onChange={event => set(index, { ...row, key: event.target.value })} disabled={disabled} className="h-8 w-40 font-mono text-xs" placeholder="NAME" />
          {row.value === null ? (
            <>
              <span className="font-mono text-xs text-muted-foreground" data-testid="secret-kept">{HIDDEN}</span>
              <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={disabled} onClick={() => set(index, { ...row, value: '' })}>Replace</Button>
            </>
          ) : (
            <Input aria-label={`${title} value ${index + 1}`} type="password" autoComplete="off" value={row.value} onChange={event => set(index, { ...row, value: event.target.value })} disabled={disabled} className="h-8 w-56 font-mono text-xs" placeholder="value" />
          )}
          <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={disabled} aria-label={`Remove ${title.toLowerCase()} ${row.key || index + 1}`} onClick={() => onChange(rows.filter((_, at) => at !== index))}>Remove</Button>
        </div>
      ))}
      <div><Button size="sm" variant="secondary" className="h-7 text-xs" disabled={disabled} onClick={() => onChange([...rows, { key: '', value: '' }])}>Add {title.toLowerCase().replace(/s$/, '')}</Button></div>
    </fieldset>
  );
}

function McpFields({ form, onChange, disabled }: { form: McpForm; onChange: (form: McpForm) => void; disabled: boolean }) {
  return (
    <div className="flex flex-col gap-3">
      <label className={label}>Transport
        <select aria-label="Transport" className={field} value={form.transport} disabled={disabled} onChange={event => onChange({ ...form, transport: event.target.value as McpForm['transport'] })}>
          <option value="command">Command (stdio)</option><option value="url">URL (HTTP)</option>
        </select>
      </label>
      {form.transport === 'command' ? (
        <>
          <label className={label}>Command<Input aria-label="Command" value={form.command} disabled={disabled} onChange={event => onChange({ ...form, command: event.target.value })} className="font-mono text-xs" placeholder="npx" /></label>
          <label className={label}>Arguments, one per line<textarea aria-label="Arguments" className={cn(field, 'min-h-16 font-mono text-xs')} value={form.args} disabled={disabled} onChange={event => onChange({ ...form, args: event.target.value })} /></label>
          <label className={label}>Directory (optional)<Input aria-label="Directory" value={form.cwd} disabled={disabled} onChange={event => onChange({ ...form, cwd: event.target.value })} className="font-mono text-xs" /></label>
          <SecretRows title="Environment variables" rows={form.env} disabled={disabled} onChange={env => onChange({ ...form, env })} />
        </>
      ) : (
        <>
          <label className={label}>URL<Input aria-label="URL" value={form.url} disabled={disabled} onChange={event => onChange({ ...form, url: event.target.value })} className="font-mono text-xs" placeholder="https://" /></label>
          <SecretRows title="Headers" rows={form.headers} disabled={disabled} onChange={headers => onChange({ ...form, headers })} />
        </>
      )}
    </div>
  );
}

function HookFields({ form, onChange, disabled }: { form: HookForm; onChange: (form: HookForm) => void; disabled: boolean }) {
  const canBlock = BLOCKING_HOOK_EVENTS.includes(form.event);
  return (
    <div className="flex flex-col gap-3">
      <label className={label}>Description<Input aria-label="Description" value={form.description} disabled={disabled} onChange={event => onChange({ ...form, description: event.target.value })} /></label>
      <label className={label}>Event
        <select aria-label="Event" className={field} value={form.event} disabled={disabled} onChange={event => onChange({ ...form, event: event.target.value, blocking: form.blocking && BLOCKING_HOOK_EVENTS.includes(event.target.value) })}>
          {HOOK_EVENTS.map(event => <option key={event} value={event}>{event}</option>)}
        </select>
      </label>
      <label className={label}>Command (a shell line)<Input aria-label="Hook command" value={form.command} disabled={disabled} onChange={event => onChange({ ...form, command: event.target.value })} className="font-mono text-xs" /></label>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input type="checkbox" aria-label="Blocking" checked={form.blocking} disabled={disabled || !canBlock} onChange={event => onChange({ ...form, blocking: event.target.checked })} />
        Blocking: a failure refuses the action{canBlock ? '' : ` (only ${BLOCKING_HOOK_EVENTS.join(', ')})`}
      </label>
      <div className="flex flex-wrap gap-3">
        <label className={label}>Timeout (s)<Input aria-label="Timeout seconds" value={form.timeoutSec} disabled={disabled} onChange={event => onChange({ ...form, timeoutSec: event.target.value.replace(/[^\d.]/g, '') })} className="h-8 w-24" /></label>
        <label className={label}>Only for agent<Input aria-label="Only for agent" value={form.matchAgent} disabled={disabled} onChange={event => onChange({ ...form, matchAgent: event.target.value })} className="h-8 w-40" /></label>
        <label className={label}>Only for label<Input aria-label="Only for label" value={form.matchLabel} disabled={disabled} onChange={event => onChange({ ...form, matchLabel: event.target.value })} className="h-8 w-40" /></label>
      </div>
    </div>
  );
}

type Loaded = { content: Record<string, any>; revision: string | null; exists: boolean };

/**
 * The host owner's editor for one kind (host.library.*): an entry of this host's library or of the
 * open project; MCP servers and hooks as forms, other kinds as their content JSON. Save opens a
 * review of what the host will run, and writes only from there. A hidden value stays hidden: the
 * save sends alpd's keep marker for it, unless a new value was typed.
 */
export function OwnerLibraryEditor({ kind, noun, selected, onChanged, onClose }: { kind: LibraryKind; noun: string; selected: { name: string; source: string } | null; onChanged: () => void; onClose: () => void }) {
  const controller = useController();
  const { workspace } = useAppState();
  const ownerKind = kind as OwnerKind;
  const [scope, setScope] = React.useState<OwnerScope>(selected?.source === 'project' ? 'project' : 'library');
  const [name, setName] = React.useState(selected?.name ?? '');
  const [loaded, setLoaded] = React.useState<Loaded | null>(null);
  const [mcp, setMcp] = React.useState<McpForm>(() => mcpForm(undefined));
  const [hook, setHook] = React.useState<HookForm>(() => hookForm(undefined));
  const [json, setJson] = React.useState('');
  const [review, setReview] = React.useState<{ content: Record<string, unknown>; rows: Array<[string, string]> } | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const [tested, setTested] = React.useState<Record<string, any> | null>(null);
  const projectRoot = workspace ?? undefined;

  const fill = React.useCallback((content: Record<string, any>) => {
    setMcp(mcpForm(content)); setHook(hookForm(content)); setJson(JSON.stringify(content, null, 2));
  }, []);

  // The entry of exactly this scope (its revision), else the one that applies, copied into it.
  React.useEffect(() => {
    let live = true;
    setError(null); setReview(null); setConfirmDelete(false); setTested(null);
    if (!selected) { setLoaded({ content: blankContent(ownerKind, name), revision: null, exists: false }); fill(blankContent(ownerKind, name)); return; }
    setLoaded(null);
    (async () => {
      const own = await ownScopeEntry(controller, { kind: ownerKind, name: selected.name, scope, ...(projectRoot ? { projectRoot } : {}) });
      const entry = own.entry ?? await getOwnerEntry(controller, { kind: ownerKind, name: selected.name, ...(projectRoot ? { projectRoot } : {}) });
      if (!live) return;
      setLoaded({ content: entry.content ?? {}, revision: own.revision, exists: !!own.entry });
      fill(entry.content ?? {});
      setNote(own.entry ? null : `Not in ${SCOPE_LABELS[scope].toLowerCase()} yet: saving puts a copy there, made from the entry that applies now (${entry.source ?? 'unknown'}).`);
    })().catch(failure => { if (live) setError(describe(failure).message); });
    return () => { live = false; };
    // name is read for a new entry's blank content only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, ownerKind, selected?.name, scope, projectRoot, fill]);

  const content = (): Record<string, unknown> => {
    if (kind === 'mcp') return mcpContent(mcp);
    if (kind === 'hooks') return hookContent(hook);
    let parsed: unknown;
    try { parsed = JSON.parse(json); } catch { throw new Error('The content is not valid JSON.'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The content is a JSON object.');
    return parsed as Record<string, unknown>;
  };
  const startReview = () => {
    setError(null);
    try {
      if (!name.trim()) throw new Error('Name the entry first.');
      const next = content();
      setReview({ content: next, rows: reviewRows(ownerKind, name.trim(), scope, next) });
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  };
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await work(); } catch (failure) { setError(describe(failure).message); } finally { setBusy(false); }
  };
  const save = () => run(async () => {
    if (!review || !loaded) return;
    const result = await saveOwnerEntry(controller, { kind: ownerKind, name: name.trim(), scope, ...(projectRoot ? { projectRoot } : {}), content: review.content, revision: loaded.revision });
    const fresh = await getOwnerEntry(controller, { kind: ownerKind, name: name.trim(), scope, ...(projectRoot ? { projectRoot } : {}) });
    setLoaded({ content: fresh.content ?? {}, revision: typeof result?.revision === 'string' ? result.revision : fresh.revision ?? null, exists: true });
    fill(fresh.content ?? {});
    setReview(null); setNote(`Saved ${name.trim()} in ${SCOPE_LABELS[scope].toLowerCase()}.`);
    onChanged();
  });
  const remove = () => run(async () => {
    if (!loaded?.revision) return;
    await deleteOwnerEntry(controller, { kind: ownerKind, name: name.trim(), scope, ...(projectRoot ? { projectRoot } : {}), revision: loaded.revision });
    setConfirmDelete(false); onChanged(); onClose();
  });
  const test = () => run(async () => {
    setTested(null);
    setTested(await testOwnerEntry(controller, { kind: kind as 'mcp' | 'hooks', name: name.trim(), ...(loaded?.exists ? { scope } : {}), ...(projectRoot ? { projectRoot } : {}) }));
  });

  const disabled = busy || !loaded;
  return (
    <Section title={selected ? `Edit ${selected.name}` : `New ${noun.replace(/s$/, '')}`} action={selected ? <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onClose}>New</Button> : undefined}>
      <div className="flex flex-col gap-3 p-4" data-testid="owner-library-editor">
        <p className="text-xs text-muted-foreground">You are on this host: changes are saved in its library or in this project, as <code className="font-mono">alp {kind === 'mcp' ? 'mcp' : kind.replace(/s$/, '')} {selected ? 'edit' : kind === 'mcp' || kind === 'hooks' ? 'add' : 'new'}</code> does. Values kept hidden stay as stored unless you replace them.</p>
        {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
        {note ? <p role="status" className="text-xs text-muted-foreground">{note}</p> : null}
        <div className="flex flex-wrap gap-3">
          <label className={label}>Name<Input aria-label="Entry name" value={name} onChange={event => setName(event.target.value)} disabled={disabled || !!selected} className="h-8 w-56" placeholder="name" /></label>
          <label className={label}>Saved in
            <select aria-label="Saved in" className={field} value={scope} disabled={busy || (!projectRoot && scope === 'library')} onChange={event => setScope(event.target.value as OwnerScope)}>
              <option value="library">{SCOPE_LABELS.library}</option>
              {projectRoot ? <option value="project">{SCOPE_LABELS.project}</option> : null}
            </select>
          </label>
        </div>
        {!loaded && !error ? <Spinner label="Loading…" className="text-xs" /> : null}
        {loaded && !review ? (
          kind === 'mcp' ? <McpFields form={mcp} onChange={setMcp} disabled={disabled} />
            : kind === 'hooks' ? <HookFields form={hook} onChange={setHook} disabled={disabled} />
            : <textarea aria-label={`${noun} entry JSON`} className={cn(field, 'min-h-48 font-mono text-xs')} value={json} onChange={event => setJson(event.target.value)} disabled={disabled} />
        ) : null}
        {review ? (
          <div className="rounded-md border border-border" role="group" aria-label="Review before saving" data-testid="owner-library-review">
            <p className="border-b border-border px-3 py-2 text-xs text-foreground">This is what will be saved, and what the host will run:</p>
            <dl className="divide-y divide-border">
              {review.rows.map(([term, value]) => (
                <div key={term} className="flex gap-3 px-3 py-1.5 text-xs"><dt className="w-32 shrink-0 text-muted-foreground">{term}</dt><dd className="min-w-0 break-all font-mono">{value}</dd></div>
              ))}
            </dl>
          </div>
        ) : null}
        {loaded ? (
          <div className="flex flex-wrap gap-2">
            {review ? (
              <>
                <Button size="sm" disabled={busy} onClick={() => { void save(); }}>Confirm and save</Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setReview(null)}>Back</Button>
              </>
            ) : (
              <>
                <Button size="sm" disabled={disabled} onClick={startReview}>Review and save…</Button>
                {loaded.exists && !confirmDelete ? <Button size="sm" variant="secondary" disabled={disabled} onClick={() => setConfirmDelete(true)}>Delete…</Button> : null}
                {confirmDelete ? <Button size="sm" variant="destructive" disabled={disabled} onClick={() => { void remove(); }}>Delete {name} from {SCOPE_LABELS[scope].toLowerCase()}</Button> : null}
                {confirmDelete ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmDelete(false)}>Keep it</Button> : null}
                {(kind === 'mcp' || kind === 'hooks') && selected ? <Button size="sm" variant="secondary" disabled={disabled} onClick={() => { void test(); }} title={kind === 'mcp' ? 'Starts the server and lists its tools (alp mcp test)' : 'Runs the hook once with a sample payload (alp hook test)'}>Test saved entry</Button> : null}
              </>
            )}
          </div>
        ) : null}
        {busy ? <Spinner label="Working…" className="text-xs" /> : null}
        {tested ? <TestResult kind={kind} result={tested} /> : null}
      </div>
    </Section>
  );
}

function TestResult({ kind, result }: { kind: LibraryKind; result: Record<string, any> }) {
  const lines: string[] = [];
  if (kind === 'mcp') {
    lines.push(`${result.server?.name ?? 'server'} ${result.server?.version ?? ''} offers ${Array.isArray(result.tools) ? result.tools.length : 0} tools`);
    for (const tool of Array.isArray(result.tools) ? result.tools : []) lines.push(`  ${tool.name}${tool.description ? `  ${String(tool.description).split('\n')[0]}` : ''}`);
  } else {
    lines.push(`${result.timedOut ? 'timed out' : `exit ${result.exitCode ?? result.signal}`} in ${result.durationMs} ms${result.wouldBlock ? '; as a blocking hook it would refuse the action' : ''}`);
    if (typeof result.stdout === 'string' && result.stdout.trim()) lines.push(`stdout: ${result.stdout.trim()}`);
    if (typeof result.stderr === 'string' && result.stderr.trim()) lines.push(`stderr: ${result.stderr.trim()}`);
  }
  return (
    <div role="status" aria-label="Test result" data-testid="owner-library-test" data-ok={result.ok ? 'true' : 'false'} className="rounded-md border border-border p-3">
      <p className={cn('mb-1 text-xs', result.ok ? 'text-foreground' : 'text-destructive')}>{result.ok ? 'Test passed' : 'Test failed'}</p>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">{lines.join('\n')}</pre>
    </div>
  );
}
