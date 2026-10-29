#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync, appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const log = message => {
  if (process.env.FAKE_AGY_LOG) {
    appendFileSync(process.env.FAKE_AGY_LOG, (typeof message === 'string' ? message : JSON.stringify(message)) + '\n');
  }
};

// 1. Version check: agy --version
if (args.includes('--version')) {
  console.log('agy version 1.3.4 (fake)');
  process.exit(0);
}

// 2. Models list: agy models
if (args[0] === 'models') {
  if (process.env.FAKE_AGY_MODELS_FAIL) {
    process.exit(1);
  }
  const models = [
    'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
    'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
    'gemini-2.5-pro\tGemini 2.5 Pro',
  ];
  console.log(models.join('\n'));
  process.exit(0);
}

// 3. Stream-json session
const send = obj => process.stdout.write(JSON.stringify(obj) + '\n');

log({ op: 'start', args });
const conversationId = args.includes('--conversation') ? args[args.indexOf('--conversation') + 1] : crypto.randomUUID();
// Immediately emit init
send({
  event: 'init',
  conversation_id: conversationId,
  init: {
    conversation_id: conversationId,
    model: 'gemini-3.8-flash-high',
  },
});

async function callMcp(server, method, params) {
  const env = { ...process.env, ...(server.env || {}) };
  const child = spawn(server.command, server.args || [], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const replies = new Map();
  createInterface({ input: child.stdout }).on('line', line => {
    try {
      const message = JSON.parse(line);
      replies.get(message.id)?.(message);
    } catch {}
  });
  let seq = 0;
  const request = (methodName, methodParams) => new Promise(resolve => {
    const id = ++seq;
    replies.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: methodName, params: methodParams }) + '\n');
  });

  try {
    await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-agy', version: '1' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return await request(method, params);
  } finally {
    child.stdin.end();
    child.kill();
  }
}

function findAlpServer() {
  try {
    const configPath = process.env.ALP_AGY_MCP_CONFIG || path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json');
    const content = JSON.parse(readFileSync(configPath, 'utf8'));
    for (const [key, server] of Object.entries(content.mcpServers || {})) {
      if (key === 'alp' || key.startsWith('alp_')) return server;
    }
  } catch {}
  return null;
}

let stepIndex = 0;

const rl = createInterface({ input: process.stdin });
rl.on('line', async line => {
  log(line);
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }

  const content = parsed.message?.content || parsed.prompt || '';
  const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
  const commandLine = lines.findLast(l => /^(say|tools|call_tool|tool_step|fail|hang)\b/.test(l)) || lines.at(-1) || '';

  // tool_step JSON: a native tool step, ACTIVE then DONE (or ERROR when JSON has error), with JSON as its
  // tool_info ({name, parameters, output, error: {type, message}}).
  if (commandLine.startsWith('tool_step')) {
    const info = JSON.parse(commandLine.slice('tool_step'.length).trim());
    const idx = ++stepIndex;
    send({ event: 'step_update', step_update: { conversation_id: conversationId, step_type: 'tool', step_index: idx, state: 'ACTIVE', tool_name: info.name, tool_info: { name: info.name, parameters: info.parameters || {}, output: '', error: null } } });
    send({ event: 'step_update', step_update: { conversation_id: conversationId, step_type: 'tool', step_index: idx, state: info.error ? 'ERROR' : 'DONE', tool_name: info.name, tool_info: { name: info.name, parameters: info.parameters || {}, output: info.output || '', error: info.error || null } } });
    send({ event: 'step_update', step_update: { conversation_id: conversationId, step_type: 'agent_response', step_index: ++stepIndex, state: 'DONE', text_delta: 'done' } });
    send({ event: 'result', result: { conversation_id: conversationId, status: 'COMPLETED', response: 'done' } });
    return;
  }

  if (commandLine.startsWith('hang')) {
    // Wait until process is killed
    return;
  }

  if (commandLine.startsWith('fail')) {
    send({
      event: 'result',
      result: {
        conversation_id: conversationId,
        status: 'ERROR',
        error: 'fake failure',
      },
    });
    return;
  }

  if (commandLine.startsWith('tools')) {
    const alpServer = findAlpServer();
    let toolNames = 'none';
    if (alpServer) {
      const res = await callMcp(alpServer, 'tools/list', {});
      toolNames = (res?.result?.tools || []).map(t => t.name).join(',');
    }
    const idx = ++stepIndex;
    send({
      event: 'step_update',
      step_update: {
        step_type: 'agent_response',
        step_index: idx,
        state: 'ACTIVE',
        text_delta: `tools: ${toolNames}`,
        usage: { input_tokens: 10, output_tokens: 10 },
      },
    });
    send({
      event: 'step_update',
      step_update: {
        step_type: 'agent_response',
        step_index: idx,
        state: 'DONE',
        text_delta: '',
      },
    });
    send({
      event: 'result',
      result: {
        conversation_id: conversationId,
        status: 'COMPLETED',
        response: `tools: ${toolNames}`,
      },
    });
    return;
  }

  if (content.includes('call_tool')) {
    const match = /call_tool\s+(\S+)\s+(.+)/.exec(content);
    if (match) {
      const [, toolName, argsJson] = match;
      const alpServer = findAlpServer();
      let toolResult = '';
      if (alpServer) {
        const res = await callMcp(alpServer, 'tools/call', { name: toolName, arguments: JSON.parse(argsJson) });
        toolResult = JSON.stringify(res?.result || {});
      }
      const idx = ++stepIndex;
      send({
        event: 'step_update',
        step_update: {
          step_type: 'agent_response',
          step_index: idx,
          state: 'ACTIVE',
          text_delta: `tool ${toolName}: ${toolResult}`,
          usage: { input_tokens: 10, output_tokens: 10 },
        },
      });
      send({
        event: 'step_update',
        step_update: {
          step_type: 'agent_response',
          step_index: idx,
          state: 'DONE',
          text_delta: '',
        },
      });
      send({
        event: 'result',
        result: {
          conversation_id: conversationId,
          status: 'COMPLETED',
          response: `tool ${toolName}: ${toolResult}`,
        },
      });
      return;
    }
  }

  // Default: say TEXT
  const sayMatch = /^say\s+(.+)/.exec(commandLine);
  const text = sayMatch ? sayMatch[1] : (commandLine || 'ok');
  const idx = ++stepIndex;

  send({
    event: 'step_update',
    step_update: {
      step_type: 'agent_response',
      step_index: idx,
      state: 'ACTIVE',
      text_delta: text,
      usage: { input_tokens: 10, output_tokens: 15 },
    },
  });

  send({
    event: 'step_update',
    step_update: {
      step_type: 'agent_response',
      step_index: idx,
      state: 'DONE',
      text_delta: '',
    },
  });

  send({
    event: 'result',
    result: {
      conversation_id: conversationId,
      status: 'COMPLETED',
      response: text,
      duration_seconds: 1,
      num_turns: 1,
      usage: { input_tokens: 10, output_tokens: 15, total_tokens: 25 },
      ...(/^deny /.test(commandLine) ? { denied_actions: [{ action: 'write_file', display_name: 'WriteFile' }] } : {}),
    },
  });
});
