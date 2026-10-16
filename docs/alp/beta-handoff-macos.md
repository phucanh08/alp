# Handoff: finish ALP beta on macOS

Prepared 2026-10-16. This commit is beta preparation, NOT a release approval. No npm publish, registry cleanup, release tag or GitHub Release was performed.

## Decisions and source of truth

Read `beta-scope.md` first (especially decisions D1–D5 and sections 6–8).
- First release: `0.0.0-beta.1`, 8 public packages: @anhlp/alp, alp-protocol/core/runtime/client/daemon/cli and @anhlp/alp-paseo. Gateway, standalone apps/web and TUI are private/deferred.
- License: Apache-2.0; metadata points to phucanh08/alp. Node engines >=22.12; supported release matrix is Node 22/24 on macOS/Linux; Windows/Node26 experimental.
- Publish with beta tag. Only move latest for all 8 packages after Q1–Q3 pass (D2).
- Owner will run macOS and Linux acceptance (D1/D3); WSL2 is an option, identify it in evidence.
- F3 linkify-it browser DoS risk accepted for beta.1, owner: anh, deadline beta.2 or 2026-11-15, whichever first. Do not reopen this decision without new evidence.
- User explicitly requested preserving docs/alp/data-recovery.md. Its old 0.11 wording is a known documentation discrepancy; do not silently change it.

## Completed preparation

- T1–T3 manifests/lockfile: beta.1, gateway private, engines; plugin renamed @anhlp/alp-paseo.
- T4: LICENSE/NOTICE, bundled third-party notices generation and pack verification, metadata and runtime repository links; web rebuilt.
- T5: install/upgrade/removal guide and DRAFT release notes; docs links checked by docs agent.
- T6: F1 optional React/React Native peers; F2 ajv 8.20.0; local default consumer audit 0, root production audit 0. Web F3 remains accepted. See beta-audit/REPORT.md; raw Windows cache is NOT transferred.
- Gate/artifact tooling: scripts/release-{check,pack,verify,consumer,gate,lib}.mjs. Consumer checks use saved tarballs. Fake/rehearsal evidence cannot pass the release gate.
- T10: permission question tests for plugin and loopback web.
- T8 harnesses: scripts/beta-acceptance-{cli,web,r7,lib}.mjs. CLI fake rehearsal passed 8 steps (live-only steps skipped), web fake W6 passed. Live POSIX flow and R7 remain unverified.

## Validation already done (local Windows, Node 26.8.1)

- License agent: full npm test 778 total, 0 failures, 43 skipped; pack-check 8/8; build packages/web complete.
- Gate agent: artifact tests 13/13; related integration set 25/25; 8-tarball rehearsal verified hashes; consumer suite 89/89 plus package smoke passed.
- Root final check: release source check passed; TypeScript check passed; release-artifacts + permissions + paseo-web: 30/30 passed, no skips.
- None is release-SHA evidence. Full validate:packages and supported macOS/Linux live acceptance must still run.
- Some earlier Windows full-suite runs had TEMP-dependent panel/esbuild failures and a web-log flake. Root targeted tests passed using per-command TEMP/TMP under user AppData/Local/Temp outside sandbox. Do not hide failures on macOS by assuming they are the same issue.

## Continue on Mac

1. Fetch origin and check out `release/beta-1-preparation` (tracking `origin/release/beta-1-preparation`) in a clean checkout. Direct push to main was rejected by branch protection; the preparation is on this PR branch. After the PR merges, use main and select the final release SHA there. Check Node/npm/Paseo versions; use Node24 or supported Node22. Ensure TLS verification is enabled (Windows environment had NODE_TLS_REJECT_UNAUTHORIZED=0; do not copy it).
2. Read beta-scope.md sections 6–8 and beta-install.md. Run npm ci, npm run check, validate:core and validate:paseo; record H2 on macOS. Build web and run validate:packages. Inspect any real failures.
3. A rehearsal before final SHA/tag is allowed, but must be labeled rehearsal. Fixes require a new commit and rerun affected checks. Do not invent pass evidence.
4. Follow scope P0–P5: finalize SHA and local tag, clean clone, build and pack once to an external/new directory using release:pack. Keep the 8 tarballs, SHA256SUMS and release-manifest.json. Test/install those exact artifacts. Do not reuse Windows rehearsal artifacts as release evidence.
5. Run release:verify, release:consumer and the acceptance harnesses from scope on macOS and Linux. Live mode calls paid providers; user requested this phase on Mac, coordinate model/account and interactive approval steps. Web live installs a plugin into the selected Paseo host; use a deliberate test ALP_HOME/user and follow prompts.
6. Audit again on the final SHA/artifacts (beta-audit/REPORT.md and tools); record accepted F3 with D5. No claim that npm audit covers opaque vendored provider SDK code.
7. Complete the evidence JSON and release:gate --phase publish. Only then follow manual publishing and Q checks; latest and announcement have their own gates. Registry cleanup, actual publishing and announcements remain separate explicit owner actions per scope.
8. Update draft release notes/checksums and stale task statuses after evidence exists. A few scope/report status snapshots predate final preparation; current manifests and this handoff clarify implementation, not acceptance.

