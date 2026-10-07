import assert from 'node:assert/strict'
import { test } from 'node:test'
import { screenshotEnvelope, screenshotSummary, scrollPhrase, typeSummary } from '../src/render.mjs'

test('the screenshot envelope names the path, the image and its size', () => {
  const envelope = screenshotEnvelope({ path: '/tmp/dsh-viewport/shot.png', width: 1920, height: 1080, bytes: 4242 })
  assert.equal(
    envelope,
    [
      '<path>/tmp/dsh-viewport/shot.png</path>',
      '<type>image</type>',
      '<content>',
      'screenshot of the whole Viewport desktop layout: 1920x1080 px PNG, 4242 bytes',
      '</content>',
    ].join('\n'),
  )
})

test('a downscaled attachment carries the multiplier back onto the layout', () => {
  const envelope = screenshotEnvelope({
    path: '/tmp/shot.png',
    width: 1920,
    height: 1080,
    bytes: 4242,
    originalDimensions: { width: 3840, height: 2160 },
  })
  assert.match(envelope, /downscaled from 3840x2160/)
  assert.match(envelope, /multiply a coordinate read on this image by 2\.00 to get the layout coordinate to click/)
})

test('a note rides under the envelope when the image stayed on disk', () => {
  const summary = screenshotSummary({ path: '/tmp/shot.png', width: 800, height: 600, bytes: 12 }, 'no attachment store is mounted')
  assert.match(summary, /^<path>\/tmp\/shot\.png<\/path>/)
  assert.match(summary, /\nnote: no attachment store is mounted$/)
})

test('scroll phrases count notches in both directions, both axes', () => {
  assert.equal(scrollPhrase(0, 3), '3 notches up')
  assert.equal(scrollPhrase(0, -1), '1 notch down')
  assert.equal(scrollPhrase(2, 3), '3 notches up and 2 notches right')
  assert.equal(scrollPhrase(-5, 0), '5 notches left')
  assert.equal(scrollPhrase(1, 1), '1 notch up and 1 notch right')
})

test('the type summary is one line, with a short preview', () => {
  assert.equal(typeSummary('hi'), 'Typed 2 characters ("hi").')
  assert.equal(typeSummary('x'), 'Typed 1 character ("x").')
  assert.match(typeSummary('one\ntwo'), /^Typed 7 characters \("one\\ntwo"\)\.$/)
  const long = 'y'.repeat(40)
  assert.equal(typeSummary(long), `Typed 40 characters ("${'y'.repeat(31)}…").`)
})
