import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describeInputs, heldTrace, releaseMessage, releasePlan } from '../src/held.mjs'
import { buttonMessage, pointerMessage } from '../src/messages.mjs'
import { refusalIndex, ViewportSeat } from '../src/seat.mjs'
import { chordMessages, typeText } from '../src/keys.mjs'

const CTRL = 0xffe3
const SHIFT = 0xffe1
const LEFT = 272
const RIGHT = 273

/** One message as the fake client sees it: the `msg` subcommand in front. */
const line = (message) => ['msg', ...message].join(' ')

/** One `osk.key` message, as the seat would run it. */
const key = (keysym, pressed) => ['-t', 'osk.key', '--keysym', String(keysym), '--pressed', pressed ? 'true' : 'false']

/** A fresh scratch directory for one test. */
function scratch() {
  return mkdtempSync(join(tmpdir(), 'dsh-viewport-safety-'))
}

/** A throwaway executable standing in for the `viewport` client. */
function fakeClient(dir, body) {
  const path = join(dir, 'viewport-fake')
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

/** The lines a fake client appended, in order. */
function lines(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter((entry) => entry.length > 0)
}

/** Wait until `predicate` holds, or fail. */
async function waitFor(predicate, what, timeoutMs = 5000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** True once the pid is gone; kills a survivor so the failure does not leak a process. */
async function gone(pid) {
  if (pid === undefined) return true
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // Already gone between the check and the kill.
  }
  return false
}

/** The shell body of a client that logs every invocation, then refuses exactly the k-th. */
function refusalBody(dir, k) {
  return [
    `count='${dir}/count'`,
    `log='${dir}/log'`,
    'n=$(cat "$count" 2>/dev/null || echo 0)',
    'n=$((n + 1))',
    `printf '%s\\n' "$n" > "$count"`,
    `printf '%s\\n' "$*" >> "$log"`,
    `if [ "$n" -eq ${k} ]; then`,
    "  echo 'viewport msg: refused for the test (control socket: not this client)' >&2",
    '  exit 3',
    'fi',
    'exit 0',
  ].join('\n')
}

/**
 * One representative call per shape that can hold state, built by the real
 * builders — not by matching on the action's name.
 */
const HOLDING_CALLS = [
  ['click at a point', [pointerMessage(10, 20), buttonMessage(LEFT, true), buttonMessage(LEFT, false)]],
  ['click at the pointer', [buttonMessage(RIGHT, true), buttonMessage(RIGHT, false)]],
  ['key ctrl+shift+t', chordMessages('ctrl+shift+t')],
  ['key ctrl+? (shifted single character)', chordMessages('ctrl+?')],
  ['key ? (shifted wrap)', chordMessages('?')],
  ['type shifted and plain characters', typeText('Hi! a')],
]

test('a refusal at any message of any holding call releases exactly the prefix in reverse press order', async () => {
  for (const [name, messages] of HOLDING_CALLS) {
    const trace = heldTrace(messages)
    for (let k = 1; k <= messages.length; k += 1) {
      const dir = scratch()
      const log = join(dir, 'log')
      const count = join(dir, 'count')
      const seat = new ViewportSeat({ executable: fakeClient(dir, refusalBody(dir, k)), timeoutMs: 5000 })
      let error
      try {
        await seat.run(messages)
      } catch (caught) {
        error = caught
      }
      assert.ok(error, `${name}: a refusal at ${k} must reject`)
      assert.match(
        error.message,
        new RegExp(`message ${k} of ${messages.length} was refused \\(exit 3\\)`),
        `${name} at ${k}: the script's place line is carried`,
      )
      assert.match(error.message, /refused for the test/, `${name} at ${k}: the client's own words are carried`)
      const logged = lines(log)
      assert.deepEqual(
        logged.slice(0, k),
        messages.slice(0, k).map(line),
        `${name} at ${k}: the batch ran through the refused message`,
      )
      const held = trace[k - 1]
      const expected = [...held].reverse().map((input) => line(releaseMessage(input)))
      assert.deepEqual(
        logged.slice(k),
        expected,
        `${name} at ${k}: compensation releases the held prefix, last press first`,
      )
      assert.equal(
        Number(readFileSync(count, 'utf8').trim()),
        k + expected.length,
        `${name} at ${k}: nothing else was invoked`,
      )
      assert.match(error.message, /released/i, `${name} at ${k}: the error is never silent about releases`)
      if (held.length === 0) {
        assert.match(error.message, /Nothing was held, so nothing was released\./, `${name} at ${k}`)
      } else {
        assert.ok(
          error.message.endsWith(
            `Released ${describeInputs([...held].reverse())} (reverse press order); nothing is left held.`,
          ),
          `${name} at ${k}: ${error.message}`,
        )
      }
    }
  }
})

test('a refused release after a press is compensated; a refused press holds nothing from itself', async () => {
  const messages = [buttonMessage(LEFT, true), buttonMessage(LEFT, false)]
  // The release being refused is the dangerous one: the press it never undid
  // is exactly what compensation has to let go.
  const dir = scratch()
  const log = join(dir, 'log')
  const seat = new ViewportSeat({ executable: fakeClient(dir, refusalBody(dir, 2)), timeoutMs: 5000 })
  await assert.rejects(seat.run(messages), /viewport msg: refused for the test[\s\S]*Released left button/)
  assert.deepEqual(lines(log).slice(2), [line(buttonMessage(LEFT, false))])

  // The press itself being refused leaves nothing down: a refused message
  // was not applied.
  const otherDir = scratch()
  const otherLog = join(otherDir, 'log')
  const other = new ViewportSeat({ executable: fakeClient(otherDir, refusalBody(otherDir, 1)), timeoutMs: 5000 })
  await assert.rejects(other.run(messages), /Nothing was held, so nothing was released\./)
  assert.deepEqual(lines(otherLog), [line(buttonMessage(LEFT, true))])
})

test('a refusal in a multi-message batch is found from the script line', () => {
  assert.equal(refusalIndex('viewport: message 2 of 3 was refused (exit 3)'), 2)
  assert.equal(refusalIndex('some client words\nviewport: message 12 of 12 was refused (exit 1)\n'), 12)
  assert.equal(refusalIndex('viewport msg: refused'), undefined)
  assert.equal(refusalIndex(undefined), undefined)
})

test('a hung message is cut off, its process group dies, and the pressed keys are released', async () => {
  const dir = scratch()
  const log = join(dir, 'log')
  const pidFile = join(dir, 'pid')
  const fake = fakeClient(
    dir,
    [
      `log='${log}'`,
      `pid='${pidFile}'`,
      `printf '%s\\n' "$*" >> "$log"`,
      // Hang on the second press, so the first one has a progress marker.
      "if [ \"$*\" = 'msg -t osk.key --keysym 65505 --pressed true' ]; then",
      '  printf \'%s\\n\' "$$" > "$pid"',
      '  exec sleep 30',
      'fi',
      'exit 0',
    ].join('\n'),
  )
  const seat = new ViewportSeat({ executable: fake, timeoutMs: 100 })
  const messages = [key(CTRL, true), key(SHIFT, true), key(116, true)]
  // The batch budget is per message: a 3-message batch gets 4.5 seconds.
  const timeout = seat.timeoutFor(messages.length)
  const started = Date.now()
  let error
  try {
    await seat.run(messages)
  } catch (caught) {
    error = caught
  }
  assert.ok(error, 'the timeout must reject')
  assert.ok(Date.now() - started >= timeout - 50, 'the call is cut off at its budget')
  assert.match(error.message, new RegExp(`did not answer within ${timeout}ms`))
  assert.ok(
    error.message.endsWith('Released shift and ctrl (reverse press order); nothing is left held.'),
    error.message,
  )
  // Only the first (completed) message and the hung second one ran; the
  // in-flight press is released conservatively, the third message never ran.
  assert.deepEqual(lines(log), [
    line(key(CTRL, true)),
    line(key(SHIFT, true)),
    line(key(SHIFT, false)),
    line(key(CTRL, false)),
  ])
  await waitFor(() => existsSync(pidFile), 'the hung client to record its pid')
  const pid = Number(readFileSync(pidFile, 'utf8').trim())
  assert.equal(await gone(pid), true, 'the orphaned client must not outlive the call')
})

test('an abort mid-batch kills the group, compensates, and only then runs the next queued call', async () => {
  const dir = scratch()
  const log = join(dir, 'log')
  const pidFile = join(dir, 'pid')
  const fake = fakeClient(
    dir,
    [
      `log='${log}'`,
      `pid='${pidFile}'`,
      `printf '%s\\n' "$*" >> "$log"`,
      "if [ \"$*\" = 'msg -t osk.key --keysym 65505 --pressed true' ]; then",
      '  printf \'%s\\n\' "$$" > "$pid"',
      '  exec sleep 30',
      'fi',
      'exit 0',
    ].join('\n'),
  )
  const seat = new ViewportSeat({ executable: fake, timeoutMs: 5000 })
  const controller = new AbortController()
  const messages = [key(CTRL, true), key(SHIFT, true), key(116, true)]
  const first = seat.run(messages, controller.signal)
  const second = seat.run([pointerMessage(42, 42)], new AbortController().signal)
  await waitFor(() => lines(log).length >= 2, 'the second press to start')
  controller.abort()
  let error
  try {
    await first
  } catch (caught) {
    error = caught
  }
  assert.ok(error, 'the abort must reject')
  assert.equal(error.name, 'AbortError')
  assert.match(error.message, /^tool call aborted /)
  assert.ok(
    error.message.endsWith('Released shift and ctrl (reverse press order); nothing is left held.'),
    error.message,
  )
  await second
  assert.deepEqual(lines(log).slice(2), [
    line(key(SHIFT, false)),
    line(key(CTRL, false)),
    line(pointerMessage(42, 42)),
  ])
  await waitFor(() => existsSync(pidFile), 'the hung client to record its pid')
  const pid = Number(readFileSync(pidFile, 'utf8').trim())
  assert.equal(await gone(pid), true, 'the aborted client must not outlive the call')
})

test('a call aborted while still queued never runs and rejects before the running call finishes', async () => {
  const dir = scratch()
  const log = join(dir, 'log')
  const fake = fakeClient(
    dir,
    [`printf '%s\\n' "$*" >> '${log}'`, 'sleep 0.2', 'exit 0'].join('\n'),
  )
  const seat = new ViewportSeat({ executable: fake, timeoutMs: 5000 })
  const running = seat.run([pointerMessage(1, 1), pointerMessage(2, 2)])
  const controller = new AbortController()
  let rejectedAt
  const queued = seat.run([pointerMessage(999, 999)], controller.signal).then(
    () => ({ ok: true }),
    (error) => ({ ok: false, error, at: Date.now() }),
  )
  setTimeout(() => controller.abort(), 50)
  const outcome = await queued
  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.name, 'AbortError')
  rejectedAt = outcome.at
  const runningDoneAt = await running.then(() => Date.now())
  assert.ok(rejectedAt < runningDoneAt, 'the queued abort settles without waiting for the running call')
  assert.equal(lines(log).some((entry) => entry.includes('--x 999')), false, 'the queued call never ran')
  assert.deepEqual(lines(log), [line(pointerMessage(1, 1)), line(pointerMessage(2, 2))])
  // And the queue is still usable afterwards: an abort cannot wedge it.
  await seat.run([pointerMessage(7, 7)])
  assert.equal(lines(log).at(-1), line(pointerMessage(7, 7)))
})

