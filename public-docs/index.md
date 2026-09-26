---
title: Getting started
description: Install alp and start running coding agents from anywhere.
nav: Getting started
order: 1
category: Getting started
---

# Getting started

alp runs your coding agents on your machine and gives you a mobile, desktop, web, and CLI client to drive them from anywhere. Three common ways to install.

## Desktop app (recommended)

Download from [alp.anhlp.com/download](https://alp.anhlp.com/download) or the [GitHub releases page](https://github.com/phucanh08/alp/releases). Open it and you're done.

The desktop app bundles its own daemon and starts it automatically, no separate install required. On first launch you'll see a brief startup screen, then connect from your phone using **Settings → your host → Pair Device**.

### Linux

Use the `.deb` on Debian/Ubuntu or the `.rpm` on Fedora to keep Chromium's sandbox available even when your distribution restricts user namespaces. The installer configures the bundled sandbox helper; you do not need to change system security settings.

For an AppImage, make the download executable and open it:

```bash
chmod +x alp-x86_64.AppImage
./alp-x86_64.AppImage
```

If it reports `error loading libfuse.so.2`, run without FUSE:

```bash
./alp-x86_64.AppImage --appimage-extract-and-run
```

Alternatively, install `libfuse2t64` on Ubuntu 24.04 or newer (`sudo apt install libfuse2t64`), or your distribution's FUSE 2 compatibility package. This dependency belongs to the AppImage runtime, before alp starts.

alp checks sandbox availability each time it launches. AppImage and extracted tar archives retain sandboxing when user namespaces work. On a restricted host without a usable installed helper, they launch with Chromium's sandbox disabled. Prefer the installed package if you require OS process isolation. **Settings → Diagnostics → App Diagnostics** reports the sandbox state and reason; the desktop log records the same decision. An explicit `--no-sandbox` argument overrides the automatic choice.

## Server / CLI

For headless machines, dev boxes, or any setup where you want the daemon running without the desktop UI: a standalone CLI package isn't published for alp yet. Run it from a repo checkout instead:

```bash
git clone https://github.com/phucanh08/alp.git
cd alp
npm install
npm run build
npm run cli -- daemon start
```

The daemon starts locally, then asks whether to enable the end-to-end encrypted relay and print a pairing QR code. If you decline, enter the daemon address manually over TCP, Tailscale, or another VPN.

The daemon can also serve the browser web app itself, so you can use the full UI without the hosted app. See [Self-hosting the web UI](/docs/web-ui).

Configuration and local state live under `PASEO_HOME` (defaults to `~/.alp`).

## Docker

For servers, dev boxes, NAS devices, or homelab hosts: alp doesn't publish a prebuilt image yet. Build one from [`docker/`](https://github.com/phucanh08/alp/tree/main/docker) in the repo, tag it `alp:latest`, then run it:

```bash
docker run -d --name alp \
  -p 6767:6767 \
  -e PASEO_PASSWORD=change-me \
  -v "$PWD/alp-home:/home/paseo" \
  -v "$PWD:/workspace" \
  alp:latest
```

Then open `http://localhost:6767`.

The image runs the daemon and serves the bundled web UI. It does not bundle agent CLIs, so extend it with the agents you use. See [Docker](/docs/docker) for Compose, reverse proxy, agent install, and security examples.

## Where next

- [Connectivity](/docs/connectivity), connect through the relay or Tailscale.
- [Docker](/docs/docker), run the daemon and bundled web UI in a container.
- [Workspaces](/docs/workspaces), the project, workspace, and session model alp is built around.
- [Providers](/docs/providers), what a provider is and how alp wraps existing CLIs.
- [Orchestration](/docs/orchestration), let one agent delegate work to other providers and models.
- [Plugins](/docs/plugins), add trusted local surfaces, sidebar actions, daemon behavior, and composer attachments.
- [CLI reference](/docs/cli), every command.
- [Self-hosting the web UI](/docs/web-ui), serve the browser app from your own daemon.
- [GitHub repo](https://github.com/phucanh08/alp)
- [Report an issue](https://github.com/phucanh08/alp/issues)

## Prerequisites

alp manages other agents, it doesn't ship one. Before it's useful, install at least one provider CLI yourself and make sure it works with your credentials. See [Supported providers](/docs/supported-providers) for the full list.

You'll also want the [GitHub CLI](https://cli.github.com/) (`gh`) installed and authenticated, alp uses it for PR-aware worktrees and a few orchestration features.
