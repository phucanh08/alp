# Containers

Read when writing or reviewing a Dockerfile, compose file or container build.

## Base images

- Pin the base image by version tag and, where the project does so, by digest
  (`image:1.2.3@sha256:...`). Never rely on `latest`.
- Prefer the smallest base that runs the workload: slim or distroless variants, or a minimal
  OS image. Match the libc the application needs (glibc vs musl) to avoid runtime surprises.
- Use the same base family across services when the project already has one.
- Plan for base updates: note where the version is pinned so it can be bumped deliberately.

## Multi-stage builds

- Build stage: compilers, dev dependencies, build tools. Runtime stage: only the artifact and
  runtime dependencies.
- Copy only what is needed from the build stage (`COPY --from=build /app/dist /app`).
- Install production dependencies from the lockfile with the package manager's frozen or
  clean-install mode.

## Layer order and caching

- Order from least to most frequently changed: base, system packages, dependency manifests and
  lockfile, dependency install, then source.
- Combine package install and cache cleanup in one layer; remove package manager caches.
- Use a `.dockerignore` that excludes `.git`, `node_modules` or equivalent, build output, local
  env files, test artifacts and editor files. It shrinks context and keeps secrets out.
- Use build cache mounts if the project's builder supports them and already uses them.

## Non-root and permissions

- Create or use an unprivileged user and switch with `USER` before the entrypoint.
- Files the app only reads should be owned by root and not writable by the app user.
- Write paths (temp, cache, uploads) are explicit directories or volumes.
- Avoid privileged mode, host networking and added capabilities; if needed, document why.
- Prefer a read-only root filesystem at runtime where the platform supports it.

## No secrets in layers

- Never `COPY` env files, keys or credential files into an image. Deleting them in a later layer
  does not remove them from history.
- Do not pass secrets as `ARG` or `ENV`; both persist in image metadata.
- For build-time secrets (private registry tokens), use the builder's secret mount feature and
  confirm the secret is absent from the final image.
- Runtime secrets come from the orchestrator's secret store or injected environment.
- Inspect the built image history and filesystem for leaked files before handing off.

## Runtime behavior

- One main process per container. Use exec-form `ENTRYPOINT`/`CMD` (JSON array) so signals reach
  the process; add a minimal init if the process does not reap children.
- Handle SIGTERM: stop accepting work, finish in-flight requests within the grace period, exit.
- Log to stdout/stderr, not files inside the container.
- Configure through environment variables with documented defaults.
- Expose only the ports the service uses.

## Healthchecks

- Liveness: the process is alive and not deadlocked. Cheap; no dependency checks.
- Readiness: able to serve traffic (dependencies reachable, warmed up). Used to gate traffic.
- Implement as a lightweight endpoint or command with a short timeout. Use the orchestrator's
  probes when deploying to one; a Dockerfile `HEALTHCHECK` is mainly for plain Docker and compose.
- Do not make liveness depend on a downstream service; an outage there would restart every replica.

## Labels and metadata

- Add the labels the project uses (source repository, revision, version) so images are traceable.
- Tag images with an immutable identifier (commit SHA or version), not only a moving tag.

## Compose and local development

- Pin service images in compose files the same way.
- Keep local-only conveniences (bind mounts, debug ports) in an override file, not the base file.
- Local credentials in compose come from an uncommitted env file listed in `.gitignore`.

## Verification commands (adapt to the project's tooling)

- Build: the project's build command or `docker build` with the existing context and target.
- Size and layers: inspect image size and history; compare with the previous image.
- User: confirm the container's effective user is not root.
- Secrets: search the final image filesystem and history for env files, keys and tokens.
- Scan: run the vulnerability scanner the project already uses, if any; adding one is an
  owner decision.
- Run: start the container, hit the healthcheck, send SIGTERM and confirm clean shutdown.
