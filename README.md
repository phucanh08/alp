<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="packages/website/public/alp-wordmark-on-dark.svg">
    <img src="packages/website/public/alp-wordmark-on-light.svg" alt="alp" width="220">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/phucanh08/alp/stargazers">
    <img src="https://img.shields.io/github/stars/phucanh08/alp?style=flat&logo=github" alt="GitHub stars">
  </a>
  <a href="https://github.com/phucanh08/alp/releases">
    <img src="https://img.shields.io/github/v/release/phucanh08/alp?style=flat&logo=github" alt="GitHub release">
  </a>
  <a href="https://x.com/moboudra">
    <img src="https://img.shields.io/badge/%40moboudra-555?logo=x" alt="X">
  </a>
  <a href="https://discord.gg/jz8T2uahpH">
    <img src="https://img.shields.io/badge/Discord-555?logo=discord" alt="Discord">
  </a>
  <a href="https://www.reddit.com/r/PaseoAI/">
    <img src="https://img.shields.io/badge/Reddit-555?logo=reddit" alt="Reddit">
  </a>
</p>

<p align="center"><em>A fork of <a href="https://github.com/getpaseo/paseo">Paseo</a>, licensed Apache-2.0.</em></p>

<p align="center">One interface for Claude Code, Codex, Copilot, OpenCode, and Pi agents.</p>

<p align="center">
  <img src="https://alp.anhlp.com/hero-mockup.png" alt="alp app screenshot" width="100%">
</p>

<p align="center">
  <img src="https://alp.anhlp.com/mobile-mockup.png" alt="alp mobile app" width="100%">
</p>

Run agents in parallel on your own machines. Ship from your phone or your desk.

- **Self-hosted:** Agents run on your machine with your full dev environment. Use your tools, your configs, and your skills.
- **Multi-provider:** Claude Code, Codex, Copilot, OpenCode, and Pi through the same interface. Pick the right model for each job.
- **Voice control:** Dictate tasks or talk through problems in voice mode. Hands-free when you need it.
- **Cross-device:** iOS, Android, desktop, web, and CLI. Start work at your desk, check in from your phone, script it from the terminal.
- **Privacy-first:** alp doesn't have any telemetry, tracking, or forced log-ins.

## Plugins

Add themes, workspace panels, commands, settings screens, and coding-agent providers with trusted
TypeScript plugins. Install from npm, Git, or a local directory with `alp plugin install <source>`.

Start with the [plugin quickstart](https://alp.anhlp.com/docs/plugins). Plugins run with access to your daemon
machine and inside connected clients; install only code you trust.

## Getting Started

alp runs a local server called the daemon that manages your coding agents. Clients like the desktop app, mobile app, web app, and CLI connect to it.

### Prerequisites

You need at least one agent CLI installed and configured with your credentials:

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
- [Codex](https://github.com/openai/codex)
- [GitHub Copilot](https://github.com/features/copilot/cli/)
- [OpenCode](https://github.com/anomalyco/opencode)
- [Pi](https://pi.dev)

### Desktop app (recommended)

Download it from [alp.anhlp.com/download](https://alp.anhlp.com/download) or the [GitHub releases page](https://github.com/phucanh08/alp/releases). Open the app and the daemon starts automatically. Nothing else to install.

To connect from your phone, open **Settings → your host → Pair Device**.

### CLI / headless

Install the CLI and start alp:

```bash
npm install -g @getpaseo/cli
alp
```

alp starts locally, then asks whether to enable the end-to-end encrypted relay for device pairing. If you decline, connect directly over TCP, Tailscale, or another VPN. This path is useful for servers and remote machines.

For full setup and configuration, see:

- [Docs](https://alp.anhlp.com/docs)
- [Connectivity guide](https://alp.anhlp.com/docs/connectivity)
- [Configuration reference](https://alp.anhlp.com/docs/configuration)

### Docker

Run the alp daemon and self-hosted web UI in Docker:

```bash
docker run -d --name paseo \
  -p 6767:6767 \
  -e PASEO_PASSWORD=change-me \
  -v "$PWD/paseo-home:/home/paseo" \
  -v "$PWD:/workspace" \
  ghcr.io/getpaseo/paseo:latest
```

Open `http://localhost:6767` after it starts. Extend the base image with the agent CLIs you use, then provide credentials through environment variables or the persistent `/home/paseo` volume. See the [Docker documentation](docs/docker.md) for full setup details.

## CLI

Everything you can do in the app, you can do from the terminal.

```bash
alp run --provider claude/opus-4.6 "implement user authentication"
alp run --provider codex/gpt-5.5 --worktree feature-x "implement feature X"

alp ls                             # list running agents
alp attach abc123                  # stream live output
alp send abc123 "also add tests"   # follow-up task

# run on a remote daemon; --cwd is a path on that host
alp run --host workstation.local:6767 --cwd /workspace "run the full test suite"
```

See the [full CLI reference](https://alp.anhlp.com/docs/cli) for more.

## TypeScript SDK

Build issue integrations, dashboards, and orchestration services with `@getpaseo/client`:

```ts
import { createPaseoClient } from "@getpaseo/client";

const client = createPaseoClient({ url: "ws://127.0.0.1:6767/ws" });
await client.connect();

const agent = await client.agents.create({
  config: { provider: "codex/gpt-5.5" },
  cwd: "/Users/me/dev/storefront",
  prompt: "Review the current diff and name the riskiest change.",
});

const result = await agent.waitForFinish();
console.log(result.lastMessage);

await client.close();
```

See the [SDK quickstart](https://alp.anhlp.com/docs/sdk/quickstart), [recipes](https://alp.anhlp.com/docs/sdk/recipes), and [API reference](https://alp.anhlp.com/docs/sdk/reference).

## Skills

Skills teach your agent to use alp to orchestrate other agents.

```bash
npx skills add getpaseo/paseo
```

Then use them in any agent conversation:

- `/paseo-handoff` — hand off work between agents. I use this to plan with Claude and then handoff to Codex to implement.
- `/paseo-advisor` — spin up a single agent as an advisor for a second opinion, without delegating the work itself.
- `/paseo-committee` — form a committee of two contrasting agents to step back, do root cause analysis, and produce a plan.

## Development

Quick monorepo package map:

- `packages/server`: alp daemon (agent process orchestration, WebSocket API, MCP server)
- `packages/app`: Expo client (iOS, Android, web)
- `packages/cli`: `alp` CLI for daemon and agent workflows
- `packages/desktop`: Electron desktop app
- `packages/relay`: Relay transport and encryption used by the daemon and clients
- `packages/website`: Marketing site and documentation (`alp.anhlp.com`)

Common commands:

```bash
# run all local dev services
npm run dev

# run individual surfaces
npm run dev:server
npm run dev:app
npm run dev:desktop
npm run dev:website

# build the server stack
npm run build:server

# repo-wide checks
npm run typecheck
```

## Related projects

- [getpaseo/paseo-relay](https://github.com/getpaseo/paseo-relay) — official distributed relay, written in Elixir
- [paseo-vscode](https://marketplace.visualstudio.com/items?itemName=hinnes.paseo-vscode) — VS Code extension

## License

Apache-2.0
