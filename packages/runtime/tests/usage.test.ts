// daemon.usage's provider shape (t-9116): Paseo's window ids and labels, plan label, details and
// balances mapped from real-shaped provider answers (Claude SDK get_usage / accountInfo, Codex
// app-server account/rateLimits/read / account/read, codex 0.171.0 schema), and the account email
// kept to usageReport (daemon.usage) and out of orchestrationContext (what agents see).
import test from 'node:test';
import assert from 'node:assert/strict';
import { usageAllows } from '@anhlp/alp-runtime';
import { claudeUsage, codexUsage, codexAccount, claudeAccount } from '@anhlp/alp-runtime/runtime-context';
import { providerUsage } from '@anhlp/alp-runtime/usage';
import { CodexTransport } from '@anhlp/alp-runtime/transport';
import { ClaudeTransport } from '@anhlp/alp-runtime/claude-transport';

// `any`: a usage report is a union of its available and unavailable shapes; the tests read the available one's fields.
type Json = any;

const EMAIL = 'private-owner@example.com';
const checkedAt = '2026-11-22T00:00:00.000Z';

/** SDKControlGetUsageResponse as Claude Code answers it on a Max plan (sdk.d.ts). */
const CLAUDE = {
  session: { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 0, total_lines_added: 0, total_lines_removed: 0, model_usage: {} },
  subscription_type: 'max',
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 11, resets_at: '2026-11-22T05:10:00.175478+00:00' },
    seven_day: { utilization: 45, resets_at: '2026-11-26T08:00:00.175501+00:00' },
    seven_day_oauth_apps: { utilization: 3, resets_at: '2026-11-26T08:00:00+00:00' },
    seven_day_opus: { utilization: 20, resets_at: '2026-11-26T08:00:00+00:00' },
    seven_day_sonnet: null,
    model_scoped: [
      { display_name: 'Opus', utilization: null, resets_at: '2026-11-26T09:00:00+00:00' },
      { display_name: 'Fable', utilization: 61, resets_at: '2026-11-26T08:00:00+00:00' },
    ],
    extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 4650, utilization: 93.01470588235294, currency: 'USD' },
  },
  behaviors: null,
};

/** GetAccountRateLimitsResponse: the default bucket and a model bucket, credits, a Plus plan. */
const window = (usedPercent: number, windowDurationMins: number, resetsAt: number) => ({ usedPercent, windowDurationMins, resetsAt });
const CODEX_MAIN = { limitId: 'codex', limitName: null, normalModelSlug: null, planType: 'plus', primary: window(42, 300, 1_800_000_000), secondary: window(7, 10080, 1_800_500_000),
  credits: { hasCredits: false, unlimited: false, balance: '0' }, spendControlReached: false, rateLimitReachedType: null, individualLimit: null };
const CODEX = {
  accountId: 'acct-PRIVATE', ordinaryUsageAllowed: true, rateLimits: CODEX_MAIN,
  rateLimitsByLimitId: {
    codex: CODEX_MAIN,
    codex_bengalfox: { limitId: 'codex_bengalfox', limitName: 'GPT-5.3-Codex-Spark', normalModelSlug: 'gpt-5.3-codex-spark', planType: 'plus', primary: window(100, 300, 1_800_000_100), secondary: { usedPercent: 4, windowDurationMins: null, resetsAt: null }, credits: null, spendControlReached: null },
  },
};
const CODEX_ACCOUNT = { account: { type: 'chatgpt', email: EMAIL, planType: 'plus', workspaceName: null }, requiresOpenaiAuth: true, userId: 'user-PRIVATE' };

