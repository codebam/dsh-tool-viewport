import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  RELEASABLE_INPUTS,
  describeInputs,
  heldAfter,
  heldTrace,
  inputKey,
  inputName,
  inputStateChange,
  pressedInputs,
  releaseMessage,
  releaseMessages,
  releasePlan,
} from '../src/held.mjs'
import { chordMessages, typeText } from '../src/keys.mjs'

/** One `osk.key` message, as the seat would run it. */
const key = (keysym, pressed) => ['-t', 'osk.key', '--keysym', String(keysym), '--pressed', pressed ? 'true' : 'false']

/** One `input.button` message. */
const button = (code, pressed) => ['-t', 'input.button', '--button', String(code), '--pressed', pressed ? 'true' : 'false']

const CTRL = 0xffe3
const SHIFT = 0xffe1
const ALT = 0xffe9
const SUPER = 0xffeb
const LEFT = 272
const RIGHT = 273
const MIDDLE = 274

/** A held input as the identity helpers spell it. */
const id = (input) => inputKey(input)

test('a press and a release are the two state-changing primitives', () => {
  assert.deepEqual(inputStateChange(key(CTRL, true)), { input: { kind: 'key', id: CTRL }, pressed: true })
  assert.deepEqual(inputStateChange(key(CTRL, false)), { input: { kind: 'key', id: CTRL }, pressed: false })
  assert.deepEqual(inputStateChange(button(LEFT, true)), { input: { kind: 'button', id: LEFT }, pressed: true })
  assert.deepEqual(inputStateChange(button(LEFT, false)), { input: { kind: 'button', id: LEFT }, pressed: false })
})

test('the protocol default for --pressed is true, as the compositor documents', () => {
  assert.deepEqual(inputStateChange(['-t', 'osk.key', '--keysym', '65505']), {
    input: { kind: 'key', id: SHIFT },
    pressed: true,
  })
  assert.equal(inputStateChange(['-t', 'osk.key', '--keysym', '65505', '--pressed', 'yes']), undefined)
})

test('argument order is not assumed, and other messages hold nothing', () => {
  assert.deepEqual(inputStateChange(['--pressed', 'false', '-t', 'osk.key', '--keysym', '65507']), {
    input: { kind: 'key', id: CTRL },
    pressed: false,
  })
  assert.equal(inputStateChange(['-t', 'input.pointer', '--x', '1', '--y', '2']), undefined)
  assert.equal(inputStateChange(['-t', 'input.scroll', '--dx', '0', '--dy', '1']), undefined)
  assert.equal(inputStateChange(['-t', 'input.key', '--keycode', '29', '--pressed', 'true']), undefined)
  assert.equal(inputStateChange(['-t', 'osk.key', '--keysym', 'not-a-number']), undefined)
  assert.equal(inputStateChange(['-t', 'osk.key', '--keysym', '-1']), undefined)
  assert.equal(inputStateChange(undefined), undefined)
})

test('a chord trace is every prefix state, in press order', () => {
  assert.deepEqual(heldTrace(chordMessages('ctrl+shift+t')), [
    [],
    [{ kind: 'key', id: CTRL }],
    [{ kind: 'key', id: CTRL }, { kind: 'key', id: SHIFT }],
    [{ kind: 'key', id: CTRL }, { kind: 'key', id: SHIFT }, { kind: 'key', id: 116 }],
    [{ kind: 'key', id: CTRL }, { kind: 'key', id: SHIFT }],
    [{ kind: 'key', id: CTRL }],
    [],
  ])
})

test('a click holds its button only between the press and its release', () => {
  assert.deepEqual(heldTrace([button(RIGHT, true), button(RIGHT, false)]), [
    [],
    [{ kind: 'button', id: RIGHT }],
    [],
  ])
  assert.deepEqual(heldTrace([button(RIGHT, true), button(RIGHT, false)])[1], [{ kind: 'button', id: RIGHT }])
})

test('a shifted character is a Shift wrap around a tap', () => {
  assert.deepEqual(heldTrace(typeText('aA')), [
    [],
    [{ kind: 'key', id: 97 }],
    [],
    [{ kind: 'key', id: SHIFT }],
    [{ kind: 'key', id: SHIFT }, { kind: 'key', id: 97 }],
    [{ kind: 'key', id: SHIFT }],
    [],
  ])
})

test('a repeated press is one input, moved to the most recent press position', () => {
  const trace = heldTrace([key(CTRL, true), key(SHIFT, true), key(CTRL, true), key(SHIFT, false)])
  assert.deepEqual(trace[trace.length - 1], [{ kind: 'key', id: CTRL }])
  assert.deepEqual(trace[3], [{ kind: 'key', id: SHIFT }, { kind: 'key', id: CTRL }])
})