test('two concurrent runs never interleave their messages', async () => {
  const dir = scratch()
  const fake = join(dir, 'viewport-fake.mjs')
  // A Node fake so the sequence number is atomic even if serialization broke:
  // mkdir is the lock, the log line is one append, and only then does it sleep.
  writeFileSync(
    fake,
    [
      '#!/usr/bin/env node',
      "import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'",
      `const dir = ${JSON.stringify(dir)}`,
      "const lock = dir + '/lock'",
      'for (;;) {',
      '  try { mkdirSync(lock); break } catch (error) { if (error.code !== "EEXIST") throw error }',
      '}',
      'let n = 0',
      "try { n = Number(readFileSync(dir + '/seq', 'utf8')) } catch {}",
      'n += 1',
      "writeFileSync(dir + '/seq', String(n))",
      "appendFileSync(dir + '/log', n + ' ' + process.argv.slice(2).join(' ') + '\\n')",
      "rmSync(lock, { recursive: true, force: true })",
      'await new Promise((resolve) => setTimeout(resolve, 25))',
    ].join('\n'),
  )
  chmodSync(fake, 0o755)
  const seat = new ViewportSeat({ executable: fake, timeoutMs: 5000 })
  const first = [pointerMessage(1, 1), pointerMessage(2, 2), pointerMessage(3, 3)]
  const second = [pointerMessage(11, 11), pointerMessage(12, 12), pointerMessage(13, 13)]
  await Promise.all([seat.run(first), seat.run(second)])
  const logged = lines(join(dir, 'log'))
  const sequence = logged.map((entry) => Number(entry.split(' ')[0]))
  assert.deepEqual(sequence, [1, 2, 3, 4, 5, 6], 'one queue, one contiguous sequence')
  const xs = logged.map((entry) => Number(extractX(entry)))
  assert.ok(
    xs.join(',') === '1,2,3,11,12,13' || xs.join(',') === '11,12,13,1,2,3',
    `the two batches stayed whole: ${xs.join(',')}`,
  )
})

