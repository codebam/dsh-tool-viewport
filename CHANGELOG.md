# Changelog

All notable changes to this project are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.2.0]: https://github.com/codebam/dsh-tool-viewport/compare/v0.1.0...v0.2.0
