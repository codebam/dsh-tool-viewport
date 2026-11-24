/**
 * Held-input accounting for a batch of `viewport msg` messages.
 *
 * Only two primitives carry state across messages: `osk.key` presses and
 * releases a keysym, and `input.button` presses and releases an evdev button
 * code. Everything else — pointer moves, wheel notches, taps — ends where it
 * starts. So a batch's held state is a fold over its messages: a press adds
 * the input (or moves it to the end, if it was already down), a release
 * removes it, and the order of the remaining entries is the order in which
 * they went down. That order is what compensation reverses.
 *
 * This module is deliberately derived from the message vocabulary, not from
 * the actions that build it: `click`, `key` and `type` are just different
 * arrangements of these two primitives, and a batch assembled by hand folds
 * the same way.
 *
 * @module @codebam/dsh-tool-viewport/held
 */
import {
  BUTTON_CODES,
  MODIFIER_KEYSYMS,
  NAMED_KEYSYMS,
  buttonMessage,
  oskKeyMessage,
} from './messages.mjs'

/** The canonical modifier names, in the order a chord presses them. */
const MODIFIER_NAMES = new Map([
  [MODIFIER_KEYSYMS.ctrl, 'ctrl'],
  [MODIFIER_KEYSYMS.alt, 'alt'],
  [MODIFIER_KEYSYMS.shift, 'shift'],
  [MODIFIER_KEYSYMS.super, 'super'],
])

/** Named keys, with one canonical spelling per keysym (the aliases stay out). */
const NAMED_KEY_NAMES = new Map([
  [NAMED_KEYSYMS.backspace, 'Backspace'],
  [NAMED_KEYSYMS.tab, 'Tab'],
  [NAMED_KEYSYMS.return, 'Return'],
  [NAMED_KEYSYMS.escape, 'Escape'],
  [NAMED_KEYSYMS.insert, 'Insert'],
  [NAMED_KEYSYMS.delete, 'Delete'],
  [NAMED_KEYSYMS.home, 'Home'],
  [NAMED_KEYSYMS.end, 'End'],
  [NAMED_KEYSYMS.pageup, 'PageUp'],
  [NAMED_KEYSYMS.pagedown, 'PageDown'],
  [NAMED_KEYSYMS.left, 'Left'],
  [NAMED_KEYSYMS.up, 'Up'],
  [NAMED_KEYSYMS.right, 'Right'],
  [NAMED_KEYSYMS.down, 'Down'],
  [NAMED_KEYSYMS.space, 'Space'],
  ...Array.from({ length: 12 }, (_, index) => [NAMED_KEYSYMS[`f${index + 1}`], `F${index + 1}`]),
])

/**
 * Every key and button the plugin's own builders can leave held: the four
 * chord modifiers (Shift doubles as the shifted-character wrap) and the
 * three mouse buttons. A tap releases its key inside the batch; a key only
 * stays down when its release message never ran, and compensation is what
 * catches that.
 * @type {ReadonlyArray<{ kind: 'key' | 'button', id: number }>}
 */
export const RELEASABLE_INPUTS = Object.freeze([
  { kind: 'key', id: MODIFIER_KEYSYMS.ctrl },
  { kind: 'key', id: MODIFIER_KEYSYMS.alt },
  { kind: 'key', id: MODIFIER_KEYSYMS.shift },
  { kind: 'key', id: MODIFIER_KEYSYMS.super },
  { kind: 'button', id: BUTTON_CODES.left },
  { kind: 'button', id: BUTTON_CODES.right },
  { kind: 'button', id: BUTTON_CODES.middle },
])

/**
 * The stable identity of one held input, for de-duplicating folds.
 * @param {{ kind: 'key' | 'button', id: number }} input - a held input.
 * @returns {string} the key.
 */
export function inputKey(input) {
  return `${input.kind}:${input.id}`
}

/**
 * The state change one message makes, if any.
 *
 * `--pressed` is optional in the compositor's protocol and defaults to true
 * (`docs/ipc.md`), so a bare `osk.key --keysym 65505` is a press; the
 * builders always spell it out. Argument order is not assumed: the fields
 * are picked out by flag.
 *
 * @param {string[]} message - one message argument list.
 * @returns {{ input: { kind: 'key' | 'button', id: number }, pressed: boolean } | undefined} the change, or undefined for a message that holds nothing.
 */
export function inputStateChange(message) {
  if (!Array.isArray(message)) return undefined
  let type
  let field
  for (let index = 0; index < message.length - 1; index += 1) {
    if (message[index] === '-t') {
      type = message[index + 1]
      break
    }
  }
  if (type === 'osk.key') field = '--keysym'
  else if (type === 'input.button') field = '--button'
  else return undefined
  let rawId
  let rawPressed
  for (let index = 0; index < message.length - 1; index += 1) {
    if (message[index] === field) rawId = message[index + 1]
    else if (message[index] === '--pressed') rawPressed = message[index + 1]
  }
  const id = Number(rawId)
  if (!Number.isInteger(id) || id < 0) return undefined
  let pressed
  if (rawPressed === undefined || rawPressed === 'true') pressed = true
  else if (rawPressed === 'false') pressed = false
  else return undefined
  return { input: { kind: type === 'osk.key' ? 'key' : 'button', id }, pressed }
}

