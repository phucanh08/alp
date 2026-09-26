#!/usr/bin/env node
// Proves a relay deployment end to end: a throwaway daemon pairs through the relay, a headless
// Chrome opens the pairing link on the public web app, and the relay session has to stay up for
// the stability window. See docs/relay.md "Verifying a relay".
//
// The daemon runs from its own temp home on a free port and is always stopped and removed.
// The pairing link is a credential: it never reaches stdout, stderr, or the error messages.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_CLI = path.join(REPO_ROOT, "packages", "cli", "bin", "alp");
const REPO_CLI_BUILD = path.join(REPO_ROOT, "packages", "cli", "dist", "index.js");
const RESERVED_PORTS = new Set([6767, 6768, 6797]);
// A reachable relay accepts the daemon within seconds; don't wait the full step deadline for one
// that is down.
const RELAY_CONNECT_TIMEOUT_MS = 30_000;

// Daemon log messages this proof keys on (packages/server/src/server/relay-transport.ts and
// websocket-server.ts).
const RELAY_READY = "relay_control_connected";
const RELAY_LOST = "relay_control_disconnected";
const RELAY_FAILURES = new Set(["relay_error", RELAY_LOST]);
const CLIENT_HELLO = "Client connected via hello";
const DATA_CLOSED = "relay_data_disconnected";
const DATA_FAILURES = new Set([
  DATA_CLOSED,
  "relay_data_error",
  "relay_e2ee_error",
  "relay_e2ee_handshake_failed",
]);

class ProofError extends Error {}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const part = argv[i];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

const USAGE = `Usage: node scripts/prove-relay-prod.mjs [options]

  --relay-endpoint <host:port>  Relay to prove (default: relay-alp.anhlp.com:443)
  --relay-use-tls <true|false>  Default: true when the port is 443
  --base-url <url>              Web app that opens the pairing link (default: https://app-alp.anhlp.com)
  --timeout-ms <ms>             Deadline for each step (default: 120000)
  --stability-ms <ms>           How long the relay session must stay up (default: 30000)
  --cli <path>                  alp CLI that drives the daemon (default: this checkout, needs npm run build:server)
  --browser-channel <name>      Playwright channel (default: chrome; "none" uses bundled Chromium)
  --keep-log <path>             Copy the daemon log there before the temp home is removed
  --headed                      Show the browser`;

const args = parseArgs(process.argv);
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

const relayEndpoint =
  args["relay-endpoint"] ?? process.env.PASEO_RELAY_ENDPOINT ?? "relay-alp.anhlp.com:443";
const baseUrl = String(
  args["base-url"] ?? process.env.PASEO_APP_URL ?? "https://app-alp.anhlp.com",
).replace(/\/$/, "");
const timeoutMs = Number(args["timeout-ms"] ?? process.env.PASEO_PROVE_TIMEOUT_MS ?? 120_000);
const stabilityMs = Number(args["stability-ms"] ?? process.env.PASEO_PROVE_STABILITY_MS ?? 30_000);
const relayUseTls =
  args["relay-use-tls"] === undefined
    ? String(relayEndpoint).endsWith(":443")
    : String(args["relay-use-tls"]) === "true";
const browserChannel = args["browser-channel"] ?? "chrome";
const cliPath = typeof args.cli === "string" ? args.cli : null;

function usageError(message) {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}

if (typeof relayEndpoint !== "string" || !/^[^\s:]+:\d+$/.test(relayEndpoint)) {
  usageError(`--relay-endpoint must be host:port, got ${JSON.stringify(relayEndpoint)}.`);
}
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) usageError("--timeout-ms must be positive.");
if (!Number.isFinite(stabilityMs) || stabilityMs < 0) usageError("--stability-ms must be >= 0.");
if (!cliPath && !existsSync(REPO_CLI_BUILD)) {
  usageError(`${REPO_CLI_BUILD} is missing. Run npm run build:server first, or pass --cli <alp>.`);
}

