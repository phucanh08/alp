# Risk matrix and edge cases

Read when turning behaviours into risks, choosing the test level for each, or listing edge cases.

## Risk to test level
| Risk | Cheapest proving level | Notes |
|---|---|---|
| Wrong calculation, parsing, branching | Unit | Table-driven cases over inputs |
| Invalid input accepted or valid input rejected | Unit, plus one integration at the boundary | Validate where input enters |
| Wiring: config, dependency injection, routing | Integration | Real module graph, fake externals |
| Storage: queries, migrations, transactions | Integration with real or embedded store | Use the project's existing test DB setup |
| Shape change breaks a consumer | Contract | See contract-tests reference |
| Critical user journey broken end to end | End-to-end, one path | Only when lower levels cannot see it |
| Previously fixed bug returns | Regression at the seam of the original bug | Keep the original reproducer |
| Dependency down, slow or erroring | Integration with a fault-injecting fake | Assert timeout, retry, error message |
| Permission or authorisation bypass | Integration through the real check | Test both allowed and denied |
| Concurrency: race, double submit, lost update | Integration with controlled interleaving | Deterministic scheduling, not sleeps |
| Performance regression on a known hot path | Benchmark or budget check if the project has one | Compare equivalent workloads |

Prioritise by likelihood times cost. Low-likelihood, low-cost risks may be accepted
untested; say so in the plan.

## Edge-case checklist by input type
**Strings:** empty, whitespace only, very long, Unicode (combining marks, emoji, RTL),
case differences, leading or trailing spaces, embedded newlines or NUL, injection
characters for the sink in use (SQL, shell, HTML, path separators).

**Numbers:** zero, negative, one, maximum and minimum of the type, just past each limit,
non-integers where integers are expected, NaN and infinity, rounding and currency
precision, string-encoded numbers.

**Collections:** empty, one element, duplicates, very large, unsorted, nested empty,
null elements, pagination boundaries (first, last, past the end).

**Time:** time zones and DST transitions, leap day, end of month and year, clock skew,
timestamps in the past or far future, durations of zero, expiry exactly at the boundary.
Freeze or inject the clock.

**Concurrency:** two writers on one record, retry after partial success, duplicate
delivery of the same message, cancellation mid-operation, ordering assumptions.

**I/O and external services:** missing file, permission denied, disk full, partial
read or write, malformed response, timeout, slow response, connection reset, retries
exhausted, non-UTF-8 content, symlinks and path traversal.

**Permissions and identity:** anonymous, authenticated without the role, owner versus
other user, revoked or expired credentials, admin-only actions from a normal user.

**State and lifecycle:** first run with no data, upgrade from previous version's data,
repeated calls (idempotency), operations after delete or close.

Pick the items the change can actually reach; do not test every row by default.