test('Claude: Session, Weekly and one Weekly · <Model> per model, extra usage a detail and never a window', () => {
  const report: Json = claudeUsage(CLAUDE);
  assert.ok(!report.windows.some((item: Json) => item.name === 'extra_usage'), 'extra_usage is not a window of the report');
  assert.equal(report.extraUsage, true);
  const usage = providerUsage('claude', report, checkedAt);
  assert.deepEqual(usage.windows, [
    { name: 'five hour', usedPercent: 11, resetsAt: '2026-11-22T05:10:00.175Z', id: 'five_hour', label: 'Session' },
    { name: 'seven day', usedPercent: 45, resetsAt: '2026-11-26T08:00:00.175Z', id: 'weekly', label: 'Weekly' },
    // The legacy key and its model_scoped twin are one window: model_scoped wins, its null falls back.
    { name: 'seven day opus', usedPercent: 20, resetsAt: '2026-11-26T09:00:00.000Z', id: 'weekly:opus', label: 'Weekly · Opus' },
    { name: 'seven day fable', usedPercent: 61, resetsAt: '2026-11-26T08:00:00.000Z', id: 'weekly:fable', label: 'Weekly · Fable' },
  ]);
  assert.equal(usage.plan, 'max');
  assert.equal(usage.planLabel, 'Max');
  assert.deepEqual(usage.details, [{ id: 'extra_usage', label: 'Extra usage', value: 'Enabled' }]);
  assert.deepEqual(usage.balances, []);
  assert.equal(usage.account, null);
  assert.equal(usage.limited, false);
  assert.equal(providerUsage('claude', claudeUsage({ ...CLAUDE, rate_limits: { ...CLAUDE.rate_limits, extra_usage: { is_enabled: false, utilization: null } } })).details[0].value, 'Disabled');
  assert.deepEqual(providerUsage('claude', claudeUsage({ ...CLAUDE, rate_limits: { five_hour: CLAUDE.rate_limits.five_hour } })).details, [], 'no extra_usage, no detail');
});

test('Claude limit semantics: extra usage spent no longer reads as a limit; plan windows still do; model_scoped is not read', () => {
  const spent = claudeUsage({ ...CLAUDE, rate_limits: { ...CLAUDE.rate_limits, extra_usage: { is_enabled: true, utilization: 100 } } });
  assert.equal(usageAllows(spent), true);
  assert.equal(providerUsage('claude', spent).limited, false);
  const week = claudeUsage({ ...CLAUDE, rate_limits: { ...CLAUDE.rate_limits, seven_day: { utilization: 100, resets_at: null } } });
  assert.equal(usageAllows(week), false);
  assert.equal(providerUsage('claude', week).limited, true);
  const oauth = claudeUsage({ ...CLAUDE, rate_limits: { ...CLAUDE.rate_limits, seven_day_oauth_apps: { utilization: 100, resets_at: null } } });
  assert.equal(usageAllows(oauth), false, 'a window Paseo does not show still counts for the limit watch, as before');
  assert.equal(providerUsage('claude', oauth).limited, true);
  assert.ok(!providerUsage('claude', oauth).windows.some(item => /oauth/.test(item.name)), 'seven_day_oauth_apps is not shown, as in Paseo');
  const model = claudeUsage({ ...CLAUDE, rate_limits: { five_hour: { utilization: 10, resets_at: null }, model_scoped: [{ display_name: 'Fable', utilization: 100, resets_at: null }] } });
  assert.equal(usageAllows(model), true, 'model_scoped is not read by the limit watch');
});

test('Claude: model names that fold to one name are one window, as Paseo reconciles them', () => {
  const usage = providerUsage('claude', claudeUsage({ rate_limits_available: true, subscription_type: 'pro', rate_limits: { model_scoped: [
    { display_name: 'Fable Pro', utilization: 1, resets_at: null }, { display_name: 'fable_pro!', utilization: 2, resets_at: null },
  ] } }));
  // One normalized name is one limit (Paseo's isSameLimit without ids): the second entry updates the first.
  assert.deepEqual(usage.windows.map(item => [item.id, item.label, item.usedPercent]), [['weekly:fable_pro', 'Weekly · fable_pro!', 2]]);
  assert.equal(usage.planLabel, 'Pro');
});

