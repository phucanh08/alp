#!/usr/bin/env node
// What opt-in real-runtime tests outside the root package (apps/web's Playwright specs) need of the
// installed runtimes, as a command, so they import no runtime package: Codex's usage windows, and
// deleting a native thread a test made.
//
//   node test/e2e/native-threads.mjs usage codex           → {"windows":[{usedPercent,windowDurationMins}],"ok":bool}
//   node test/e2e/native-threads.mjs delete codex <threadId>
//   node test/e2e/native-threads.mjs delete claude <sessionId>
//
// `ok` is false unless every window is known and has more than 10% remaining.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodexTransport } from '@anhlp/alp-runtime';

const [action, runtime, id] = process.argv.slice(2);
const scratch = await mkdtemp(path.join(tmpdir(), 'alp-native-'));
try {
  if (action === 'usage' && runtime === 'codex') {
    const transport = new CodexTransport(process.env.ALP_CODEX_BIN ?? 'codex', scratch, process.env);
    try {
      await transport.initialize();
      const result = await transport.request('account/rateLimits/read', {});
      const windows = Object.values(result?.rateLimitsByLimitId ?? (result?.rateLimits ? { default: result.rateLimits } : {})).flatMap(limit => [limit?.primary, limit?.secondary].filter(Boolean));
      console.log(JSON.stringify({ windows: windows.map(window => ({ usedPercent: window.usedPercent, windowDurationMins: window.windowDurationMins })), ok: windows.length > 0 && windows.every(window => typeof window.usedPercent === 'number' && 100 - window.usedPercent > 10) }));
    } finally { await transport.close(); }
  } else if (action === 'delete' && runtime === 'codex' && id) {
    const transport = new CodexTransport(process.env.ALP_CODEX_BIN ?? 'codex', scratch, process.env);
    try {
      await transport.initialize();
      console.log(JSON.stringify(await transport.request('thread/delete', { threadId: id }).then(() => ({ deleted: true }), error => ({ deleted: false, error: error.message }))));
    } finally { await transport.close(); }
  } else if (action === 'delete' && runtime === 'claude' && id) {
    const { deleteSession } = await import('@anthropic-ai/claude-agent-sdk');
    console.log(JSON.stringify(await deleteSession(id).then(() => ({ deleted: true }), error => ({ deleted: false, error: error.message }))));
  } else {
    console.error('usage: native-threads.mjs usage codex | delete codex|claude <id>');
    process.exitCode = 2;
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