## Progress on Mac (2026-10-16)

Orientation only: everything below ran at `c47dfdc`, before the release SHA (D3). None of it is gate evidence.

- Environment: macOS, Node 24.19.0, npm 11.17.0, Paseo 0.11.2, TLS verification on.
- H2 (orientation): `npm ci`, `npm run check` pass. `validate:core` 399 pass, 0 fail, 4 skipped (Windows-only). `validate:paseo` 325 pass, 0 fail, 1 skipped (cmd.exe only). `validate:packages` pass (rehearsal pack, consumer, package-smoke, gateway-smoke).
- Harness fix (`8f3384b`): the acceptance harness made its throwaway `ALP_HOME` 0755. alpd refuses that on POSIX, so the CLI rehearsal failed from C2 on; Windows skips the mode check. A rehearsal also exited 0 with failing steps. After the fix, a macOS `--fake` rehearsal on rehearsal tarballs gave CLI 8 pass (C6/C7 skipped; Ctrl-C in C5 passes) and web W6 pass.
- This Mac now runs the local rehearsal beta.1 globally instead of 0.10.0: the old `alp-paseo-plugin` was removed and the 8 rehearsal tarballs were installed with `npm install -g`. `paseo plugin add` points at `/opt/homebrew/lib/node_modules/@anhlp/alp-paseo`. The pre-upgrade copy of `~/.alp` is in `~/alp-home-before-beta`; `pre-migrate-v1-v2-*` and a first beta backup are in `~/.alp/backups`. Before R5, reinstall from the final release tarballs.
- Observation, not fixed: a stale `$ALP_HOME/alpd.json` left by a dev checkout wins over the installed plugin's own alpd. Paseo kept starting `integrations/paseo/server/dist/alpd.js` from the repo until the file was removed while alpd was stopped. Upgrades from 0.10.0 are unaffected, because the old entry path is replaced in place.

Open, for the owner:
- Merge the PR from `release/beta-1-preparation`, then choose the release SHA on `main` (P0) and continue with P1–P3.
- Live macOS rows R1, R2, R5 and R7 (paid providers; models still to pick). Planned for the evening of 2026-10-16.
- Linux, not started: R3, R4, R6 and R7 on Linux, plus `release:consumer` on Linux, on the saved release tarballs. Before the live rows, run the harness `--fake` rehearsal there too. The macOS home-mode failure would have shown up there as well. Record the environment (for example "Linux (WSL2 Ubuntu 24.04)").
- Optional: `alp doctor --fix` on this Mac (it tightens group/other access on old run and board files in `~/.alp`).

## Repository hygiene

Unrelated local .alp/, .claude/, ALP.md and hello.txt were left untracked and must not be committed. Build outputs, node_modules, .cache and raw audit data are intentionally absent from Git. Rebuild on macOS. Existing agent reports are in plans/reports/. Audit helper copies are in docs/alp/beta-audit/tools/ and may write only their requested output files.

## Agent ownership (Windows Paseo session)

Scope b78f2a9a-1604-47b4-a1f7-2df000f16d35; license fb17b279-c713-4144-b7fa-cc1619694343; docs 605c5380-0e59-4b30-9f88-1176e39921e9; gate 19f2ed3a-50f9-4e3f-a74c-06c26923f0c0; audit ec05d561-48d5-4f1d-b501-d7424e41f634; acceptance 055472d9-8d16-4924-92ea-715656c4cc29. Their prior conversations need not be available on Mac: use committed scope, reports and this document.
