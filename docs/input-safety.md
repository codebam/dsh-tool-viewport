# Input safety

The `viewport` tool drives a live desktop. A key that is pressed and never
released — a stuck Ctrl, a held mouse button — is the worst failure this
plugin can produce, because it follows the person using the machine into
every other application. This document says exactly what the plugin
guarantees, how it keeps those promises, and what it deliberately does not
promise.

Most of what follows is about the `viewport` tool's own process: its queue,
its ledger, and its compensation. The one thing a single process cannot do is
stop a second dsh process from interleaving input on the same socket; a
per-socket advisory lease, described below, closes that gap without pretending
it can see the other process's held keys. Screenshots (`grim`) never hold input
and are not part of the input queue.

## The problem, in one paragraph

An action is a batch of `viewport msg` invocations run as one shell script
(`src/seat.mjs`). Some of those messages hold state: `osk.key --pressed
true` presses a keysym and `input.button --pressed true` presses a mouse
button; the matching `--pressed false` lets them go. A chord is modifiers
down, a tap, modifiers up in reverse. A click is button down, button up. A
batch that fails between the down and the up leaves that key or button
down. The batch can fail by being **refused** (the client exits non-zero),
by **timing out**, or by being **aborted** (the tool call is cancelled).
The plugin releases what it pressed before the error reaches the model.

## What is accounted for

`src/held.mjs` folds a message list into held state, derived from the two
state-changing primitives — not from the action names:

- `osk.key --keysym <n> --pressed true|false` (the Shift wrap and chord
  modifiers included);
- `input.button --button <272|273|274> --pressed true|false`.

A press adds the input (a repeated press moves it to the end of the press
order), a release removes it, and `--pressed` defaults to `true` exactly as
the compositor's protocol documents. Pointer moves and wheel notches never
hold anything. The fold gives both the final state and every prefix state,
which is what compensation uses.

## The guarantees

| Situation | What is guaranteed |
| --- | --- |
| A message is **refused** part-way | Messages before it ran; the keys and buttons *they* left down are released, last press first, before the error comes back. The refused message is not treated as applied. The error carries the client's own words, the script's `message k of n was refused` line, and a sentence naming what was released — or saying plainly that nothing was held. |
| A message **times out** | The whole batch process group is killed with `SIGKILL`; the call does not reject until the group's pipes have closed. The batch's progress marker says how many messages completed; those messages' held state is released, plus the in-flight message's press (it may have been accepted before the kill). Releasing a key that was not down is harmless. |
| The call is **aborted** while its batch is running | Same as a timeout: group killed, compensation run on its own budget, and only then does the `AbortError` reach the model. The abort signal is deliberately ignored during compensation — cancelling must not leave a key down. |
| The call is **aborted while queued** | It never starts: no message, no release, no spawn. It rejects promptly and is removed from the queue. |
| Two tool calls run **concurrently** | They are serialized through one FIFO queue per seat. One call's messages are contiguous; no two calls interleave. A failed, refused or aborted call never wedges the queue, and the next call starts only after compensation has finished. |
| A **second dsh process** drives the same socket, resolving the same target and lease directory | They are serialized by a per-socket lease: only one process's batch is in flight at a time. The other waits (abortably) up to `leaseWaitMs` (30 s by default), then gets a `LeaseError` naming the holder and the lock file. The lease is taken before the first message and given back after compensation. |
| The lease holder is **SIGKILLed** or exits without releasing | The next call reads the recorded identity (pid plus `/proc/<pid>/stat` field 22, the process start time), finds it provably gone — pid gone, a later process with the same pid and a different start time, or a zombie — and reclaims the lease before its first message. |
| The lease file is **stale, released or garbled** | A provably dead identity, or a release tombstone, is reclaimed at once; a garbled file after a one-second grace. Reclamation runs under a guard that re-checks the exact bytes before unlinking, so a fresh holder's record is never the bytes that were inspected. A file whose owner cannot be read is never stolen: the call waits out its bound and reports it. |
| Input is stuck and the model calls **`release`** | Every input the seat's ledger still counts as possibly down is released, last press first, followed by the standard modifier and button set (`ctrl`, `alt`, `shift`, `super`, left, right, middle). Each release is its own `viewport msg`, so one refusal cannot stop the sweep; refusals are reported in the summary and the input stays in the ledger for a retry. |
| `release` is called when **nothing is held** | The releases are no-ops; the summary says nothing was known to be held. It is safe and idempotent. |

The error text is the original error, unchanged, with one appended
sentence:

```text
viewport msg: osk.key: refused (control socket: not this client)
viewport: message 3 of 6 was refused (exit 3) Released shift and ctrl (reverse press order); nothing is left held.
```

or, when compensation could not land:

```text
... Released shift (reverse press order); could not release ctrl (no answer within 2000ms) — call the `release` action.
```

A compensation failure never replaces the original error.

## How the ordering works

1. **Detect.** A refusal is read from the batch script's own stderr line
   (`viewport: message k of n was refused (exit s)`), so the executed
   prefix is exact. A timeout or abort is detected by the process runner.