test('releasing an input that is not down is a no-op', () => {
  assert.deepEqual(heldTrace([key(CTRL, false), button(LEFT, false)]), [[], [], []])
})

test('every action-shaped batch leaves nothing held when it completes', () => {
  for (const messages of [
    chordMessages('ctrl+c'),
    chordMessages('Ctrl+Shift+T'),
    chordMessages('ctrl+?'),
    chordMessages('?'),
    chordMessages('Return'),
    typeText('Hi\nyo!'),
    typeText('aA\t!?'),
    [button(LEFT, true), button(LEFT, false)],
  ]) {
    assert.deepEqual(heldAfter(messages), [])
  }
})

test('the conservative union of every press is last-press first', () => {
  assert.deepEqual(pressedInputs(chordMessages('ctrl+shift+t')), [
    { kind: 'key', id: CTRL },
    { kind: 'key', id: SHIFT },
    { kind: 'key', id: 116 },
  ])
  // `a` is pressed twice; the union has it once, in the position of its last press.
  assert.deepEqual(pressedInputs(typeText('aA')), [
    { kind: 'key', id: SHIFT },
    { kind: 'key', id: 97 },
  ])
  assert.deepEqual(pressedInputs([['-t', 'input.pointer', '--x', '1', '--y', '2']]), [])
})

test('release messages are the same primitives, in reverse press order', () => {
  assert.deepEqual(releaseMessage({ kind: 'key', id: CTRL }), key(CTRL, false))
  assert.deepEqual(releaseMessage({ kind: 'button', id: LEFT }), button(LEFT, false))
  assert.deepEqual(
    releaseMessages(heldTrace(chordMessages('ctrl+shift+t'))[3]),
    [key(116, false), key(SHIFT, false), key(CTRL, false)],
  )
})

test('the release plan unwinds the ledger, then sweeps the standard set once', () => {
  assert.deepEqual(releasePlan([]), [...RELEASABLE_INPUTS].reverse())
  assert.deepEqual(releasePlan([{ kind: 'key', id: CTRL }, { kind: 'key', id: SHIFT }]), [
    { kind: 'key', id: SHIFT },
    { kind: 'key', id: CTRL },
    { kind: 'button', id: MIDDLE },
    { kind: 'button', id: RIGHT },
    { kind: 'button', id: LEFT },
    { kind: 'key', id: SUPER },
    { kind: 'key', id: ALT },
  ])
  // The standard set never repeats an input the ledger already names.
  assert.equal(releasePlan([{ kind: 'button', id: LEFT }]).filter((input) => id(input) === `button:${LEFT}`).length, 1)
})

test('held inputs are named the way the model reads them', () => {
  assert.equal(inputName({ kind: 'key', id: CTRL }), 'ctrl')
  assert.equal(inputName({ kind: 'key', id: SHIFT }), 'shift')
  assert.equal(inputName({ kind: 'key', id: ALT }), 'alt')
  assert.equal(inputName({ kind: 'key', id: SUPER }), 'super')
  assert.equal(inputName({ kind: 'key', id: 0xff0d }), 'Return')
  assert.equal(inputName({ kind: 'key', id: 0x20 }), 'Space')
  assert.equal(inputName({ kind: 'key', id: 116 }), "'t'")
  assert.equal(inputName({ kind: 'key', id: 0x01000000 + 0x1f600 }), 'U+1F600')
  assert.equal(inputName({ kind: 'key', id: 0x1008ff13 }), 'keysym 0x1008ff13')
  assert.equal(inputName({ kind: 'button', id: LEFT }), 'left button')
  assert.equal(inputName({ kind: 'button', id: 999 }), 'button 999')
})

test('describeInputs reads as one English phrase', () => {
  assert.equal(describeInputs([]), 'nothing')
  assert.equal(describeInputs([{ kind: 'key', id: CTRL }]), 'ctrl')
  assert.equal(
    describeInputs([{ kind: 'key', id: 116 }, { kind: 'key', id: SHIFT }, { kind: 'key', id: CTRL }]),
    "'t', shift and ctrl",
  )
})

test('the standard releasable set is the four chord modifiers and three buttons', () => {
  assert.deepEqual(
    RELEASABLE_INPUTS.map(id),
    [`key:${CTRL}`, `key:${ALT}`, `key:${SHIFT}`, `key:${SUPER}`, `button:${LEFT}`, `button:${RIGHT}`, `button:${MIDDLE}`],
  )
})
