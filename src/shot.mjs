/**
 * Screenshots: `grim` against the session, the same as a person typing it.
 *
 * Viewport speaks `zwlr-screencopy-v1`, so `grim` works as an ordinary client
 * (`docs/debugging.md`) — no portal, no consent dialog, no compositor-side
 * IPC for this. The capture is written to a PNG file under the plugin's
 * screenshot directory and read back: the file is what the result reports
 * and the model can revisit, while the bytes are what the attachment store
 * gets when one is mounted.
 *
 * @module @codebam/dsh-tool-viewport/shot
 */
import { execFile } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Where screenshots go when the configuration does not say: a directory of this run's own under the temp dir. */
export function defaultScreenshotDir() {
  return join(tmpdir(), 'dsh-viewport')
}

/** A filename stamp: local time to the millisecond, plus a little entropy so two calls in one millisecond do not collide. */
function shotName(now) {
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  const stamp = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
    pad(now.getMilliseconds(), 3),
  ].join('')
  return `viewport-${stamp}-${Math.random().toString(36).slice(2, 6)}.png`
}

/**
 * The dimensions in a PNG's IHDR chunk. Not a decoder: enough of one to
 * report the size the file it just wrote actually has.
 * @param {Buffer} data - the PNG bytes.
 * @returns {{ width: number, height: number }} the pixel dimensions.
 */
export function pngSize(data) {
  const png = Buffer.isBuffer(data) ? data : Buffer.from(data)
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (png.length < 24 || !png.subarray(0, 8).equals(signature) || png.subarray(12, 16).toString('latin1') !== 'IHDR') {
    throw new Error('the capture is not a PNG — grim did not write an image')
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

/** Run grim once, writing the capture to `path`; shaped failures like the seat's. */
function runGrim({ grim, runtimeDir, waylandDisplay, path, timeoutMs, signal }) {
  const overrides = {}
  if (runtimeDir !== undefined) overrides.XDG_RUNTIME_DIR = runtimeDir
  if (waylandDisplay !== undefined) overrides.WAYLAND_DISPLAY = waylandDisplay
  const env = Object.keys(overrides).length === 0 ? undefined : { ...process.env, ...overrides }
  const options = { timeout: timeoutMs, signal, env, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }
  return new Promise((resolve, reject) => {
    execFile(grim, [path], options, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ stdout, stderr })
        return
      }
      if (error.name === 'AbortError') {
        const aborted = new HarnessError('tool call aborted', TOOL_ABORTED)
        aborted.name = 'AbortError'
        reject(aborted)
        return
      }
      if (error.code === 'ENOENT') {
        reject(new Error(`cannot run \`${grim}\`: ${error.message} — set the plugin's \`grim\` to the screenshot tool`))
        return
      }
      if (error.killed) {
        reject(new Error(`\`${grim}\` did not answer within ${timeoutMs}ms`))
        return
      }
      const message = typeof stderr === 'string' ? stderr.trim() : ''
      reject(new Error(message.length > 0 ? message : `\`${grim}\` exited ${error.code ?? 'unnamed'} with no message on stderr`))
    })
  })
}

/**
 * Capture the whole desktop layout to a new PNG.
 * @param {object} options - capture configuration.
 * @param {string} options.grim - the grim executable.
 * @param {string} [options.runtimeDir] - `XDG_RUNTIME_DIR` override for a seat outside the session.
 * @param {string} [options.waylandDisplay] - Wayland display override for a seat outside the session.
 * @param {string} options.dir - screenshot directory (created if missing).
 * @param {number} options.timeoutMs - capture budget.
 * @param {AbortSignal} [options.signal] - the tool call's cancellation.
 * @param {() => Date} [options.now] - clock seam for tests.
 * @returns {Promise<{ path: string, data: Buffer, width: number, height: number }>} the capture.
 */
export async function captureScreenshot({ grim, runtimeDir, waylandDisplay, dir, timeoutMs, signal, now = () => new Date() }) {
  await mkdir(dir, { recursive: true })
  const path = join(dir, shotName(now()))
  await runGrim({ grim, runtimeDir, waylandDisplay, path, timeoutMs, signal })
  const data = await readFile(path)
  const { width, height } = pngSize(data)
  return { path, data, width, height }
}
