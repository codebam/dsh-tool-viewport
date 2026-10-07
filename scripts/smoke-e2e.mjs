/**
 * End-to-end smoke for the plugin modules against a real Viewport instance:
 * the real seat runs `viewport msg` against the control socket, the real
 * capture runs grim against the Wayland socket, and the tool definition in
 * between is the one dsh mounts.
 *
 * The instance is whatever VP_RT names — scripts/headless-smoke.sh starts a
 * throwaway `viewport --headless` one there. The script never touches the
 * live session: it forces XDG_RUNTIME_DIR/WAYLAND_DISPLAY to the instance
 * and drops VIEWPORT_SOCKET (which, in a session shell, names the real one).
 *
 * Environment:
 *   VP_EXE   the viewport binary (default: the Viewport checkout's debug build)
 *   VP_GRIM  the capture client (default: grim on PATH)
 *   VP_RT    the instance's runtime dir (default: /tmp/vp-smoke)
 */
import { statSync } from 'node:fs'
import { ViewportSeat } from '../src/seat.mjs'
import { captureScreenshot } from '../src/shot.mjs'
import { mountViewportTool } from '../src/tool.mjs'
import { pointerMessage } from '../src/messages.mjs'

const V = process.env.VP_EXE ?? '/home/codebam/Documents/git/Viewport/target/debug/viewport'
const G = process.env.VP_GRIM ?? 'grim'
const RT = process.env.VP_RT ?? '/tmp/vp-smoke'
const SOCK = `${RT}/viewport-wayland-1.sock`

if (RT.startsWith('/run/user')) {
  console.error(`refusing to run against ${RT}: that is a live session's runtime dir`)
  process.exit(1)
}
process.env.XDG_RUNTIME_DIR = RT
process.env.WAYLAND_DISPLAY = 'wayland-1'
delete process.env.VIEWPORT_SOCKET

const exec = { signal: new AbortController().signal }
let failed = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`)
  if (!ok) failed += 1
}

function mount({ attachments, captureDir = `${RT}/shots` } = {}) {
  let tool
  const ctx = {
    get: (name) => (name === 'attachments' ? attachments : undefined),
    tools: { register: (t) => { tool = t } },
  }
  const seat = new ViewportSeat({ executable: V, socket: SOCK, timeoutMs: 8000 })
  const capture = ({ signal }) => captureScreenshot({ grim: G, dir: captureDir, timeoutMs: 8000, signal })
  tool = mountViewportTool(ctx, { seat, capture })
  return tool
}

const tool = mount()

const rMove = await tool.execute({ action: 'move', x: 123, y: 456 }, exec)
check('move', rMove.summary === 'Moved the pointer to (123, 456).', rMove.summary)

const rClick = await tool.execute({ action: 'click', x: 100, y: 100 }, exec)
check('click at a point', rClick.summary.includes('Clicked the left button at (100, 100)'), rClick.summary)

const rRight = await tool.execute({ action: 'click', button: 'right' }, exec)
check('click at the pointer', rRight.summary.includes('right button at the pointer'), rRight.summary)

const rScroll = await tool.execute({ action: 'scroll', dy: 3 }, exec)
check('scroll', rScroll.summary.includes('3 notches up'), rScroll.summary)

const rBoth = await tool.execute({ action: 'scroll', dx: -2, dy: -1, x: 300, y: 300 }, exec)
check('scroll both axes, moving first', rBoth.summary.includes('1 notch down and 2 notches left'), rBoth.summary)

const rType = await tool.execute({ action: 'type', text: 'echo hi\n' }, exec)
check('type', rType.summary.includes('Typed 8 characters'), rType.summary)

const rChord = await tool.execute({ action: 'key', key: 'ctrl+shift+Escape' }, exec)
check('chord', rChord.summary === 'Pressed ctrl+shift+Escape.', rChord.summary)

const rShot = await tool.execute({ action: 'screenshot' }, exec)
check('screenshot path', rShot.path.startsWith(`${RT}/shots/`), rShot.path)
check('screenshot envelope', /1920x1080 px PNG/.test(rShot.summary), rShot.summary.split('\n')[0])
check('screenshot file on disk', statSync(rShot.path).size > 0)
check('no attachment store, no image block', rShot.image === undefined)

const saved = []
const tool2 = mount({
  attachments: {
    async saveImage(input) {
      saved.push(input)
      return { attachmentId: 'att-e2e', mediaType: 'image/png', bytes: input.data.length, width: 1920, height: 1080 }
    },
  },
})
const rShot2 = await tool2.execute({ action: 'screenshot' }, exec)
check('attached image', rShot2.image?.attachmentId === 'att-e2e' && saved.length === 1)
const blocks = tool2.output.render({ action: 'screenshot' }, rShot2)
check('render blocks: text + image', blocks.length === 2 && blocks[0].type === 'text' && blocks[1].type === 'image')
check('render text is the summary', blocks[0].text === rShot2.summary)

// The defaults path: no socket configured, discovery through the environment.
const seatEnv = new ViewportSeat({ executable: V, timeoutMs: 8000 })
await seatEnv.run([pointerMessage(7, 8)])
check('socket discovery from the environment', true)

console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
