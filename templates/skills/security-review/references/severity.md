# Severity Rubric and Report Template

Read when rating findings and writing the security review report.

## Rating

Rate by impact if exploited and by how reachable the issue is. Start from impact,
then move one level down if exploitation needs rare preconditions, or up if it is
trivially reachable by an unauthenticated attacker.

| Severity | Typical impact | Typical reachability |
| --- | --- | --- |
| critical | Remote code execution, full auth bypass, mass data exposure, live secret leaked | Unauthenticated or any user, no special conditions |
| high | Privilege escalation, access to other users' data, injection into a privileged sink | Authenticated user or a common configuration |
| medium | Limited data exposure, stored or reflected XSS, SSRF to limited targets, DoS of a component | Needs user interaction, specific config, or insider position |
| low | Information disclosure with little value, missing hardening, defense-in-depth gap | Hard to reach or no direct exploit path |

Confidence is separate from severity:

- confirmed: the path from untrusted input to sink is traced in code or shown by a
  local test, and no control blocks it.
- suspected: a plausible path with one or more unverified links; state which.

Do not rate style issues or theoretical weaknesses with no path as findings; list
them under hardening notes.

## Report template

```text
Security review: <target (diff range, PR, component)>
Scope reviewed: <paths/modules>   Not reviewed: <paths/areas and why>
Tools run: <command -> result> | none (reason)

Confirmed findings
1. [<severity>] <short title>
   Evidence: <file:line> (source) -> <file:line> (sink)
   Exploit scenario: <who does what, and what they gain>
   Fix suggestion: <specific change; reference the project's existing helper if any>

Suspected findings
1. [<severity>] <short title>
   Evidence: <file:line>
   Unverified link: <what is not yet confirmed and how to confirm it>
   Exploit scenario: <...>
   Fix suggestion: <...>

Hardening notes (not findings)
- <item>

Checked and clean
- <category>: <what was checked>

Summary: <counts by severity>; blocking: <yes/no, which>
```

Secrets are cited as path:line and type only ("AWS-style key"), never the value.
