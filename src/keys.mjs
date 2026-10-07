/**
 * Text and chords into keystrokes.
 *
 * The mapping is `data/shell/osk.js`'s, because it is the compositor's own
 * answer to the same problem: every key is sent in its base, unshifted form,
 * and a character that needs Shift — an uppercase letter, or a shifted symbol
 * like `!` — is sent as its base keysym wrapped in a real Shift_L press. The
 * keysym path can only press what the active layout can produce, so a real
 * modifier is the only way a shifted form can be typed at all.
 *
 * The symbol pairs are the OSK's two rows plus the backtick, which the OSK
 * does not draw but a US layout still pairs with `~`:
 *
 * ```text
 * ` 1234567890 -=[]\;',./      (base)
 * ~ !@#$%^&*() _+{}|:"<>?      (shifted)
 * ```
 *
 * Characters outside ASCII are sent as Unicode keysyms
 * (`0x01000000 + code point`), which work wherever the active layout (or a
 * sym fallback) can produce them; control characters other than `\n` and
 * `\t` are refused rather than guessed at.
 *
 * @module @codebam/dsh-tool-viewport/keys
 */
import {
  MODIFIER_KEYSYMS,
  MODIFIER_ORDER,
  NAMED_KEYSYMS,
  SHIFT_KEYSYM,
  keyTapMessages,
  oskKeyMessage,
} from './messages.mjs'

/** What each base key produces when Shift is held on a US layout. */
const SHIFTED_BY_BASE = {
  '`': '~',
  1: '!',
  2: '@',
  3: '#',
  4: '$',
  5: '%',
  6: '^',
  7: '&',
  8: '*',
  9: '(',
  0: ')',
  '-': '_',
  '=': '+',
  '[': '{',
  ']': '}',
  '\\': '|',
  ';': ':',
  "'": '"',
  ',': '<',
  '.': '>',
  '/': '?',
}

/** The base key to press, with Shift, for each shifted character. */
const BASE_BY_SHIFTED = new Map(
  Object.entries(SHIFTED_BY_BASE).map(([base, shifted]) => [shifted, base]),
)

/**
 * The keystroke one character is: which keysym to press, and whether a real
 * Shift_L has to be wrapped around it.
 * @param {string} ch - one character.
 * @returns {{ keysym: number, shift: boolean } | undefined} the stroke, or undefined for a control character.
 */
export function charStroke(ch) {
  const codePoint = ch.codePointAt(0)
  const base = BASE_BY_SHIFTED.get(ch)
  if (base !== undefined) return { keysym: base.codePointAt(0), shift: true }
  if (ch >= 'A' && ch <= 'Z') return { keysym: ch.toLowerCase().codePointAt(0), shift: true }
  if (codePoint === 0x20 || (codePoint > 0x20 && codePoint <= 0x7e)) {
    return { keysym: codePoint, shift: false }
  }
  if (codePoint >= 0xa0) return { keysym: 0x01000000 + codePoint, shift: false }
  return undefined
}

/** Render one code point the way the error messages name it. */
function codePointName(ch) {
  const hex = ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')
  return `U+${hex}`
}

/**
 * One character into its keystroke messages, Shift wrap included.
 * @param {string} ch - one character that is not `\n` or `\t`.
 * @returns {string[][]} the messages; two for a plain key, four for a shifted one.
 */
export function charMessages(ch) {
  const stroke = charStroke(ch)
  if (stroke === undefined) {
    throw new Error(
      `cannot type ${codePointName(ch)} — it is a control character, and only \\n (Return) and \\t (Tab) are keystrokes`,
    )
  }
  if (!stroke.shift) return keyTapMessages(stroke.keysym)
  return [
    oskKeyMessage(SHIFT_KEYSYM, true),
    ...keyTapMessages(stroke.keysym),
    oskKeyMessage(SHIFT_KEYSYM, false),
  ]
}

/**
 * Text into keystroke messages. Newlines are Return, tabs are Tab — the
 * characters a text file has that a keyboard also has — and `\r\n` collapses
 * into the single Return it stood for.
 * @param {string} text - the text to type.
 * @returns {string[][]} every message, in typing order.
 */
