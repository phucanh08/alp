// Tool calls per detail type (t-7679.13, docs/paseo-parity.md): the fake Codex emits its native
// items (fileChange, webSearch, mcpToolCall, collabAgentToolCall, commandExecution), alpd maps
// them to typed details, and the stream shows each as Paseo does: a one-line row (label, path
// relative to the workspace, query, diff stat) that opens into its view (a numbered diff, a
// file with a line gutter, a sub-agent's task, an MCP call's input and output). Read, fetch and
// plan details have no Codex item; tests/tool-calls.test.js covers their rows.
import { expect, test } from '@playwright/test';
import { startWorld } from './support/world.js';
import { assistant, connect, idle, newSession, send } from './support/app.js';

/** @type {Awaited<ReturnType<typeof startWorld>>} */
let world;
test.beforeAll(async () => { world = await startWorld(); });
test.afterAll(async () => { await world?.close(); });

const tool = (page, kind) => page.locator(`[data-testid="tool-call"][data-tool-kind="${kind}"]`);
/** Opens a row and returns it. */
async function open(row) {
  await row.getByRole('button').first().click();
  await expect(row.getByRole('button').first()).toHaveAttribute('aria-expanded', 'true');
  return row;
}

test('each tool kind: its row and its view', async ({ page }) => {
  await connect(page, world);
  await newSession(page, 'Tool views');
  await send(page, 'Use every tool [tools]');
  await expect(assistant(page).last()).toContainText('Tools done.');
  await idle(page);

  // An edit: path relative to the workspace, "+2 −1", a diff with the hunk's line numbers.
  const edit = tool(page, 'edit');
  await expect(edit).toHaveCount(1);
  await expect(edit).toContainText('Edit');
  await expect(edit).toContainText('src/app.ts');
  await expect(edit.getByTestId('tool-diff-stat')).toHaveText('+2 −1');
  await open(edit);
  const diff = edit.getByTestId('tool-diff');
  await expect(diff.locator('[data-diff="add"]')).toHaveCount(2);
  await expect(diff.locator('[data-diff="remove"]')).toHaveCount(1);
  await expect(diff.locator('[data-diff="add"]').first()).toContainText('const code = run();');
  await expect(diff.locator('[data-diff="remove"]')).toContainText('run();');
  await expect(diff.locator('[data-diff="context"]').last()).toHaveText(/^3\s*4\s*export \{\};$/);

  // A new file: the Write row, its content with a line gutter.
  const write = tool(page, 'write');
  await expect(write).toContainText('Write');
  await expect(write).toContainText('notes/todo.md');
  await open(write);
  const content = write.getByTestId('tool-file-content');
  await expect(content).toContainText('- ship it');
  await expect(content.locator('.flex').nth(3)).toHaveText(/^4\s*- ship it$/);

  // A web search: the query on the row.
  const search = tool(page, 'search');
  await expect(search).toContainText('Search');
  await expect(search).toContainText('paseo tool call views');

  // An MCP tool: no typed detail, the tool's name and first argument, input and output inside.
  const mcp = page.getByTestId('tool-call').filter({ hasText: 'mcp__docs__lookup' });
  await expect(mcp).toHaveAttribute('data-tool-kind', 'unknown');
  await expect(mcp).toContainText('diff viewer');
  await open(mcp);
  await expect(mcp).toContainText('"topic": "diff viewer"');
  await expect(mcp).toContainText('Found 2 pages about the diff viewer');

  // A sub-agent: its type and task.
  const agent = tool(page, 'sub_agent');
  await expect(agent).toContainText('Sub-agent');
  await expect(agent).toContainText('Review the parser for edge cases');
  await open(agent);
  await expect(agent.getByTestId('tool-sub-agent-description')).toHaveText('Review the parser for edge cases');
});

test('a shell command keeps its view', async ({ page }) => {
  await connect(page, world);
  await newSession(page, 'Shell view');
  await send(page, 'List the files [tool]');
  await idle(page);
  const shell = tool(page, 'shell');
  await expect(shell).toContainText('Shell');
  await expect(shell).toContainText('ls -1 src');
  await open(shell);
  await expect(shell).toContainText('util.ts');
});
