# Performance and Load Testing

Read when running performance baselines, budgets, or load tests.

Examples use k6-style scripts for load and Lighthouse-style audits for page
performance; Artillery, Gatling, Locust, or WebPageTest are equivalents. Use the
tools the project already has.

## Authorization first

- Never load-test or stress production, a shared staging environment, or any
  third-party API without explicit authorization from the owner, naming the target,
  time window, and maximum load.
- Load against third-party services (payment, email, maps) can breach their terms
  and cost money; stub them or use their sandbox with its limits.
- A load test can look like an attack to the hosting provider; the owner coordinates
  notice if required.
- Default target: a local build or a dedicated test environment you control.
- Stop immediately if errors spike on a shared environment or other users are
  affected, and report.

## Define the question

- State what you are measuring and why: a regression check, capacity estimate,
  latency under expected load, or a soak for leaks.
- Pick the test type: smoke (tiny load, checks the script), load (expected traffic),
  stress (beyond expected, find the breaking point), spike (sudden burst), soak
  (steady load for a long time).
- Use realistic scenarios: the mix of endpoints and user journeys that real traffic
  has, think time between steps, realistic payloads and data sizes.

## Baselines

- Measure a baseline on the current main or release build in the same environment
  before testing a change.
- Keep conditions identical between runs: environment size, data volume, build
  mode, network profile, warm or cold cache, test duration.
- Run more than once; report the spread, not a single best run.
- Record conditions with every result so it can be reproduced.

## Metrics

- Server and API: latency percentiles (p50, p95, p99) rather than averages,
  throughput, error rate, and saturation (CPU, memory, connections, queue depth) if
  observable.
- Page performance: Core Web Vitals (LCP, INP, CLS), time to first byte, total
  transfer size, and long tasks, under a stated device and network profile.
- Separate client-side tool limits from server limits; a load generator at 100% CPU
  produces meaningless numbers.

## Budgets and thresholds

- Use budgets the project defines (bundle size, LCP, p95 latency, error rate).
- If none exist, report measured values and propose budgets to the owner; do not
  invent pass/fail thresholds and present them as requirements.
- Encode agreed thresholds in the tool's threshold mechanism so a run fails
  objectively.

## Scripts

- Keep scripts in the project's test directory with the project's conventions.
- Parameterize target URL, users, and duration through environment variables;
  default to the local or test target, never production.
- Use test accounts and synthetic data; never real credentials. Create and clean up
  test data the run needs.
- Check responses (status, a key field), not only that a request returned; fast
  errors look like good latency.
- Ramp up gradually; include a short smoke stage before full load.

## Interpreting results

- Compare against the baseline with the same conditions; treat differences within
  run-to-run spread as noise.
- Look for where latency bends upward as load rises; that is the capacity limit.
- Correlate with server metrics and logs where available to locate the bottleneck,
  then hand diagnosis to bug-loop or the owning skill (databases,
  backend-development, frontend-development).

## Reporting

- Target environment and authorization reference, tool and version, scenario, load
  profile, duration, data volume.
- Baseline and new results with percentiles, error rate, and spread.
- Bottleneck observations labeled as evidence or inference.
- Anything not run and why.