export function typeText(text) {
  const normalized = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
  const messages = []
  for (const ch of normalized) {
    if (ch === '\n') {
      messages.push(...keyTapMessages(NAMED_KEYSYMS.return))
      continue
    }
    if (ch === '\t') {
      messages.push(...keyTapMessages(NAMED_KEYSYMS.tab))
      continue
    }
    messages.push(...charMessages(ch))
  }
  return messages
}

/** Spell modifiers the way the chord message reports them back. */
const CANONICAL_MODIFIER = {
  control: 'ctrl',
  meta: 'super',
  logo: 'super',
  cmd: 'super',
  win: 'super',
}

/**
 * One token of a chord into its stroke. A single character presses that
 * character's base key — case is how the chord is written, not something to
 * hold Shift for, so `ctrl+A` and `ctrl+a` are the same chord — and anything
 * longer must be a name from `NAMED_KEYSYMS`.
 * @param {string} token - the chord's last `+`-separated part.
 * @returns {{ keysym: number, shift: boolean }} the stroke.
 */
function chordKeyStroke(token) {
  if ([...token].length === 1) {
    if (token >= 'A' && token <= 'Z') return { keysym: token.toLowerCase().codePointAt(0), shift: false }
    const stroke = charStroke(token)
    if (stroke === undefined) throw new Error(`cannot press ${codePointName(token)} — it is a control character`)
    return stroke
  }
  const keysym = NAMED_KEYSYMS[token.toLowerCase()]
  if (keysym === undefined) {
    throw new Error(
      `unknown key "${token}" — use a single character, or a name like Return, Escape, Tab, Backspace, Delete, Home, End, PageUp, PageDown, Left, Up, Right, Down, Space or F1–F12`,
    )
  }
  return { keysym, shift: false }
}

/**
 * A chord into its keystroke messages: every modifier down, the key tapped,
 * every modifier back up in reverse. The Shift a shifted single character
 * needs joins the modifiers rather than wrapping the tap, because a chord
 * cannot contain the same modifier twice.
 * @param {string} chord - `+`-joined modifiers and a final key, e.g. `ctrl+shift+t`, `Return`, `ctrl+?`.
 * @returns {string[][]} the messages, in press order.
 */
export function chordMessages(chord) {
  const parts = chord
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  if (parts.length === 0) {
    throw new Error('a chord needs a key — try `Return`, `Escape`, `a`, or `ctrl+a`')
  }
  const token = parts.pop()
  const held = new Set()
  for (const part of parts) {
    const lower = part.toLowerCase()
    const canonical = CANONICAL_MODIFIER[lower] ?? lower
    if (!MODIFIER_ORDER.includes(canonical)) {
      throw new Error(`unknown modifier "${part}" in "${chord}" — the modifiers are ctrl, alt, shift and super`)
    }
    held.add(canonical)
  }
  const stroke = chordKeyStroke(token)
  if (stroke.shift) held.add('shift')
  const mods = MODIFIER_ORDER.filter((modifier) => held.has(modifier))
  const messages = []
  for (const modifier of mods) messages.push(oskKeyMessage(MODIFIER_KEYSYMS[modifier], true))
  messages.push(...keyTapMessages(stroke.keysym))
  for (const modifier of [...mods].reverse()) {
    messages.push(oskKeyMessage(MODIFIER_KEYSYMS[modifier], false))
  }
  return messages
}

/**
 * The chord with its modifiers in canonical order, for the result summary.
 * @param {string} chord - the model's chord.
 * @returns {string} the canonical spelling, e.g. `ctrl+shift+t`.
 */
export function canonicalChord(chord) {
  const parts = chord
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  const token = parts.pop() ?? chord
  const held = new Set()
  for (const part of parts) {
    const lower = part.toLowerCase()
    const canonical = CANONICAL_MODIFIER[lower] ?? lower
    if (MODIFIER_ORDER.includes(canonical)) held.add(canonical)
  }
  if ([...token].length === 1 && ((token >= 'A' && token <= 'Z') || (charStroke(token)?.shift ?? false))) {
    held.add('shift')
  }
  const mods = MODIFIER_ORDER.filter((modifier) => held.has(modifier))
  return [...mods, token].join('+')
}
