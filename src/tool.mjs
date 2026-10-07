/**
 * The `viewport` tool: see and drive the Viewport desktop this harness runs on.
 *
 * One tool, one action per call: each call turns into a short list of control
 * messages (`src/messages.mjs`, `src/keys.mjs`) run through the trusted
 * `viewport msg` client (`src/seat.mjs`), or into one grim capture
 * (`src/shot.mjs`). Screenshots come back as images through the `attachments`
 * service when the composition mounts one — the same optional-service gate
 * `read_image` uses — and every result carries the text that names what
 * happened.
 *
 * @module @codebam/dsh-tool-viewport/tool
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { basename } from 'node:path'
import { canonicalChord, chordMessages, typeText } from './keys.mjs'
import { BUTTON_CODES, buttonMessage, pointerMessage, scrollMessage } from './messages.mjs'
import { screenshotSummary, scrollPhrase, typeSummary } from './render.mjs'
import { abortError } from './seat.mjs'

/** Every action the tool offers. */
export const ACTIONS = ['screenshot', 'move', 'click', 'scroll', 'type', 'key']

/** One call types at most this much; 2000 characters is 4000 messages already. */
export const MAX_TYPE_LENGTH = 2000

/**
 * The image outcome's schema, `read_image`'s minus the required marker at the
 * property level: a screenshot whose image could not be stored still reports
 * its path.
 */
const IMAGE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', required: true },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    name: { type: 'string' },
    originalDimensions: {
      type: 'object',
      additionalProperties: false,
      properties: {
        width: { type: 'integer', required: true },
        height: { type: 'integer', required: true },
      },
    },
  },
}