/** The x coordinate a fake client logged. */
function extractX(entry) {
  return /--x (\d+)/.exec(entry)[1]
}

test('a failed batch does not deadlock the queue: the next call still runs', async () => {
  const dir = scratch()
  const log = join(dir, 'log')
  const count = join(dir, 'count')
  const fake = fakeClient(
    dir,
    [
      `count='${count}'`,
      `log='${log}'`,
      'n=$(cat "$count" 2>/dev/null || echo 0)',
      'n=$((n + 1))',
      `printf '%s\\n' "$n" > "$count"`,
      `printf '%s\\n' "$*" >> "$log"`,
      'if [ "$n" -eq 1 ]; then echo "refused for the test" >&2; exit 3; fi',
      'exit 0',
    ].join('\n'),
  )
  const seat = new ViewportSeat({ executable: fake, timeoutMs: 5000 })
  await assert.rejects(seat.run([pointerMessage(1, 1)]), /refused for the test/)
  await seat.run([pointerMessage(2, 2)])
  assert.deepEqual(lines(log), [line(pointerMessage(1, 1)), line(pointerMessage(2, 2))])
})

test('releaseAll sweeps the standard set, is idempotent, and names the ledger first', async () => {
  const dir = scratch()
  const log = join(dir, 'log')
  const seat = new ViewportSeat({ executable: fakeClient(dir, `printf '%s\\n' "$*" >> '${log}'\nexit 0`), timeoutMs: 5000 })
  const standard = releasePlan([]).map((input) => line(releaseMessage(input)))

  const first = await seat.releaseAll()
  assert.deepEqual(first.known, [])
  assert.deepEqual(first.failed, [])
  assert.deepEqual(first.released, releasePlan([]))
  assert.deepEqual(lines(log), standard)

  const second = await seat.releaseAll()
  assert.deepEqual(second.known, [])
  assert.deepEqual(second.failed, [])
  assert.deepEqual(lines(log), [...standard, ...standard], 'release is idempotent: the same no-op messages')

  await seat.run([key(CTRL, true)])
  const seeded = await seat.releaseAll()
  assert.deepEqual(seeded.known, [{ kind: 'key', id: CTRL }])
  assert.deepEqual(seeded.failed, [])
  assert.deepEqual(lines(log).slice(-releasePlan([{ kind: 'key', id: CTRL }]).length), [
    line(key(CTRL, false)),
    ...standard.filter((entry) => entry !== line(key(CTRL, false))),
  ])
})

