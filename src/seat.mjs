/**
 * The seat: turning message lists into `viewport msg` runs, one at a time,
 * with the session's held input put back the way it was found.
 *
 * The compositor's socket refuses synthetic input from anyone but the
 * compositor's own client (`docs/ipc.md`), so every message is one `viewport
 * msg` invocation — the trusted client — rather than a hand-rolled socket
 * writer. Several messages run as one POSIX shell script of sequential
 * invocations: each invocation connects, sends, waits for the acceptance
 * barrier, and only then does the next one start, which keeps a click's press
 * and release milliseconds apart without paying a process spawn between them.
 *
 * Two things make that safe:
 *
 * - **Serialization.** One seat is mounted per dsh process and shared by
 *   every tool call, so every run is queued through one FIFO. Two calls can
 *   never interleave their messages, and a call that is aborted while queued
 *   never starts at all.
 * - **Compensation.** A batch that stops part-way — a refusal, a timeout, an
 *   abort — leaves the keys and buttons its prefix pressed down. Before the
 *   error reaches the model, the seat releases exactly those (see
 *   `src/held.mjs`), last press first, each as its own `viewport msg`.
 *   Releasing an input that is already up is harmless, so this is always
 *   safe; failing to release one never replaces the original error.
 *
 * The whole batch runs in its own process group. A timeout or abort kills the
 * group, not just the shell, so a `viewport msg` grandchild cannot outlive
 * the call and press something after compensation has run. A progress marker
 * written by the batch script after every accepted message tells compensation
 * how far the batch got; the message that was in flight is included
 * conservatively, because it may have been accepted before the kill.
 *
 * Every run goes through the plugin's one timeout. A batch gets the timeout
 * scaled by its message count, because the budget is per message, not per
 * batch: typing two hundred characters is four hundred invocations and a
 * perfectly healthy one can take seconds. Compensation uses its own short
 * budget, so a wedged session still returns the original error promptly.
 *
 * @module @codebam/dsh-tool-viewport/seat
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import {
  describeInputs,
  heldAfter,
  inputKey,
  inputStateChange,
  pressedInputs,
  releaseMessage,
  releasePlan,
} from './held.mjs'

/** The most output one invocation may produce before it is cut off. */
const MAX_OUTPUT = 16 * 1024 * 1024

/** The longest a single compensation attempt waits, however generous the run budget is. */
const COMPENSATION_CAP_MS = 2000

