/**
 * @codebam/dsh-tool-viewport
 *
 * The model-facing `viewport` tool for the DeepSeek Harness: screenshot,
 * pointer, wheel and keyboard control of a live Viewport session through its
 * control socket. The tool is a thin, deliberate consumer of two existing
 * interfaces rather than a new capability — `viewport msg` for everything
 * that enters the seat (`input.pointer`, `input.button`, `input.scroll`, and
 * `osk.key`, the same path the on-screen keyboard's keys take) and `grim`
 * for captures, which works because Viewport speaks `zwlr-screencopy-v1`.
 *
 * Nothing here goes through `ctx.shell`: the dsh host process spawns the two
 * clients directly, so the tool keeps working in compositions whose shell is
 * the OpenSandbox world. It does mean the plugin needs the `viewport` and
 * `grim` executables where dsh itself runs, and that it drives whoever is
 * logged in on that machine — the messages go into the real session.
 *
 * @module @codebam/dsh-tool-viewport
 */
import z from '@deepseek-ai/schemastery'
import { ViewportSeat } from './src/seat.mjs'
import { captureScreenshot, defaultScreenshotDir } from './src/shot.mjs'
import { mountViewportTool } from './src/tool.mjs'

/** Cordis plugin name. */
export const name = 'tool-viewport'

/** The tool registers into the tool registry and adds one short prompt section. */
export const inject = ['tools', 'systemPrompt']

/** Runtime configuration schema for the `viewport` tool plugin. */
export const Config = z.object({
  /** The `viewport` client every control message runs through. Defaults to `viewport` on PATH; deployments should pin a store path. */
  executable: z.string().default('viewport'),
  /** The screenshot tool. Defaults to `grim` on PATH; deployments should pin a store path. */
  grim: z.string().default('grim'),
  /** The control socket to talk to. Omitted, the client finds the session from its own environment (`VIEWPORT_SOCKET`, then the runtime dir). */
  socket: z.string(),
  /** `XDG_RUNTIME_DIR` to talk through when dsh's own environment is not the session (a service outside the login). */
  runtimeDir: z.string(),
  /** The Wayland display to talk to when dsh's own environment is not the session (for example `wayland-1`). */
  waylandDisplay: z.string(),
  /** Where captures are written. Defaults to a directory under the temp dir; the model sees the path in every screenshot result. */
  screenshotDir: z.string(),
  /** Per-message budget in milliseconds. A batch of messages (typing) scales this by its size, bounded at five minutes. */
  timeoutMs: z.number().default(10000),
})

/**
 * Mount the `viewport` tool.
 * @param {import('@deepseek-ai/cordis').Context} ctx - owning Cordis context.
 * @param {object} [config] - resolved plugin configuration.
 */
export function apply(ctx, config = {}) {
  const executable = config.executable ?? 'viewport'
  const grim = config.grim ?? 'grim'
  const timeoutMs = config.timeoutMs ?? 10000
  if (typeof executable !== 'string' || executable.trim().length === 0) {
    throw new Error('tool-viewport: executable must be a non-empty string')
  }
  if (typeof grim !== 'string' || grim.trim().length === 0) {
    throw new Error('tool-viewport: grim must be a non-empty string')
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`tool-viewport: timeoutMs must be a positive number, got ${JSON.stringify(config.timeoutMs)}`)
  }
  const seat = new ViewportSeat({
    executable,
    socket: config.socket,
    runtimeDir: config.runtimeDir,
    waylandDisplay: config.waylandDisplay,
    timeoutMs,
  })
  const screenshotDir = config.screenshotDir ?? defaultScreenshotDir()
  const capture = ({ signal }) => captureScreenshot({
    grim,
    runtimeDir: config.runtimeDir,
    waylandDisplay: config.waylandDisplay,
    dir: screenshotDir,
    timeoutMs,
    signal,
  })
  mountViewportTool(ctx, { seat, capture })
  ctx.systemPrompt.section({
    name: 'tool:viewport',
    order: ctx.systemPrompt.getSectionOrder('TOOL_BASH'),
    text: 'The `viewport` tool drives the actual desktop this harness runs on: its screenshots are the live screen, and its clicks, wheel turns and keystrokes land in the real session a person is sitting at. Screenshot first, act in small steps, and keep the user told what you are about to do to their screen.',
  })
}

export default { name, inject, Config, apply }