2. **Stop the source.** On timeout or abort the seat sends `SIGKILL` to the
   batch's process group (`kill(-pid, SIGKILL)`) — not just to the shell —
   and waits for the group's output pipes to close. This matters: under the
   old `execFile` arrangement the `viewport msg` grandchild outlived the
   shell (see below), and it could otherwise press something *after*
   compensation had run.
3. **Compute the held set.**
   - Refusal: the exact prefix state, `heldTrace(messages)[k - 1]`.
   - Timeout/abort: the progress marker's completed count, folded, plus
     the in-flight message's press when it is a press. The in-flight
     message may have been accepted just before the kill, so releasing it
     is the safe choice; if it was only a release, the key stays in the
     held set and is released again.
   - No marker at all (a single-message invocation that failed in an
     unknown way): every press in the batch, once each.
4. **Release in reverse press order.** The model's chord `ctrl+shift+t`
   presses Ctrl, Shift, `t`; compensation releases `t`, then Shift, then
   Ctrl. Each release is a separate `viewport msg`, not one script, so a
   refusal of one release does not strand the rest. Each gets a
   compensation budget of `min(timeoutMs, 2000)`.
5. **Record and report.** Successful releases leave the ledger; failed ones
   stay in it for `release` to retry. The original error is shaped, the
   compensation sentence is appended, and only then does it reach the
   model.

The batch shell writes the number of each accepted message to a private
progress file (`$VIEWPORT_PROGRESS`, in a per-batch `mkdtemp` directory)
before starting the next one. That marker is what makes a timed-out or
aborted batch exact instead of "assume everything in the batch". It is
removed after every batch.

## The ledger

One `ViewportSeat` is mounted per dsh process and shared by every tool call.
It keeps an in-memory ledger of inputs it has pressed and not confirmed
released: a successful batch applies its full press/release trace; a failed
batch applies the prefix it knows ran and then the possibly-held set, and
compensation removes what it actually released. `release` drains the ledger
plus the standard set. The ledger is process-local by design: the lease below
orders two processes' batches, but it does not merge their ledgers, so one
process still cannot see the keys the other may have left down.

## The orphaned-client finding

With the pre-change `execFile` implementation, Node's timeout killed the
direct child (`sh`) but not its `viewport msg` grandchild. Measured with a
fake client that records its pid and sleeps: the client was alive at 0 ms,
500 ms and 2 s after the call rejected, still alive after the Node process
exited, reparented to PID 1, in the caller's process group. The batch had
sent one message and would never return.

The fix is the process-group design described above: `spawn(..., {
detached: true })` makes the batch a session and process-group leader, and
`kill(-pid, 'SIGKILL')` takes the shell and every client it started. The
timeout and abort tests assert the recorded client pid is gone, not merely
that the call rejected.

## The cross-process lease

A second dsh process has its own FIFO and its own ledger. The lease is what
stops the two from interleaving a click's press and release or a typed
string; it lives in `src/lease.mjs` and the seat wraps every input run and
every `release` sweep in it, including compensation.

- **Where it lives.** The file is `lease-<32 hex>.lock` in a per-user
  directory under the system temp dir (`leaseDir` overrides it), and the
  name is a SHA-256 of the canonical target. It is deliberately *not* under
  `XDG_RUNTIME_DIR` or beside the socket: the runtime dir is the live
  session's own space, and a socket directory is not guaranteed writable;
  the lock's name — not its directory — is what has to be per-socket. The
  directory only has to be one that every dsh process for this user agrees
  on; `leaseDir` pins it when `TMPDIR` differs between them.
- **What the name names.** The canonical control-socket path when the seat
  pins one (`socket`, or `VIEWPORT_SOCKET` in its environment). When neither
  names a socket, the client itself discovers the session (`$XDG_RUNTIME_DIR`
  plus `viewport-$WAYLAND_DISPLAY.sock`, else the newest `viewport-*.sock`
  there), so the lease is scoped to the canonical runtime dir instead. That is
  deliberately broader: two unpinned seats in one session still serialize
  even though neither can say which socket the client will choose. A pinned
  seat and an unpinned one cannot share a key; pin `socket` (or export
  `VIEWPORT_SOCKET`) on both if that matters.
- **What the record says.** The format version, the owner's pid, the owner's
  process start time (`/proc/<pid>/stat` field 22, the same identity the
  compositor uses for its clients), the boot id and PID namespace, a random
  token, and the scope. It is written to a unique temp file and hard-linked
  into place, so a reader sees either nothing or a complete record. On a
  filesystem that cannot hard-link, an exclusive create is used instead and
  the writer re-checks that the record at the path is still its own, so a
  lease reclaimed under a stalled writer is not believed by that writer.