test('a release that is refused is reported, does not stop the sweep, and is retried next time', async () => {
  const dir = scratch()
  const log = join(dir, 'log')
  const fake = fakeClient(
    dir,
    [
      `printf '%s\\n' "$*" >> '${log}'`,
      "if [ \"$*\" = 'msg -t osk.key --keysym 65507 --pressed false' ]; then",
      "  echo 'release refused for the test' >&2",
      '  exit 4',
      'fi',
      'exit 0',
    ].join('\n'),
  )
  const seat = new ViewportSeat({ executable: fake, timeoutMs: 5000 })
  await seat.run([key(CTRL, true)])
  const first = await seat.releaseAll()
  assert.deepEqual(first.known, [{ kind: 'key', id: CTRL }])
  assert.deepEqual(first.failed.map((entry) => entry.input), [{ kind: 'key', id: CTRL }])
  assert.equal(first.failed[0].reason, 'release refused for the test')
  assert.equal(first.released.length, releasePlan([{ kind: 'key', id: CTRL }]).length - 1)
  const second = await seat.releaseAll()
  assert.deepEqual(second.known, [{ kind: 'key', id: CTRL }], 'the refused release stays in the ledger')
  assert.deepEqual(second.failed.map((entry) => entry.input), [{ kind: 'key', id: CTRL }])
})

