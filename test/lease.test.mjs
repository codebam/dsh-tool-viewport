import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyHolder,
  DEFAULT_LEASE_WAIT_MS,
  parseProcessStat,
  readProcessIdentity,
  resolveLeaseTarget,
} from '../src/lease.mjs'
import { buttonMessage, pointerMessage } from '../src/messages.mjs'
import { ViewportSeat } from '../src/seat.mjs'

const LEFT = 272
const SEAT_MODULE = new URL('../src/seat.mjs', import.meta.url).href

/** One invocation as a fake client sees it, with the seat's socket in front. */
function invocation(socket, message) {
  return ['msg', '--socket', socket, ...message].join(' ')
}

/** A fresh scratch directory for one test. */
function scratch() {
  return mkdtempSync(join(tmpdir(), 'dsh-viewport-lease-'))
}

/** The lines a file recorded, in order. */
function lines(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter((entry) => entry.length > 0)
}

/** A throwaway executable standing in for the `viewport` client. */
function fakeClient(dir, name, body) {
  const path = join(dir, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

/** A Node fake client, for a body that needs millisecond timestamps and top-level await. */
function nodeFake(dir, name, body) {
  const path = join(dir, name)
  writeFileSync(path, ['#!/usr/bin/env node', ...body].join('\n'))
  chmodSync(path, 0o755)
  return path
}

/** A fake client that records one start/end interval and then succeeds, in its own log. */
function intervalFake(dir, name, log, ms) {
  return nodeFake(dir, name, [
    "import { appendFileSync } from 'node:fs'",
    `appendFileSync(${JSON.stringify(log)}, 'start ' + Date.now() + '\\n')`,
    `await new Promise((resolve) => setTimeout(resolve, ${ms}))`,
    `appendFileSync(${JSON.stringify(log)}, 'end ' + Date.now() + '\\n')`,
  ])
}

/** The one [start, end] interval a fake client logged. */
function intervalOf(log) {
  const entries = lines(log).map((entry) => entry.split(' '))
  assert.equal(entries.length, 2, `${log} did not record one start/end pair: ${lines(log).join(' | ')}`)
  assert.equal(entries[0][0], 'start')
  assert.equal(entries[1][0], 'end')
  return [Number(entries[0][1]), Number(entries[1][1])]
}

/** Wait until `predicate` holds, or fail. */
async function waitFor(predicate, what, timeoutMs = 5000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** A short sleep. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Write a child that constructs one real ViewportSeat against the given
 * target and runs one message list. The process exits 0 on success and 1 with
 * the seat's own error on stderr otherwise.
 */
function childRunner(dir, name, { seat, messages }) {
  const path = join(dir, name)
  writeFileSync(path, [
    '#!/usr/bin/env node',
    `import { ViewportSeat } from ${JSON.stringify(SEAT_MODULE)}`,
    `const config = ${JSON.stringify({ seat, messages })}`,
    'const seat = new ViewportSeat(config.seat)',
    'try {',
    '  await seat.run(config.messages)',
    '  process.exit(0)',
    '} catch (error) {',
    '  console.error(`child: ${error?.message ?? error}`)',
    '  process.exit(1)',
    '}',
  ].join('\n'))
  chmodSync(path, 0o755)
  return path
}

/** Spawn a child in its own process group, collecting its output. */
function spawnChild(script) {
  const child = spawn(process.execPath, [script], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const done = new Promise((resolve) => {
    child.on('error', (error) => resolve({ code: null, signal: null, stdout, stderr: `${stderr}${error.message}` }))
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
  const kill = () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {
        // Already gone.
      }
    }
  }
  return { child, done, kill, output: () => ({ stdout, stderr }) }
}

/** Kill a set of children on the way out of a test. */
function cleanup(children) {
  for (const entry of children) entry.kill()
}

test('procfs identity parsing handles comm with spaces and parentheses, and the start time is part of identity', async () => {
  const fields = Array.from({ length: 17 }, (_, index) => index + 4).join(' ')
  const text = `42 (odd name) here) S 7 ${fields} 999 23 24`
  assert.deepEqual(parseProcessStat(text), { state: 'S', parent: 7, start: 999 })
  assert.equal(parseProcessStat('not a stat line'), undefined)
  assert.equal(parseProcessStat(undefined), undefined)

  const mine = await readProcessIdentity(process.pid)
  assert.equal(mine.status, 'alive')
  assert.equal(await classifyHolder({ pid: process.pid, start: mine.start }), 'alive')
  // The same pid with a different start time is a later incarnation: the
  // recorded holder is provably gone.
  assert.equal(await classifyHolder({ pid: process.pid, start: mine.start + 1 }), 'dead')
  // A pid that cannot exist is dead.
  assert.equal(await classifyHolder({ pid: 2_147_483_646, start: 1 }), 'dead')
  // A record from another boot or PID namespace names a pid that is not
  // comparable here; it can never be proven dead.
  const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
  assert.equal(await classifyHolder({ pid: process.pid, start: mine.start, boot: `${boot}-other` }), 'unknown')
  assert.equal(
    await classifyHolder({ pid: process.pid, start: mine.start, pidNamespace: 'pid:[not-this-one]' }),
    'unknown',
  )
})

test('a pid that has exited is reported dead once it is reaped', async () => {
  const child = spawn(process.execPath, ['-e', ''])
  const exited = await new Promise((resolve) => child.on('exit', resolve))
  assert.equal(typeof exited, 'number')
  assert.equal((await readProcessIdentity(child.pid)).status, 'dead')
})

test('the lease is held before the first message and given back after the batch', async () => {
  const dir = scratch()
  const socket = join(dir, 'viewport-test.sock')
  const leaseDir = join(dir, 'leases')
  const target = await resolveLeaseTarget({ socket, leaseDir })
  const observed = join(dir, 'observed')
  const log = join(dir, 'log')
  const fake = fakeClient(
    dir,
    'viewport-fake',
    [`cat '${target.path}' >> '${observed}'`, `printf '%s\\n' "$*" >> '${log}'`, 'exit 0'].join('\n'),
  )
  const seat = new ViewportSeat({ executable: fake, socket, leaseDir, timeoutMs: 5000 })
  await seat.run([pointerMessage(1, 2), pointerMessage(3, 4)])

  const records = lines(observed).map((entry) => JSON.parse(entry))
  assert.equal(records.length, 2, 'every invocation saw the lease in place')
  const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
  for (const record of records) {
    assert.equal(record.pid, process.pid)
    assert.equal(record.scope, target.key)
    assert.equal(record.boot, boot, 'the record names the boot it belongs to')
    assert.match(record.pidNamespace, /^pid:\[/, 'the record names the PID namespace')
  }
  assert.equal(records[0].token, records[1].token, 'both messages ran under one lease')
  assert.deepEqual(lines(log), [
    invocation(socket, ['-t', 'input.pointer', '--x', '1', '--y', '2']),
    invocation(socket, ['-t', 'input.pointer', '--x', '3', '--y', '4']),
  ])
  assert.equal(existsSync(target.path), false, 'the lease is released when the batch settles')
})

test('the lease is held through compensation and released after a refused batch', async () => {
  const dir = scratch()
  const socket = join(dir, 'viewport-test.sock')
  const leaseDir = join(dir, 'leases')
  const target = await resolveLeaseTarget({ socket, leaseDir })
  const observed = join(dir, 'observed')
  const log = join(dir, 'log')
  const fake = fakeClient(
    dir,
    'viewport-fake',
    [
      `cat '${target.path}' >> '${observed}'`,
      `printf '%s\\n' "$*" >> '${log}'`,
      `case "$*" in *'--pressed false'*)`,
      `  if [ ! -f '${dir}/refused' ]; then`,
      `    touch '${dir}/refused'`,
      "    echo 'viewport msg: refused for the test' >&2",
      '    exit 3',
      '  fi',
      '  ;;',
      'esac',
      'exit 0',
    ].join('\n'),
  )
  const seat = new ViewportSeat({ executable: fake, socket, leaseDir, timeoutMs: 5000 })
  let error
  try {
    await seat.run([buttonMessage(LEFT, true), buttonMessage(LEFT, false)])
  } catch (caught) {
    error = caught
  }
  assert.ok(error, 'the refusal must reject')
  assert.match(error.message, /Released left button \(reverse press order\); nothing is left held\.$/)
  // press, refused release, compensated release: all three under one lease.
  const records = lines(observed).map((entry) => JSON.parse(entry))
  assert.equal(records.length, 3)
  assert.ok(records.every((record) => record.pid === process.pid && record.token === records[0].token))
  assert.equal(existsSync(target.path), false, 'the lease is released after compensation')
  // The seat is still usable, and takes a fresh lease for the next batch.
  await seat.run([pointerMessage(9, 9)])
  assert.equal(existsSync(target.path), false)
})

test('a call aborted while queued never takes the lease and never spawns', async () => {
  const dir = scratch()
  const socket = join(dir, 'viewport-test.sock')
  const leaseDir = join(dir, 'leases')
  const target = await resolveLeaseTarget({ socket, leaseDir })
  const log = join(dir, 'log')
  const fake = fakeClient(dir, 'viewport-fake', [`printf '%s\\n' "$*" >> '${log}'`, 'sleep 0.4', 'exit 0'].join('\n'))
  const seat = new ViewportSeat({ executable: fake, socket, leaseDir, timeoutMs: 5000, leaseWaitMs: 10_000 })

  const running = seat.run([pointerMessage(1, 1)])
  await waitFor(() => existsSync(target.path), 'the running call to take the lease')
  const held = readFileSync(target.path, 'utf8')

  const controller = new AbortController()
  const queued = seat.run([pointerMessage(999, 999)], controller.signal).then(
    () => ({ ok: true }),
    (error) => ({ ok: false, error, at: Date.now() }),
  )
  setTimeout(() => controller.abort(), 30)
  const outcome = await queued
  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.name, 'AbortError')
  assert.equal(readFileSync(target.path, 'utf8'), held, 'the queued call did not replace the running lease')
  await running
  assert.deepEqual(lines(log), [invocation(socket, ['-t', 'input.pointer', '--x', '1', '--y', '1'])], 'the queued call never ran')
  assert.equal(existsSync(target.path), false)
})

test('a call waiting for another process\'s lease can be aborted, and then spawns nothing', async () => {
  const dir = scratch()
  const socket = join(dir, 'viewport-test.sock')
  const leaseDir = join(dir, 'leases')
  const ready = join(dir, 'holder-ready')
  const holderLog = join(dir, 'holder-log')
  const holderFake = nodeFake(dir, 'holder-fake.mjs', [
    "import { appendFileSync, writeFileSync } from 'node:fs'",
    `appendFileSync(${JSON.stringify(holderLog)}, 'held\\n')`,
    `writeFileSync(${JSON.stringify(ready)}, '')`,
    'await new Promise((resolve) => setTimeout(resolve, 1500))',
  ])
  const holderScript = childRunner(dir, 'holder.mjs', {
    seat: { executable: holderFake, socket, leaseDir, timeoutMs: 10_000 },
    messages: [pointerMessage(5, 5)],
  })
  const holder = spawnChild(holderScript)
  const children = [holder]
  try {
    await waitFor(() => existsSync(ready), 'the holding process to start its batch')
    const parentLog = join(dir, 'parent-log')
    const parentFake = fakeClient(dir, 'parent-fake', [`printf '%s\\n' "$*" >> '${parentLog}'`, 'exit 0'].join('\n'))
    const seat = new ViewportSeat({ executable: parentFake, socket, leaseDir, timeoutMs: 5000, leaseWaitMs: 10_000 })
    const controller = new AbortController()
    const run = seat.run([pointerMessage(7, 7)], controller.signal)
    await sleep(150)
    const abortedAt = Date.now()
    controller.abort()
    await assert.rejects(run, (error) => {
      assert.equal(error.name, 'AbortError')
      return true
    })
    assert.ok(Date.now() - abortedAt < 1000, 'the abort cuts the lease wait short')
    assert.deepEqual(lines(parentLog), [], 'an aborted waiter spawns nothing')
    const holderResult = await holder.done
    assert.equal(holderResult.code, 0, holderResult.stderr)
  } finally {
    cleanup(children)
  }
})

test('two processes contending for the same socket take turns: the second waits for the first', async () => {
  const dir = scratch()
  const socket = join(dir, 'viewport-test.sock')
  const leaseDir = join(dir, 'leases')
  const logA = join(dir, 'log-a')
  const logB = join(dir, 'log-b')
  const fakeA = intervalFake(dir, 'fake-a.mjs', logA, 800)
  const fakeB = intervalFake(dir, 'fake-b.mjs', logB, 800)
  const scriptA = childRunner(dir, 'a.mjs', {
    seat: { executable: fakeA, socket, leaseDir, timeoutMs: 10_000, leaseWaitMs: 10_000 },
    messages: [pointerMessage(1, 1)],
  })
  const scriptB = childRunner(dir, 'b.mjs', {
    seat: { executable: fakeB, socket, leaseDir, timeoutMs: 10_000, leaseWaitMs: 10_000 },
    messages: [pointerMessage(2, 2)],
  })
  const a = spawnChild(scriptA)
  const b = spawnChild(scriptB)
  const children = [a, b]
  try {
    const [first, second] = await Promise.all([a.done, b.done])
    assert.equal(first.code, 0, first.stderr)
    assert.equal(second.code, 0, second.stderr)
    const [aStart, aEnd] = intervalOf(logA)
    const [bStart, bEnd] = intervalOf(logB)
    const [earlier, later] = aStart <= bStart ? [[aStart, aEnd], [bStart, bEnd]] : [[bStart, bEnd], [aStart, aEnd]]
    assert.ok(
      later[0] >= earlier[1],
      `the two batches must not overlap: [${earlier}] then [${later}]`,
    )
    assert.ok(later[1] - earlier[0] >= 1500, 'the second batch waited for the first, so the total spans both sleeps')
    assert.ok(later[0] - earlier[1] < 500, `the second batch started promptly once the lease was free (gap ${later[0] - earlier[1]}ms)`)
  } finally {
    cleanup(children)
  }
})

test('a holder SIGKILLed mid-batch is reclaimed within the bounded wait', async () => {
  const dir = scratch()
  const socket = join(dir, 'viewport-test.sock')
  const leaseDir = join(dir, 'leases')
  const target = await resolveLeaseTarget({ socket, leaseDir })
  const ready = join(dir, 'holder-ready')
  const batchPidFile = join(dir, 'batch-pid')
  const holderFake = nodeFake(dir, 'holder-fake.mjs', [
    "import { writeFileSync } from 'node:fs'",
    `writeFileSync(${JSON.stringify(batchPidFile)}, String(process.pid))`,
    `writeFileSync(${JSON.stringify(ready)}, '')`,
    'await new Promise((resolve) => setTimeout(resolve, 30_000))',
  ])
  const batchPid = () => {
    try {
      return Number(readFileSync(batchPidFile, 'utf8').trim())
    } catch {
      return undefined
    }
  }
  const holderScript = childRunner(dir, 'holder.mjs', {
    seat: { executable: holderFake, socket, leaseDir, timeoutMs: 60_000, leaseWaitMs: 10_000 },
    messages: [pointerMessage(5, 5)],
  })
  const holder = spawnChild(holderScript)
  const children = [holder]
  try {
    await waitFor(() => existsSync(ready), 'the holder process to start its batch')
    const record = JSON.parse(readFileSync(target.path, 'utf8'))
    assert.equal(record.pid, holder.child.pid, 'the holder is the process that was killed')

    // The waiter is already polling the live holder's record when the kill
    // lands, which is the reclaim-inside-the-acquire-loop path, not a fresh
    // acquire that happens to find a dead file.
    const log = join(dir, 'parent-log')
    const fake = fakeClient(dir, 'parent-fake', [`printf '%s\\n' "$*" >> '${log}'`, 'exit 0'].join('\n'))
    const seat = new ViewportSeat({ executable: fake, socket, leaseDir, timeoutMs: 5000, leaseWaitMs: 5000 })
    const run = seat.run([pointerMessage(6, 6)])
    await sleep(150)
    const killedAt = Date.now()
    holder.kill()
    const exit = await holder.done
    assert.ok(exit.code !== 0 || exit.signal !== null, 'the holder did not exit cleanly')

    await run
    const elapsed = Date.now() - killedAt
    assert.ok(elapsed < 5000, `the reclaim fits the bound, took ${elapsed}ms`)
    assert.deepEqual(lines(log), [invocation(socket, ['-t', 'input.pointer', '--x', '6', '--y', '6'])])
    assert.equal(existsSync(target.path), false, 'the new holder released the reclaimed lease')
  } finally {
    cleanup(children)
    // The seat's batch runs detached from the holder, so the holder's
    // process-group kill leaves the sleeping fake client behind.
    const orphan = batchPid()
    if (orphan !== undefined) {
      try {
        process.kill(orphan, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
  }
})

test('a stale record with a dead identity is reclaimed at once', async () => {
  const dir = scratch()
  const socket = join(dir, 'viewport-test.sock')
  const leaseDir = join(dir, 'leases')
  const target = await resolveLeaseTarget({ socket, leaseDir })
  writeFileSync(
    target.path,
    `${JSON.stringify({ version: 1, pid: 2_147_483_646, start: 1, token: 'stale-holder', scope: target.key })}\n`,
  )
  const log = join(dir, 'log')
  const fake = fakeClient(dir, 'viewport-fake', [`printf '%s\\n' "$*" >> '${log}'`, 'exit 0'].join('\n'))
  const seat = new ViewportSeat({ executable: fake, socket, leaseDir, timeoutMs: 5000, leaseWaitMs: 1000 })
  const started = Date.now()
  await seat.run([pointerMessage(3, 3)])
  assert.ok(Date.now() - started < 1000, 'a provably dead holder causes no meaningful wait')
  assert.deepEqual(lines(log), [invocation(socket, ['-t', 'input.pointer', '--x', '3', '--y', '3'])])
  assert.equal(existsSync(target.path), false)
})

test('a released tombstone is reclaimed at once, even from a live pid', async () => {
  const dir = scratch()
  const socket = join(dir, 'viewport-test.sock')
  const leaseDir = join(dir, 'leases')
  const target = await resolveLeaseTarget({ socket, leaseDir })
  const mine = await readProcessIdentity(process.pid)
  writeFileSync(
    target.path,
    `${JSON.stringify({ version: 1, pid: process.pid, start: mine.start, token: 'released-holder', scope: target.key, released: true })}\n`,
  )
  const log = join(dir, 'log')
  const fake = fakeClient(dir, 'viewport-fake', [`printf '%s\\n' "$*" >> '${log}'`, 'exit 0'].join('\n'))
  const seat = new ViewportSeat({ executable: fake, socket, leaseDir, timeoutMs: 5000, leaseWaitMs: 2000 })
  const started = Date.now()
  await seat.run([pointerMessage(10, 10)])
  assert.ok(Date.now() - started < 1000, 'a release tombstone needs no grace')
  assert.deepEqual(lines(log), [invocation(socket, ['-t', 'input.pointer', '--x', '10', '--y', '10'])])
  assert.equal(existsSync(target.path), false)
})

test('a record from another plugin version is honoured while its owner lives, and reclaimed when dead', async () => {
  const dir = scratch()
  const socket = join(dir, 'viewport-test.sock')
  const leaseDir = join(dir, 'leases')
  const target = await resolveLeaseTarget({ socket, leaseDir })
  const mine = await readProcessIdentity(process.pid)
  writeFileSync(
    target.path,
    `${JSON.stringify({ version: 2, pid: process.pid, start: mine.start, token: 'v2-holder', scope: target.key })}\n`,
  )
  const log = join(dir, 'log')
  const fake = fakeClient(dir, 'viewport-fake', [`printf '%s\\n' "$*" >> '${log}'`, 'exit 0'].join('\n'))
  const live = new ViewportSeat({ executable: fake, socket, leaseDir, timeoutMs: 5000, leaseWaitMs: 200 })
  await assert.rejects(live.run([pointerMessage(11, 11)]), (error) => {
    assert.equal(error.name, 'LeaseError')
    assert.equal(error.holder.pid, process.pid)
    assert.match(error.message, /another version of this plugin/)
    return true
  })
  assert.deepEqual(lines(log), [], 'a live foreign-version holder is never stolen')

  // The same format, with an identity that is provably gone: reclaimed.
  writeFileSync(
    target.path,
    `${JSON.stringify({ version: 2, pid: 2_147_483_646, start: 1, token: 'v2-holder' })}\n`,
  )
  const started = Date.now()
  await live.run([pointerMessage(12, 12)])
  assert.ok(Date.now() - started < 1000, 'a dead foreign-version holder is reclaimed at once')
  assert.deepEqual(lines(log), [invocation(socket, ['-t', 'input.pointer', '--x', '12', '--y', '12'])])
  assert.equal(existsSync(target.path), false)
})

test('a foreign-version record from another boot or namespace is never called dead', async () => {
  const dir = scratch()
  const socket = join(dir, 'viewport-test.sock')
  const leaseDir = join(dir, 'leases')
  const target = await resolveLeaseTarget({ socket, leaseDir })
  writeFileSync(
    target.path,
    `${JSON.stringify({ version: 2, pid: 2_147_483_646, start: 1, boot: 'another-boot', pidNamespace: 'pid:[1]', token: 'v2' })}\n`,
  )
  const log = join(dir, 'log')
  const fake = fakeClient(dir, 'viewport-fake', [`printf '%s\\n' "$*" >> '${log}'`, 'exit 0'].join('\n'))
  const seat = new ViewportSeat({ executable: fake, socket, leaseDir, timeoutMs: 5000, leaseWaitMs: 200 })
  await assert.rejects(seat.run([pointerMessage(13, 13)]), (error) => {
    assert.equal(error.name, 'LeaseError')
    assert.match(error.message, /another version of this plugin/)
    return true
  })
  assert.deepEqual(lines(log), [], 'a pid that means nothing in this boot is not treated as dead')
})

test('a garbled lease file is reclaimed, after a grace when it is fresh', async () => {
  // An old garbled file: reclaimed immediately.
  const oldDir = scratch()
  const oldTarget = await resolveLeaseTarget({ socket: join(oldDir, 'socket.sock'), leaseDir: join(oldDir, 'leases') })
  writeFileSync(oldTarget.path, 'this is not a lease record\n')
  const old = new Date(Date.now() - 5000)
  utimesSync(oldTarget.path, old, old)
  const oldLog = join(oldDir, 'log')
  const oldFake = fakeClient(oldDir, 'fake', [`printf '%s\\n' "$*" >> '${oldLog}'`, 'exit 0'].join('\n'))
  const oldSeat = new ViewportSeat({
    executable: oldFake,
    socket: join(oldDir, 'socket.sock'),
    leaseDir: join(oldDir, 'leases'),
    timeoutMs: 5000,
    leaseWaitMs: 2000,
  })
  const oldStarted = Date.now()
  await oldSeat.run([pointerMessage(1, 1)])
  assert.ok(Date.now() - oldStarted < 1000, 'an old garbled file does not hold the caller up')

  // A fresh garbled file: left for the grace period, then reclaimed. The
  // writer publishes complete records atomically, so nothing legitimate can
  // be torn; the grace only protects an unknown writer's half-written file.
  const dir = scratch()
  const socket = join(dir, 'socket.sock')
  const leaseDir = join(dir, 'leases')
  const target = await resolveLeaseTarget({ socket, leaseDir })
  writeFileSync(target.path, '{"half":')
  const log = join(dir, 'log')
  const fake = fakeClient(dir, 'fake', [`printf '%s\\n' "$*" >> '${log}'`, 'exit 0'].join('\n'))
  const seat = new ViewportSeat({ executable: fake, socket, leaseDir, timeoutMs: 5000, leaseWaitMs: 4000 })
  const started = Date.now()
  await seat.run([pointerMessage(2, 2)])
  const elapsed = Date.now() - started
  assert.ok(elapsed >= 800, `a fresh garbled file is not stolen before the grace (waited ${elapsed}ms)`)
  assert.ok(elapsed < 4000, `the grace fits the bound (waited ${elapsed}ms)`)
  assert.deepEqual(lines(log), [invocation(socket, ['-t', 'input.pointer', '--x', '2', '--y', '2'])])
  assert.equal(existsSync(target.path), false)
})

test('a live holder outlasting the bound produces a clear error and no input', async () => {
  const dir = scratch()
  const socket = join(dir, 'viewport-test.sock')
  const leaseDir = join(dir, 'leases')
  const target = await resolveLeaseTarget({ socket, leaseDir })
  const mine = await readProcessIdentity(process.pid)
  assert.equal(mine.status, 'alive')
  writeFileSync(
    target.path,
    `${JSON.stringify({ version: 1, pid: process.pid, start: mine.start, token: 'another-seat', scope: target.key })}\n`,
  )
  const log = join(dir, 'log')
  const fake = fakeClient(dir, 'viewport-fake', [`printf '%s\\n' "$*" >> '${log}'`, 'exit 0'].join('\n'))
  const seat = new ViewportSeat({ executable: fake, socket, leaseDir, timeoutMs: 5000, leaseWaitMs: 200 })
  const started = Date.now()
  await assert.rejects(seat.run([pointerMessage(4, 4)]), (error) => {
    assert.equal(error.name, 'LeaseError')
    assert.equal(error.code, 'VIEWPORT_LEASE_BUSY')
    assert.equal(error.leasePath, target.path)
    assert.deepEqual(error.holder, { pid: process.pid, start: mine.start })
    assert.ok(error.waitedMs >= 200 && error.waitedMs < 2000, `the reported wait is the measured one (${error.waitedMs}ms)`)
    assert.match(error.message, /another dsh process/)
    assert.match(error.message, new RegExp(`waited \\d+ms for ${target.path.replaceAll('.', '\\.')}`))
    return true
  })
  assert.ok(Date.now() - started >= 190, 'the bound was actually waited out')
  assert.deepEqual(lines(log), [], 'no message was spawned without the lease')
  writeFileSync(target.path, '')
  utimesSync(target.path, new Date(Date.now() - 5000), new Date(Date.now() - 5000))
})

test('the lease is per socket: two sockets in one directory do not block each other', async () => {
  const dir = scratch()
  const leaseDir = join(dir, 'leases')
  const socketA = join(dir, 'viewport-a.sock')
  const socketB = join(dir, 'viewport-b.sock')
  const targetA = await resolveLeaseTarget({ socket: socketA, leaseDir })
  const targetB = await resolveLeaseTarget({ socket: socketB, leaseDir })
  assert.notEqual(targetA.path, targetB.path, 'different sockets name different lease files')
  assert.equal(targetA.directory, targetB.directory)

  const logA = join(dir, 'log-a')
  const logB = join(dir, 'log-b')
  const fakeA = intervalFake(dir, 'fake-a.mjs', logA, 800)
  const fakeB = intervalFake(dir, 'fake-b.mjs', logB, 800)
  const scriptA = childRunner(dir, 'a.mjs', {
    seat: { executable: fakeA, socket: socketA, leaseDir, timeoutMs: 10_000, leaseWaitMs: 10_000 },
    messages: [pointerMessage(1, 1)],
  })
  const scriptB = childRunner(dir, 'b.mjs', {
    seat: { executable: fakeB, socket: socketB, leaseDir, timeoutMs: 10_000, leaseWaitMs: 10_000 },
    messages: [pointerMessage(2, 2)],
  })
  const a = spawnChild(scriptA)
  const b = spawnChild(scriptB)
  const children = [a, b]
  try {
    const [first, second] = await Promise.all([a.done, b.done])
    assert.equal(first.code, 0, first.stderr)
    assert.equal(second.code, 0, second.stderr)
    const [aStart, aEnd] = intervalOf(logA)
    const [bStart, bEnd] = intervalOf(logB)
    assert.ok(aStart < bEnd && bStart < aEnd, `the two batches overlap: a=[${aStart}, ${aEnd}] b=[${bStart}, ${bEnd}]`)
  } finally {
    cleanup(children)
  }
})

test('the default lease bound is a sane number of seconds', () => {
  assert.equal(DEFAULT_LEASE_WAIT_MS, 30_000)
})

test('a leaseDir that cannot be used is a clear error, not a hang', async () => {
  const dir = scratch()
  const notADirectory = join(dir, 'not-a-directory')
  writeFileSync(notADirectory, '')
  const socket = join(dir, 'viewport-test.sock')
  const log = join(dir, 'log')
  const fake = fakeClient(dir, 'viewport-fake', [`printf '%s\\n' "$*" >> '${log}'`, 'exit 0'].join('\n'))
  const seat = new ViewportSeat({ executable: fake, socket, leaseDir: notADirectory, timeoutMs: 5000 })
  await assert.rejects(seat.run([pointerMessage(1, 1)]), (error) => {
    assert.equal(error.name, 'LeaseError')
    assert.match(error.message, /input lease (directory|path)/)
    return true
  })
  assert.deepEqual(lines(log), [], 'no input without a lease directory')
})

test('a batch aborted mid-flight gives the lease back, and the next call takes it', async () => {
  const dir = scratch()
  const socket = join(dir, 'viewport-test.sock')
  const leaseDir = join(dir, 'leases')
  const target = await resolveLeaseTarget({ socket, leaseDir })
  const log = join(dir, 'log')
  const fake = fakeClient(
    dir,
    'viewport-fake',
    [
      `printf '%s\\n' "$*" >> '${log}'`,
      `if [ "$*" = 'msg --socket ${socket} -t input.button --button ${LEFT} --pressed true' ]; then`,
      `  touch '${dir}/started'`,
      '  exec sleep 30',
      'fi',
      'exit 0',
    ].join('\n'),
  )
  const seat = new ViewportSeat({ executable: fake, socket, leaseDir, timeoutMs: 5000 })
  const controller = new AbortController()
  const run = seat.run([buttonMessage(LEFT, true), buttonMessage(LEFT, false)], controller.signal)
  await waitFor(() => existsSync(join(dir, 'started')), 'the batch to start')
  assert.ok(existsSync(target.path), 'the running batch holds the lease')
  controller.abort()
  await assert.rejects(run, (error) => {
    assert.equal(error.name, 'AbortError')
    return true
  })
  assert.equal(existsSync(target.path), false, 'the lease is given back after compensation')
  await seat.run([pointerMessage(8, 8)])
  assert.equal(existsSync(target.path), false)
  assert.equal(lines(log).at(-1), invocation(socket, ['-t', 'input.pointer', '--x', '8', '--y', '8']))
})

test('a timed-out batch gives the lease back after compensation', async () => {
  const dir = scratch()
  const socket = join(dir, 'viewport-test.sock')
  const leaseDir = join(dir, 'leases')
  const target = await resolveLeaseTarget({ socket, leaseDir })
  const log = join(dir, 'log')
  const fake = fakeClient(
    dir,
    'viewport-fake',
    [
      `printf '%s\\n' "$*" >> '${log}'`,
      `case "$*" in *'--pressed true'*) exec sleep 30 ;; esac`,
      'exit 0',
    ].join('\n'),
  )
  const seat = new ViewportSeat({ executable: fake, socket, leaseDir, timeoutMs: 150 })
  const press = ['-t', 'osk.key', '--keysym', '65507', '--pressed', 'true']
  await assert.rejects(seat.run([press]), /did not answer within 150ms/)
  assert.equal(existsSync(target.path), false, 'the lease is released after timeout compensation')
  assert.deepEqual(lines(log), [
    invocation(socket, press),
    invocation(socket, ['-t', 'osk.key', '--keysym', '65507', '--pressed', 'false']),
  ])
})

test('two ViewportSeat instances in one process still serialize through the lease', async () => {
  const dir = scratch()
  const socket = join(dir, 'viewport-test.sock')
  const leaseDir = join(dir, 'leases')
  const log = join(dir, 'log')
  const fake = fakeClient(dir, 'viewport-fake', [`printf '%s\\n' "$*" >> '${log}'`, 'sleep 0.2', 'exit 0'].join('\n'))
  const first = new ViewportSeat({ executable: fake, socket, leaseDir, timeoutMs: 5000 })
  const second = new ViewportSeat({ executable: fake, socket, leaseDir, timeoutMs: 5000 })
  const started = Date.now()
  await Promise.all([first.run([pointerMessage(1, 1)]), second.run([pointerMessage(2, 2)])])
  assert.ok(Date.now() - started >= 350, 'the second seat waited for the first seat\'s lease')
  assert.equal(lines(log).length, 2)
})
