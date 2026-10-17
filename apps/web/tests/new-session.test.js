// The New session screen's logic (lib/new-session.js): models with efforts, thinking options and
// labels, the effective model from a preview, the spec sent, the preview's rows and a title from
// the first message.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSpec, effectiveModel, startNewSession, effortLabel, effortOptions, initialChoices, normalizeModels, parsePreview, previewRows, resolveThinking, titleFromPrompt } from '../src/lib/new-session.js';

const models = normalizeModels([
  { id: 'codex:gpt-6.1-sol', label: 'codex · GPT-6.1-Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'low'], effort: 'low' },
  { id: 'claude:claude-haiku-4-5', label: 'claude · Haiku 4.5', efforts: [] },
  { id: 'claude:claude-opus-5', label: 'claude · Opus 5', efforts: ['off', 'high'], effort: 'ultra' },
  { id: 'codex:gpt-6.1-sol', label: 'duplicate' },
  { label: 'no id' }, null, 'x',
]);

test('library.models rows: ids kept once, efforts deduplicated, a usual effort only when offered', () => {
  assert.deepEqual(models, [
    { id: 'codex:gpt-6.1-sol', label: 'codex · GPT-6.1-Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], effort: 'low' },
    { id: 'claude:claude-haiku-4-5', label: 'claude · Haiku 4.5', efforts: [] },
    { id: 'claude:claude-opus-5', label: 'claude · Opus 5', efforts: ['off', 'high'] },
  ]);
  assert.deepEqual(normalizeModels(undefined), []);
});

test('thinking options and labels as Paseo formats them', () => {
  assert.deepEqual(effortOptions(models[0]).map(option => option.label), ['Low', 'Medium', 'High', 'Extra high', 'Max']);
  assert.deepEqual(effortOptions(models[1]), []);
  assert.deepEqual(effortOptions(undefined), []);
  assert.equal(effortLabel('ultracode'), 'Ultracode');
  assert.equal(effortLabel('x-high'), 'Extra high');
  assert.equal(resolveThinking(models[0], 'xhigh'), 'xhigh');
  assert.equal(resolveThinking(models[0], 'off'), undefined, 'an effort the model does not take is not sent');
  assert.equal(resolveThinking(models[1], 'low'), undefined);
  assert.equal(resolveThinking(undefined, 'low'), undefined);
});

test('the effective model: the chosen one, else the one the preview names as runtime:model', () => {
  assert.equal(effectiveModel(models, 'claude:claude-opus-5', undefined)?.label, 'claude · Opus 5');
  assert.equal(effectiveModel(models, undefined, { runtime: 'codex', model: 'gpt-6.1-sol' })?.id, 'codex:gpt-6.1-sol');
  assert.equal(effectiveModel(models, undefined, { runtime: 'acp', model: 'unknown' }), undefined);
  assert.equal(effectiveModel(models, undefined, undefined), undefined);
});

test('initial choices: remembered ones the workspace still offers, the default mode otherwise', () => {
  const catalog = { teams: [{ id: 'pho' }, { id: 'cafe' }], modes: [{ id: 'read-only' }, { id: 'full-access' }], models, defaultMode: 'full-access' };
  assert.deepEqual(initialChoices(catalog, {}), { mode: 'full-access' });
  assert.deepEqual(initialChoices(catalog, { team: 'cafe', mode: 'read-only', model: 'codex:gpt-6.1-sol', thinkingByModel: { 'codex:gpt-6.1-sol': 'high' } }),
    { team: 'cafe', mode: 'read-only', model: 'codex:gpt-6.1-sol', thinking: 'high' });
  // Gone team, mode outside the token's, unknown model, effort the model no longer takes.
  assert.deepEqual(initialChoices(catalog, { team: 'old', mode: 'workspace-write', model: 'codex:gone', thinkingByModel: { 'codex:gone': 'high' } }), { mode: 'full-access' });
  assert.deepEqual(initialChoices(catalog, { model: 'claude:claude-opus-5', thinkingByModel: { 'claude:claude-opus-5': 'max' } }), { mode: 'full-access', model: 'claude:claude-opus-5' });
  // The team default's thinking waits for the preview to name the model.
  assert.deepEqual(initialChoices(catalog, { thinkingByModel: { default: 'medium' } }), { mode: 'full-access', thinking: 'medium' });
});

test('the spec carries only allowed fields, empty choices left to the host', () => {
  assert.deepEqual(buildSpec('/w/a', {}), { cwd: '/w/a' });
  assert.deepEqual(buildSpec('/w/a', { team: 'cafe', mode: 'read-only', model: 'codex:gpt-6.1-sol', thinking: 'high' }, { persist: true }),
    { cwd: '/w/a', persist: true, workflow: 'cafe', mode: 'read-only', model: 'codex:gpt-6.1-sol', thinking: 'high' });
  assert.deepEqual(buildSpec('/w/a', /** @type {any} */ ({ team: '', title: 'x', prompt: 'y', agent: 'evil' })), { cwd: '/w/a' });
});

test('a preview: checked, then read as rows', () => {
  assert.equal(parsePreview(undefined), undefined);
  assert.equal(parsePreview({ preview: { team: 'pho' } }), undefined, 'no agent');
  const preview = parsePreview({ preview: { teams: [{ id: 'pho', label: 'Phở' }, { id: 7 }], team: 'pho', teamLabel: 'Phở', agent: 'main', runtime: 'codex', model: 'gpt-6.1-sol', mode: 'full-access', thinking: 'xhigh', extra: 1 } });
  assert.deepEqual(preview, { teams: [{ id: 'pho', label: 'Phở' }], team: 'pho', teamLabel: 'Phở', agent: 'main', runtime: 'codex', model: 'gpt-6.1-sol', mode: 'full-access', thinking: 'xhigh' });
  assert.deepEqual(previewRows(preview, models).map(row => [row.label, row.value]), [
    ['Team', 'Phở'], ['Agent', 'main'], ['Runtime', 'Codex'], ['Model', 'codex · GPT-6.1-Sol'], ['Thinking', 'Extra high'], ['Permissions', 'Full access'],
  ]);
  // Without a label or a known model, the ids; empty fields leave their row out.
  const bare = parsePreview({ preview: { teams: [], team: 'custom', agent: 'lead', runtime: 'acp', model: 'x/y', mode: '', thinking: '' } });
  assert.deepEqual(previewRows(bare).map(row => [row.label, row.value]), [['Team', 'custom'], ['Agent', 'lead'], ['Runtime', 'ACP'], ['Model', 'x/y']]);
});

test('a title from the first message: its first line, collapsed, at most 80 characters', () => {
  assert.equal(titleFromPrompt('\n  Fix   the login\tbug  \nwith details'), 'Fix the login bug');
  assert.equal(titleFromPrompt('   \n '), undefined);
  const long = 'é'.repeat(100);
  const title = titleFromPrompt(long);
  assert.equal([...title].length, 80);
  assert.ok(title.endsWith('…'));
});

test('the team a start sends: chosen, else the current preview\'s, else the first listed once the preview cannot answer; none only when the host has no team', async () => {
  const { startTeam, previewBase, failedStartNotice } = await import('../src/lib/new-session.js');
  const teams = [{ id: 'pho' }, { id: 'cafe' }];
  assert.deepEqual(startTeam({ chosen: 'cafe', previewTeam: 'pho', previewSettled: false, teams }), { team: 'cafe' });
  assert.deepEqual(startTeam({ previewTeam: 'pho', previewSettled: false, teams: [] }), { team: 'pho' });
  assert.match(startTeam({ previewSettled: false, teams }).wait, /Checking/);
  assert.deepEqual(startTeam({ previewSettled: true, teams }), { team: 'pho' });
  assert.match(startTeam({ previewSettled: true, previewError: 'denied', teams: [] }).wait, /Cannot tell which team.*denied/);
  assert.match(startTeam({ previewSettled: true, teams: [], teamsKnown: false }).wait, /Cannot tell/);
  assert.deepEqual(startTeam({ previewSettled: true, teams: [], teamsKnown: true }), {});
  // A preview is trusted for the model only when it answered the same team and model.
  assert.equal(previewBase({ workflow: 'pho', model: 'm', thinking: 'high', cwd: '/w' }), previewBase({ workflow: 'pho', model: 'm' }));
  assert.notEqual(previewBase({ workflow: 'pho' }), previewBase({}));
  assert.notEqual(previewBase({ workflow: 'pho', model: 'm' }), previewBase({ workflow: 'pho' }));
  assert.equal(failedStartNotice('Refused.', '  '), 'Refused.');
  assert.equal(failedStartNotice('Refused.', 'hi'), 'Refused. Your first message was not sent; it is back in the New session box.');
  assert.equal(failedStartNotice('Refused.', 'hi', 'shop'), 'Refused. Your first message was not sent; it is back in the New session box of shop.');
  assert.doesNotMatch(failedStartNotice('Refused.', 'x'.repeat(500)), /x{10}/, 'the text itself is re-seeded, not cut into the notice');
});

test('a start that cannot tell its team says why and what unblocks it, and never starts without one', async () => {
  const { startTeam } = await import('../src/lib/new-session.js');
  const stuck = input => {
    const result = startTeam({ previewSettled: true, teams: [], teamsKnown: false, ...input });
    assert.equal(result.team, undefined, 'fail closed: no create without a team');
    assert.equal(result.stuck, true);
    return result.wait;
  };
  // No project.read, and the preview blocked by a missing session.read: both grants named.
  const noRead = stuck({ teamsUnavailable: { reason: 'permission' }, previewBlocked: true, previewNeedsRead: true, previewError: 'Your access token cannot read sessions.' });
  assert.match(noRead, /lacks project\.read/);
  assert.match(noRead, /preview is not available \(Your access token cannot read sessions\)/);
  assert.match(noRead, /reconnect with a token that has project\.read or session\.read/);
  assert.doesNotMatch(noRead, /Retry/, 'retrying does not help a missing permission');
  // No team capability and a failed preview: Retry (the preview) is the way.
  const noCapability = stuck({ teamsUnavailable: { reason: 'capability' }, previewError: 'timed out.' });
  assert.match(noCapability, /does not list teams \(no team capability\)/);
  assert.match(noCapability, /preview failed \(timed out\)/);
  assert.match(noCapability, /use Retry in the preview/);
  // team.list failed: Retry asks it again even when the preview itself is blocked.
  const listFailed = stuck({ teamsUnavailable: { reason: 'failed', message: 'Gateway busy.' }, previewBlocked: true, previewNeedsRead: true, previewError: 'no session.read' });
  assert.match(listFailed, /team list failed \(Gateway busy\)/);
  assert.match(listFailed, /use Retry in the preview to ask again, or reconnect with a token that has session\.read/);
  // No capability and no preview possible for another reason: says what host would do.
  assert.match(stuck({ teamsUnavailable: { reason: 'capability' }, previewBlocked: true, previewError: 'Not connected.' }), /connect to a host that lists teams or previews sessions/);
  // Not stuck while the preview may still answer.
  assert.equal(startTeam({ previewSettled: false, teams: [], teamsUnavailable: { reason: 'permission' } }).stuck, undefined);
});

test('a New session start takes its workspace and connection before waiting on the host', async () => {
  let workspace = '/w/shop';
  const kept = [];
  const notices = [];
  const controller = {
    startOrigin: () => ({ workspace, connection: 7 }),
    // The person moves to another workspace while the host answers, then the start fails.
    createSession: async () => { workspace = '/w/other'; await Promise.resolve(); throw new Error('Refused.'); },
    keepUnsentDraft: (text, origin) => kept.push({ text, origin }),
    notify: (level, text) => notices.push({ level, text }),
  };
  const screen = { mounted: () => false, describe: error => ({ message: error.message }), nameOf: path => path.split('/').pop() };
  await assert.rejects(startNewSession(controller, { prompt: 'hi' }, 'hi', screen), /Refused/);
  assert.deepEqual(kept, [{ text: 'hi', origin: { workspace: '/w/shop', connection: 7 } }]);
  assert.deepEqual(notices, [{ level: 'error', text: 'Refused. Your first message was not sent; it is back in the New session box of shop.' }]);
  // Still open: the screen shows the failure itself; nothing is kept or announced.
  workspace = '/w/shop';
  await assert.rejects(startNewSession(controller, {}, 'hi', { ...screen, mounted: () => true }), /Refused/);
  assert.equal(kept.length, 1);
  assert.equal(notices.length, 1);
  // Started: the id comes back.
  controller.createSession = async () => 'S1';
  assert.equal(await startNewSession(controller, {}, 'hi', screen), 'S1');
});
