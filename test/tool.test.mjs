import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chordMessages, typeText } from '../src/keys.mjs'
import { mountViewportTool, validateViewportArgs } from '../src/tool.mjs'

const SIGNAL = new AbortController().signal
const EXEC = { callId: 'call-1', signal: SIGNAL }

const SHOT = { path: '/tmp/dsh-viewport/shot.png', data: Buffer.from('png-bytes'), width: 640, height: 360 }

/** A mock Cordis context capturing the tool registration and the attachment seam. */
function createCtx({ attachments } = {}) {
  const state = { tool: undefined }
  const ctx = {
    get: (name) => (name === 'attachments' ? attachments : undefined),
    tools: {
      register(tool) {
        state.tool = tool
      },
    },
  }
  return { ctx, state }
}

/** A seat stub recording every message list, in the order they were run. */
function createSeat() {
  const state = { runs: [] }
  return {
    state,
    seat: {
      async run(messages, signal) {
        state.runs.push({ messages, signal })
      },
    },
  }
}

/** Mount the tool against mocks; returns everything the assertions need. */
function mount({ attachments, shot = SHOT } = {}) {
  const { ctx, state } = createCtx({ attachments })
  const { seat, state: seatState } = createSeat()
  const captureCalls = []
  const tool = mountViewportTool(ctx, {
    seat,
    capture: async ({ signal }) => {
      captureCalls.push({ signal })
      return shot
    },
  })
  return { tool, state, seatState, captureCalls }
}

/** The messages from the first (usually only) seat run. */
function firstRun(seatState) {
  assert.equal(seatState.runs.length, 1, 'one run')
  return seatState.runs[0]
}

test('move runs one pointer message and reports where', async () => {
  const { tool, seatState } = mount()
  const value = await tool.execute({ action: 'move', x: 100, y: 200 }, EXEC)
  assert.deepEqual(value, { action: 'move', summary: 'Moved the pointer to (100, 200).' })
  assert.deepEqual(firstRun(seatState).messages, [['-t', 'input.pointer', '--x', '100', '--y', '200']])
  assert.equal(firstRun(seatState).signal, SIGNAL)
})

test('click at a point moves, presses and releases without a gap', async () => {
  const { tool, seatState } = mount()
  const value = await tool.execute({ action: 'click', x: 10, y: 20 }, EXEC)
  assert.equal(value.summary, 'Clicked the left button at (10, 20).')
  assert.deepEqual(firstRun(seatState).messages, [
    ['-t', 'input.pointer', '--x', '10', '--y', '20'],
    ['-t', 'input.button', '--button', '272', '--pressed', 'true'],
    ['-t', 'input.button', '--button', '272', '--pressed', 'false'],
  ])
})

test('click without a point uses the pointer, and names the button it used', async () => {
  const { tool, seatState } = mount()
  const value = await tool.execute({ action: 'click', button: 'right' }, EXEC)
  assert.equal(value.summary, 'Clicked the right button at the pointer.')
  assert.deepEqual(firstRun(seatState).messages, [
    ['-t', 'input.button', '--button', '273', '--pressed', 'true'],
    ['-t', 'input.button', '--button', '273', '--pressed', 'false'],
  ])
})

test('scroll turns the wheel where asked, and can move there first', async () => {
  const { tool, seatState } = mount()
  const value = await tool.execute({ action: 'scroll', dy: 3 }, EXEC)
  assert.equal(value.summary, 'Scrolled 3 notches up.')
  assert.deepEqual(firstRun(seatState).messages, [['-t', 'input.scroll', '--dx', '0', '--dy', '3']])

  const second = mount()
  const moved = await second.tool.execute({ action: 'scroll', dx: -1, dy: -2, x: 5, y: 6 }, EXEC)
  assert.equal(moved.summary, 'Scrolled 2 notches down and 1 notch left at (5, 6).')
  assert.deepEqual(firstRun(second.seatState).messages, [
    ['-t', 'input.pointer', '--x', '5', '--y', '6'],
    ['-t', 'input.scroll', '--dx', '-1', '--dy', '-2'],
  ])
})

test('type runs the typing message list and reports the count', async () => {
  const { tool, seatState } = mount()
  const value = await tool.execute({ action: 'type', text: 'Hi\nyo' }, EXEC)
  assert.equal(value.summary, 'Typed 5 characters ("Hi\\nyo").')
  assert.deepEqual(firstRun(seatState).messages, typeText('Hi\nyo'))
})