test('Codex: the default bucket by length, another bucket scoped by its limit id, credits a balance, planType as is', () => {
  const report = codexUsage(CODEX);
  assert.equal(JSON.stringify(report).includes('PRIVATE'), false);
  const usage = providerUsage('codex', report, checkedAt);
  assert.deepEqual(usage.windows, [
    { name: '5 hour window', usedPercent: 42, resetsAt: '2027-01-15T08:00:00.000Z', id: 'five_hour', label: '5-hour' },
    { name: '7 day window', usedPercent: 7, resetsAt: '2027-01-21T02:53:20.000Z', id: 'weekly', label: 'Weekly' },
    { name: 'GPT-5.3-Codex-Spark · 5 hour window', usedPercent: 100, resetsAt: '2027-01-15T08:01:40.000Z', id: 'limit:codex_bengalfox:five_hour', label: 'GPT-5.3-Codex-Spark · 5-hour' },
    { name: 'GPT-5.3-Codex-Spark · Window 2', usedPercent: 4, resetsAt: null, id: 'limit:codex_bengalfox:unknown_secondary', label: 'GPT-5.3-Codex-Spark · Secondary limit' },
  ]);
  assert.equal(usage.planLabel, 'plus');
  assert.deepEqual(usage.balances, [{ id: 'credits', label: 'Credits', remaining: 0, unlimited: false }]);
  assert.deepEqual(usage.details, []);
  assert.equal(usage.limited, true, 'a used-up bucket still makes the provider limited');
  assert.deepEqual(providerUsage('codex', codexUsage({ rateLimits: { ...CODEX_MAIN, credits: { hasCredits: true, unlimited: true, balance: null } } })).balances,
    [{ id: 'credits', label: 'Credits', remaining: null, unlimited: true }]);
  assert.deepEqual(providerUsage('codex', codexUsage({ rateLimits: { ...CODEX_MAIN, credits: null } })).balances, []);
  // Without rateLimitsByLimitId the snapshot is the default bucket, as before.
  assert.deepEqual(providerUsage('codex', codexUsage({ rateLimits: { ...CODEX_MAIN, limitId: null } })).windows.map(item => item.id), ['five_hour', 'weekly']);
});

test('an unavailable provider answers the new fields empty', () => {
  for (const runtime of ['codex', 'claude'] as const) {
    const usage = providerUsage(runtime, undefined, checkedAt);
    assert.deepEqual({ ...usage, runtime: undefined }, { runtime: undefined, available: false, checkedAt, plan: null, planLabel: null, limited: false, windows: [], details: [], balances: [], account: null });
  }
});

test('account emails: read from account/read and accountInfo only', () => {
  assert.deepEqual(codexAccount(CODEX_ACCOUNT), { email: EMAIL });
  assert.equal(codexAccount({ account: { type: 'apiKey' }, requiresOpenaiAuth: true }), null);
  assert.equal(codexAccount(undefined), null);
  assert.deepEqual(claudeAccount({ email: EMAIL, subscriptionType: 'max' }), { email: EMAIL });
  assert.equal(claudeAccount({ apiProvider: 'bedrock' }), null);
  assert.deepEqual(providerUsage('codex', codexUsage(CODEX), checkedAt, codexAccount(CODEX_ACCOUNT)).account, { email: EMAIL });
});

