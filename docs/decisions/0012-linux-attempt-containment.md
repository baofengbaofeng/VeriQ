# ADR 0012 — Kernel-owned Attempt containment and correlated claim recovery

Status: accepted for T10 review fix1 after coordinator preflight approval.

A real counterexample invalidated the original stop-time ownership scan: a worker can start
an empty-environment detached child, then exit before discovery. The orphan loses both the
recorded parent relation and inherited nonce. An empty scan cannot establish physical stop.
Ordinary signal-forwarding init wrappers are also insufficient: exiting with the primary
worker or forwarding only its process group does not establish that all adopted children
are gone. This decision supersedes the positive scanning proof in ADR0011.

A thin per-Attempt Linux guardian uses the existing kernel `PR_SET_CHILD_SUBREAPER` primitive.
It successfully enables adoption before its single fork. The business worker stays behind
an internal gate until Node has durably journaled actual UID, worker and guardian PID/start
times. The existing server activation acknowledgment precedes this entire path; the trusted
Node worker retains its additional START message gate before compiler/auth/fixture work.

The guardian has no device or lease credential. Node IPC to the original worker remains FD3.
Private guardian status/control channels are FD4/FD5, distinct from business stdout/stderr;
the worker closes both before exec and cannot hold control open or emit a guardian status.
The bounded version1 protocol has READY(workerPid), EXIT(code/signal), START and STOP. Parent
control EOF or a termination signal initiates cleanup; signal handlers only set a flag.
The main loop exclusively waits/reaps and signals actual same-UID direct children after
start-time verification. `/proc` PPID enumeration works without the optional task/children
file. Kernel adoption brings descendants back to the guardian regardless of setsid, exec,
environment replacement or intervening parent death. Scanning never establishes success.

Only a closed spawn gate plus `waitpid(-1) == -1` with ECHILD permits the guardian to write
its private DRAINED proof. It fsyncs the file and directory before exit. Version1 proof binds
nonce, UID, guardian PID/start time and worker PID/start time. Node validates those exact
journal identities and waits for guardian exit before positive stop. It retains bounded
TERM grace (500ms by default) followed by KILL, with a bounded parent stop wait of grace+2s.
An uninterruptible child can outlive that wait: the guardian continues adopting/reaping,
while Node returns unknown and capacity stays quarantined. Missing proof, guardian death,
identity mismatch, inaccessible ownership facts or old journals lacking containment never
become success through a fallback scan. After guardian death Node may kill the exactly
identified known worker group as best effort, while still returning unknown for the tree.

Source is `apps/runtime/native/linux-runner.c`. The development-only `build:launcher` command
uses a C compiler and outputs ignored `apps/runtime/build/veriq_runner`; normal Runtime
start never compiles or invokes bwrap/unshare/Python. Runtime uses this fixed installed path,
never a Job-selected executable. Missing helper fails closed. T20 must build and distribute
the same helper ABI/source for each supported Linux target alongside the Agent, using its
native release controls; this developer build is not a production installer. Windows job
objects and native image/vault integration remain T20. No npm dependency pins changed.

Separately, claim request recovery now journals the exact clientRequestId with the assigned
Attempt. Only successful reconciliation of that same request permits removal of its pending
request file. Unrelated historical journals cannot erase a newer unacknowledged UUID. Old
journals without association are conservative; no new queue, manifest or server fence path
is introduced.

The initial absence of a proof is a time-bounded observation. The guardian can fsync its
proof and exit before the parent's subsequent `/proc` read. On that exit handoff the parent
rechecks the complete proof binding and guardian exit before returning unknown. A live
UID/start-time/nonce mismatch is still rejected; empty `/proc` results alone remain insufficient.
