import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { batchScript, shellQuote, ViewportSeat } from '../src/seat.mjs'

/** A throwaway executable standing in for the `viewport` client. */
function fakeClient(dir, body) {
  const path = join(dir, 'viewport-fake')
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

/** A fresh scratch directory for one test. */
function scratch() {
  return mkdtempSync(join(tmpdir(), 'dsh-viewport-seat-'))
}

test('one message runs the client once, with the msg subcommand and the message arguments', async () => {
  const dir = scratch()
  const log = join(dir, 'log')
  const fake = fakeClient(dir, `printf '%s\\n' "$*" >> '${log}'`)
  const seat = new ViewportSeat({ executable: fake, timeoutMs: 5000 })
  await seat.run([['-t', 'input.pointer', '--x', '100', '--y', '200']])
  assert.equal(readFileSync(log, 'utf8'), 'msg -t input.pointer --x 100 --y 200\n')
})

test('a configured socket rides in front of every message', async () => {
  const dir = scratch()
  const log = join(dir, 'log')
  const fake = fakeClient(dir, `printf '%s\\n' "$*" >> '${log}'`)
  const seat = new ViewportSeat({ executable: fake, socket: '/run/user/1000/viewport-wayland-1.sock', timeoutMs: 5000 })
  await seat.run([['-t', 'input.scroll', '--dx', '0', '--dy', '3']])
  assert.equal(
    readFileSync(log, 'utf8'),
    'msg --socket /run/user/1000/viewport-wayland-1.sock -t input.scroll --dx 0 --dy 3\n',
  )
})

test('a waylandDisplay and runtimeDir override reach the client environment', async () => {
  const dir = scratch()
  const log = join(dir, 'log')
  const fake = fakeClient(dir, `printf '%s %s\\n' "$WAYLAND_DISPLAY" "$XDG_RUNTIME_DIR" >> '${log}'`)
  const seat = new ViewportSeat({
    executable: fake,
    runtimeDir: '/run/user/1000',
    waylandDisplay: 'wayland-9',
    timeoutMs: 5000,
  })
  await seat.run([['-t', 'input.pointer', '--x', '1', '--y', '2']])
  assert.equal(readFileSync(log, 'utf8'), 'wayland-9 /run/user/1000\n')
})

test('a batch runs every message in order, under one shell', async () => {
  const dir = scratch()
  const log = join(dir, 'log')
  // $PPID is the shared shell's pid: execFile starts one `sh` for the whole
  // batch, and every fake-client invocation is its child.
  const fake = fakeClient(dir, `printf '%s %s\\n' "$PPID" "$*" >> '${log}'`)
  const seat = new ViewportSeat({ executable: fake, timeoutMs: 5000 })
  await seat.run([
    ['-t', 'input.pointer', '--x', '5', '--y', '6'],
    ['-t', 'input.button', '--button', '272', '--pressed', 'true'],
    ['-t', 'input.button', '--button', '272', '--pressed', 'false'],
  ])
  const lines = readFileSync(log, 'utf8').trim().split('\n')
  assert.equal(lines.length, 3)
  const [pid] = lines[0].split(' ')
  assert.ok(lines.every((line) => line.startsWith(`${pid} `)), 'every message ran under the one shell')
  assert.deepEqual(
    lines.map((line) => line.slice(pid.length + 1)),
    [
      'msg -t input.pointer --x 5 --y 6',
      'msg -t input.button --button 272 --pressed true',
      'msg -t input.button --button 272 --pressed false',
    ],
  )
})

test('a refusal names its place in the batch and carries the client words', async () => {
  const dir = scratch()
  const count = join(dir, 'count')
  const fake = fakeClient(
    dir,
    [
      `n=$(cat '${count}' 2>/dev/null || echo 0)`,
      'n=$((n + 1))',
      `printf '%s\\n' "$n" > '${count}'`,
      "if [ \"$n\" -eq 2 ]; then echo 'viewport msg: input.scroll: refused (control socket: not this client)' >&2; exit 3; fi",
    ].join('\n'),
  )
  const seat = new ViewportSeat({ executable: fake, timeoutMs: 5000 })
  await assert.rejects(
    seat.run([['-t', 'input.pointer', '--x', '1', '--y', '2'], ['-t', 'input.scroll', '--dx', '0', '--dy', '3'], ['-t', 'quit']]),
    (error) => {
      assert.match(error.message, /refused \(control socket: not this client\)/)
      assert.match(error.message, /message 2 of 3 was refused \(exit 3\)/)
      return true
    },
  )
})

test('a missing client is named as such', async () => {
  const seat = new ViewportSeat({ executable: '/nonexistent/viewport-for-tests', timeoutMs: 5000 })
  await assert.rejects(seat.run([['-t', 'quit']]), /cannot run `\/nonexistent\/viewport-for-tests`/)
})

test('a client that never answers is cut off at the timeout', async () => {
  const dir = scratch()
  const fake = fakeClient(dir, 'sleep 5')
  const seat = new ViewportSeat({ executable: fake, timeoutMs: 300 })
  await assert.rejects(seat.run([['-t', 'input.pointer', '--x', '1', '--y', '2']]), /did not answer within 300ms/)
})

test('an aborted call never spawns, and reports the harness abort', async () => {
  const seat = new ViewportSeat({ executable: '/nonexistent/viewport-for-tests', timeoutMs: 5000 })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(seat.run([['-t', 'quit']], controller.signal), (error) => {
    assert.equal(error.name, 'AbortError')
    return true
  })
})

test('the batch timeout scales with the message count, within bounds', () => {
  const seat = new ViewportSeat({ executable: 'viewport', timeoutMs: 10000 })
  assert.equal(seat.timeoutFor(1), 10000)
  assert.equal(seat.timeoutFor(2), 10000)
  assert.equal(seat.timeoutFor(100), 53000)
  assert.equal(seat.timeoutFor(100000), 300000)
})

test('the batch script numbers its messages and keeps quoting intact', () => {
  const text = batchScript(
    ["'/usr/bin/viewport'", "'msg'", "'--socket'", "'/tmp/a b.sock'"],
    [['-t', 'a'], ['-t', 'b']],
  )
  assert.match(text, /^n=0\nrun\(\) \{\n/)
  assert.match(text, /message \$n of 2 was refused/)
  assert.match(text, /run '-t' 'a'\nrun '-t' 'b'\n$/)
  assert.ok(text.includes(`'/usr/bin/viewport' 'msg' '--socket' '/tmp/a b.sock' "$@"`))
})

test('quoting survives quotes of its own', () => {
  assert.equal(shellQuote("it's"), "'it'\\''s'")
  assert.equal(shellQuote('plain'), "'plain'")
})