test('key runs the chord and reports it canonically', async () => {
  const { tool, seatState } = mount()
  const value = await tool.execute({ action: 'key', key: 'Ctrl+Shift+T' }, EXEC)
  assert.equal(value.summary, 'Pressed ctrl+shift+T.')
  assert.deepEqual(firstRun(seatState).messages, chordMessages('Ctrl+Shift+T'))
})

test('bad calls are refused before anything is sent', async () => {
  const { tool, seatState, captureCalls } = mount()
  // The framework's own schema gate runs first, for the things a schema can say.
  await assert.rejects(tool.execute({ action: 'teleport' }, EXEC), /invalid arguments/)
  await assert.rejects(tool.execute({ action: 'click', button: 'thumb' }, EXEC), /invalid arguments/)
  await assert.rejects(tool.execute({ action: 'move', x: NaN, y: 1 }, EXEC), /invalid arguments/)
  // And the tool's own checks catch what a schema cannot: the conditional
  // requirements and the values that are the right type but the wrong kind.
  await assert.rejects(tool.execute({ action: 'move', x: 1 }, EXEC), /move needs both x and y/)
  await assert.rejects(tool.execute({ action: 'click', y: 1 }, EXEC), /click takes x and y together/)
  await assert.rejects(tool.execute({ action: 'scroll' }, EXEC), /scroll needs dx or dy/)
  await assert.rejects(tool.execute({ action: 'scroll', dy: 1.5 }, EXEC), /whole number of notches/)
  await assert.rejects(tool.execute({ action: 'scroll', dx: 1, y: 2 }, EXEC), /scroll takes x and y together/)
  await assert.rejects(tool.execute({ action: 'type', text: '' }, EXEC), /type needs text/)
  await assert.rejects(tool.execute({ action: 'type', text: 'x'.repeat(2001) }, EXEC), /at most 2000 characters/)
  await assert.rejects(tool.execute({ action: 'type', text: 'a\u0007' }, EXEC), /cannot type U\+0007/)
  await assert.rejects(tool.execute({ action: 'key' }, EXEC), /key needs the key or chord/)
  assert.equal(seatState.runs.length, 0, 'nothing reached the seat')
  assert.equal(captureCalls.length, 0, 'nothing reached the capture')
})

test('validateViewportArgs passes every action it offers, and refuses the rest with its own words', () => {
  validateViewportArgs({ action: 'screenshot' })
  validateViewportArgs({ action: 'move', x: 0, y: 0 })
  validateViewportArgs({ action: 'click' })
  validateViewportArgs({ action: 'scroll', dy: -1 })
  validateViewportArgs({ action: 'type', text: 'ok' })
  validateViewportArgs({ action: 'key', key: 'Return' })
  assert.throws(() => validateViewportArgs({ action: 'teleport' }), /unknown action "teleport"/)
  assert.throws(() => validateViewportArgs({ action: 'click', button: 'thumb' }), /unknown button "thumb"/)
  assert.throws(() => validateViewportArgs({ action: 'move', x: NaN, y: 1 }), /x must be a finite number/)
  assert.throws(() => validateViewportArgs({ action: 'move', x: Infinity, y: 1 }), /x must be a finite number/)
  assert.throws(() => validateViewportArgs(null), /object of arguments/)
})

test('an aborted call never runs anything', async () => {
  const { tool, seatState } = mount()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    tool.execute({ action: 'move', x: 1, y: 2 }, { ...EXEC, signal: controller.signal }),
    (error) => {
      assert.equal(error.name, 'AbortError')
      return true
    },
  )
  assert.equal(seatState.runs.length, 0)
})

test('a screenshot without an attachment store reports the file honestly', async () => {
  const { tool, seatState, captureCalls } = mount()
  const value = await tool.execute({ action: 'screenshot' }, EXEC)
  assert.equal(value.action, 'screenshot')
  assert.equal(value.path, '/tmp/dsh-viewport/shot.png')
  assert.equal(value.image, undefined)
  assert.match(value.summary, /screenshot of the whole Viewport desktop layout: 640x360 px PNG, 9 bytes/)
  assert.match(value.summary, /no attachment store is mounted/)
  assert.equal(captureCalls.length, 1)
  assert.equal(captureCalls[0].signal, SIGNAL)
  assert.equal(seatState.runs.length, 0)
})

