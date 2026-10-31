import type { PluginClientContext } from '@getpaseo/plugin/client';
import { TasksPanel, TasksScreen } from './client/tasks-panel';
import { TASKS_SCREEN, addTaskPills, tasksScreen } from './client/task-pills';
import { LibrarySettings, ProjectLibraryPanel, TeamsSettings, AgentsSettings, SkillsSettings, HooksSettings, McpSettings } from './client/library';
import { UsageScreen } from './client/usage';
import { addCompactCommands } from './client/compact';

/**
 * ALP's client contributions: the Tasks panel of a workspace's project, the Tasks screen
 * with a pill in each ALP agent's composer that opens it (phones cannot reach panels),
 * the ALP settings screen for the user's library, and the "ALP project" panel for a
 * project's overrides.
 */
export default function contribute(client: PluginClientContext) {
  const removePanel = client.addWorkspacePanel({ id: 'alp-tasks', title: 'Tasks', icon: 'ListTodo', context: 'workspace', Component: TasksPanel });
  const removeScreen = client.addScreen({ id: TASKS_SCREEN, title: params => params.taskId ? `ALP task ${params.taskId}` : 'ALP tasks', Component: TasksScreen });
  const removePills = addTaskPills(client);
  const removeCommand = client.addCommandCenterItem({
    id: 'alp-open-tasks',
    title: 'Open ALP tasks',
    icon: 'ListTodo',
    keywords: ['tasks', 'todo', 'alp'],
    context: 'workspace',
    onSelect({ openPanel }) { openPanel('alp-tasks'); },
  });
  const removeScreenCommand = client.addCommandCenterItem({
    id: 'alp-open-tasks-screen',
    title: 'Open ALP tasks full screen',
    icon: 'ListTodo',
    keywords: ['tasks', 'todo', 'alp', 'phone'],
    context: 'workspace',
    onSelect({ workspace, openScreen }) { openScreen(tasksScreen(workspace.id, workspace.directory || workspace.projectRootPath)); },
  });
  // "/alp-tasks" opens the board, "/alp-tasks t-0003" that task; not "/tasks", which Claude Code has.
  const removeSlash = client.addSlashCommand({
    name: 'alp-tasks',
    description: 'Open the ALP tasks of this project',
    argumentHint: '[task id]',
    context: 'agent',
    onSubmit({ workspace, args, openScreen }) { openScreen(tasksScreen(workspace.id, workspace.directory || workspace.projectRootPath, args.trim() || undefined)); },
  });
  // Compact context (t-de1a): a command-center item and "/alp-compact" for an ALP agent.
  const removeCompact = addCompactCommands(client);
  const removeSettings = client.addSettingsScreen({ id: 'alp-settings', title: 'ALP', icon: 'Bot', Component: LibrarySettings });
  const removeHostSettings = [
    { id: 'alp-templates', title: 'Templates', icon: 'Users', Component: TeamsSettings },
    { id: 'alp-agents', title: 'Agents', icon: 'Bot', Component: AgentsSettings },
    { id: 'alp-skills', title: 'Skills', icon: 'BookOpen', Component: SkillsSettings },
    { id: 'alp-hooks', title: 'Hooks', icon: 'Webhook', Component: HooksSettings },
    { id: 'alp-mcp', title: 'MCP servers', icon: 'Plug', Component: McpSettings },
  ].map(screen => client.addSettingsScreen(screen));
  const removeUsage = client.addSettingsScreen({ id: 'alp-usage', title: 'Usage', icon: 'ChartNoAxesCombined', Component: UsageScreen });
  const removeUsagePanel = client.addWorkspacePanel({ id: 'alp-usage', title: 'Usage', icon: 'ChartNoAxesCombined', context: 'workspace', Component: UsageScreen });
  const removeProject = client.addWorkspacePanel({ id: 'alp-project', title: 'ALP project', icon: 'Bot', context: 'workspace', Component: ProjectLibraryPanel });
  return () => { removePanel(); removeScreen(); removePills(); removeCommand(); removeScreenCommand(); removeSlash(); removeCompact(); removeSettings(); removeHostSettings.forEach(remove => remove()); removeProject(); removeUsage(); removeUsagePanel(); };
}
