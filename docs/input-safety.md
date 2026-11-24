# Input safety

The `viewport` tool drives a live desktop. A key that is pressed and never
released — a stuck Ctrl, a held mouse button — is the worst failure this
plugin can produce, because it follows the person using the machine into
every other application. This document says exactly what the plugin
guarantees, how it keeps those promises, and what it deliberately does not
promise.

Everything below is about the `viewport` tool's own process. Screenshots
(`grim`) never hold input and are not part of the input queue.

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
plus the standard set. The ledger is process-local by design — see the next
section.

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

## What is *not* guaranteed

| Case | What happens |
| --- | --- |
| dsh itself is **SIGKILLed** or the machine loses power | No compensation code runs. Keys or buttons pressed at that instant can stay down until the compositor or session ends. Nothing can fix this from inside a dead process. |
| The compositor or its socket is **dead** when compensation runs | The release messages cannot land. The original error is still returned, the sentence names the inputs that could not be released, and the ledger keeps them; `release` retries them if the session comes back. The guarantee is best-effort, not absolute. |
| A **second dsh process** drives the same socket | **Out of scope.** Each seat's FIFO serializes only its own calls, and each ledger knows only its own presses. Two processes can interleave input and neither can release the other's stuck keys. A shared per-socket lease or a compositor-side "release everything" would be the fix; it is deliberately not attempted here (follow-up). |
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
queued abort, FIFO contiguity, `releaseAll`, and a refused compensation) and
`test/release.test.mjs` (the action, schema, summary and idempotency). All
of it runs against fake clients in temp directories; nothing touches the
live session.