test('a screenshot with an attachment store comes back as an image', async () => {
  const saved = []
  const attachments = {
    async saveImage(input) {
      saved.push(input)
      return { attachmentId: 'att-1', mediaType: 'image/png', bytes: 9, width: 640, height: 360 }
    },
  }
  const { tool } = mount({ attachments })
  const value = await tool.execute({ action: 'screenshot' }, EXEC)
  assert.deepEqual(value.image, { attachmentId: 'att-1', mediaType: 'image/png', bytes: 9, width: 640, height: 360 })
  assert.equal(saved.length, 1)
  assert.equal(saved[0].mediaType, 'image/png')
  assert.equal(saved[0].name, 'shot.png')
  assert.equal(saved[0].data, SHOT.data)
  const rendered = tool.output.render({ action: 'screenshot' }, value)
  assert.equal(rendered.length, 2)
  assert.equal(rendered[0].type, 'text')
  assert.match(rendered[0].text, /^<path>\/tmp\/dsh-viewport\/shot\.png<\/path>/)
  assert.equal(rendered[1].type, 'image')
  assert.equal(rendered[1].attachment.attachmentId, 'att-1')
})

test('a downscaled attachment tells the model which way to multiply', async () => {
  const attachments = {
    async saveImage() {
      return {
        attachmentId: 'att-2',
        mediaType: 'image/png',
        bytes: 99,
        width: 1920,
        height: 1080,
        originalDimensions: { width: 3840, height: 2160 },
      }
    },
  }
  const { tool } = mount({ attachments })
  const value = await tool.execute({ action: 'screenshot' }, EXEC)
  assert.match(value.summary, /multiply a coordinate read on this image by 2\.00/)
  const rendered = tool.output.render({ action: 'screenshot' }, value)
  assert.deepEqual(rendered[1].attachment.originalDimensions, { width: 3840, height: 2160 })
})

test('a failed attachment store still reports the capture and says why', async () => {
  const attachments = {
    async saveImage() {
      throw new Error('image cannot be stored within the limits')
    },
  }
  const { tool } = mount({ attachments })
  const value = await tool.execute({ action: 'screenshot' }, EXEC)
  assert.equal(value.image, undefined)
  assert.match(value.summary, /could not be attached \(image cannot be stored within the limits\)/)
  assert.match(value.summary, /saved at the path above/)
})

test('input results render as their summary and nothing else', async () => {
  const { tool } = mount()
  const value = await tool.execute({ action: 'scroll', dy: 3 }, EXEC)
  assert.deepEqual(tool.output.render({ action: 'scroll' }, value), [{ type: 'text', text: 'Scrolled 3 notches up.' }])
})

test('presentCall titles say what will happen and screenshots read as reads', () => {
  const { tool } = mount()
  assert.deepEqual(tool.presentCall({ action: 'screenshot' }), {
    card: 'generic',
    title: 'Screenshot the desktop',
    kind: 'read',
  })
  assert.equal(tool.presentCall({ action: 'click', x: 3, y: 4, button: 'right' }).title, 'Click right at (3, 4)')
  assert.equal(tool.presentCall({ action: 'click' }).title, 'Click left at the pointer')
  assert.equal(tool.presentCall({ action: 'scroll', dy: -2 }).title, 'Scroll 2 notches down')
  assert.equal(tool.presentCall({ action: 'key', key: 'ctrl+c' }).title, 'Press ctrl+c')
  assert.equal(tool.presentCall({ action: 'type', text: 'hi' }).title, 'Type "hi"')
  assert.equal(tool.presentCall({ action: 'move', x: 1, y: 2 }).title, 'Move the pointer to (1, 2)')
  assert.equal(tool.presentCall({ action: 'click' }).kind, 'execute')
})

test('presentCall covers the schema-valid calls a UI shows pending', () => {
  // The framework validates arguments against the parameter schema before it
  // calls presentCall, so only schema-valid calls ever arrive here — and one
  // that names an action without its fields still has to read sensibly.
  const { tool } = mount()
  assert.equal(tool.presentCall({ action: 'move' }).title, 'Move the pointer')
  assert.equal(tool.presentCall({ action: 'scroll' }).title, 'Scroll the wheel')
  assert.equal(tool.presentCall({ action: 'type' }).title, 'Type ""')
  assert.equal(tool.presentCall({ action: 'key' }).title, 'Press a key')
})