test('releaseAll is refused before it starts when the call is already aborted', async () => {
  const seat = new ViewportSeat({ executable: '/nonexistent/viewport-for-tests', timeoutMs: 5000 })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(seat.releaseAll(controller.signal), (error) => {
    assert.equal(error.name, 'AbortError')
    return true
  })
})

test('a compensation that is itself refused never replaces the original error, and the ledger keeps the input', async () => {
  const dir = scratch()
  const log = join(dir, 'log')
  const fake = fakeClient(
    dir,
    [
      `printf '%s\\n' "$*" >> '${log}'`,
      "if [ \"$*\" = 'msg -t osk.key --keysym 65507 --pressed false' ]; then",
      "  echo 'release refused for the test' >&2",
      '  exit 4',
      'fi',
      'exit 0',
    ].join('\n'),
  )
  const seat = new ViewportSeat({ executable: fake, timeoutMs: 5000 })
  let error
  try {
    // The batch's own release is refused, so ctrl is still down when
    // compensation tries to release it — and that release is refused too.
    await seat.run([key(CTRL, true), key(CTRL, false)])
  } catch (caught) {
    error = caught
  }
  assert.ok(error)
  assert.match(error.message, /release refused for the test/)
  assert.match(error.message, /viewport: message 2 of 2 was refused \(exit 4\)/)
  assert.match(
    error.message,
    /Could not release ctrl \(release refused for the test\); it may still be held — call the `release` action\.$/,
  )
  // The refused release stays in the ledger, so the manual escape hatch
  // still knows about it.
  const sweep = await seat.releaseAll()
  assert.deepEqual(sweep.known, [{ kind: 'key', id: CTRL }])
  assert.deepEqual(sweep.failed.map((entry) => entry.input), [{ kind: 'key', id: CTRL }])
  assert.equal(sweep.failed[0].reason, 'release refused for the test')
})

test('releaseAll is serialized behind a running batch, like any other input', async () => {
  const dir = scratch()
  const log = join(dir, 'log')
  const fake = fakeClient(dir, [`printf '%s\\n' "$*" >> '${log}'`, 'sleep 0.1', 'exit 0'].join('\n'))
  const seat = new ViewportSeat({ executable: fake, timeoutMs: 5000 })
  const run = seat.run([pointerMessage(1, 1), pointerMessage(2, 2)])
  const sweep = seat.releaseAll()
  await run
  await sweep
  const logged = lines(log)
  assert.deepEqual(logged.slice(0, 2), [line(pointerMessage(1, 1)), line(pointerMessage(2, 2))])
  assert.deepEqual(logged.slice(2), releasePlan([]).map((input) => line(releaseMessage(input))))
})
