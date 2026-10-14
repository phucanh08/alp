---
title: ALP modular npm monorepo migration
description: Extract independently packaged modules while retaining legacy entry points and wire/data formats.
status: completed
priority: P1
tags: [refactor, backend, api]
created: 2026-10-14
---

# Migration contract

Preserve CLI commands, filesystem formats, JSON-RPC v1, session events, provider behavior and Paseo integration. No Rust or TUI implementation. Do not rewrite orchestration logic.

## Evidence

- Local: core and client are ESM JavaScript; runtime/daemon/ACP are TypeScript; esbuild bundles Node20 artifacts. Existing tests import src paths and dist bundles.
- Local: runtime.ts is 5,012 lines; cli.js is 1,251 lines. Runtime transport injection already supports tests/custom harnesses.
- Local: daemon imports plugin RPC handlers and plugin imports daemon; remove this cycle by sharing daemon-owned RPC implementation.
- Upstream: https://github.com/getpaseo/paseo/blob/main/package.json uses explicit npm workspaces, package-specific build/test scripts and release dry runs.
- Docs: https://docs.npmjs.com/cli/v11/using-npm/workspaces/ supports local linking, workspace scripts, individual package versioning/publishing.

## Architecture

| Package | Responsibility | Allowed ALP dependencies |
|---|---|---|
| protocol | JSON-RPC, event DTOs, version, framing, schemas | none |
| core | filesystem configuration, agent/task/team semantics, templates | protocol |
| runtime | orchestration and native provider adapters | core, protocol |
| client | socket client, discovery, lifecycle helpers | core, protocol |
| daemon | persistent runtime host, IPC server, web/Paseo bridge and shared panel RPCs | runtime, core, client, protocol |
| cli | command domains, ACP editor surface | client, core, protocol (protocol session/connection contracts) |
| tui | reserved, private, no implementation | none |
| integrations/paseo-plugin | Paseo SDK adapter and panels | daemon, runtime, client, core, protocol |

Keep @anhlp/alp as compatibility distribution. Old src paths re-export canonical package sources; plugins/paseo remains a portable compatibility directory with source wrappers and generated output copies. Cross-package imports use exported package specifiers. Public subpaths preserve existing module APIs, with an automated dependency/cycle check.

## Phases and gates

1. **Baseline and design**: run existing full suite; inventory imports, asset paths and publish behavior. Record baseline failures without modifying tests to hide them.
2. **Physical workspaces**: move canonical code into packages and integrations; add manifests, exports and legacy shims. Relocate templates into core while preserving root assets. Gate: build, typecheck, core/client/CLI tests.
3. **Runtime and CLI domains**: extract API types, tool definitions, handoff parsing, provider selection/configuration; split CLI by command domains. Keep mutable orchestration closure intact to avoid changing state semantics. Gate: runtime, provider, workflow and CLI suites.
4. **Protocol/IPC**: move event DTOs and connection contract to protocol; centralize existing wire constants/errors; add portable JSON Schema and compatibility fixtures. Preserve v1 handshake and event envelopes. Gate: schema/contract tests and daemon/ACP/Paseo suites.
5. **Packaging and release**: package builds/tests, independent version/publish scripts, declaration builds, tarball smoke checks; dependency graph enforcement. Gate: all tests, typecheck, build, npm pack and isolated install verification.

## Alternative and decision

A manifest-only workspace overlay is cheaper but leaves ownership and publish boundaries dependent on root source files. Choose physical extraction with compatibility shims; bundled release outputs let packages install independently without changing business logic.

## Rust migration seam

Replace implementations behind JSON-RPC v1, not TypeScript object layouts. UTF-8 newline JSON, explicit request ids/errors, opaque session ids, epoch/seq event cursors, ISO timestamps and unchanged JSON persistence are the contract. In-process Rust replacements retain package APIs behind Node bindings/proxies; the daemon socket is not silently repurposed into a runtime/core API. Additive fields are permitted; incompatible fields/method semantics require a new negotiated protocol version. Native provider normalization remains internal to runtime.

## Validation limitations

Live provider E2E scripts require installed/authenticated providers and may incur external work. Execute hermetic full test suite and available deterministic E2E; report unavailable live checks explicitly. No publish or data migration is performed.

## Completed phases

All five phases are implemented. [Verification evidence](verification.md) records baseline, full regression suite, workspace suites, dependency/type/build checks, tarball previews, strict installed type consumption and standalone CLI/daemon compatibility.

The migration deliberately retains the session/delegation coordinator instead of redesigning its shared mutable state. Future extraction can proceed domain by domain against the same regression suite.
