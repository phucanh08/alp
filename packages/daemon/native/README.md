# Experimental terminal owner — NOT production enabled

Task t-d71b, B3/B4 remain incomplete. `src/terminals.ts` still uses the previous
backend. This isolated prototype is NOT a shipped six-platform implementation or
an accepted strict signaling fix. It is retained for the next implementation
round, with concrete macOS arm64 execution evidence.

## Protocol and lifetime

One standalone C process owns forkpty, the startup gate, every signal and root
wait/reap. JS sends terminal input on stdin and resize (`R cols rows\n`) / cleanup
(`C\n`) on fd4. PTY output is stdout; fd3 contains bounded JSON ready, root-exit,
and cleanup records. Input/output queues and identity storage are bounded.

The child reports `getsid(0)==getpid()` before the parent releases its startup
gate. The owner acquires root identity before release, has default SIGCHLD and no
other reaper, and uses waitid(WNOWAIT) to observe natural exit. It retains the
root's live process or zombie until all discovery/signaling ends. This reserves
the root PID and prevents unrelated sessions reusing that session number. Only
processes proven to belong to that reserved session can be discovered. Observed
identities remain authorized if they subsequently leave the session. There is no
marker, environment, age, PPid, parentuniqueid, TTY, numeric PID signal or numeric
group signal fallback. Never-observed children that immediately detach can be
missed (the approved g3 limit).

Linux opens a proc TGID directory with O_RDONLY|O_DIRECTORY (not O_PATH), reads
stat relative to that SAME descriptor, and uses pidfd_send_signal on that fd with
flags0/infoNULL. Capability probing checks kernel procfs and that /proc/self PID
and SID match the caller's namespace coordinates. Linux source has NOT been
compiled or executed here; permission/race/namespace/minimum-kernel evidence is
still required.

Darwin validates the complete private flavor17 56-byte struct and audit-token
version at runtime. Discovery uses U_before → reserved getsid → audit token →
U_after, requiring equal uniqueids and a matching token pidversion. Signals
refresh only a previously known uniqueid and use proc_signal_with_audittoken.
Unknown/changed identity never authorizes a numeric signal. Cleanup reports
observed/live/uncertain separately; it does not claim universal containment.

## Unresolved security proof

The Darwin final syscall compares PID + **32-bit global pidversion**, not the
64-bit private uniqueid. Fork AND exec increment this global generation. If the
helper is suspended after its last identity check, enough global allocations can
wrap that generation and a recycled target PID can collide. Keeping a task-name
port or checking uniqueid again does not atomically bind the eventual syscall.
This is a source-derived unresolved strict-proof limitation, not an executed
2^32-operation exploit. Do NOT claim B3/B4 acceptance based on this prototype's
ordinary exec/orphan tests. No safety waiver was requested or assumed.

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

## Build and remaining integration

`node scripts/build-terminal-native.mjs` is an EXPLICIT developer build, never
terminal startup or postinstall. A source-hash / binary-hash protocol manifest
accompanies each helper. Only Darwin arm64 has been built and executed.
`--require-matrix` deliberately FAILS until all six current-source slots exist:
Darwin arm64/x64, Linux arm64/x64 × glibc/musl. Do not fabricate missing artifacts,
reduce support, or claim an unexecuted platform passes. Minimum platform floors,
cross-arch code signing and packaged Node22/24 daemon/Paseo smoke remain pending.
The prototype's native files are not yet in package distribution allowlists.

Production integration must also preserve async startup reservations, idempotent
request IDs, concurrent create limits, revoke/disable during startup, bounded
readiness, and existing observable descendant/orphan regressions. It must remove
all JS/node-pty numeric signaling paths before claiming a native security fix.
Actual Linux/Windows browser keyboard and Linux /proc tests remain NOT_CHECKED.
