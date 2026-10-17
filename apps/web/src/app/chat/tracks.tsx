import * as React from 'react';
import { CheckCheck, CircleCheck, CircleSlash, Eye, Hand, ListTodo, LoaderCircle } from 'lucide-react';
import { Menu } from '../../components/ui/menu';
import { tasksTrack, type TaskState } from '../../lib/tracks.js';
import { cn } from '../../lib/utils';
import { useAppState, useController } from '../store';
import { useTabs } from '../tabs';

/**
 * The pills above Paseo's composer (composer/tracks.tsx). paseo-web shows ALP's tasks there
 * (integrations/paseo/client/task-pills.ts): the pill counts the tasks this session worked on
 * (done of them) or else the project's open tasks; its menu lists the session's tasks first,
 * then the other open ones, what waits for the user first, and All tasks.
 */

type State = TaskState;
const STATES: Record<State, { label: string; icon: React.ComponentType<{ className?: string }> }> = {
  approve: { label: 'Approve', icon: Hand }, review: { label: 'Review', icon: Eye }, progress: { label: 'In progress', icon: LoaderCircle },
  ready: { label: 'Ready', icon: CircleCheck }, blocked: { label: 'Blocked', icon: CircleSlash }, closed: { label: 'Done', icon: CheckCheck },
};
const MENU_LIMIT = 8;
const PILL_POLL_MS = 20_000;
type Worked = { id: string; text: string; status: string };

export const pillClass = 'inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-border bg-card px-3 text-[13px] text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-muted aria-expanded:text-foreground [&_svg]:size-3.5 [&_svg]:shrink-0';

/** ALP's Tasks pill, for the open session's main agent. */
export function TasksPill({ worked }: { worked: Worked[] }) {
  const controller = useController();
  const { tasks } = useAppState();
  const { openTask, openPanel } = useTabs();
  const blocked = controller.tasksBlock();
  // Read when the pill shows, on each opening and every 20 s as paseo-web's pill does; the
  // Tasks views poll faster on their own.
  React.useEffect(() => {
    if (blocked) return;
    void controller.refreshTasks({ quiet: true });
    const timer = window.setInterval(() => { if (controller.getState().connection.phase === 'open') void controller.refreshTasks({ quiet: true }); }, PILL_POLL_MS);
    return () => window.clearInterval(timer);
  }, [controller, blocked]);
  if (blocked) return null;
  const track = tasksTrack(worked, tasks.rows);
  const shown = track.lines.slice(0, MENU_LIMIT);
  const more = track.lines.length - MENU_LIMIT;
  return (
    <Menu label="Tasks" title={track.title} align="start" triggerClassName={cn(pillClass)}
      onOpenChange={open => { if (open) void controller.refreshTasks({ quiet: true }); }}
      trigger={<><ListTodo aria-hidden /><span className="truncate" data-testid="tasks-pill-label">{track.label}</span></>}
      items={[
        ...shown.map((line, index) => {
          const Icon = STATES[line.state].icon;
          return { id: `task:${line.id}`, label: `${STATES[line.state].label} · ${line.title}`, icon: <Icon aria-hidden />, onSelect: () => openTask(line.id), group: index === track.mine && index > 0 };
        }),
        { id: 'all-tasks', label: more > 0 ? `All tasks (${more} more)` : 'All tasks', icon: <ListTodo aria-hidden />, onSelect: () => openPanel('tasks'), group: shown.length > 0 },
      ]} />
  );
}
