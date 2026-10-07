/**
 * The model-facing text of a `viewport` result.
 *
 * Screenshots keep `read_image`'s envelope (`<path>`, `<type>`, `<content>`)
 * so the session reads a capture the same way it reads any image, and the
 * downscale advice is the same arithmetic as `read_image`'s: coordinates
 * measured on the attached (possibly shrunk) image, multiplied back onto the
 * layout, are what `click` takes.
 *
 * @module @codebam/dsh-tool-viewport/render
 */

/** `3840x2160` */
export function dimensions(width, height) {
  return `${width}x${height}`
}

/** A coordinate as the summaries spell it. */
export function coordinate(value) {
  return String(value)
}

/**
 * One line naming a screenshot: what was captured, its size, and the
 * multiplier from image coordinates to layout coordinates when the attached
 * copy was downscaled.
 * @param {object} shot - the capture facts.
 * @param {string} shot.path - the PNG's path.
 * @param {number} shot.width - attached image width in px.
 * @param {number} shot.height - attached image height in px.
 * @param {number} shot.bytes - attached image bytes.
 * @param {{ width: number, height: number }} [shot.originalDimensions] - the capture's own size, when the attached copy was downscaled.
 * @returns {string} the `<path>`/`<type>`/`<content>` envelope.
 */
export function screenshotEnvelope({ path, width, height, bytes, originalDimensions }) {
  let scaled = ''
  if (originalDimensions !== undefined) {
    const x = (originalDimensions.width / width).toFixed(2)
    const y = (originalDimensions.height / height).toFixed(2)
    const advice = x === y
      ? `multiply a coordinate read on this image by ${x}`
      : `multiply an x coordinate by ${x} and a y coordinate by ${y}`
    scaled = ` (downscaled from ${dimensions(originalDimensions.width, originalDimensions.height)}; ${advice} to get the layout coordinate to click)`
  }
  return [
    `<path>${path}</path>`,
    '<type>image</type>',
    '<content>',
    `screenshot of the whole Viewport desktop layout: ${dimensions(width, height)} px PNG, ${bytes} bytes${scaled}`,
    '</content>',
  ].join('\n')
}

/** The screenshot summary with an extra line when the image block could not be attached. */
export function screenshotSummary(shot, note) {
  const envelope = screenshotEnvelope(shot)
  if (note === undefined) return envelope
  return `${envelope}\nnote: ${note}`
}

/**
 * `3 notches up and 1 notch right` — the phrase `scroll` results use.
 * @param {number} dx - horizontal notches, positive right.
 * @param {number} dy - vertical notches, positive up.
 * @returns {string} the phrase.
 */
export function scrollPhrase(dx, dy) {
  const parts = []
  if (dy !== 0) parts.push(`${Math.abs(dy)} ${Math.abs(dy) === 1 ? 'notch' : 'notches'} ${dy > 0 ? 'up' : 'down'}`)
  if (dx !== 0) parts.push(`${Math.abs(dx)} ${Math.abs(dx) === 1 ? 'notch' : 'notches'} ${dx > 0 ? 'right' : 'left'}`)
  return parts.join(' and ')
}

/**
 * `Typed 12 characters ("hello\\nworld").` — a single line, with a short
 * preview when the text is short enough to be worth showing.
 * @param {string} text - the text that was typed.
 * @returns {string} the summary.
 */
export function typeSummary(text) {
  const count = [...text].length
  const preview = [...text].length > 32 ? `${[...text].slice(0, 31).join('')}…` : text
  return `Typed ${count} ${count === 1 ? 'character' : 'characters'} (${JSON.stringify(preview)}).`
}

/** `Clicked the left button at (100, 200).` or `Moved the pointer to (100, 200).` */
export function pointerSummary(verb, x, y, suffix = '') {
  return `${verb} (${coordinate(x)}, ${coordinate(y)})${suffix}.`
}