- **When it may be reclaimed.** Only when the recorded identity is provably
  dead: `/proc/<pid>/stat` is gone, the pid now names a process with a
  different start time, or the recorded process is a zombie and will never
  release. A stat that cannot be read (permissions, `hidepid`) is treated as
  *unknown*, never dead, because stealing a live holder is worse than
  waiting. Release tombstones are reclaimed at once and garbled files after
  a one-second grace; reclamation is serialized by a guard file and re-checks
  the exact bytes immediately before the unlink.
- **How long it waits.** A live or unreadable holder is waited for up to
  `leaseWaitMs` (30 s by default), interruptible by the call's abort signal.
  Running out produces a `LeaseError` naming the holder, the lock file and
  the time waited; the next call tries again. A call aborted while queued in
  the FIFO never reaches the lease; a call already waiting for another
  process's lease can be aborted and then spawns nothing.

## What it does not buy

The lease serializes input across processes. It does **not** make another
process's stuck keys visible, and it does not merge ledgers: if process A is
SIGKILLed with Ctrl held, process B's lease is reclaimed as soon as A is
provably gone, but B never knew Ctrl was down. `release` still sweeps the
standard modifier and button set, which may clear that particular key by
accident, but an arbitrary stuck keysym is not something the lease can find.
The lease is also advisory and dsh-specific: a client that does not look for
the file is not stopped by it.

## What is *not* guaranteed

| Case | What happens |
| --- | --- |
| dsh itself is **SIGKILLed** or the machine loses power | No compensation code runs. Keys or buttons pressed at that instant can stay down until the compositor or session ends. Nothing can fix this from inside a dead process. |
| The compositor or its socket is **dead** when compensation runs | The release messages cannot land. The original error is still returned, the sentence names the inputs that could not be released, and the ledger keeps them; `release` retries them if the session comes back. The guarantee is best-effort, not absolute. |
| A **second dsh process** drives the same socket | Its batches no longer interleave with this process's (the lease above), but its ledger is still invisible here: if that process dies with an arbitrary key down, nothing on this side knows it. `release` sweeps the standard modifier/button set, not every key another process could have pressed. Two seats also only share a lease when they resolve the same target — pin `socket`/`VIEWPORT_SOCKET` or configure `leaseDir` alike on both. |
| The lease holder is **SIGKILLed mid-batch** and its batch children survive | The lease is reclaimed as soon as the owner's identity is gone, but a `viewport msg` child that outlived its owner (or left its process group) can still be in flight. The seat kills its own batch group on timeout and abort; a SIGKILL of the dsh process itself is outside its control, so a new holder can start while such an orphan is on the wire. |
| Two dsh processes share a lease directory across **different boots or PID namespaces** (a shared `/tmp` across containers, a `leaseDir` that survives a reboot, say) | The recorded pid and start time mean something else there, so the lease record carries its boot id and PID namespace and a holder from elsewhere is never called dead: the call waits out its bound and reports the lease file rather than stealing it. Delete the file once no process is using that session; a leftover lock from an earlier boot is never reclaimed automatically. |
| Another tool (not dsh) writes to the same socket | The lease is advisory and only this plugin's processes look for it. It cannot order input from a client that ignores it. |
| A client **leaves its process group** (double-fork plus `setsid`) | The group kill misses it. The stock `viewport msg` does not do this; the orphan check covers the normal case. |
| A person is **physically holding** a modifier while `release` sweeps | The injected release clears the compositor's modifier state even though the physical key is still down (the later physical release is a no-op). `release` is the manual escape hatch and is meant for stuck input; ordinary compensation only releases inputs the plugin pressed. |
| Screenshots overlap an input batch | Captures are not input and are not queued with it. A screenshot can observe a press/release window but cannot hold anything. |
| A queued call waits behind a long batch | Serialization means waiting; the wait is bounded by the running batch's budget (up to five minutes for a very large typing batch). Aborting while queued settles immediately. |

## Why not just release "everything" on every failure?

Because releasing a key that a person is holding is not free, and because
the compositor does not tell a client what is currently down. The plugin
releases what it knows it pressed, in the order it pressed it. `release` is
the deliberate exception: it is the one place that also sweeps the standard
modifier and button set, because that is what an escape hatch is for.

## Testing

The guarantees above are covered by `test/held.test.mjs` (the fold),
`test/input-safety.test.mjs` (refusal at every message of every
state-holding action shape, timeout with a recorded orphan pid, abort,
queued abort, FIFO contiguity, `releaseAll`, and a refused compensation),
`test/release.test.mjs` (the action, schema, summary and idempotency) and
`test/lease.test.mjs` (procfs identity parsing, the lease held across a
batch and across compensation, a queued abort never taking it, an abort
during the lease wait, two real child processes contending on one socket,
a SIGKILLed holder reclaimed, stale and garbled files, the bounded
live-holder error, and two sockets not blocking each other). All of it runs
against fake clients in temp directories, and the lease tests give every
seat a private `leaseDir`; no message reaches the live session. The older
suites build seats with no target, so their (fake) batches resolve the
ambient session's socket as the lease *key*; the lock file still lands in
the temp lease directory, and the client they run is a fake, not the
compositor's.
