# Terminal native owner — candidate, platform matrix incomplete

Task t-d71b. Production `src/terminals.ts` now uses this identity-bound owner,
with no node-pty fallback. Linux may use the explicitly acknowledged root-only mode described below. This candidate is NOT accepted for release:
four Linux artifacts and actual Linux/Windows evidence remain missing. Missing or
unverifiable backends refuse terminal capability explicitly; only a verified ENOSYS bound-signal capability result enables root-only compatibility. No end-user compiler
is required. Existing session authentication and host/Paseo opt-ins still apply.

## Protocol and lifetime

One standalone C process owns forkpty, the startup gate, every signal and root
wait/reap. JS sends terminal input on stdin and resize (`R cols rows\n`) / cleanup
(`C\n`) on fd4. PTY output is stdout; fd3 contains bounded JSON ready, root-exit,
and cleanup records. Input/output queues and identity storage are bounded. Resizes coalesce behind
writable backpressure; cleanup closes the control pipe immediately. Native startup
polls the handshake/control descriptors with a 3s deadline; failure closes the
gate and attempts only identity-bound cleanup with a bounded nonblocking reap.

The child reports `getsid(0)==getpid()` before the parent releases its startup
gate. The owner acquires root identity before release, has default SIGCHLD and no
other reaper, and uses waitid(WNOWAIT) to observe natural exit. It retains the
root's live process or zombie until all discovery/signaling ends. This reserves
the root PID and prevents unrelated sessions reusing that session number. Only
processes proven to belong to that reserved session can be discovered. Observed
identities remain authorized if they subsequently leave the session. On the full-protection path there is no
marker, environment, age, PPid, parentuniqueid, TTY, numeric PID signal or numeric
group signal fallback. Never-observed children that immediately detach can be
missed (the approved g3 limit).

Linux opens a proc TGID directory with O_RDONLY|O_DIRECTORY (not O_PATH), reads
stat relative to that SAME descriptor, and uses pidfd_send_signal on that fd with
flags0/infoNULL. Capability probing checks kernel procfs and that /proc/self PID
and SID match the caller's namespace coordinates, and requires /proc/self/status
NSpid to have exactly one field equal to getpid() (proves the procfs PID namespace
is our active one without reading PID1, so it works for non-root users; missing
NSpid denies). A mount-privileged actor remounting /proc is outside this guarantee;
failure denies capability. Linux source has NOT been
compiled or executed here; permission/race/namespace/minimum-kernel evidence is
still required.

Darwin validates the complete private flavor17 56-byte struct and audit-token
version at runtime. Discovery uses U_before → reserved getsid → audit token →
U_after, requiring equal uniqueids and a matching token pidversion. Signals
refresh only a previously known uniqueid and use proc_signal_with_audittoken.
Unknown/changed identity never authorizes a numeric signal. Cleanup reports
observed/live/uncertain separately; it does not claim universal containment.

## Accepted finite-generation Darwin limit

The Darwin final syscall compares PID + **32-bit global pidversion**, not the
64-bit private uniqueid. Fork AND exec increment this global generation. If the
helper is suspended after its last identity check, enough global allocations can
wrap that generation and a recycled target PID can collide. Keeping a task-name
port or checking uniqueid again does not atomically bind the eventual syscall.
This is a source-derived limitation, not an executed 2^32-operation exploit.
The user explicitly accepted ONLY this residual in g4 (2026-10-29); ordinary PID
reuse protection, all native checks, packaging, platform tests and independent
review remain required. No blanket no-wrong-process waiver is inferred.

Kernel proof anchors (oracle 275c5e36, advice only; not implementation review):