/** Quote one argument for the POSIX shell script a batch runs under. */
export function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** The abort error every tool-call cancellation reports (shared with the tool's pre-check). */
export function abortError() {
  const error = new HarnessError('tool call aborted', TOOL_ABORTED)
  error.name = 'AbortError'
  return error
}

/**
 * The place in a batch a refusal names, from the script's own stderr line
 * (`viewport: message 2 of 3 was refused (exit 3)`).
 * @param {unknown} stderr - the batch's stderr.
 * @returns {number | undefined} the 1-based message number, or undefined when the failure was not a refusal.
 */
export function refusalIndex(stderr) {
  if (typeof stderr !== 'string') return undefined
  const match = /message (\d+) of \d+ was refused/.exec(stderr)
  if (match === null) return undefined
  const index = Number(match[1])
  return Number.isInteger(index) && index >= 1 ? index : undefined
}

/**
 * The script that runs a batch: a `run` helper that numbers each invocation,
 * stops at the first refusal with the invocation's own exit code and the
 * failing message's place in the batch on stderr, and otherwise records the
 * completed message's number in `$VIEWPORT_PROGRESS` when the seat asked for
 * a progress marker.
 * @param {string[]} command - the executable and its standing arguments, each already quoted.
 * @param {string[][]} messages - the message argument lists.
 * @returns {string} the script text.
 */
export function batchScript(command, messages) {
  const lines = [
    'n=0',
    'run() {',
    '  n=$((n + 1))',
    `  ${command.join(' ')} "$@" || { s=$?; echo "viewport: message $n of ${messages.length} was refused (exit $s)" >&2; exit $s; }`,
    '  [ -z "${VIEWPORT_PROGRESS:-}" ] || printf \'%s\\n\' "$n" >> "$VIEWPORT_PROGRESS" 2>/dev/null || true',
    '}',
    ...messages.map((message) => `run ${message.map(shellQuote).join(' ')}`),
  ]
  return `${lines.join('\n')}\n`
}

/** An error from one child invocation, carrying what the seat needs to shape and compensate it. */
function childFailure(kind, { code, signal, message, stdout = '', stderr = '' } = {}) {
  const error = new Error(message ?? `the ${kind} failed`)
  error.kind = kind
  if (code !== undefined) error.code = code
  if (signal !== undefined) error.signal = signal
  error.stdout = stdout
  error.stderr = stderr
  error.killed = kind === 'timeout' || kind === 'abort' || kind === 'output'
  return error
}

/**
 * Run one command in its own process group, collecting its output.
 *
 * `spawn(..., { detached: true })` makes the command a session and process
 * group leader, so a timeout or abort can kill the whole tree with one
 * `kill(-pid, SIGKILL)` instead of only the direct child. The promise settles
 * on `close`, after the group's output pipes have closed, which is what lets
 * the caller compensate only once nothing is left to press anything.
 *
 * @param {string} command - the executable.
 * @param {string[]} args - its arguments.
 * @param {object} options - the run's shape.
 * @param {number} options.timeout - budget in milliseconds.
 * @param {AbortSignal} [options.signal] - the call's cancellation.
 * @param {NodeJS.ProcessEnv} [options.env] - the environment.
 * @returns {Promise<{ stdout: string, stderr: string }>} the collected output.
 */
function runChild(command, args, { timeout, signal, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    })
    let stdout = ''
    let stderr = ''
    let kind
    let settled = false
    let timer

    const finish = (error, value) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error === undefined) resolve(value)
      else reject(error)
    }
    const killGroup = () => {
      if (child.pid === undefined) return
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        // The group may already be empty. Killing the direct child as well
        // covers a platform where the group signal did not take.
        try {
          child.kill('SIGKILL')
        } catch {
          // Nothing left to kill either way.
        }
      }
    }
    const fail = (nextKind) => {
      if (settled || kind !== undefined) return
      kind = nextKind
      killGroup()
    }
    const onAbort = () => fail('abort')
    const onTimer = () => fail('timeout')

    if (signal !== undefined) {
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    }
    if (Number.isFinite(timeout) && timeout > 0) timer = setTimeout(onTimer, timeout)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      if (stdout.length + stderr.length > MAX_OUTPUT) fail('output')
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      if (stdout.length + stderr.length > MAX_OUTPUT) fail('output')
    })
    child.on('error', (error) => {
      finish(childFailure(kind ?? 'spawn', { code: error.code, message: error.message, stdout, stderr }))
    })
    child.on('close', (code, closedBy) => {
      if (settled) return
      if (kind === 'abort') {
        finish(childFailure('abort', { code, signal: closedBy, stdout, stderr }))
        return
      }
      if (kind === 'timeout') {
        finish(childFailure('timeout', { code, signal: closedBy, stdout, stderr }))
        return
      }
      if (kind === 'output') {
        finish(childFailure('output', { code, signal: closedBy, stdout, stderr }))
        return
      }
      if (code === 0) {
        finish(undefined, { stdout, stderr })
        return
      }
      finish(childFailure('exit', { code, signal: closedBy, stdout, stderr }))
    })
  })
}

