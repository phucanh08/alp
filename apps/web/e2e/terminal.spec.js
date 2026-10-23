// The Terminal tab (#121 H, docs/protocol/alp-json-rpc-v1.md §12.10) through the real gateway and a
// real alpd with a real PTY: the host's owner allowed terminals (alp terminal allow --yes), alpd's
// shell is /bin/sh, and only the `terminal` credential holds terminal.exec. A person sees that the
// shell is not a sandbox, answers an interactive prompt, interrupts a command with Ctrl-C, resizes
// the window, reloads the page and loses the gateway (earlier output comes back, input still works),
// and ends the shell with `exit`. A token without terminal.exec gets the refusal and no terminal. No
// shell this spec started outlives the host.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { connect as hostConnect } from '@anhlp/alp-client';
import { startWorld } from './support/world.js';
import { connect } from './support/app.js';

test.describe.configure({ mode: 'serial' });

/** @type {Awaited<ReturnType<typeof startWorld>>} */
let world;
/** Every shell process alpd ran for this spec: none may outlive the host. */
const shells = new Map();
const run = promisify(execFile);

test.beforeAll(async () => {
  world = await startWorld({ terminal: true });
  // The host owner registers the workspace: a terminal opens in a registry workspace.
  const owner = await hostConnect(world.socket);
  try {
    const { revision } = await owner.request('project.list', {});
    await owner.request('project.register', { directory: world.projects.main, ifRevision: revision, requestId: 'terminal-e2e' });
  } finally { owner.close(); }
});
test.afterAll(async () => {
  await world?.close();
  // alpd is stopped: no shell (or its children) it started for this spec may still run.
  const alive = [...shells].filter(([pid]) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } });
  expect(alive.map(([pid, command]) => `${pid} ${command}`)).toEqual([]);
});

/** The processes below alpd now (the PTY shells and what they run), remembered for the final check. */
async function underDaemon() {
  const { stdout } = await run('/bin/ps', ['-A', '-o', 'pid=,ppid=,command=']);
  const rows = stdout.split('\n').map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map(match => ({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }));
  const found = [];
  const queue = [world.daemonPid];
  while (queue.length) {
    const parent = queue.shift();
    for (const row of rows) if (row.ppid === parent) { found.push(row); queue.push(row.pid); }
  }
  // What a terminal starts: not a fake Codex, nor alpd's own process listing (ps, which it runs to
  // find a terminal's process tree; briefly a zombie "(ps)").
  const ownHelper = row => row.command.includes('fake-codex') || /^(\(ps\)|(\/bin\/)?ps(\s|$))/.test(row.command);
  const terminalProcesses = found.filter(row => !ownHelper(row) && !found.some(parent => parent.pid === row.ppid && ownHelper(parent)));
  for (const row of terminalProcesses) shells.set(row.pid, row.command);
  return terminalProcesses;
}

const panel = page => page.getByTestId('terminal-panel');
const rows = page => page.getByTestId('terminal-screen').locator('.xterm-rows');
const screenText = async page => (await rows(page).innerText()).replace(/ /g, ' ');

