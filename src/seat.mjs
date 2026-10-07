/**
 * The seat: turning message lists into `viewport msg` runs.
 *
 * The compositor's socket refuses synthetic input from anyone but the
 * compositor's own client (`docs/ipc.md`), so every message is one `viewport
 * msg` invocation — the trusted client — rather than a hand-rolled socket
 * writer. Several messages run as one POSIX shell script of sequential
 * invocations: each invocation connects, sends, waits for the acceptance
 * barrier, and only then does the next one start, which keeps a click's press
 * and release milliseconds apart without paying a process spawn between
 * them.
 *
 * Every run goes through the plugin's one timeout. A batch gets the timeout
 * scaled by its message count, because the budget is per message, not per
 * batch: typing two hundred characters is four hundred invocations and a
 * perfectly healthy one can take seconds.
 *
 * @module @codebam/dsh-tool-viewport/seat
 */
import { execFile } from 'node:child_process'
import { TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import { HarnessError } from '@deepseek-ai/dsh-llm'

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

/** Run one command, resolving stdout/stderr and throwing shaped errors. */
function exec(command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error !== null) {
        error.stdout = stdout
        error.stderr = stderr
        reject(error)
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

/**
 * The script that runs a batch: a `run` helper that numbers each invocation
 * and stops at the first refusal with the invocation's own exit code and the
 * failing message's place in the batch on stderr.
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
    '}',
    ...messages.map((message) => `run ${message.map(shellQuote).join(' ')}`),
  ]
  return `${lines.join('\n')}\n`
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

  #env

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
    const overrides = {}
    if (runtimeDir !== undefined) overrides.XDG_RUNTIME_DIR = runtimeDir
    if (waylandDisplay !== undefined) overrides.WAYLAND_DISPLAY = waylandDisplay
    this.#env = Object.keys(overrides).length === 0 ? undefined : { ...process.env, ...overrides }
  }

  /** The timeout one batch of this size gets: a per-message budget with room for startup, capped so a wedged session still ends the call. */
  timeoutFor(count) {
    if (count <= 1) return this.#timeoutMs
    return Math.max(this.#timeoutMs, Math.min(count * 500 + 3000, 300_000))
  }

  /**
   * Run one message list. Resolves when every message has been accepted;
   * rejects with the client's own words when one is refused, or with a
   * timeout/abort shaped error when it never answers.
   * @param {string[][]} messages - the message argument lists, in order.
   * @param {AbortSignal} [signal] - the tool call's cancellation.
   */
  async run(messages, signal) {
    if (messages.length === 0) return
    if (signal?.aborted) throw abortError()
    const timeout = this.timeoutFor(messages.length)
    const options = {
      timeout,
      signal,
      env: this.#env,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf8',
    }
    let command
    let args
    if (messages.length === 1) {
      command = this.#executable
      args = [...this.#base, ...messages[0]]
    } else {
      command = 'sh'
      args = ['-c', batchScript([this.#executable, ...this.#base].map(shellQuote), messages)]
    }
    try {
      await exec(command, args, options)
    } catch (error) {
      throw this.#shape(error, timeout)
    }
  }

  /** Map a child-process failure onto the error the model reads. */
  #shape(error, timeout) {
    if (error.name === 'AbortError' || error instanceof HarnessError) return abortError()
    if (error.code === 'ENOENT') {
      return new Error(`cannot run \`${this.#executable}\`: ${error.message} — set the plugin's \`executable\` to the Viewport binary`)
    }
    if (error.killed) {
      return new Error(`\`${this.#executable}\` did not answer within ${timeout}ms; is a Viewport session running?`)
    }
    const stderr = typeof error.stderr === 'string' ? error.stderr.trim() : ''
    if (stderr.length > 0) return new Error(stderr)
    return new Error(`\`${this.#executable}\` exited ${error.code ?? 'unnamed'} with no message on stderr`)
  }
}