/**
 * The held state after every message of a batch: `trace[0]` is what was held
 * before the batch and `trace[k]` what is held once message `k` (1-based) has
 * run. A refusal of message `k` leaves `trace[k - 1]` down.
 * @param {string[][]} messages - the batch, in order.
 * @returns {Array<Array<{ kind: 'key' | 'button', id: number }>>} one snapshot per position, in press order.
 */
export function heldTrace(messages) {
  const held = new Map()
  const trace = [[]]
  for (const message of messages) {
    const change = inputStateChange(message)
    if (change !== undefined) {
      const key = inputKey(change.input)
      if (change.pressed) {
        // A repeat press is not a second copy: it is the same input, and it
        // is now the most recently pressed one.
        held.delete(key)
        held.set(key, change.input)
      } else {
        held.delete(key)
      }
    }
    trace.push([...held.values()])
  }
  return trace
}

/**
 * What a batch leaves held when it completes, in press order. For every
 * action the plugin offers this is the empty list — the interesting answer
 * for a batch that stopped part-way is {@link heldTrace}.
 * @param {string[][]} messages - the batch, in order.
 * @returns {Array<{ kind: 'key' | 'button', id: number }>} the held inputs.
 */
export function heldAfter(messages) {
  const trace = heldTrace(messages)
  return trace[trace.length - 1]
}

/**
 * Every input a batch presses anywhere, once each, in the order of its last
 * press. This is the conservative answer when the batch stopped at an
 * unknown position (a timeout or an abort with no progress marker): any of
 * these could be down, and releasing one that is not is harmless.
 * @param {string[][]} messages - the batch, in order.
 * @returns {Array<{ kind: 'key' | 'button', id: number }>} the presses.
 */
export function pressedInputs(messages) {
  const pressed = new Map()
  for (const message of messages) {
    const change = inputStateChange(message)
    if (change === undefined || !change.pressed) continue
    const key = inputKey(change.input)
    pressed.delete(key)
    pressed.set(key, change.input)
  }
  return [...pressed.values()]
}

/**
 * The message that lets one input go.
 * @param {{ kind: 'key' | 'button', id: number }} input - the input to release.
 * @returns {string[]} the `osk.key` or `input.button` message.
 */
export function releaseMessage(input) {
  return input.kind === 'button' ? buttonMessage(input.id, false) : oskKeyMessage(input.id, false)
}

/**
 * Release messages for a held set, innermost first: the last press is let go
 * before the one it was wrapped in, exactly the order a chord unwinds.
 * @param {Array<{ kind: 'key' | 'button', id: number }>} held - held inputs in press order.
 * @returns {string[][]} the release messages, in release order.
 */
export function releaseMessages(held) {
  return [...held].reverse().map(releaseMessage)
}

/**
 * What the `release` action sends: everything known to be (or possibly) held,
 * last press first, then the standard modifier and button set for anything
 * the ledger does not know about. Releasing an input that is already up is
 * harmless, which is what makes the sweep safe.
 * @param {Array<{ kind: 'key' | 'button', id: number }>} [knownHeld] - the ledger, in press order.
 * @returns {Array<{ kind: 'key' | 'button', id: number }>} the inputs to release, in release order.
 */
export function releasePlan(knownHeld = []) {
  const seen = new Set()
  const plan = []
  const push = (input) => {
    const key = inputKey(input)
    if (seen.has(key)) return
    seen.add(key)
    plan.push(input)
  }
  for (const input of [...knownHeld].reverse()) push(input)
  for (const input of [...RELEASABLE_INPUTS].reverse()) push(input)
  return plan
}

/**
 * A held input as the error and result text name it: `ctrl`, `Left button`,
 * `'t'`, `Space`, `U+1F600`.
 * @param {{ kind: 'key' | 'button', id: number }} input - the input.
 * @returns {string} its name.
 */
export function inputName(input) {
  if (input.kind === 'button') {
    const entry = Object.entries(BUTTON_CODES).find(([, code]) => code === input.id)
    return entry === undefined ? `button ${input.id}` : `${entry[0]} button`
  }
  const named = MODIFIER_NAMES.get(input.id) ?? NAMED_KEY_NAMES.get(input.id)
  if (named !== undefined) return named
  if (input.id >= 0x01000000 && input.id <= 0x0110ffff) {
    const codePoint = input.id - 0x01000000
    return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`
  }
  if (input.id > 0x20 && input.id <= 0x7e) return `'${String.fromCodePoint(input.id)}'`
  return `keysym 0x${input.id.toString(16)}`
}

/**
 * A held set as one English phrase: `'t', shift and ctrl`.
 * @param {Array<{ kind: 'key' | 'button', id: number }>} inputs - the inputs, in the order to name them.
 * @returns {string} the phrase (`nothing` for none).
 */
export function describeInputs(inputs) {
  const names = inputs.map(inputName)
  if (names.length === 0) return 'nothing'
  if (names.length === 1) return names[0]
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}