test('Codex: orchestrationContext carries no email; usageReport does, for daemon.usage', async () => {
  const requests: string[] = [];
  const fake = { request: async (method: string, params: unknown) => {
    requests.push(method);
    if (method === 'model/list') return { data: [] };
    if (method === 'account/rateLimits/read') return CODEX;
    if (method === 'account/read') { assert.deepEqual(params, { refreshToken: false }); return CODEX_ACCOUNT; }
    throw new Error(`unexpected ${method}`);
  } };
  const context: Json = await CodexTransport.prototype.orchestrationContext.call(fake);
  assert.ok(!requests.includes('account/read'), 'orchestrationContext never reads the account');
  assert.doesNotMatch(JSON.stringify(context), /private-owner|PRIVATE|email/);
  assert.equal(context.usage.credits.balance, 0);
  const report = await CodexTransport.prototype.usageReport.call(fake);
  assert.deepEqual(report.account, { email: EMAIL });
  assert.doesNotMatch(JSON.stringify(report.usage), /private-owner|PRIVATE|email/);
  const failing = await CodexTransport.prototype.usageReport.call({ request: async () => { throw new Error(`bad ${EMAIL}`); } });
  assert.deepEqual(failing, { usage: { available: false }, account: null });
});

test('Claude: orchestrationContext carries no email; usageReport does, for daemon.usage', async () => {
  let asked = 0;
  const query = {
    supportedModels: async () => [],
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => CLAUDE,
    accountInfo: async () => { asked++; return { email: EMAIL, organization: 'Org PRIVATE', subscriptionType: 'max' }; },
  };
  const context: Json = await ClaudeTransport.prototype.orchestrationContext.call({ query });
  assert.equal(asked, 0, 'orchestrationContext never reads the account');
  assert.doesNotMatch(JSON.stringify(context), /private-owner|PRIVATE|email/);
  assert.deepEqual(context.usage.models.map((model: Json) => model.name), ['Opus', 'Fable']);
  const report = await ClaudeTransport.prototype.usageReport.call({ query });
  assert.deepEqual(report.account, { email: EMAIL });
  assert.doesNotMatch(JSON.stringify(report.usage), /private-owner|PRIVATE|email/);
  const missing = await ClaudeTransport.prototype.usageReport.call({ query: { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => CLAUDE } });
  assert.equal(missing.account, null, 'an SDK without accountInfo answers no account');
});

test('the limit watch reads orchestrationContext, never usageReport: no email on that path', async t => {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { createAlpRuntime } = await import('@anhlp/alp-runtime');
  const { fakeTransport, until } = await import('../../../test/support/fake-agent.ts');
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-usage-watch-'));
  const file = path.join(directory, 'pause.json');
  await writeFile(file, JSON.stringify({ runtimes: { codex: { since: new Date().toISOString(), by: 'alpd', reason: 'Codex usage limit reached', resetsAt: new Date(Date.now() + 3_600_000).toISOString() } } }));
  let accounts = 0;
  let reads = 0;
  const factory = fakeTransport([]);
  const runtime = createAlpRuntime({ supervisor: false, pauseFile: file, limitCheckMs: 20,
    // The fake's factory ignores the transport arguments; the runtime passes them all the same.
    transport: (...args) => Object.assign((factory as (...passed: unknown[]) => ReturnType<typeof factory>)(...args), {
      async orchestrationContext() { reads++; return { usage: codexUsage(CODEX) }; },
      async usageReport() { accounts++; return { usage: codexUsage(CODEX), account: codexAccount(CODEX_ACCOUNT) }; },
    }),
  });
  t.after(async () => { await runtime.shutdown(); await rm(directory, { recursive: true, force: true }); });
  // CODEX has a used-up bucket, so the watch keeps reading and the pause stays.
  await until(() => reads >= 2, 'two limit checks');
  assert.equal(accounts, 0, 'the limit watch never asks for the account');
  assert.ok(runtime.pauses().runtimes.codex);
  const { providers } = await runtime.usage(true, true);
  assert.equal(accounts, 2, 'daemon.usage asks each runtime once');
  assert.deepEqual(providers.find(provider => provider.runtime === 'codex')!.account, { email: EMAIL });
  assert.equal((await runtime.usage()).providers.find(provider => provider.runtime === 'codex')!.account, null, 'no email unless asked');
});