function redact(text) {
  return String(text).replace(/#offer=[A-Za-z0-9_\-=.%]+/g, "#offer=<redacted>");
}

function log(message) {
  console.error(`[prove-relay] ${redact(message)}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- throwaway daemon -------------------------------------------------------------------------

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// The CLI must only ever see the temp home: drop every inherited PASEO_* setting so a stray
// PASEO_HOME, PASEO_HOST or PASEO_LISTEN cannot point it at a real daemon.
function cliEnvironment(home) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("PASEO_")),
  );
  env.PASEO_HOME = home;
  return env;
}

function runCli(home, cliArgs, { timeout = timeoutMs } = {}) {
  const command = cliPath ?? process.execPath;
  const commandArgs = [...(cliPath ? [] : [REPO_CLI]), ...cliArgs, "--home", home];
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: REPO_ROOT,
      env: cliEnvironment(home),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeout);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(
        new ProofError(`Could not run alp ${cliArgs.slice(0, 2).join(" ")}: ${error.message}`),
      );
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: signal ? 1 : code, signal, stdout, stderr });
    });
  });
}

function parseJsonOutput(result, what) {
  if (result.code !== 0) {
    const output = result.stderr.trim() || result.stdout.trim();
    throw new ProofError(`alp ${what} exited ${result.signal ?? result.code}: ${redact(output)}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new ProofError(`alp ${what} printed no JSON: ${redact(result.stdout.trim())}`);
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// --- daemon log -------------------------------------------------------------------------------

// The daemon writes its log file as pino JSON lines.
function parseLogLine(line) {
  if (!line.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(line);
    return { msg: String(parsed.msg ?? ""), fields: parsed };
  } catch {
    return null;
  }
}

async function readLogEntries(logPath) {
  let text;
  try {
    text = await readFile(logPath, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .map(parseLogLine)
    .filter((entry) => entry !== null);
}

function describeEntry(entry) {
  const { fields } = entry;
  const detail = fields.err?.message ?? fields.reason ?? fields.code ?? "";
  return redact(detail ? `${entry.msg} (${detail})` : entry.msg);
}

async function waitForLog(logPath, { from, check, what, failure, timeout = timeoutMs }) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const hit = check((await readLogEntries(logPath)).slice(from));
    if (hit) return hit;
    await sleep(500);
  }
  const failures = (await readLogEntries(logPath)).slice(from).filter(failure);
  const last = failures.findLast((entry) => entry.fields.err) ?? failures.at(-1);
  throw new ProofError(
    `${what} within ${timeout}ms${last ? `; last daemon error: ${describeEntry(last)}` : ""}.`,
  );
}

// A browser session through the relay is live from its hello until its relay data socket closes.
// The web app opens short-lived probe sessions first, so a close on its own is not a failure:
// the proof passes once one session has stayed live for the whole stability window.
function liveRelaySessions(entries) {
  const live = new Map();
  for (const entry of entries) {
    if (entry.msg === CLIENT_HELLO && entry.fields.transport === "relay") {
      live.set(String(entry.fields.relayConnectionId), entry);
    } else if (entry.msg === DATA_CLOSED) {
      live.delete(String(entry.fields.connectionId));
    }
  }
  return live;
}

async function waitForStableSession(logPath, from) {
  const firstSeen = new Map();
  const deadline = Date.now() + timeoutMs + stabilityMs;
  let entries = [];
  while (Date.now() < deadline) {
    entries = (await readLogEntries(logPath)).slice(from);
    const relayLost = entries.find((entry) => entry.msg === RELAY_LOST);
    if (relayLost) throw new ProofError(`Daemon lost the relay: ${describeEntry(relayLost)}.`);
    const live = liveRelaySessions(entries);
    for (const [id, hello] of live) {
      if (!firstSeen.has(id)) {
        firstSeen.set(id, Date.now());
        log(`browser session ${id} connected through the relay`);
      }
      if (Date.now() - firstSeen.get(id) >= stabilityMs) return hello;
    }
    await sleep(500);
  }
  const drops = entries.filter((entry) => DATA_FAILURES.has(entry.msg)).map(describeEntry);
  // The app gives up on a connection after 15 s (DEFAULT_CONNECT_TIMEOUT_MS in
  // packages/client/src/daemon-client.ts); a starved browser trips it mid-handshake.
  const routed = entries.filter((entry) => entry.msg === "relay_data_connected").length;
  const hint =
    routed > 0
      ? ` The relay routed the browser to the daemon ${routed} time(s); closes during the E2EE handshake usually mean the browser was too slow, so rerun on an idle machine.`
      : "";
  throw new ProofError(
    firstSeen.size === 0
      ? `Browser never held a session through the relay within ${timeoutMs + stabilityMs}ms${drops.length ? `; daemon saw: ${drops.join("; ")}` : ""}.${hint}`
      : `No browser session through the relay stayed up for ${stabilityMs}ms; ${firstSeen.size} opened, closes: ${drops.join("; ") || "none logged"}.`,
  );
}

// --- teardown ---------------------------------------------------------------------------------

const state = { home: null, pid: null, browser: null, logPath: null };
let teardownPromise = null;

function teardown() {
  teardownPromise ??= (async () => {
    if (state.browser) await state.browser.close().catch(() => undefined);
    if (state.home) {
      const stop = await runCli(state.home, ["daemon", "stop", "--force", "--json"], {
        timeout: 30_000,
      }).catch((error) => ({ code: 1, stderr: error.message, stdout: "" }));
      if (stop.code !== 0) log(`daemon stop failed: ${stop.stderr.trim() || stop.stdout.trim()}`);
    }
    if (state.pid && isAlive(state.pid)) {
      log(`daemon PID ${state.pid} survived stop; sending SIGKILL`);
      try {
        process.kill(state.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    if (state.logPath && typeof args["keep-log"] === "string") {
      await copyFile(state.logPath, args["keep-log"]).catch((error) => log(error.message));
    }
    if (state.home) await rm(state.home, { recursive: true, force: true });
    log(`teardown done: daemon PID ${state.pid ?? "none"} stopped, temp home removed`);
  })();
  return teardownPromise;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    log(`${signal} received, tearing down`);
    void teardown().finally(() => process.exit(130));
  });
}

// --- proof ------------------------------------------------------------------------------------

async function startDaemon() {
  const port = await findFreePort();
  if (RESERVED_PORTS.has(port))
    throw new ProofError(`Free port ${port} is a reserved daemon port.`);
  state.home = await mkdtemp(path.join(os.tmpdir(), "alp-relay-proof-"));
  const listen = `127.0.0.1:${port}`;
  const config = {
    version: 1,
    daemon: {
      listen,
      relay: { enabled: true, endpoint: relayEndpoint, useTls: relayUseTls },
      mcp: { enabled: false, injectIntoAgents: false },
    },
    // Voice features download local speech models into the home on first start.
    features: { dictation: { enabled: false }, voiceMode: { enabled: false } },
    app: { baseUrl },
    pluginsEnabled: false,
  };
  await writeFile(path.join(state.home, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  log(`throwaway daemon home ${state.home}, listen ${listen}, relay ${relayEndpoint}`);

  const timeoutSeconds = String(Math.ceil(timeoutMs / 1000));
  const started = parseJsonOutput(
    await runCli(state.home, ["daemon", "start", "--json", "--timeout", timeoutSeconds]),
    "daemon start",
  );
  state.pid = started.pid ?? null;
  if (started.action !== "started") {
    throw new ProofError(`alp daemon start reported ${started.action}; expected a fresh daemon.`);
  }
  if (started.listen !== listen) {
    throw new ProofError(`Daemon listens on ${started.listen}, expected ${listen}.`);
  }
  state.logPath = started.logPath;
  return started.logPath;
}

async function prove() {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;

  const logPath = await startDaemon();
  log(`daemon PID ${state.pid} up after ${elapsed()}ms`);

  await waitForLog(logPath, {
    from: 0,
    check: (entries) => entries.find((entry) => entry.msg === RELAY_READY),
    what: `Daemon did not connect to relay ${relayEndpoint}`,
    failure: (entry) => RELAY_FAILURES.has(entry.msg),
    timeout: Math.min(timeoutMs, RELAY_CONNECT_TIMEOUT_MS),
  });
  const relayReadyMs = elapsed();
  log(`daemon control socket connected to the relay after ${relayReadyMs}ms`);

  const offer = parseJsonOutput(
    await runCli(state.home, ["daemon", "pair", "--relay", "--json"]),
    "daemon pair",
  );
  if (typeof offer.url !== "string" || !offer.url.includes("#offer=")) {
    throw new ProofError("alp daemon pair returned no pairing link.");
  }
  if (!offer.url.startsWith(`${baseUrl}/`)) {
    throw new ProofError(`Pairing link is not on ${baseUrl}: ${redact(offer.url)}`);
  }

  const logOffset = (await readLogEntries(logPath)).length;
  state.browser = await chromium.launch({
    headless: !args.headed,
    ...(browserChannel === "none" ? {} : { channel: browserChannel }),
  });
  const page = await state.browser.newPage();
  // The web app also probes a daemon on localhost; keep it away from real daemons on this machine.
  const isLoopback = (url) => ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  await page.route(isLoopback, (route) => route.abort());
  await page.routeWebSocket(isLoopback, (socket) => socket.close());
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(redact(error.message)));
  page.on("console", (message) => {
    if (message.type() === "error") log(`[browser] ${message.text()}`);
  });

  await page.goto(offer.url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  log(`web app loaded after ${elapsed()}ms`);
  // The web app imports the offer, then leaves the link for /open-project.
  await page
    .waitForURL((url) => url.pathname === "/open-project", { timeout: timeoutMs })
    .catch(() => {
      throw new ProofError(
        `Web app did not import the pairing offer: still on ${redact(page.url())} after ${timeoutMs}ms.`,
      );
    });
  log(`web app imported the offer after ${elapsed()}ms`);

  const hello = await waitForStableSession(logPath, logOffset);
  const stableAtMs = elapsed();
  if (new URL(page.url()).origin !== new URL(baseUrl).origin) {
    throw new ProofError("Browser left the web app during the stability window.");
  }

  return {
    ok: true,
    relayEndpoint,
    relayUseTls,
    baseUrl,
    daemonVersion: hello.fields.daemonVersion ?? null,
    appVersion: hello.fields.appVersion ?? null,
    relayReadyMs,
    stableAtMs,
    stabilityMs,
    pageErrors,
  };
}

let exitCode = 0;
try {
  console.log(JSON.stringify(await prove(), null, 2));
} catch (error) {
  exitCode = 1;
  const reason = error instanceof ProofError ? error.message : (error?.stack ?? String(error));
  console.error(`FAIL: ${redact(reason)}`);
} finally {
  await teardown();
}
process.exit(exitCode);
