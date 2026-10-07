/**
 * Control-message building for the `viewport` tool.
 *
 * Every action is a list of `viewport msg` invocations: `-t <type>` plus the
 * message's own fields. The type and field vocabulary is the one
 * `crates/viewport/src/msg.rs` offers and `docs/ipc.md` documents:
 *
 * - `input.pointer` — `--x`, `--y` in layout coordinates.
 * - `input.button` — `--button` as an evdev code, `--pressed` true/false.
 * - `input.scroll` — `--dx`, `--dy` in wheel notches, positive right and up.
 * - `osk.key` — `--keysym` and `--pressed`, the same path the on-screen
 *   keyboard's keys take (`data/shell/osk.js`), which the compositor feeds
 *   through the seat exactly as a physical keyboard's events go.
 *
 * Keysyms are the X11 ones (`xkbcommon` parlance): Latin-1 code points for
 * ASCII, the 0xff00 block for named keys, and `0x01000000 + code point` for
 * anything outside Latin-1.
 *
 * @module @codebam/dsh-tool-viewport/messages
 */

/** Evdev button codes for the three buttons a mouse has (`include/uapi/linux/input-event-codes.h`). */
export const BUTTON_CODES = {
  left: 272,
  right: 273,
  middle: 274,
}

/** Keysyms for the modifier keys a chord may name. */
export const MODIFIER_KEYSYMS = {
  ctrl: 0xffe3,
  control: 0xffe3,
  alt: 0xffe9,
  shift: 0xffe1,
  super: 0xffeb,
  meta: 0xffeb,
  logo: 0xffeb,
  cmd: 0xffeb,
  win: 0xffeb,
}

/** The canonical press order for a chord's modifiers; releases run in reverse. */
export const MODIFIER_ORDER = ['ctrl', 'alt', 'shift', 'super']

/** Keysyms for the named keys `key` and `type` can address beyond single characters. */
export const NAMED_KEYSYMS = {
  backspace: 0xff08,
  tab: 0xff09,
  return: 0xff0d,
  enter: 0xff0d,
  escape: 0xff1b,
  esc: 0xff1b,
  insert: 0xff63,
  delete: 0xffff,
  home: 0xff50,
  end: 0xff57,
  pageup: 0xff55,
  prior: 0xff55,
  pagedown: 0xff56,
  next: 0xff56,
  left: 0xff51,
  up: 0xff52,
  right: 0xff53,
  down: 0xff54,
  space: 0x20,
  f1: 0xffbe,
  f2: 0xffbf,
  f3: 0xffc0,
  f4: 0xffc1,
  f5: 0xffc2,
  f6: 0xffc3,
  f7: 0xffc4,
  f8: 0xffc5,
  f9: 0xffc6,
  f10: 0xffc7,
  f11: 0xffc8,
  f12: 0xffc9,
}

/** The Shift modifier's keysym, for the wrap a shifted character needs. */
export const SHIFT_KEYSYM = 0xffe1

/** `input.pointer`: move the pointer to layout coordinates. */
export function pointerMessage(x, y) {
  return ['-t', 'input.pointer', '--x', String(x), '--y', String(y)]
}

/** `input.button`: press or release an evdev button code. */
export function buttonMessage(button, pressed) {
  return ['-t', 'input.button', '--button', String(button), '--pressed', pressed ? 'true' : 'false']
}

/** `input.scroll`: turn the wheel, in notches, positive right and up. */
export function scrollMessage(dx, dy) {
  return ['-t', 'input.scroll', '--dx', String(dx), '--dy', String(dy)]
}

/** `osk.key`: press or release a keysym. */
export function oskKeyMessage(keysym, pressed) {
  return ['-t', 'osk.key', '--keysym', String(keysym), '--pressed', pressed ? 'true' : 'false']
}

/** A tap of one keysym: press, then release. */
export function keyTapMessages(keysym) {
  return [oskKeyMessage(keysym, true), oskKeyMessage(keysym, false)]
}
