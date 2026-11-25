# Changelog

All notable changes to this project are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-11-24

0.2.0 shipped the transactional input model — the per-call FIFO, the
detached process group, the ledger and reverse-order compensation — and
this release extends it rather than replaces it: no 0.2.0 behaviour
changes, and the 89 tests that predate the lease pass unmodified.

### Added

- `src/lease.mjs`, an advisory lease per control socket that serializes
  input across dsh processes. The seat takes it before the first message
  of every input run and every `release` sweep, including compensation,
  and gives it back in a `finally` on success, refusal, timeout or abort.
- A lease record carrying the owner's pid and its `/proc/<pid>/stat`
  field 22 start time, the boot id, the PID namespace and a random token,
  published with an atomic hard link (or a re-checked exclusive create
  where links are unavailable) so a reader sees nothing or a complete
  record.
- `leaseWaitMs` (30 s by default) bounds the wait for another process's
  lease and is interruptible by the call's abort signal; running out
  produces a `LeaseError` naming the holder, the lock file and the time
  waited, and the next call tries again. `leaseDir` pins the lease
  directory when `TMPDIR` differs between processes.
- `test/lease.test.mjs`, including two real child processes contending
  for one socket, a SIGKILLed holder reclaimed by an already-waiting call,
  stale, garbled and foreign-version records, an aborted queued call, and
  two sockets not blocking each other.

### Changed

- A holder is reclaimed only when its recorded identity is provably dead:
  the pid is gone, it now names a different start time, or it is a zombie.
  An unreadable identity (`hidepid`, permissions) and a record from
  another boot or PID namespace are treated as *unknown*, never dead, so a
  live holder is never stolen. Reclamation is serialized by a guard file
  and re-checks the exact bytes immediately before unlinking; garbled
  files wait a one-second grace and release tombstones are reclaimed at
  once.
- The lease is scoped to the canonical target: the pinned control socket
  (`socket`, or `VIEWPORT_SOCKET`), else the canonical runtime dir the
  client will discover its session in. Seats share a lease when they
  resolve the same target and lease directory.
- `docs/input-safety.md` documents the lease's mechanism and its honest
  limits: it serializes batches but cannot make another process's stuck
  keys visible, it does not merge ledgers, it is advisory and dsh-specific,
  and a SIGKILLed dsh process can still leave an orphaned client on the
  wire.

## [0.2.0] - 2026-11-24

### Added

- `release` action that sweeps every input the seat still counts as
  possibly down, plus the standard modifier and button set, one
  `viewport msg` at a time. It reports refusals instead of throwing and is
  safe and idempotent when nothing is held.
- `src/held.mjs`, which folds a message list into held state from the two
  state-changing primitives (`osk.key` and `input.button`) and exposes the
  final state plus every prefix, release planning in reverse press order,
  and input naming for error text.
- A per-batch progress marker in a private temporary directory, so a
  timed-out or aborted batch knows exactly which messages ran.
- A per-seat ledger of inputs pressed and not confirmed released.
- `docs/input-safety.md` documenting the guarantees, the compensation
  ordering, the measured orphaned-client finding, and the out-of-scope
  cases (SIGKILL, a dead compositor, a second dsh process on the socket).

### Changed

- Every input batch is serialized through one FIFO queue per seat: one
  call's messages stay contiguous, and the next call starts only after the
  previous call's compensation has finished. A call aborted while queued
  never starts.
- Batches are spawned detached as their own process-group leader; a
  timeout or abort kills the whole group with `kill(-pid, SIGKILL)` and
  waits for its pipes to close before returning, so no orphaned
  `viewport msg` client can press input after compensation has run.

### Fixed

- A failed input action can no longer leave a modifier or a mouse button
  down. On refusal, timeout or abort the plugin releases what it pressed,
  last press first, each release as its own `viewport msg`, and appends
  what was released (or that nothing was held) to the original error,
  which is otherwise unchanged.
- A compensation that is itself refused no longer strands the remaining
  releases or replaces the original error; the ledger keeps the input for
  `release` to retry.

[0.3.0]: https://github.com/codebam/dsh-tool-viewport/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/codebam/dsh-tool-viewport/compare/v0.1.0...v0.2.0
