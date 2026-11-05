# Deployment and rollback

Read when planning a rollout, ordering database migrations, or writing and rehearsing a rollback.

Planning is the default output. Executing any step against a shared or production environment
requires explicit authorization for that step.

## Choose a strategy

| Strategy | How | Fits | Cost |
|---|---|---|---|
| Rolling | Replace instances in batches | Stateless services, compatible versions | Mixed versions during rollout |
| Blue/green | Run new stack beside old, switch traffic at once | Fast, clean rollback; config or runtime changes | Double capacity during switch |
| Canary | Send a small share of traffic to new version, widen in steps | Risky changes, high traffic, good metrics | Needs traffic splitting and comparison |
| Feature flag | Ship code dark, enable per cohort | Behavior changes independent of deploy | Flag debt; needs cleanup |
| Recreate | Stop old, start new | Dev or batch jobs where downtime is fine | Downtime |

Use the strategy the platform and project already support. Introducing traffic splitting, a
flag service or extra environments is an owner decision.

## Rollout plan contents

- Version or artifact identifier being deployed, and the one being replaced.
- Preconditions: tests passed, migration compatibility confirmed, on-call aware if the project
  requires it, change window if any.
- Steps with the exact commands or pipeline actions, in order.
- Success signals: which metrics, logs or checks, with thresholds and watch duration per step.
- Abort criteria: what triggers rollback (error rate, latency, saturation, failed healthchecks).
- Rollback steps (below) and who can execute them.

## Canary and progressive delivery

- Steps such as 1% then 5%, 25%, 50%, 100%, with a watch period at each. Use what the platform supports.
- Compare canary against baseline on the same metrics over the same window, not against
  yesterday.
- Automate abort on clear threshold breaches where tooling exists; otherwise name a human watcher.
- Make sure the canary receives representative traffic (regions, client types).

## Blue/green

- Warm the new stack and run smoke checks before switching.
- Keep the old stack running and untouched until the watch period ends.
- Switch and switch back through the same mechanism (load balancer, DNS with low TTL, router).
- Watch long-lived connections, sessions and caches across the switch.

## Database migrations ordering (expand and contract)

Code and schema must be compatible across the rollout and the rollback.

1. **Expand:** add new columns, tables or indexes in a backward-compatible way (nullable or with
   defaults; build indexes without long locks where the database supports it).
2. **Deploy code** that writes both old and new shapes, or reads new with fallback to old.
3. **Backfill** in small batches with throttling; make it resumable and idempotent.
4. **Switch reads** to the new shape; verify.
5. **Contract:** remove old columns or code paths in a later release, after the rollback window.

- Never combine a destructive migration with the code change that depends on it.
- Estimate lock impact and duration on production-sized data before running.
- Back up or snapshot before irreversible steps, and confirm the restore procedure works.
- Migrations run once, from one place (pipeline job or release step), not from every instance.

## Rollback

- Application: redeploy the previous immutable artifact through the normal pipeline, or switch
  traffic back (blue/green), or reduce canary to 0%.
- Configuration and flags: revert the specific change; keep config versioned.
- Schema: with expand/contract, old code still works, so roll back code only. A rollback that needs
  a down-migration is high risk; prefer a forward fix unless the down path is tested.
- Infrastructure: revert the IaC change and run plan; check for resources that cannot be
  recreated (data stores, static IPs) before any destroy.
- Data written by the new version must remain readable by the old version, or the rollback plan
  must say how it is handled.

## Rehearsal

- Rehearse the rollback in a non-production environment for changes that are new, risky or touch
  schema. Record the command, duration and result.
- If rehearsal is not possible, mark the plan "rollback unrehearsed" and state the risk.
- Time each step; a rollback slower than the tolerated outage needs a different strategy.

## After deploy

- Watch the success signals for the stated period; confirm error budgets and alerts are quiet.
- Record what was deployed, when, by whom, and any deviations from the plan.
- Schedule the contract step and flag cleanup.
