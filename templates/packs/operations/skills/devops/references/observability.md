# Observability

Read when adding or reviewing logs, metrics, traces, SLOs, alerts or dashboards.

Use the telemetry stack the project already has. Adding an agent, vendor, collector or paid
plan is an owner decision.

## Logs

- Structured (JSON or the project's format) with consistent fields: timestamp, level, service,
  environment, version, request or trace ID, event name, outcome, duration.
- Levels mean something: error = needs attention, warn = degraded but handled, info = significant
  business or lifecycle events, debug = off by default in production.
- Log events, not narratives: `event=payment_failed reason=card_declined order_id=...`.
- Never log secrets, tokens, passwords, full card numbers or unnecessary personal data. Redact
  at the logger, not by convention.
- Write to stdout/stderr in containers; let the platform collect and ship.
- Control volume: sample noisy success logs, not errors. Avoid logging inside tight loops.

## Metrics

- Requests (RED): rate, errors, duration for every service endpoint or queue consumer.
- Resources (USE): utilization, saturation, errors for CPU, memory, disk, connection pools, queues.
- Business signals that show user impact: sign-ups completed, orders placed, jobs processed.
- Duration as histograms, not averages; report p50, p95, p99.
- Keep label cardinality bounded: no user IDs, request IDs or raw URLs as labels; use route templates.
- Name metrics with units and the project's naming convention.

## Traces

- Propagate context across service boundaries with the standard headers the stack uses
  (W3C trace context is common); include trace IDs in logs to link them.
- Span the units that matter: inbound request, outbound calls, database queries, queue publish
  and consume. Avoid a span per function.
- Record attributes that help diagnosis (route, status, retry count), not payloads.
- Sample at a rate the backend can afford; keep errors and slow traces when the tooling supports it.

## SLOs

- Start from user-visible behavior: availability (successful requests / valid requests) and
  latency (share of requests under a threshold), per important user journey.
- Define: SLI formula, target (for example 99.5% over 28 days), window, and what counts as valid.
- The error budget is 100% minus the target. Budget burn guides release pace and reliability work;
  how the team acts on it is an owner policy.
- Pick targets from current measured performance and user needs, not round aspirational numbers.
- Few SLOs per service; each one has an owner.

## Alerts that are actionable

- Every page answers: what is broken for users, how badly, and what to do first.
- Page on symptoms (SLO burn, error rate, latency, saturation close to exhaustion), not on every
  cause (single host CPU spike, one failed retry).
- Prefer multi-window burn-rate alerts on SLOs: a fast window catches sharp outages, a slow window
  catches steady degradation.
- Each alert has: clear name, severity, threshold and duration, owner, runbook link or first
  diagnostic step, and a dashboard link.
- Non-urgent conditions become tickets or reports, not pages.
- Test alerts: trigger in a non-production environment or with a synthetic condition and confirm
  delivery and runbook accuracy.
- Review alerts that fired without action or were silenced; tune or delete them.

## Dashboards

- One overview per service: SLO status, RED metrics, saturation, recent deploys marked.
- Drill-down dashboards per dependency. Same time range and units across panels.
- Prefer few, well-labeled panels to many unexplained ones.

## Runbooks

- Short: symptom, impact, first checks (dashboards, logs queries), safe mitigations (rollback,
  scale, disable flag), escalation path.
- Mitigations that change production still need the authorization the runbook names.

## Adding telemetry to a change

- Identify the new failure modes the change introduces and make each one visible: a log event,
  an error metric, or a span attribute.
- Add the signal before or with the change, so the rollout can be watched.
- State in the handoff which signals show success and which show failure.

## Review checklist

- No secrets or excess personal data in logs, labels or spans.
- Cardinality bounded; histograms for latency.
- Alerts symptom-based, owned, with runbooks; no alert without an action.
- SLOs defined from user journeys with measured baselines.
