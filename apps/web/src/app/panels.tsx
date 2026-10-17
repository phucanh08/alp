import { Bot, FileDiff, FolderTree, GitCompareArrows, ListTodo, SquareTerminal } from 'lucide-react';
import { members } from '../lib/timeline.js';
import { modeLabel } from '../lib/format';
import { cn } from '../lib/utils';
import { StatusIndicator } from './status';
import { useAppState } from './store';
import { Tasks } from './TaskBoard';
import { FilesPanel } from './FilesPanel';
import { useTabs } from './tabs';

/*
 * The panels a tab can show, in the explorer dock or the center column, as Paseo's: Changes,
 * Terminal and Diff (Paseo's own; this beta shows them unavailable, the gateway has no git or
 * terminal access yet), Files (read-only, with files.read: FilesPanel), and ALP's Agents and Tasks. Picking an agent or a task opens it
 * in a tab of the center column.
 */

export type PanelKind = 'changes' | 'terminal' | 'diff' | 'files' | 'agents' | 'tasks';

export const PANELS: Record<PanelKind, { label: string; icon: typeof Bot; unavailable?: string }> = {
  changes: { label: 'Changes', icon: FileDiff, unavailable: "The gateway has no git access yet, so this panel cannot show the workspace's changes. Use git on the host." },
  terminal: { label: 'Terminal', icon: SquareTerminal, unavailable: 'The gateway does not run terminals yet. Open a terminal on the host.' },
  diff: { label: 'Diff', icon: GitCompareArrows, unavailable: 'The gateway has no git access yet, so this panel cannot show a diff. Use git on the host.' },
  files: { label: 'Files', icon: FolderTree },
  agents: { label: 'Agents', icon: Bot },
  tasks: { label: 'Tasks', icon: ListTodo },
};

const focusRing = 'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset';
const row = cn('flex w-full min-w-0 items-start gap-2 rounded-lg py-2 pl-2 pr-3 text-left', focusRing);

function Agents({ onPicked }: { onPicked?: () => void }) {
  const { openAgent, active } = useTabs();
  const { tree } = useAppState();
  if (!tree) return <p className="px-4 py-6 text-sm text-muted-foreground">Open a session to see its agents.</p>;
  const list = members(tree.projection);
  const waiting = new Set(Object.values(tree.projection.questions).map(question => (question as any).sessionId));
  return (
    <ul className="p-2" aria-label="Agents in this session">
      {list.map(member => {
        const session = member.session;
        const root = member.id === tree.rootId;
        const current = active?.kind === 'agent' && active.id === member.id;
        const bucket = waiting.has(member.id) ? 'needs_input' : member.running ? 'running' : 'done';
        return (
          <li key={member.id} className={cn('mb-0.5 rounded-lg', current ? 'bg-sidebar-selected' : 'hover:bg-sidebar-hover', !root && 'ml-4')}>
            <button type="button" onClick={() => { openAgent(member.id); onPicked?.(); }} aria-current={current ? 'true' : undefined} className={row} data-testid="agent-row">
              <StatusIndicator bucket={bucket} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className={cn('truncate text-sm leading-5', current ? 'text-foreground' : 'text-foreground/80')}>{session?.agent ?? (root ? 'main' : 'agent')}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{member.closed ? 'closed' : member.running ? 'working' : 'idle'}</span>
                </span>
                <span className="block truncate text-xs text-muted-foreground">{[root ? 'main conversation' : 'assignment', modeLabel(session?.mode), session?.model].filter(Boolean).join(' · ')}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Paseo's empty panel: the panel's icon and name, centered, and why it is empty here. */
function Unavailable({ kind }: { kind: PanelKind }) {
  const panel = PANELS[kind];
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-2 p-6 text-center" role="note" data-testid={`panel-unavailable-${kind}`}>
      <panel.icon aria-hidden strokeWidth={1.5} className="size-6 text-extra-muted" />
      <p className="text-sm text-foreground">{panel.label} is not available in this beta</p>
      <p className="max-w-[300px] text-xs leading-5 text-muted-foreground">{panel.unavailable}</p>
    </div>
  );
}

/** A panel's content; `onPicked` runs after an agent or task was opened (an overlay closes). */
export function PanelView({ kind, onPicked }: { kind: PanelKind; onPicked?: () => void }) {
  if (kind === 'agents') return <Agents onPicked={onPicked} />;
  if (kind === 'tasks') return <Tasks onPicked={onPicked} />;
  if (kind === 'files') return <FilesPanel onPicked={onPicked} />;
  return <Unavailable kind={kind} />;
}
