import * as React from 'react';
import { ArrowLeft, ListTodo, PanelLeft, X } from 'lucide-react';
import { baseName } from '../lib/format';
import { cn } from '../lib/utils';
import { Tasks } from './TaskBoard';
import { TaskDetail } from './TaskDetail';
import { useAppState } from './store';
import { isEditable } from '../lib/shortcuts.js';

const focusRing = 'outline-none focus-visible:ring-2 focus-visible:ring-ring';
const headerButton = cn('flex size-8 shrink-0 items-center justify-center rounded-lg text-extra-muted hover:bg-secondary hover:text-foreground [&_svg]:size-[18px]', focusRing);

/**
 * ALP's Tasks screen, as the alp-provider plugin opens it in Paseo's app with "Open ALP tasks full
 * screen" (integrations/paseo, docs/alp/paseo-plugin.md): the project's task board in place of the
 * workspace (the sidebar stays, as in Paseo's app; on a phone that is the whole screen), with its
 * List, Board and Epics views, filters and search (TaskBoard.tsx). Its header's close button (or
 * Escape) goes back to the workspace. A task picked from the board shows beside it when the
 * screen is 820 px wide or more, in place of it otherwise, where the detail's back arrow shows
 * the board again.
 */
export function TasksScreen({ navOpen, onToggleNav, onClose }: { navOpen: boolean; onToggleNav: () => void; onClose: () => void }) {
  const { workspace } = useAppState();
  const [task, setTask] = React.useState<string | null>(null);
  const close = React.useRef<HTMLButtonElement>(null);
  const region = React.useRef<HTMLElement>(null);
  React.useEffect(() => {
    close.current?.focus();
    // Back in the workspace, the focus goes to the focused pane's tab in front.
    return () => { setTimeout(() => document.querySelector<HTMLElement>('[data-focused="true"] [role="tab"][aria-selected="true"]')?.focus(), 0); };
  }, []);
  // Escape goes back (from the detail on a narrow screen, else to the workspace), from anywhere but
  // a field with text in it, a menu or a dialog.
  const latest = React.useRef({ task, onClose });
  latest.current = { task, onClose };
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      const target = event.target as HTMLElement | null;
      if (isEditable(target) && (target as HTMLInputElement).value) return;
      if (document.querySelector('dialog[open], [role="menu"], [data-modal-overlay]')) return;
      event.preventDefault();
      if (latest.current.task && !wide(region.current)) setTask(null); else latest.current.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <section aria-label="ALP tasks" data-testid="alp-tasks-screen" ref={region}
      className="flex min-h-0 flex-1 flex-col bg-background text-foreground">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-2 md:h-9 md:px-3">
        <button type="button" aria-label={navOpen ? 'Close sessions' : 'Open sessions'} aria-expanded={navOpen} title="Toggle sidebar" onClick={onToggleNav} className={cn(headerButton, 'md:-ml-1.5')}>
          <PanelLeft aria-hidden strokeWidth={1.5} />
        </button>
        <ListTodo aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <h1 className="min-w-0 truncate text-sm">ALP tasks</h1>
        {workspace ? <span className="min-w-0 truncate text-xs text-muted-foreground md:text-sm" title={workspace}>{baseName(workspace)}</span> : null}
        <span className="flex-1" />
        <button ref={close} type="button" className={headerButton} aria-label="Close tasks" title="Close" onClick={onClose} data-testid="alp-tasks-screen-close">
          <X aria-hidden strokeWidth={1.5} />
        </button>
      </header>
      <div className="@container flex min-h-0 flex-1">
        {/* The board takes the whole width; a picked task takes three fifths of it from 820 px, as the plugin's. */}
        <div className={cn('min-h-0 min-w-0 overflow-y-auto', task ? 'hidden @[820px]:block @[820px]:w-2/5 @[820px]:shrink-0 @[820px]:border-r @[820px]:border-border' : 'flex-1')}>
          <Tasks onOpen={setTask} current={task} />
        </div>
        {task ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex h-10 shrink-0 items-center border-b border-border px-2 @[820px]:hidden">
              <button type="button" className={cn(headerButton, 'w-auto gap-1.5 px-2 text-sm text-muted-foreground')} onClick={() => setTask(null)} aria-label="Back to tasks">
                <ArrowLeft aria-hidden /> Tasks
              </button>
            </div>
            <TaskDetail key={task} id={task} onOpenTask={setTask} />
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** Whether the board is wide enough for the detail beside the list. */
const wide = (element: HTMLElement | null) => (element?.getBoundingClientRect().width ?? 0) >= 820;
