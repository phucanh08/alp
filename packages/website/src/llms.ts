import { AGENT_PAGES } from "~/data/agent-pages";
import { type Doc, getDocs } from "~/docs";

const SITE_URL = "https://alp.anhlp.com";

const PRODUCT_PREAMBLE = `# alp

> Mobile and desktop app for monitoring and controlling your local AI coding agents from anywhere. Your dev environment, in your pocket.

alp is an open source application that lets you run AI coding agents on your own machine and drive them from your phone, desktop, browser, or terminal. Your code stays local — alp connects directly to your real development environment instead of running agents in someone else's cloud.

A self-hosted daemon manages agent lifecycle, exposes a WebSocket API, and ships with an MCP server so other agents can talk to it. Native apps for iOS, Android, macOS, Windows, Linux, and the web let you launch sessions, watch them work, review diffs, and ship from anywhere. A Docker-style CLI ("alp run", "alp ls", "alp logs", "alp wait") gives you scripting access. An end-to-end encrypted relay lets the mobile app reach your daemon over the public internet without exposing it.

alp supports every major coding agent: Claude Code, Codex, GitHub Copilot, OpenCode, Cursor, Gemini, Cline, Goose, Amp, Aider, and 30+ others. Each agent runs as its own process; alp handles I/O, persistence, git worktree isolation, schedules, and skills.

Distribution: native apps for Mac, Windows, Linux, iOS, and Android; web app; Homebrew; npm. Source: Apache-2.0 at https://github.com/phucanh08/alp. Marketing site: https://alp.anhlp.com.
`;

function docLine(doc: Doc): string {
  const url = `${SITE_URL}${doc.href}.md`;
  const description = doc.frontmatter.description?.trim();
  const suffix = description ? `: ${description}` : "";
  return `- [${doc.frontmatter.title}](${url})${suffix}`;
}

function agentLine(agent: (typeof AGENT_PAGES)[number]): string {
  return `- [${agent.name}](${SITE_URL}/${agent.slug}): ${agent.subtitle}`;
}

function topLevelDocs(): Doc[] {
  return getDocs().filter((d) => !d.slug.includes("/"));
}

export function buildLlmsTxt(): string {
  const docs = topLevelDocs().map(docLine).join("\n");
  const agents = AGENT_PAGES.map(agentLine).join("\n");

  return `${PRODUCT_PREAMBLE}
## Docs

${docs}

## Supported agents

${agents}

## Optional

- [Changelog](${SITE_URL}/changelog): Release notes for the alp daemon, CLI, desktop, and mobile apps.
- [Download](${SITE_URL}/download): Install alp on Mac, Windows, Linux, iOS, Android, or run the web app.
- [alp Hub](${SITE_URL}/hub): Connect daemons and run GitHub, Slack, Discord, and Linear workflows through the hosted service or your own deployment.
- [Blog](${SITE_URL}/blog): Updates and technical posts from the alp team.
- [GitHub](https://github.com/phucanh08/alp): Source code, issues, and releases.
`;
}
