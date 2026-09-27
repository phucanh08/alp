---
title: Orchestration skills
description: Reusable workflows for handing off tasks, getting a second opinion, and planning with multiple agents.
nav: Skills
order: 33
category: Orchestration
---

# Orchestration skills

Skills give your agents reusable instructions for delegation, handoffs, and reviews. You can also [ask for these workflows directly](/docs/orchestration-workflows) without installing skills.

| Skill            | Use it to                                                            |
| ---------------- | -------------------------------------------------------------------- |
| `/alp`           | Look up how to manage agents, workspaces, schedules, and heartbeats. |
| `/alp-handoff`   | Transfer a task and its context to another agent.                    |
| `/alp-committee` | Get two independent analyses of a difficult problem.                 |
| `/alp-advisor`   | Get a second opinion on your current work.                           |

## Installation

- **In alp:** Open **Settings → your host → Agents → Orchestration skills** and choose which skills to install on that host.
- **From the terminal:** Run `npx skills add phucanh08/alp` on the machine where your agents run.

Use the same settings card to update or uninstall skills. The host also refreshes selected installed alp skills on startup.

## `/alp`, alp Reference

The foundational reference used by the other skills. It teaches agents to check your [agent profiles and their notes](/docs/agent-profiles#guide-delegation-with-notes) before delegating, then apply the selected launch settings. If no profile fits, it directs them to discover available providers and models and tell you about the fallback.

> /alp show me how to create an agent in a workspace with worktree isolation

## `/alp-handoff`, Task Handoff

Transfer the current task with a briefing: relevant files, progress, decisions, constraints, and acceptance criteria. The skill checks profiles before choosing the receiving agent; you can name the profile you want.

> /alp-handoff hand off the auth fix to an implementation agent in its own worktree

The receiving agent gets the context it needs to continue. Ask for a separate worktree when it should edit independently.

## `/alp-committee`, Committee Planning

Get two agents to analyze a difficult problem independently. The skill checks profile notes for planning and analysis, preferring different provider families when possible.

> /alp-committee why are the websocket connections dropping under load?

Committee members return analyses without editing files. The main agent synthesizes their plans, implements the solution, and sends the diff back for review.

## `/alp-advisor`, Advisor

Get another agent's judgment on a design, diff, or question. The skill chooses a profile whose notes fit the work, or uses the profile you name.

> /alp-advisor did I miss anything in this migration plan?

The advisor returns a second opinion without editing files.

## SLP skills

alp bundles six more skills for the SLP (Supervisor / Lead / Peer) workflow. They are not
installed on the host: each Lead and Peer agent gets its seat's skills through its own seat
directory under `$PASEO_HOME/slp/seat-skills/`.

| Skill                      | Use it to                                                                         |
| -------------------------- | --------------------------------------------------------------------------------- |
| `/bug-loop`                | Diagnose a bug or performance regression with a disciplined red-before-fix loop.  |
| `/goal-griller`            | Turn a vague idea into a verifiable Task Contract before splitting up work.       |
| `/prompt-leverage`         | Turn a raw prompt into an execution-ready prompt or handoff brief.                |
| `/sequence-execution-plan` | Turn a Task Contract or backlog into an ordered, dependency-aware execution plan. |
| `/smart-commits`           | Group a working tree into logical conventional commits ready for handoff.         |
| `/xia`                     | Scout the repo and upstream docs before writing code, so nothing gets reinvented. |

If an earlier alp version installed them on the host, **Settings → your host → Agents →
Orchestration skills** offers to remove those copies; see
[breaking-changes.md](../docs/breaking-changes.md#slp-defaults-on-a-fresh-host).
