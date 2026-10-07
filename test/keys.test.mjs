import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canonicalChord, charMessages, chordMessages, typeText } from '../src/keys.mjs'

/** One `osk.key` message, as the seat would run it. */
const key = (keysym, pressed) => ['-t', 'osk.key', '--keysym', String(keysym), '--pressed', pressed ? 'true' : 'false']

/** A tap: press, then release. */
const tap = (keysym) => [key(keysym, true), key(keysym, false)]

const SHIFT = 0xffe1
const CTRL = 0xffe3
const ALT = 0xffe9
const SUPER = 0xffeb

test('a plain character is its code point, pressed and released', () => {
  assert.deepEqual(typeText('a'), tap(0x61))
  assert.deepEqual(typeText('7'), tap(0x37))
  assert.deepEqual(typeText('/'), tap(0x2f))
})

test('an uppercase letter is the base letter wrapped in a real Shift', () => {
  assert.deepEqual(typeText('A'), [key(SHIFT, true), ...tap(0x61), key(SHIFT, false)])
})

test('shifted symbols send the base key with Shift, the OSK way', () => {
  // The symbol rows: `!` is `1` with Shift, `?` is `/` with Shift, `~` is the backtick with Shift.
  assert.deepEqual(typeText('!'), [key(SHIFT, true), ...tap(0x31), key(SHIFT, false)])
  assert.deepEqual(typeText('?'), [key(SHIFT, true), ...tap(0x2f), key(SHIFT, false)])
  assert.deepEqual(typeText('~'), [key(SHIFT, true), ...tap(0x60), key(SHIFT, false)])
})

test('newlines are Return, tabs are Tab, and CRLF is one Return', () => {
  assert.deepEqual(typeText('\n'), tap(0xff0d))
  assert.deepEqual(typeText('\t'), tap(0xff09))
  assert.deepEqual(typeText('\r\n'), tap(0xff0d))
  assert.deepEqual(typeText('a\rb'), tap(0x61).concat(tap(0xff0d)).concat(tap(0x62)))
})

test('text outside ASCII goes as Unicode keysyms', () => {
  assert.deepEqual(typeText('é'), tap(0x01000000 + 0xe9))
  assert.deepEqual(typeText('😀'), tap(0x01000000 + 0x1f600))
})

test('control characters other than newline and tab are refused, named', () => {
  assert.throws(() => typeText('a\u0007b'), /U\+0007/)
  assert.throws(() => charMessages('\u007f'), /U\+007F/)
})

test('a chord holds its modifiers around one tap', () => {
  assert.deepEqual(chordMessages('ctrl+c'), [key(CTRL, true), ...tap(0x63), key(CTRL, false)])
})

test('modifiers go down in canonical order and come up in reverse', () => {
  assert.deepEqual(chordMessages('Ctrl+Shift+T'), [
    key(CTRL, true),
    key(SHIFT, true),
    ...tap(0x74),
    key(SHIFT, false),
    key(CTRL, false),
  ])
  assert.deepEqual(chordMessages('meta+alt+F4'), [
    key(ALT, true),
    key(SUPER, true),
    ...tap(0xffc1),
    key(SUPER, false),
    key(ALT, false),
  ])
})

test('a named key alone is just its tap', () => {
  assert.deepEqual(chordMessages('Return'), tap(0xff0d))
  assert.deepEqual(chordMessages('Escape'), tap(0xff1b))
  assert.deepEqual(chordMessages('F5'), tap(0xffc2))
  assert.deepEqual(chordMessages('Up'), tap(0xff52))
})

test('chord letter case is spelling, not Shift', () => {
  assert.deepEqual(chordMessages('ctrl+A'), [key(CTRL, true), ...tap(0x61), key(CTRL, false)])
})

test('a shifted single character in a chord folds Shift into the modifiers', () => {
  assert.deepEqual(chordMessages('ctrl+?'), [
    key(CTRL, true),
    key(SHIFT, true),
    ...tap(0x2f),
    key(SHIFT, false),
    key(CTRL, false),
  ])
})

test('bad chords are refused before anything is sent', () => {
  assert.throws(() => chordMessages(''), /needs a key/)
  assert.throws(() => chordMessages('hyper+x'), /unknown modifier "hyper"/)
  assert.throws(() => chordMessages('ctrl+nope'), /unknown key "nope"/)
  assert.throws(() => chordMessages('ctrl+'), /unknown key "ctrl"/)
})

test('the canonical spelling orders modifiers and marks the Shift a symbol needs', () => {
  assert.equal(canonicalChord('Ctrl+Shift+T'), 'ctrl+shift+T')
  assert.equal(canonicalChord('shift+ctrl+q'), 'ctrl+shift+q')
  assert.equal(canonicalChord('ctrl+?'), 'ctrl+shift+?')
  assert.equal(canonicalChord('meta+c'), 'super+c')
  assert.equal(canonicalChord('Return'), 'Return')
})
