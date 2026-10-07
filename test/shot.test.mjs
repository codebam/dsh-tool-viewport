import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureScreenshot, defaultScreenshotDir, pngSize } from '../src/shot.mjs'

/** A real 1x1 PNG, so the dimension parse is exercised on real IHDR bytes. */
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/** A throwaway executable standing in for grim. */
function fakeGrim(dir, body) {
  const path = join(dir, 'grim-fake')
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

function scratch() {
  return mkdtempSync(join(tmpdir(), 'dsh-viewport-shot-'))
}

test('pngSize reads the IHDR dimensions', () => {
  assert.deepEqual(pngSize(ONE_PIXEL_PNG), { width: 1, height: 1 })
})

test('pngSize refuses bytes that are not a PNG', () => {
  assert.throws(
    () => pngSize(Buffer.from('not a png at all, but comfortably past the length check')),
    /not a PNG/,
  )
})

test('a capture writes the PNG grim produced and sizes it from the bytes', async () => {
  const dir = scratch()
  writeFileSync(join(dir, 'source.png'), ONE_PIXEL_PNG)
  const grim = fakeGrim(dir, `cp '${join(dir, 'source.png')}' "$1"`)
  const capture = await captureScreenshot({ grim, dir: join(dir, 'shots'), timeoutMs: 5000 })
  assert.match(capture.path, /viewport-\d{8}-\d{6}\d{3}-[a-z0-9]{4}\.png$/)
  assert.equal(capture.width, 1)
  assert.equal(capture.height, 1)
  assert.deepEqual(readFileSync(capture.path), ONE_PIXEL_PNG)
})

test('the grim environment takes the runtime and display overrides', async () => {
  const dir = scratch()
  writeFileSync(join(dir, 'source.png'), ONE_PIXEL_PNG)
  const log = join(dir, 'env')
  const grim = fakeGrim(
    dir,
    `printf '%s %s\\n' "$WAYLAND_DISPLAY" "$XDG_RUNTIME_DIR" > '${log}'\ncp '${join(dir, 'source.png')}' "$1"`,
  )
  await captureScreenshot({
    grim,
    runtimeDir: '/run/user/1000',
    waylandDisplay: 'wayland-7',
    dir: join(dir, 'shots'),
    timeoutMs: 5000,
  })
  assert.equal(readFileSync(log, 'utf8'), 'wayland-7 /run/user/1000\n')
})

test('a grim that cannot run is reported with its name', async () => {
  await assert.rejects(
    captureScreenshot({ grim: '/nonexistent/grim-for-tests', dir: scratch(), timeoutMs: 5000 }),
    /cannot run `\/nonexistent\/grim-for-tests`/,
  )
})

test('a grim failure carries its stderr', async () => {
  const dir = scratch()
  const grim = fakeGrim(dir, `echo 'the compositor does not speak this capture protocol' >&2\nexit 1`)
  await assert.rejects(
    captureScreenshot({ grim, dir: join(dir, 'shots'), timeoutMs: 5000 }),
    /the compositor does not speak this capture protocol/,
  )
})

test('the default screenshot directory lives under the temp dir', () => {
  assert.ok(defaultScreenshotDir().startsWith(tmpdir()))
})