- [XNU PID/zombie/session reservation and fork generations](https://github.com/apple-oss-distributions/xnu/blob/xnu-11215.1.10/bsd/kern/kern_fork.c#L877)
- [XNU WNOWAIT and reap hash removal](https://github.com/apple-oss-distributions/xnu/blob/xnu-11215.1.10/bsd/kern/kern_exit.c#L2457)
- [XNU setsid and cross-session restrictions](https://github.com/apple-oss-distributions/xnu/blob/xnu-11215.1.10/bsd/kern/kern_prot.c#L245)
- [XNU identity-info and final audit signal comparison](https://github.com/apple-oss-distributions/xnu/blob/xnu-11215.1.10/bsd/kern/proc_info.c#L3290)
- [XNU exec increments generation](https://github.com/apple-oss-distributions/xnu/blob/xnu-11215.1.10/bsd/kern/kern_exec.c#L6475)
- [Private ABI layout](https://github.com/apple-oss-distributions/xnu/blob/xnu-12377.1.9/bsd/sys/proc_info_private.h#L41)
- [Linux stored proc-directory identity](https://github.com/torvalds/linux/blob/v6.12/fs/proc/base.c#L3244)
- [Linux procdirfd signal dispatch](https://github.com/torvalds/linux/blob/v6.12/kernel/signal.c#L3647)
- [Linux stat session coordinates](https://github.com/torvalds/linux/blob/v6.12/fs/proc/array.c#L505)

## Build, distribution and remaining platform evidence

`node scripts/build-terminal-native.mjs` is an EXPLICIT developer build, never
terminal startup or postinstall. Darwin also accepts `--arch=x64`/`--arch=arm64`
using the existing Apple compiler and ad-hoc codesign; capability execution must
succeed before a manifest is written. Hashes bind protocol, source and binary.
`node scripts/terminal-native-assets.mjs --require-matrix` and release pack-check
FAIL until all six slots exist: Darwin arm64/x64, Linux arm64/x64 × glibc/musl.
Builds copy only verified prebuilt assets beside root, daemon, CLI and Paseo bundles;
source-package daemon consumers also carry native source/hash manifests. They do
not invoke a compiler. A rebuild replaces the generated asset directory wholesale.

Current artifacts: Darwin arm64 executed on macOS27, Darwin x64 capability executed
through existing Rosetta on that same host. Both target macOS11.0 (LC_BUILD_VERSION),
matching [Node22's macOS floor](https://github.com/nodejs/node/blob/v22.23.0/BUILDING.md#platform-list).
This deployment target is NOT proof of runtime compatibility on macOS11 or physical
x64 hardware. Private-ABI capability validation still fails closed. Linux builds
must retain the existing libc support baseline (Node22 glibc2.28); no Linux artifact
or minimum-kernel execution has been proved here. pidfd_send_signal (Linux5.1 syscall baseline) selects full protection. User g5 approved
functional compatibility below that capability with a pre-use warning, as described below.
No permission denial or artifact failure silently selects compatibility.

Async startup reserves request IDs and quota before native readiness. Revoke,
shutdown and host optout cancel startup and await native cleanup before returning;
late readiness cannot publish an orphan terminal. Root exit is delivered after
stdio drains. The helper reads the PTY to EOF and advances partial output writes
for up to one further second; an undrained tail reports explicit uncertainty. Cleanup reports observed/live/uncertain, and uncertain/live results
refuse success and stop further terminal admission. The existing real PTY cleanup
scenarios now execute through the native owner (including exec, same-session
orphans and a late child). Never-observed immediate-setsid escapes remain the
approved g3 discovery limit. Actual Linux/Windows browser keyboard and Linux
namespace/proc permissions/races remain NOT_CHECKED.

Explicit developer regressions (require a local C compiler, not end-user startup):
`node --test packages/daemon/native/tests/lifecycle.mjs` exercises delayed native
startup and a real stalled control reader. `ALP_NATIVE_BASELINE=8ed11fd` runs the
same checks against the committed pre-correction C/TS in isolated scratch space.
This mode does not change the checkout. Both cases fail on that baseline and pass
on the correction. Ordinary lifecycle tests run separately from daemon/tests.

## Linux root-only compatibility candidate (g5)

Only a verified helper that passes procfs/PID-namespace checks and receives ENOSYS
from its valid self `pidfd_send_signal` probe advertises `alp-terminal-owner:1:root-only`.
EPERM/EACCES, proc/namespace failure, corrupt/missing binary or manifest, timeout,
crash or malformed records refuse capability. ENOSYS may also be returned by a
policy; we call the capability unavailable rather than assert a kernel version.
The owner revalidates immediately before fork; a mode change refuses before shell
launch, with a fresh acknowledgment challenge when full protection became unavailable.

`terminal.create` and `terminal.attach` require explicit
`protectionAcknowledgment: "linux-root-only-v1"` after a meaningful warning.
Web Continue/Cancel is deliberate; restore/new shell does not inherit consent
from storage. Direct clients receive a fixed structured refusal before a shell
exists. Current Paseo protocol cannot send this acknowledgment, so its bridge
surfaces the warning and refuses degraded create/attach. User g6 explicitly accepted
this temporary consumer limit on 2026-10-29; native-supported Paseo is unchanged.
This does not waive Linux artifacts, actual platform checks or independent native execution.

Compatibility never scans or explicitly signals descendants or process groups.
Only its own direct root is signaled, before final reap, with SIGCHLD explicitly
SIG_DFL and SA_NOCLDWAIT cleared by checked sigaction. A living child or WNOWAIT
zombie continuously reserves its PID; an unexpected ECHILD permanently retires
numeric authority. Final reap is checked. This is spawn ownership, not a snapshot
or a numeric PID-reuse heuristic; helper compromise invalidates that premise.
Kernel PTY hangup and line-discipline signals may naturally affect foreground jobs.

Known reduced coverage is `coverage: "root-only"`; successful cleanup establishes
only the shell's exit. Unmanaged jobs can survive close/revoke/optout/shutdown and
keep the PTY open (`outputOpen: true` after bounded draining). This accepted known
coverage limit alone does not lock admission. Root live/lost ownership, queued
bytes not delivered, protocol loss or sticky adapter failure remain uncertainty
and retain the admission lock. No delayed signals occur after root reap.

Advice/source proof: oracle18a20d0e examined [Linux5.1 wait/ptrace reap](https://github.com/torvalds/linux/blob/v5.1/kernel/exit.c)
and [original procdirfd signal dispatch](https://github.com/torvalds/linux/blob/v5.1/kernel/signal.c).
Actual Linux compilation/execution (old and supported kernel, namespace/permission,
ptrace/exec/reuse/race and four Linux shipped artifacts) remains NOT_CHECKED here.
Darwin author regressions validate the unchanged full path only; no seam/mock or
Rosetta execution is claimed as Linux or physical-x64/minimum-macOS proof.