/** Read the last completed message number from a progress marker. */
async function readProgress(path) {
  try {
    const text = await readFile(path, 'utf8')
    const lines = text.split('\n').filter((line) => line.trim().length > 0)
    if (lines.length === 0) return 0
    const value = Number(lines[lines.length - 1])
    return Number.isInteger(value) && value >= 0 ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * The sentence that tells the model what compensation did. It always names
 * something — the released inputs, or that nothing was held — because the
 * difference matters when a key is stuck.
 * @param {{ released: Array<object>, failed: Array<{ input: object, reason: string }> }} report - the compensation outcome.
 * @returns {string} one sentence.
 */
function compensationSentence({ released, failed }) {
  if (released.length === 0 && failed.length === 0) {
    return 'Nothing was held, so nothing was released.'
  }
  const failedInputs = failed.map((entry) => entry.input)
  const failedNames = describeInputs(failedInputs)
  if (failed.length === 0) {
    return `Released ${describeInputs(released)} (reverse press order); nothing is left held.`
  }
  const reason = failed[0].reason
  const stillHeld = failed.length === 1 ? 'it may still be held' : 'they may still be held'
  if (released.length === 0) {
    return `Could not release ${failedNames} (${reason}); ${stillHeld} — call the \`release\` action.`
  }
  return `Released ${describeInputs(released)} (reverse press order); could not release ${failedNames} (${reason}) — call the \`release\` action.`
}

/**
 * A seat for one Viewport session.
 *
 * @example
 * const seat = new ViewportSeat({ executable: 'viewport', timeoutMs: 10000 })
 * await seat.run([...pointerMessage(100, 200), ...buttonMessage(272, true), ...buttonMessage(272, false)], signal)
 */
export class ViewportSeat {
  #executable

  #base

  #timeoutMs

  #envOverrides

  /** The FIFO: every run and every release waits here, in call order. */
  #jobs = []

  #busy = false

  /** What the plugin has pressed and not confirmed released, in press order. */
  #ledger = new Map()

  /**
   * @param {object} options - the resolved plugin configuration.
   * @param {string} options.executable - the `viewport` client (a store path pins it).
   * @param {string} [options.socket] - explicit control socket; omitted, the client finds the session's own.
   * @param {string} [options.runtimeDir] - `XDG_RUNTIME_DIR` override for a seat outside the session.
   * @param {string} [options.waylandDisplay] - the Wayland display to talk to when the environment's own is not the session ('wayland-1' for a seat outside the session).
   * @param {number} options.timeoutMs - per-message budget.
   */
  constructor({ executable, socket, runtimeDir, waylandDisplay, timeoutMs }) {
    this.#executable = executable
    // `msg` is the subcommand, not part of any message: without it the binary
    // starts a compositor instead of talking to one.
    this.#base = socket === undefined ? ['msg'] : ['msg', '--socket', socket]
    this.#timeoutMs = timeoutMs
    this.#envOverrides = {}
    if (runtimeDir !== undefined) this.#envOverrides.XDG_RUNTIME_DIR = runtimeDir
    if (waylandDisplay !== undefined) this.#envOverrides.WAYLAND_DISPLAY = waylandDisplay
  }

  /** The timeout one batch of this size gets: a per-message budget with room for startup, capped so a wedged session still ends the call. */
  timeoutFor(count) {
    if (count <= 1) return this.#timeoutMs
    return Math.max(this.#timeoutMs, Math.min(count * 500 + 3000, 300_000))
  }

  /**
   * Run one message list. Resolves when every message has been accepted;
   * rejects with the client's own words when one is refused, or with a
   * timeout/abort shaped error when it never answers. On any failure the
   * keys and buttons the batch had pressed are released first, and the error
   * says what was released.
   * @param {string[][]} messages - the message argument lists, in order.
   * @param {AbortSignal} [signal] - the tool call's cancellation.
   */
  async run(messages, signal) {
    if (messages.length === 0) return
    if (signal?.aborted) throw abortError()
    await this.#enqueue(() => this.#runBatch(messages, signal), signal)
  }

  /**
   * Let go of everything the plugin may still be holding: the ledger's keys
   * and buttons (last press first) and then the standard modifier and button
   * set, so a state the ledger missed is still cleared. Each message runs on
   * its own, so one refusal cannot leave the rest of the sweep unsent; a
   * refusal is reported, not thrown, and the ledger keeps the input for a
   * later retry. Safe when nothing is held — the releases are no-ops.
   * @param {AbortSignal} [signal] - the tool call's cancellation.
   * @returns {Promise<{ known: Array<object>, released: Array<object>, failed: Array<{ input: object, reason: string }> }>} what was known held and what happened.
   */
  async releaseAll(signal) {
    if (signal?.aborted) throw abortError()
    return this.#enqueue(() => this.#releaseNow(signal), signal)
  }

  /** The FIFO itself: one task at a time, in call order, aborts removed before their turn. */
  #enqueue(task, signal) {
    return new Promise((resolve, reject) => {
      const job = { task, signal, resolve, reject, started: false, settled: false, cancelled: false, onAbort: undefined }
      if (signal !== undefined) {
        job.onAbort = () => {
          if (job.started || job.settled) return
          job.cancelled = true
          const index = this.#jobs.indexOf(job)
          if (index !== -1) this.#jobs.splice(index, 1)
          this.#settle(job, () => reject(abortError()))
        }
        signal.addEventListener('abort', job.onAbort, { once: true })
      }
      this.#jobs.push(job)
      this.#pump()
    })
  }

  #settle(job, action) {
    if (job.settled) return
    job.settled = true
    if (job.onAbort !== undefined) job.signal.removeEventListener('abort', job.onAbort)
    action()
  }

  #pump() {
    if (this.#busy) return
    this.#busy = true
    void this.#drain()
  }

  async #drain() {
    try {
      while (this.#jobs.length > 0) {
        const job = this.#jobs.shift()
        if (job.cancelled || job.settled) continue
        if (job.signal?.aborted) {
          this.#settle(job, () => job.reject(abortError()))
          continue
        }
        job.started = true
        if (job.onAbort !== undefined) {
          job.signal.removeEventListener('abort', job.onAbort)
          job.onAbort = undefined
        }
        try {
          const value = await job.task()
          this.#settle(job, () => job.resolve(value))
        } catch (error) {
          this.#settle(job, () => job.reject(error))
        }
      }
    } finally {
      this.#busy = false
    }
  }

  /** The environment for one invocation; overrides are only cloned in when there is something to add. */
  #environment(extra) {
    const overrides = { ...this.#envOverrides, ...extra }
    if (Object.keys(overrides).length === 0) return undefined
    return { ...process.env, ...overrides }
  }

  /** How long one compensation release may take. */
  #compensationTimeout() {
    return Math.max(1, Math.min(this.#timeoutMs, COMPENSATION_CAP_MS))
  }

  /** One message through the client, as its own invocation. */
  async #invoke(message, signal, timeout, extraEnv) {
    if (signal?.aborted) {
      const error = abortError()
      error.noProcess = true
      throw error
    }
    return runChild(this.#executable, [...this.#base, ...message], {
      timeout,
      signal,
      env: this.#environment(extraEnv),
    })
  }

  /** A whole batch as one shell script, with a progress marker when the platform can hold one. */
  async #invokeScript(messages, signal, timeout, progressPath) {
    if (signal?.aborted) {
      const error = abortError()
      error.noProcess = true
      throw error
    }
    const command = [this.#executable, ...this.#base].map(shellQuote)
    return runChild('sh', ['-c', batchScript(command, messages)], {
      timeout,
      signal,
      env: this.#environment(progressPath === undefined ? undefined : { VIEWPORT_PROGRESS: progressPath }),
    })
  }

  /** A private, empty file the batch's shell appends the completed message number to. */
  async #progressFile() {
    let dir
    try {
      dir = await mkdtemp(join(tmpdir(), 'dsh-viewport-run-'))
      const path = join(dir, 'progress')
      await writeFile(path, '')
      return {
        path,
        cleanup: async () => {
          try {
            await rm(dir, { recursive: true, force: true })
          } catch {
            // A leftover temp directory must never mask the batch's error.
          }
        },
      }
    } catch {
      if (dir !== undefined) {
        try {
          await rm(dir, { recursive: true, force: true })
        } catch {
          // Best effort; the marker is an optimisation, not a correctness need.
        }
      }
      // No marker is a degraded mode, not a failure: compensation falls back
      // to releasing every press the batch contains.
      return undefined
    }
  }

  /** Run the messages and attach how far the batch got, when the failure interrupted it. */
  async #invokeBatch(messages, signal, timeout) {
    if (messages.length === 1) {
      await this.#invoke(messages[0], signal, timeout)
      return
    }
    const progress = await this.#progressFile()
    try {
      await this.#invokeScript(messages, signal, timeout, progress?.path)
    } catch (error) {
      if (progress !== undefined) error.completed = await readProgress(progress.path)
      throw error
    } finally {
      await progress?.cleanup()
    }
  }

  /**
   * What could be down after the batch stopped, and which messages actually
   * ran. A refusal is exact (the script names the message and a refused
   * message was not applied). A timeout or abort trusts the progress marker
   * for the completed prefix and adds the in-flight message's press, because
   * it may have been accepted before the kill. With no marker at all, every
   * press in the batch is assumed — releasing an input that is not down is
   * harmless, and this is the only way not to miss one.
   */
  #heldForFailure(messages, failure) {
    const refused = refusalIndex(failure.stderr)
    if (refused !== undefined) {
      const count = Math.min(refused - 1, messages.length)
      return { held: heldAfter(messages.slice(0, count)), prefix: messages.slice(0, count) }
    }
    if (failure.completed !== undefined) {
      const count = Math.min(Math.max(failure.completed, 0), messages.length)
      const prefix = messages.slice(0, count)
      const held = heldAfter(prefix)
      const next = messages[count]
      const change = next === undefined ? undefined : inputStateChange(next)
      if (change !== undefined && change.pressed) {
        const key = inputKey(change.input)
        const rest = held.filter((input) => inputKey(input) !== key)
        rest.push(change.input)
        return { held: rest, prefix }
      }
      return { held, prefix }
    }
    return { held: pressedInputs(messages), prefix: [] }
  }

  /** Release everything in `held`, last press first, without ever throwing. */
  async #compensate(held) {
    const released = []
    const failed = []
    for (const input of [...held].reverse()) {
      try {
        await this.#invoke(releaseMessage(input), undefined, this.#compensationTimeout())
        released.push(input)
        this.#ledger.delete(inputKey(input))
      } catch (error) {
        failed.push({ input, reason: this.#reason(error) })
      }
    }
    return { released, failed }
  }

  /** A one-line reason for a compensation release that did not land. */
  #reason(error) {
    if (error?.kind === 'spawn') {
      return error.code === 'ENOENT' ? 'the viewport client is not on this machine' : 'the viewport client could not start'
    }
    if (error?.kind === 'timeout') return `no answer within ${this.#compensationTimeout()}ms`
    if (error?.kind === 'output') return 'too much output'
    const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : ''
    if (stderr.length > 0) return stderr.split('\n')[0]
    return error?.message ?? 'unknown failure'
  }

  /** Remember one input as possibly down, moving it to the end of the press order. */
  #remember(input) {
    const key = inputKey(input)
    this.#ledger.delete(key)
    this.#ledger.set(key, input)
  }

  /** Apply a batch's state changes to the ledger. */
  #applyMessages(messages) {
    for (const message of messages) {
      const change = inputStateChange(message)
      if (change === undefined) continue
      if (change.pressed) this.#remember(change.input)
      else this.#ledger.delete(inputKey(change.input))
    }
  }

  /** One batch: run it, or compensate it and throw the shaped error. */
  async #runBatch(messages, signal) {
    if (signal?.aborted) throw abortError()
    const timeout = this.timeoutFor(messages.length)
    try {
      await this.#invokeBatch(messages, signal, timeout)
    } catch (failure) {
      // Not a child failure (a bad message argument, say) or an abort before
      // anything was spawned: there is nothing to compensate, and the
      // original error is the truthful one.
      if (failure?.kind === undefined || failure?.noProcess === true) throw failure
      if (failure.kind === 'spawn') throw this.#shape(failure, timeout)
      const { held, prefix } = this.#heldForFailure(messages, failure)
      this.#applyMessages(prefix)
      for (const input of held) this.#remember(input)
      const report = await this.#compensate(held)
      const error = this.#shape(failure, timeout)
      error.message = `${error.message} ${compensationSentence(report)}`
      throw error
    }
    this.#applyMessages(messages)
  }

  /** The `release` action's work, serialized with every run. */
  async #releaseNow(signal) {
    const known = [...this.#ledger.values()]
    const released = []
    const failed = []
    for (const input of releasePlan(known)) {
      if (signal?.aborted) throw abortError()
      try {
        await this.#invoke(releaseMessage(input), signal, this.#timeoutMs)
        released.push(input)
        this.#ledger.delete(inputKey(input))
      } catch (error) {
        if (error?.noProcess === true || error?.kind === 'abort') throw abortError()
        failed.push({ input, reason: this.#reason(error) })
      }
    }
    return { known, released, failed }
  }

  /** Map a child-process failure onto the error the model reads. */
  #shape(failure, timeout) {
    if (failure.kind === 'abort') return abortError()
    if (failure.kind === 'timeout') {
      return new Error(`\`${this.#executable}\` did not answer within ${timeout}ms; is a Viewport session running?`)
    }
    if (failure.kind === 'output') {
      return new Error(`\`${this.#executable}\` produced more than 16 MiB of output; the batch was stopped`)
    }
    if (failure.kind === 'spawn') {
      if (failure.code === 'ENOENT') {
        return new Error(`cannot run \`${this.#executable}\`: ${failure.message} — set the plugin's \`executable\` to the Viewport binary`)
      }
      return new Error(`cannot run \`${this.#executable}\`: ${failure.message ?? failure.code ?? 'the client did not start'}`)
    }
    const stderr = typeof failure.stderr === 'string' ? failure.stderr.trim() : ''
    if (stderr.length > 0) return new Error(stderr)
    return new Error(`\`${this.#executable}\` exited ${failure.code ?? 'unnamed'} with no message on stderr`)
  }
}