/** Types a line into the terminal as a person does (xterm's own textarea takes the keys). */
async function typeLine(page, text) {
  await page.getByTestId('terminal-screen').click();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

/** The terminal's size as the shell sees it (stty size: rows cols). */
async function sttySize(page) {
  const marker = `SZ${Date.now() % 100000}`;
  await typeLine(page, `clear; echo ${marker}=$(stty size)`);
  let size;
  await expect.poll(async () => { size = (await screenText(page)).match(new RegExp(`${marker}=(\\d+) (\\d+)`)); return !!size; }).toBe(true);
  return { rows: Number(size[1]), cols: Number(size[2]) };
}

async function openTerminal(page) {
  await page.getByRole('button', { name: 'New tab' }).click();
  await page.getByRole('menuitem', { name: 'Terminal' }).click();
  await expect(page.getByRole('tab', { name: 'Terminal' })).toHaveAttribute('aria-selected', 'true');
}

test('a real shell on the host: notice, prompt, Ctrl-C, resize, reload, reconnect and exit', async ({ page }) => {
  test.setTimeout(180_000);
  await connect(page, world, world.tokens.terminal);
  await openTerminal(page);

  // Honest first: where the shell runs and that the workspace is not a sandbox, in full the first
  // time, and as a header line always.
  const notice = page.getByTestId('terminal-notice');
  await expect(notice).toContainText('This shell runs on the daemon host as the account that runs alpd.');
  await expect(notice).toContainText('The workspace is not a sandbox: the shell can read and write anything that account can, and use the network.');
  await expect(page.getByTestId('terminal-header')).toHaveText('Runs on the daemon host as the account that runs alpd · the workspace is not a sandbox');
  await expect(panel(page)).toHaveAttribute('data-status', 'running');
  await notice.getByRole('button', { name: 'Got it' }).click();
  await expect(notice).toBeHidden();
  await expect(page.getByTestId('terminal-header')).toBeVisible();
  expect((await underDaemon()).length).toBeGreaterThan(0);

  // An interactive prompt, answered.
  await typeLine(page, `printf 'name? '; read N; echo "hi $N"`);
  await expect(rows(page)).toContainText('name?');
  await page.keyboard.type('Ada');
  await page.keyboard.press('Enter');
  await expect(rows(page)).toContainText('hi Ada');

  // Ctrl-C interrupts the command: what it would print after never appears.
  await typeLine(page, 'sleep 30 && echo NOT-$((1))');
  await expect.poll(async () => (await underDaemon()).some(row => /sleep 30/.test(row.command))).toBe(true);
  await page.keyboard.press('Control+C');
  await expect.poll(async () => (await underDaemon()).some(row => /sleep 30/.test(row.command))).toBe(false);
  await typeLine(page, 'echo AFTER-$((1+1))');
  await expect(rows(page)).toContainText('AFTER-2');
  expect(await screenText(page)).not.toContain('NOT-1');

  // A smaller window: the shell sees the new size.
  const before = await sttySize(page);
  await page.setViewportSize({ width: 1000, height: 560 });
  await expect.poll(async () => { const now = await sttySize(page); return now.cols !== before.cols && now.rows !== before.rows; }, { timeout: 20_000 }).toBe(true);
  const after = await sttySize(page);
  expect(after.cols).toBeLessThan(before.cols);
  expect(after.rows).toBeLessThan(before.rows);
  await page.setViewportSize({ width: 1440, height: 900 });

  // A reload: the same terminal attaches again and replays what it printed; input still works.
  await typeLine(page, 'echo KEEP-$((3*3))');
  await expect(rows(page)).toContainText('KEEP-9');
  const shellsBefore = (await underDaemon()).map(row => row.pid).sort();
  await page.reload();
  await connect(page, world, world.tokens.terminal);
  await expect(page.getByRole('tab', { name: 'Terminal' })).toHaveAttribute('aria-selected', 'true');
  await expect(panel(page)).toHaveAttribute('data-status', 'running');
  await expect(rows(page)).toContainText('KEEP-9');
  // The notice was seen in this page session: the header line stays.
  await expect(page.getByTestId('terminal-notice')).toBeHidden();
  await expect(page.getByTestId('terminal-header')).toBeVisible();
  expect((await underDaemon()).map(row => row.pid).sort()).toEqual(shellsBefore);
  await typeLine(page, 'echo RELOADED-$((4*4))');
  await expect(rows(page)).toContainText('RELOADED-16');

  // The gateway restarts (the socket drops): the terminal reconnects after the last output seen,
  // output printed meanwhile comes back, and input works again.
  await typeLine(page, 'sleep 3; echo WHILE-AWAY-$((5*5))');
  // The line reached the shell (its sleep runs) before the socket drops.
  await expect.poll(async () => (await underDaemon()).some(row => /sleep 3/.test(row.command))).toBe(true);
  await world.restartGateway();
  await expect(rows(page)).toContainText('WHILE-AWAY-25', { timeout: 30_000 });
  await expect(panel(page)).toHaveAttribute('data-status', 'running');
  await typeLine(page, 'echo BACK-$((6*6))');
  await expect(rows(page)).toContainText('BACK-36');
  expect((await underDaemon()).map(row => row.pid).sort()).toEqual(shellsBefore);

  // exit ends the shell: the panel says so and takes no more input.
  await typeLine(page, 'exit 3');
  await expect(page.getByTestId('terminal-status')).toHaveText(/Process exited \(code 3\)/);
  await expect(panel(page)).toHaveAttribute('data-status', 'exited');
  await page.keyboard.type('echo NEVER');
  await page.keyboard.press('Enter');
  await expect(rows(page)).not.toContainText('NEVER');
  await expect.poll(async () => (await underDaemon()).length).toBe(0);

  // A new terminal, then closing its tab ends its shell on the host.
  await page.getByTestId('terminal-status').getByRole('button', { name: 'New terminal' }).click();
  await expect(panel(page)).toHaveAttribute('data-status', 'running');
  await typeLine(page, 'echo FRESH-$((7*7))');
  await expect(rows(page)).toContainText('FRESH-49');
  expect((await underDaemon()).length).toBeGreaterThan(0);
  await page.getByRole('tab', { name: 'Terminal' }).press('Delete');
  await expect(page.getByRole('tab', { name: 'Terminal' })).toHaveCount(0);
  await expect.poll(async () => (await underDaemon()).length, { timeout: 10_000 }).toBe(0);
});

test('a token without terminal.exec sees the refusal and no terminal', async ({ page }) => {
  await connect(page, world, world.tokens.owner);
  await openTerminal(page);
  const refused = page.getByTestId('terminal-refused');
  await expect(refused).toContainText('Your access token cannot open terminals (it needs terminal.exec)');
  // The host did allow terminals: that refusal is not shown.
  await expect(refused).not.toContainText('The host has not allowed remote terminals');
  await expect(page.getByTestId('terminal-screen')).toHaveCount(0);
  await expect(page.getByTestId('terminal-notice')).toHaveCount(0);
  expect(await underDaemon()).toEqual([]);
});