/** Refuse a non-number the schema's type check somehow let through. */
function assertFinite(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number, got ${JSON.stringify(value)}`)
  }
}

/** Scroll counts whole notches; half a detent is not a thing a wheel does. */
function assertNotches(value, name) {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`${name} must be a whole number of notches, got ${JSON.stringify(value)}`)
  }
}

/** The always-in-context description. */
export function viewportDescription() {
  return [
    'See and drive the Viewport desktop this harness runs on: take a screenshot, move the pointer, click, turn the wheel, type text, and press keys.',
    '',
    'Input goes into the real session a person is sitting at — the pointer moves on their screen and typing lands in whatever has focus — so look before you act: `screenshot` first, click what the image shows, screenshot again to check.',
    '',
    'Coordinates are layout pixels on the whole desktop: the same pixels as the screenshot, (0, 0) at its top-left corner. `scroll` counts wheel notches, positive up (`dy`) and right (`dx`); one notch is one detent of a wheel.',
    '',
    'Actions: `screenshot` captures the whole desktop and returns the image; `move` puts the pointer at (x, y); `click` presses and releases a button (`left`, `right`, `middle`) at the pointer, or at (x, y) in one step; `scroll` turns the wheel by (dx, dy) notches, optionally moving to (x, y) first; `type` types text, with `\\n` for Return; `key` presses one named key (`Return`, `Escape`, `Tab`, arrows, `F5`, …) or a `+` chord (`ctrl+c`, `ctrl+shift+t`).',
    '',
    'This needs a running Viewport session; a refused or unanswered message is reported as an error, in the client\'s own words.',
  ].join('\n')
}

/**
 * Validate one call. Runs before anything is sent, so a bad call costs
 * nothing on the session.
 * @param {object} args - the parsed model arguments.
 */
export function validateViewportArgs(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('the viewport tool takes an object of arguments')
  }
  const { action } = args
  if (typeof action !== 'string' || !ACTIONS.includes(action)) {
    throw new Error(`unknown action ${JSON.stringify(action)} — expected one of: ${ACTIONS.join(', ')}`)
  }
  const hasX = args.x !== undefined
  const hasY = args.y !== undefined
  const pointPair = (use) => {
    if (hasX !== hasY) throw new Error(`${use} takes x and y together — give both, or neither`)
    if (hasX) {
      assertFinite(args.x, 'x')
      assertFinite(args.y, 'y')
    }
  }
  switch (action) {
    case 'screenshot':
      break
    case 'move':
      if (!hasX || !hasY) throw new Error('move needs both x and y — the layout coordinates to put the pointer at')
      assertFinite(args.x, 'x')
      assertFinite(args.y, 'y')
      break
    case 'click':
      pointPair('click')
      if (args.button !== undefined && !(args.button in BUTTON_CODES)) {
        throw new Error(`unknown button ${JSON.stringify(args.button)} — the buttons are left, right and middle`)
      }
      break
    case 'scroll': {
      const dx = args.dx ?? 0
      const dy = args.dy ?? 0
      assertNotches(dx, 'dx')
      assertNotches(dy, 'dy')
      if (dx === 0 && dy === 0) {
        throw new Error('scroll needs dx or dy — the wheel notches to turn, positive up and right')
      }
      pointPair('scroll')
      break
    }
    case 'type': {
      if (typeof args.text !== 'string' || args.text.length === 0) {
        throw new Error('type needs text — the string to type')
      }
      const count = [...args.text].length
      if (count > MAX_TYPE_LENGTH) {
        throw new Error(`type takes at most ${MAX_TYPE_LENGTH} characters per call (this one is ${count}); split the text into a few calls`)
      }
      break
    }
    case 'key': {
      if (typeof args.key !== 'string' || args.key.trim().length === 0) {
        throw new Error('key needs the key or chord to press, like `Return`, `Escape` or `ctrl+c`')
      }
      break
    }
    default:
      throw new Error(`unknown action ${JSON.stringify(action)}`)
  }
}

/** Re-brand the canonical image value into the attachment reference an image block carries (identity, as `read_image` brands it). */
function imageRefFromValue(image) {
  return {
    attachmentId: image.attachmentId,
    mediaType: image.mediaType,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
    ...(image.name === undefined ? {} : { name: image.name }),
    ...(image.originalDimensions === undefined ? {} : { originalDimensions: { ...image.originalDimensions } }),
  }
}

/** One line for a pending call in a UI; defensively built, because it sees arguments before validation. */
function presentCall(args) {
  const button = typeof args?.button === 'string' ? args.button : 'left'
  const kind = args?.action === 'screenshot' ? 'read' : 'execute'
  let title = 'Viewport'
  try {
    switch (args?.action) {
      case 'screenshot':
        title = 'Screenshot the desktop'
        break
      case 'move':
        title = typeof args.x === 'number' && typeof args.y === 'number'
          ? `Move the pointer to (${args.x}, ${args.y})`
          : 'Move the pointer'
        break
      case 'click':
        title = args.x !== undefined && args.y !== undefined
          ? `Click ${button} at (${args.x}, ${args.y})`
          : `Click ${button} at the pointer`
        break
      case 'scroll': {
        const phrase = scrollPhrase(args.dx ?? 0, args.dy ?? 0)
        title = phrase === '' ? 'Scroll the wheel' : `Scroll ${phrase}`
        break
      }
      case 'type': {
        const text = typeof args.text === 'string' ? args.text : ''
        const preview = [...text].length > 40 ? `${[...text].slice(0, 39).join('')}…` : text
        title = `Type ${JSON.stringify(preview)}`
        break
      }
      case 'key':
        title = typeof args.key === 'string' && args.key.length > 0 ? `Press ${args.key}` : 'Press a key'
        break
      default:
        title = `Viewport ${typeof args?.action === 'string' ? args.action : ''}`.trim()
    }
  } catch {
    title = 'Viewport'
  }
  return { card: 'generic', title, kind }
}

/**
 * Mount the `viewport` tool.
 * @param {import('@deepseek-ai/cordis').Context} ctx - owning Cordis context.
 * @param {object} options - the wiring.
 * @param {object} options.seat - the seat to run messages through (`ViewportSeat`).
 * @param {(options: { signal: AbortSignal }) => Promise<{ path: string, data: Buffer, width: number, height: number }>} options.capture - one screenshot capture.
 * @returns {object} the registered tool definition.
 */
export function mountViewportTool(ctx, options) {
  const { seat, capture } = options
  const tool = defineTool({
    name: 'viewport',
    description: viewportDescription(),
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: [...ACTIONS],
        description: 'Which action to take.',
      },
      x: {
        type: 'number',
        description: 'Pointer x in layout pixels: required for `move`; optional for `click` and `scroll`, which move to it first.',
      },
      y: {
        type: 'number',
        description: 'Pointer y in layout pixels, beside x.',
      },
      button: {
        type: 'string',
        enum: [...Object.keys(BUTTON_CODES)],
        description: 'The mouse button for `click`; defaults to left.',
      },
      dx: {
        type: 'number',
        description: 'Wheel notches to the right (negative: left), for `scroll`.',
      },
      dy: {
        type: 'number',
        description: 'Wheel notches up (negative: down), for `scroll`.',
      },
      text: {
        type: 'string',
        description: 'The text to type, for `type`. Newlines are Return and tabs are Tab.',
      },
      key: {
        type: 'string',
        description: 'The key or chord to press, for `key`: a name like `Return`/`Escape`/`F5`, a single character, or modifiers joined with `+` (`ctrl+alt+t`).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          summary: { type: 'string', required: true },
          path: { type: 'string' },
          image: IMAGE_VALUE_SCHEMA,
        },
      },
      render: (_args, value) => [
        { type: 'text', text: value.summary },
        ...(value.image === undefined ? [] : [{ type: 'image', attachment: imageRefFromValue(value.image) }]),
      ],
    },
    async execute(args, exec) {
      validateViewportArgs(args)
      if (exec.signal?.aborted) throw abortError()
      switch (args.action) {
        case 'screenshot': {
          const shot = await capture({ signal: exec.signal })
          let image
          let note
          const attachments = ctx.get('attachments')
          if (attachments === undefined) {
            note = 'no attachment store is mounted in this session, so the image is not attached; the capture is saved at the path above'
          } else {
            try {
              const ref = await attachments.saveImage({
                data: shot.data,
                mediaType: 'image/png',
                name: basename(shot.path),
              })
              image = {
                attachmentId: ref.attachmentId,
                mediaType: ref.mediaType,
                bytes: ref.bytes,
                width: ref.width,
                height: ref.height,
                ...(ref.name === undefined ? {} : { name: ref.name }),
                ...(ref.originalDimensions === undefined ? {} : { originalDimensions: { ...ref.originalDimensions } }),
              }
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error)
              note = `the image could not be attached (${reason}); the capture is saved at the path above`
            }
          }
          // The envelope describes the image as the model will see it: when a
          // storage copy was downscaled, the click coordinates have to be
          // multiplied back out, and only the attached copy knows by how much.
          const shown = image === undefined
            ? { path: shot.path, width: shot.width, height: shot.height, bytes: shot.data.length }
            : {
                path: shot.path,
                width: image.width,
                height: image.height,
                bytes: image.bytes,
                ...(image.originalDimensions === undefined ? {} : { originalDimensions: image.originalDimensions }),
              }
          return {
            action: 'screenshot',
            summary: screenshotSummary(shown, note),
            path: shot.path,
            ...(image === undefined ? {} : { image }),
          }
        }
        case 'move': {
          await seat.run([pointerMessage(args.x, args.y)], exec.signal)
          return { action: 'move', summary: `Moved the pointer to (${args.x}, ${args.y}).` }
        }
        case 'click': {
          const button = args.button ?? 'left'
          const messages = []
          if (args.x !== undefined) messages.push(pointerMessage(args.x, args.y))
          messages.push(buttonMessage(BUTTON_CODES[button], true), buttonMessage(BUTTON_CODES[button], false))
          await seat.run(messages, exec.signal)
          const where = args.x === undefined ? ' at the pointer' : ` at (${args.x}, ${args.y})`
          return { action: 'click', summary: `Clicked the ${button} button${where}.` }
        }
        case 'scroll': {
          const dx = args.dx ?? 0
          const dy = args.dy ?? 0
          const messages = []
          if (args.x !== undefined) messages.push(pointerMessage(args.x, args.y))
          messages.push(scrollMessage(dx, dy))
          await seat.run(messages, exec.signal)
          const at = args.x === undefined ? '' : ` at (${args.x}, ${args.y})`
          return { action: 'scroll', summary: `Scrolled ${scrollPhrase(dx, dy)}${at}.` }
        }
        case 'type': {
          const messages = typeText(args.text)
          await seat.run(messages, exec.signal)
          return { action: 'type', summary: typeSummary(args.text) }
        }
        case 'key': {
          const messages = chordMessages(args.key)
          const label = canonicalChord(args.key)
          await seat.run(messages, exec.signal)
          return { action: 'key', summary: `Pressed ${label}.` }
        }
        default:
          throw new Error(`unknown action ${JSON.stringify(args.action)}`)
      }
    },
    presentCall,
  })
  ctx.tools.register(tool)
  return tool
}
